# Architecture

Why NZB Relay exists and how a request moves through it. [README.md](../README.md) is
the user guide; [CLAUDE.md](../CLAUDE.md) is the contributor contract. This document is
the reasoning behind both.

## The problem

The intuitive mental model is that Prowlarr downloads an NZB and hands the bytes to
SABnzbd. That is not what happens.

When Prowlarr sends a release to SAB, it calls SAB's `mode=addurl` API and passes the
*indexer download URL*. SABnzbd then contacts the indexer itself to retrieve the NZB.

With a split-tunnel VPN, that produces two separate egress paths for one logical
operation:

```text
1. Prowlarr  ──search/grab──▶  Indexer        (Prowlarr's route)
2. Prowlarr  ──addurl(URL)──▶  SABnzbd
3. SABnzbd   ──fetch NZB────▶  Indexer        (SABnzbd's route)
```

Steps 1 and 3 can present different public IPs to the same indexer for the same grab.

## The fix

Insert a SAB-compatible bridge between Prowlarr and the real SAB, and make it perform
the fetch itself:

```text
Prowlarr ──addurl(URL)──▶ NZB Relay ──fetch──▶ Indexer
                              │
                              ├──▶ local archive (saved first)
                              │
                              └──addfile(bytes)──▶ SABnzbd
```

SAB never learns the indexer URL, so it never contacts the indexer for the handoff.
The only process that talks to the indexer for the NZB file is NZB Relay, whose route
the user controls by excluding one app from the VPN tunnel.

Prowlarr needs no modification. It is configured with an ordinary SABnzbd download
client pointed at `127.0.0.1:9788` with a blank URL base.

## Request lifecycle

Everything arrives at `/api`. The bridge key is checked with a timing-safe comparison
against `config.bridgeApiKey`, then:

**Any mode except `addurl`** — forwarded to the real SAB unchanged, with the bridge key
swapped for the real SAB key. This is what lets Prowlarr test the client and poll queue
and history normally.

**`mode=addurl`** — the intercept path:

```text
1. extract the NZB URL from `name` or `url`
2. fresh egress-IP lookup            ── failure here aborts the grab
3. retention cleanup
4. fetch the NZB                     ── scheme check, redirects, size cap, timeout
5. validate the payload              ── NZB XML / ZIP / GZIP; reject HTML
6. save to the archive               ── bytes + metadata sidecar, mode 0600
7. upload to SAB via multipart addfile
8. record submission result and audit entry
9. return SAB's own response to Prowlarr
```

The ordering of 6 and 7 is deliberate and is the single most important detail in the
codebase. A fetched NZB is saved *before* anything can fail downstream, so a SAB outage
costs the user a retry click rather than a lost grab and a second indexer hit.

Steps 2 and 5 are the two places the app refuses to proceed. A failed IP lookup means
the relay cannot say which route it would use, so it does not use one. A payload that
does not look like an NZB is usually an indexer login or error page returned with HTTP
200 — submitting that to SAB would create a broken job and mask an auth problem.

## What the app controls

It controls exactly one thing: the NZB file handoff that SAB would otherwise perform.

It does **not** search indexers, manage them, proxy Prowlarr's own indexer API calls,
download Usenet articles, control SAB's NNTP connections, bind a network interface,
force a VPN route, or determine whether an address belongs to a VPN.

That last point matters. The IP display is an observation, not a guarantee. Routing can
still be affected by split-tunnel rules, IPv4 versus IPv6, DNS, system proxies, and VPN
client behavior. The honest claim is "this is the address the configured lookup service
saw for this process," which is why every check is a fresh, uncached lookup and why the
result is recorded per grab rather than asserted globally.

## Trust boundaries

```text
┌─ localhost ────────────────────────────────────────┐
│  Prowlarr ──bridge key──▶ NZB Relay ──real key──▶  │──▶ SABnzbd
│                              │                     │
└──────────────────────────────┼─────────────────────┘
                               └──────────────────────▶ Indexer, IP service
```

Prowlarr only ever holds the bridge key — a random 192-bit value with no privileges
beyond this relay. The real SAB key is stored separately, encrypted through Electron
`safeStorage` (Keychain-backed on macOS), never returned by the config API, and
substituted only on outbound requests to SAB.

The localhost bind is part of the security design rather than a deployment default.
Two known weaknesses follow from it, both documented in [SECURITY.md](../SECURITY.md):
anyone holding the bridge key can ask the relay to fetch an arbitrary HTTP(S) URL, and
some read-only admin routes are reachable by other local processes without the UI
header. Browser same-origin rules limit the second from ordinary web pages; neither is
solved well enough for a LAN or container deployment.

## Storage

Two directories, both mode `0700`, files mode `0600`:

| Mode | Location |
|---|---|
| Desktop | `~/Library/Application Support/NZB Relay/` |
| Headless | `$NZB_RELAY_DATA_DIR`, else `~/.nzb-relay/` |

`config.json` holds settings; in desktop mode the SAB key is stored as
`sabApiKeyEncrypted` and the plaintext field is removed. `nzbs/` holds each saved NZB
plus a JSON sidecar carrying id, filenames, size, SHA-256, source hostname, observed
egress IP, timestamps, submission history, and the preserved SAB parameters.

The sidecar deliberately omits the indexer download URL, because it carries an API key.
It deliberately *includes* the SAB `password` parameter, because a manual retry must
behave identically to the original submission — an unpack password therefore exists in
plaintext in an owner-only file.

## Why not NZBHydra2

NZBHydra2 solves an overlapping problem but replaces more of the workflow than wanted
here: it becomes the indexer aggregator, changes how searches are managed, and does not
provide the small native desktop experience this project is built around. The goal was
to keep Prowlarr's search and grab interface exactly as-is and change only the file
handoff.

## Known limits

- No end-to-end test against a live Prowlarr and SAB; integration tests use mocks.
- Tested against one user's indexer set, not broadly.
- The audit log is in-memory and lost on exit.
- SSRF protection is partial — adequate for localhost, not for exposure.
- A container build would need the egress check to run inside the container, since the
  container's network namespace, not a host split-tunnel rule, would decide the route.
