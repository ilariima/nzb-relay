# Architecture

Why NZB Relay exists, how a request moves through it, and which decisions are
deliberate. [README.md](../README.md) is the user guide and [CLAUDE.md](../CLAUDE.md) is
the contributor contract; this document is the reasoning behind both.

## The premise

Almost everyone assumes Prowlarr downloads an NZB and hands the bytes to SABnzbd. It
does not.

Prowlarr calls SABnzbd's `mode=addurl` endpoint and passes the **indexer download URL**.
SABnzbd then opens its own connection to the indexer and fetches the NZB. The file never
passes through Prowlarr at all.

That design is sensible on a single-homed machine. It becomes a problem the moment
Prowlarr and SABnzbd reach the internet by different routes.

## Why that causes account bans

Consider a normal split-tunnel setup: a VPN is active, but Prowlarr is excluded so the
indexer sees the subscriber's real home address, which is what many private indexers
expect. SABnzbd stays inside the tunnel.

```text
t+0.0s   Prowlarr    ── search, grab ──▶  Indexer      home IP
t+0.1s   Prowlarr    ── addurl(URL)  ──▶  SABnzbd
t+0.4s   SABnzbd     ── GET nzb      ──▶  Indexer      VPN exit IP
```

From the indexer's side, one account authenticated twice within a second from two
unrelated public addresses, one of them a known datacenter range. That is the exact
signature of a shared or resold account, and on many private indexers it is grounds for
suspension.

The user has misconfigured nothing. The split simply lands in the one place it cannot
help: the request that must be re-routed is the one SABnzbd issues, and Prowlarr offers
no way to influence it. Prowlarr's contract with SAB is "here is a URL."

## The fix

Put a SAB-compatible process in front of the real SAB and let it perform the fetch:

```text
Prowlarr ──addurl(URL)──▶ NZB Relay ──GET nzb──▶ Indexer
                              │
                              ├──▶ local archive        (written first)
                              │
                              └──addfile(bytes)──▶ SABnzbd
```

SAB is never told the indexer URL, so it never contacts the indexer for the handoff.
Exactly one process talks to the indexer for the NZB, and the user controls its route by
excluding one small app from the tunnel — a rule they can actually express in a VPN
client, unlike "SABnzbd, but only for this one request."

Prowlarr requires no modification. It is configured with an ordinary SABnzbd download
client pointed at `127.0.0.1:9788` with a blank URL base, and it cannot tell the
difference.

## Request lifecycle

Everything arrives at `/api`. The bridge key is compared against `config.bridgeApiKey`
with a timing-safe comparison, then the request forks:

**Every mode except `addurl`** is forwarded to the real SAB untouched, with the bridge
key swapped for the real SAB key. This is what keeps Prowlarr's connection test, queue
polling, and history working.

**`mode=addurl`** is the intercept path:

```text
1. extract the NZB URL from `name` or `url`
2. fresh egress-IP lookup           ── a failure here aborts the grab
3. retention cleanup
4. fetch the NZB                    ── scheme check, redirects, size cap, timeout
5. validate the payload             ── NZB XML / ZIP / GZIP; reject HTML
6. save to the archive              ── bytes + metadata sidecar, mode 0600
7. upload to SAB as multipart addfile
8. record the submission result and an audit entry
9. return SAB's own response to Prowlarr
```

Step 9 matters more than it looks: Prowlarr receives SAB's genuine response, including
the real `nzo_id`, so its download tracking behaves exactly as it would without the relay
in the path.

## Three deliberate decisions

**Save before submit (steps 6 then 7).** This ordering is the most important detail in
the codebase. The expensive, rate-limited, ban-sensitive operation is the indexer fetch;
the SAB upload is cheap and local. Writing the file first means a SAB outage costs a
retry click rather than a lost grab *and a second hit on the indexer*. A failed
submission must therefore never delete the saved file, and the manual retry path reads
from disk and never re-contacts the indexer.

**A fresh egress lookup before every grab, and no grab without one.** The recorded
address has to describe the route actually used at that moment, so a cached value is
useless. If the lookup fails, the relay cannot say which route it would take, so it
refuses to take one. Failing closed is correct here: the cost of a blocked grab is a
retry, and the cost of a wrong-route grab is the ban this app exists to prevent.

**No fixed "home IP" to compare against.** An early version stored an expected address
and blocked mismatches. Residential addresses are dynamic, so it went stale and blocked
legitimate grabs. The current design observes and records rather than asserts — every
check is uncached, and the result is attached to that specific grab instead of being
claimed globally.

## Content validation

Indexers return HTML with HTTP 200 constantly — expired sessions, rate limits, "download
limit reached" pages. Handing that to SAB creates a broken job and hides the real
problem, so the fetcher rejects anything that is not NZB XML, ZIP, or GZIP, and
explicitly rejects HTML. Combined with the size cap, scheme restriction, and timeout,
this keeps a failed authentication from being archived and submitted as if it were a
release.

## Trust boundaries

```text
┌─ localhost ─────────────────────────────────────────┐
│  Prowlarr ──bridge key──▶ NZB Relay ──real key──▶   │──▶ SABnzbd
│                              │                      │
└──────────────────────────────┼──────────────────────┘
                               └───────────────────────▶ Indexer, IP service
```

Prowlarr only ever holds the bridge key: a random 192-bit value with no meaning outside
this relay. If it leaks, it grants access to a localhost service, not to a SAB instance
or a Usenet account. The real SAB key is stored separately, encrypted through Electron
`safeStorage` (Keychain-backed on macOS), never returned by the settings API, and
substituted only on outbound requests to SAB.

The localhost bind is a security boundary rather than a deployment default. Two known
weaknesses follow from it, both recorded in [SECURITY.md](../SECURITY.md): anyone holding
the bridge key can ask the relay to fetch an arbitrary HTTP(S) URL, and the read-only
admin routes are reachable by other local processes without the UI header. Browser
same-origin rules prevent a remote site from reading the second. Neither is solved well
enough for a LAN, container, or reverse-proxied deployment.

## Storage

Two directories, mode `0700`, files mode `0600`:

| Mode | Location |
|---|---|
| Desktop | `~/Library/Application Support/NZB Relay/` |
| Headless | `$NZB_RELAY_DATA_DIR`, else `~/.nzb-relay/` |

`config.json` holds settings; in desktop mode the SAB key is written as
`sabApiKeyEncrypted` and the plaintext field is dropped. `nzbs/` holds each saved NZB
plus a JSON sidecar recording id, filenames, size, SHA-256, source hostname, the egress
IP observed for that grab, timestamps, submission history, and the preserved SAB
parameters.

The sidecar deliberately omits the indexer download URL, because it carries an API key.
It deliberately *includes* the SAB `password` parameter, because a manual retry must
behave identically to the original submission — an unpack password therefore exists in
plaintext inside an owner-only file.

## Rejected alternatives

**NZBHydra2.** It solves an overlapping problem, but it takes over indexer aggregation
and changes how searches are managed. The goal here was to leave Prowlarr's search and
grab workflow completely untouched and change only the file handoff, in a small native
desktop app.

**Patching Prowlarr or SABnzbd.** Both would mean maintaining a fork against upstream
churn, for a change neither project has reason to accept.

**Routing SABnzbd outside the tunnel instead.** That fixes the IP mismatch by giving up
the VPN for all Usenet traffic — the opposite of what most people running this setup
want.

## Known limits

- No end-to-end test against a live Prowlarr and SAB; integration tests use mock servers.
- Tested against one user's indexer set rather than broadly.
- The audit log is in-memory and lost on exit; persisting it would put indexer hostnames
  and egress IPs on disk, which needs a privacy decision first.
- SSRF protection is partial — adequate for a single-user localhost tool, not for
  exposure.
- A container build would need the egress check to run inside the container, since the
  container's network namespace rather than a host split-tunnel rule would decide the
  route.
