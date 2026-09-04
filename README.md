# NZB Relay

A local SABnzbd stand-in that stops your indexer from seeing two different IP
addresses for a single grab.

NZB Relay presents itself to Prowlarr as an ordinary SABnzbd download client. When
Prowlarr sends a release, the relay downloads the NZB itself, saves a copy locally, and
hands the actual file bytes to your real SABnzbd. Your indexer is contacted exactly
once, by one process, over one route.

```text
Prowlarr  ──▶  NZB Relay  ──▶  SABnzbd
                   │
                   ├──▶ Indexer   (one connection, one IP)
                   └──▶ local NZB archive
```

## The problem this solves

Prowlarr does not hand SABnzbd an NZB file. It calls SABnzbd's `mode=addurl` API and
passes the **indexer download URL**, and SABnzbd then contacts the indexer itself to
fetch the NZB.

So two different programs talk to your indexer for a single grab: Prowlarr for the
search and the grab request, SABnzbd for the file. Whenever those two leave the network
by different routes, your indexer sees one account authenticate from two public
addresses seconds apart:

```text
1. Prowlarr search / grab   ──▶ Indexer     from Prowlarr's IP
2. Prowlarr addurl(URL)     ──▶ SABnzbd
3. SABnzbd fetches the NZB  ──▶ Indexer     from SABnzbd's IP
```

That pattern is the signature of a shared or resold account, and on many private
indexers it is grounds for suspension. Two common setups produce it:

**Home machine with a VPN and split tunneling.** You exclude Prowlarr from the tunnel so
your indexer sees your real subscriber address, while SABnzbd stays inside the tunnel
and fetches the NZB from a datacenter exit.

**VPS or self-hosted server behind a proxy.** You route Prowlarr's indexer API calls
through a specific proxy or egress address, but SABnzbd fetches the NZB over the box's
default route — so the grab arrives from an address the searches never used.

In both cases you configured nothing wrong. The split falls in the one place you cannot
reach, because the request that needs redirecting is the one SABnzbd issues, and
Prowlarr's only contract with a download client is "here is a URL." The same problem
applies to any downloader handed a URL rather than a file.

## How it fixes it

Point Prowlarr at NZB Relay instead of SABnzbd. The relay speaks SAB's API, so Prowlarr
cannot tell the difference and needs no modification.

When an `addurl` request arrives, the relay:

1. checks its own current public IP;
2. downloads the NZB from the indexer itself, over its own route;
3. validates that the response really is an NZB;
4. saves the file to a local archive; and
5. uploads the bytes to your real SABnzbd using `mode=addfile`.

SABnzbd never receives the indexer URL, so it never contacts your indexer. The grab is
performed by NZB Relay, over NZB Relay's route — so route the relay the way you route
Prowlarr and both halves of a grab come from one address.

That is the whole point: the downloader stops using its own IP to fetch NZBs. Instead of
trying to redirect one specific SABnzbd request, which is not something a VPN client or
a proxy rule can express, you point one small process wherever you want.

Every other SAB API call — version, queue, history — passes straight through, so
Prowlarr's connection test and download monitoring keep working normally.

## What it does not do

- It does not search indexers or replace Prowlarr.
- It does not proxy Prowlarr's own indexer searches. Route Prowlarr yourself.
- It does not touch SABnzbd's Usenet (NNTP) connections.
- It does not force a network interface or configure your VPN.
- It cannot tell you whether an address belongs to a VPN. It reports the address your
  configured lookup service saw, and you compare.

It controls one thing: the NZB file handoff that SABnzbd would otherwise perform.

## Install

Download the Apple Silicon DMG or ZIP from a [release](../../releases) and move **NZB
Relay** to Applications.

Release builds are ad-hoc signed on a macOS runner, so you do not need to run `codesign`
yourself. They are not signed with a paid Developer ID and are not notarized, so on
first launch try to open the app once, then go to **System Settings → Privacy &
Security** and click **Open Anyway**. macOS remembers the exception.

Verify a download against the published checksums:

```bash
shasum -c SHA256SUMS.txt
```

### Build it yourself

Node.js 22 or newer:

```bash
npm ci
npm test
npm run dist:mac
```

The DMG and ZIP land in `dist/`. For a headless run without the desktop shell:

```bash
npm start
```

Then open <http://127.0.0.1:9788>.

## Set it up

**1. Configure the relay.** Open NZB Relay, enter your real SABnzbd URL and API key,
click **Save settings**, then **Test SABnzbd**. A local address like `127.0.0.1:8080`
is fine — the scheme is added for you.

**2. Route the relay like Prowlarr.** This is the step that determines which address
your indexer sees. On a home machine that usually means excluding NZB Relay from your
VPN's tunnel alongside Prowlarr. On a server it means giving the relay the same egress
as Prowlarr's indexer traffic. If the relay and Prowlarr already share a host and a
default route, this is already true.

**3. Confirm the route.** Click **Check IP**. Every click performs a fresh, uncached
lookup from inside the app, so the address shown is the one the relay would actually use
right now. Compare it before and after connecting your VPN, or against the address your
indexer's login history records for Prowlarr's searches.

**4. Point Prowlarr at the relay.** Add or edit a SABnzbd download client:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `9788` |
| SSL | off |
| URL Base | *blank* |
| API Key | the **local endpoint** key shown in NZB Relay |
| Category | your normal SAB category |

Prowlarr gets the relay's own bridge key — never your real SAB key, which stays inside
NZB Relay.

**5. Test it.** Run Prowlarr's connection test, then do one manual grab. The relay's
activity log should show `uploaded` along with the indexer host, filename, byte count,
the egress IP used for that grab, and the SAB job ID.

## Where it can run

The relay binds `127.0.0.1` and cannot be reached from another machine. Prowlarr and the
relay therefore have to share a host.

**macOS desktop** is the supported setup and what release builds target.

**Headless on a server** works today with `npm start`, which runs the same relay on plain
Node without the Electron shell. This suits a VPS or self-hosted box where Prowlarr,
NZB Relay, and SABnzbd all live on one machine. It behaves identically to the desktop
build.

**Containers are not supported yet.** A Docker image is planned but deliberately not
built by relaxing the localhost bind — a container deployment needs its own network and
secret handling design, and the egress check has to run inside the container, because
the container's network namespace rather than a host routing rule decides where the grab
comes from.

## Saved NZB inbox

Every NZB is written to disk *before* SAB is contacted, so a SAB outage costs you a
retry click instead of a lost grab and a second hit on your indexer.

The **Saved NZBs** panel lists each file with its indexer host, size, short SHA-256, and
submission history. From there you can push a saved NZB to SAB again — reading the local
file, never re-contacting the indexer — delete one, or open the storage folder.

### Holding grabs instead of sending them

**Settings → When a grab arrives** chooses what happens after the NZB is fetched
and saved:

- **Send to SABnzbd** (default) forwards the bytes immediately.
- **Hold in inbox** stops after the archive write. Nothing reaches SABnzbd until
  you press **Send to SAB** on the row yourself.

Holding is useful when you want to look at a release before it downloads, or to
collect NZBs while SABnzbd is off. The indexer is still contacted once, over the
relay's route, exactly as in the normal path — holding changes only what happens
afterwards.

One caveat: with nothing queued in SABnzbd, Prowlarr is told the grab succeeded
and given a placeholder job id, so anything that later asks SABnzbd about that id
will not find it. That is fine for grabs made from Prowlarr itself; if Sonarr or
Radarr track the download through this relay, leave the mode on **Send to
SABnzbd**.

Retention is configurable in hours or days, with a **Forever** option. The default is
seven days. Cleanup runs at startup, on save, when the inbox is viewed, and before each
grab. A manual retry preserves the original category, priority, post-processing, script,
password, display name, and duplicate handling.

## Data and security

- The service is hard-bound to `127.0.0.1`. Remote machines cannot connect.
- A random 192-bit bridge key protects the SAB-compatible endpoint. It is not your SAB
  key, and Prowlarr only ever sees the bridge key.
- Your real SAB key is stored in an owner-only configuration file and is never returned
  by the settings API. It is not encrypted at rest — SABnzbd keeps the same key in
  plaintext in its own configuration file, and encrypting this copy made macOS ask for
  a Keychain password on every update without protecting anything new.
- Config and saved NZBs use owner-only permissions in an owner-only directory.
- Archive metadata never stores the indexer download URL or its API key. Errors have
  credentials stripped before they are logged.
- Indexer responses are capped at 64 MB by default, adjustable from 1 to 256 MB.
- HTML login and error pages are rejected rather than passed to SAB as a broken job.
- The activity log lives in memory only and is gone when the app exits.

Read [SECURITY.md](SECURITY.md) before exposing or redistributing a build.

## A realistic caveat

This is a routing control, not an anonymity guarantee. It makes the NZB fetch happen in
a process whose route you control, and it tells you what address that process is using.
It cannot account for DNS behavior, IPv4 versus IPv6 differences, system proxies, or a
VPN client that behaves unexpectedly. Verify with your own account and your indexer's
own login history.

## Compatibility

Targets Prowlarr's SABnzbd client contract and SABnzbd's documented API:

- `addurl` is converted to `addfile`; every other mode passes through unchanged.
- Both query-string and URL-encoded `addurl` parameters are accepted.
- Category, priority, post-processing, script, password, display name, and duplicate
  handling are preserved.
- Indexer redirects are followed; NZB XML, ZIP, and GZIP payloads are accepted.

## Development

```bash
npm test          # 15 tests, no network or accounts required
npm run electron  # desktop app
```

The relay uses only Node built-ins — no runtime dependencies. Integration tests start
mock indexer and SAB servers and assert byte-for-byte upload behavior offline.

Before changing code, read [CLAUDE.md](CLAUDE.md) for the behavioral invariants this app
depends on, and [ARCHITECTURE.md](ARCHITECTURE.md) for the design reasoning.

```text
src/relay-server.mjs    SAB-compatible endpoint, admin routes, addurl interception
src/nzb-fetcher.mjs     Bounded download, redirects, content validation
src/nzb-archive.mjs     Persistent inbox, metadata, retention, manual retry
src/sab-client.mjs      SAB pass-through and multipart addfile upload
src/egress-checker.mjs  Per-grab public-IP lookup
src/config-store.mjs    Defaults, normalization, protected secret storage
src/electron-main.mjs   macOS desktop shell
src/ui/                 Local configuration interface
```

## License

MIT. See [LICENSE](LICENSE).
