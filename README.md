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

That is fine until Prowlarr and SABnzbd leave your network by different routes — which
is exactly what happens with a VPN and split tunneling. Say you route Prowlarr outside
the tunnel so your indexer sees your home address, while SABnzbd runs inside the tunnel:

```text
1. Prowlarr search / grab   ──▶ Indexer     from your home IP
2. Prowlarr addurl(URL)     ──▶ SABnzbd
3. SABnzbd fetches the NZB  ──▶ Indexer     from your VPN IP
```

One grab, one account, two public IP addresses, seconds apart. To an indexer that
pattern looks like a shared or resold account, and on many private indexers that is a
bannable offence. You did nothing wrong — the split simply falls in the worst possible
place, because the one request you cannot redirect is the one SABnzbd makes.

Nothing in Prowlarr fixes this. It only knows how to hand SAB a URL.

## How it fixes it

Point Prowlarr at NZB Relay instead of SABnzbd. The relay speaks SAB's API, so Prowlarr
cannot tell the difference and needs no modification.

When an `addurl` request arrives, the relay:

1. checks its own current public IP;
2. downloads the NZB from the indexer itself, over its own route;
3. validates that the response really is an NZB;
4. saves the file to a local archive; and
5. uploads the bytes to your real SABnzbd using `mode=addfile`.

SABnzbd never receives the indexer URL, so it never contacts your indexer. Only NZB
Relay does — and you control its route by excluding one small app from your VPN tunnel.

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

**2. Exclude NZB Relay from your VPN tunnel.** This is the step that determines which
address your indexer sees. Consult your VPN client's split-tunnel settings.

**3. Confirm the route.** Click **Check IP** before connecting your VPN, then again
after. Every click performs a fresh, uncached lookup from inside the app. If the
address does not change when you connect the VPN, the exclusion is working.

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

## Saved NZB inbox

Every NZB is written to disk *before* SAB is contacted, so a SAB outage costs you a
retry click instead of a lost grab and a second hit on your indexer.

The **Saved NZBs** panel lists each file with its indexer host, size, short SHA-256, and
submission history. From there you can push a saved NZB to SAB again — reading the local
file, never re-contacting the indexer — delete one, or open the storage folder.

Retention is configurable in hours or days, with a **Forever** option. The default is
seven days. Cleanup runs at startup, on save, when the inbox is viewed, and before each
grab. A manual retry preserves the original category, priority, post-processing, script,
password, display name, and duplicate handling.

## Data and security

- The service is hard-bound to `127.0.0.1`. Remote machines cannot connect.
- A random 192-bit bridge key protects the SAB-compatible endpoint. It is not your SAB
  key, and Prowlarr only ever sees the bridge key.
- Your real SAB key is encrypted through Electron's Keychain-backed safe storage and is
  never returned by the settings API.
- Config and saved NZBs use owner-only permissions in an owner-only directory.
- Archive metadata never stores the indexer download URL or its API key. Errors have
  credentials stripped before they are logged.
- Indexer responses are capped at 64 MB by default, adjustable from 1 to 256 MB.
- HTML login and error pages are rejected rather than passed to SAB as a broken job.
- The activity log lives in memory only and is gone when the app exits.

Headless Node mode has no Keychain and keeps its key in the owner-only config file. Read
[SECURITY.md](SECURITY.md) before exposing or redistributing a build.

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
npm test          # 14 tests, no network or accounts required
npm run electron  # desktop app
```

The relay uses only Node built-ins — no runtime dependencies. Integration tests start
mock indexer and SAB servers and assert byte-for-byte upload behavior offline.

Before changing code, read [CLAUDE.md](CLAUDE.md) for the behavioral invariants this app
depends on, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design reasoning.

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
