# NZB Relay

NZB Relay is a small macOS desktop bridge for a specific split-tunneling problem:
Prowlarr normally gives SABnzbd an indexer URL, so **SABnzbd** fetches the NZB. NZB
Relay intercepts that `addurl` call, freshly checks the relay process's public IP, downloads
and archives the NZB itself, and uploads the actual bytes to SABnzbd with `addfile`.

```text
Prowlarr  →  NZB Relay (URL → bytes)  →  SABnzbd
                  │
                  └── fresh public-IP check before indexer contact
```

The app listens only on `127.0.0.1`. It keeps Prowlarr's search and grab interface;
it is not another indexer database or search UI.

## What it guarantees

- `mode=addurl` never reaches SABnzbd. The relay fetches the URL and sends SAB a
  multipart `mode=addfile` request containing the NZB bytes.
- A fresh public-IP lookup runs before each NZB fetch. The observed address is
  recorded with the saved NZB and local audit entry.
- Prowlarr receives SABnzbd's original API response, including the job ID.
- SAB capability, queue, and history calls pass through so Prowlarr can test and
  monitor the download client.
- The bridge key presented to Prowlarr and the real SAB API key are separate.
- HTML login/error pages and oversized responses are rejected instead of being
  submitted as downloads.
- Every successful indexer fetch is saved locally before SAB submission. Saved
  files can be pushed to SAB again from the desktop interface.

## Install on macOS

### Community build

Download the Apple Silicon DMG or ZIP from a project release and move **NZB Relay**
to Applications. Release builds are ad-hoc signed automatically on a macOS GitHub
runner, so users do not need to run `codesign` themselves.

The free build is not signed with a paid Developer ID and is not notarized. On first
launch, try to open the app once, then go to **System Settings → Privacy & Security**
and click **Open Anyway**. macOS saves that decision as an exception for the app.

### Build it yourself

Node.js 22 or newer is required.

```bash
npm ci
npm test
npm run dist:mac
```

The DMG and ZIP are written to `dist/`. A GitHub Actions workflow is included for
building, ad-hoc signing, verifying, checksumming, and publishing the same artifacts
on an Apple Silicon macOS runner. Pushing a tag named `v*` creates the corresponding
GitHub release automatically.

Ad-hoc signing only supplies the valid code signature required to run the bundle on
Apple Silicon. Removing the unidentified-developer warning entirely requires paid
Developer ID signing and Apple notarization.

For a headless development run:

```bash
npm start
```

Then open <http://127.0.0.1:9788>.

## Configure

1. Open NZB Relay and enter the real SABnzbd URL and API key.
2. Click **Save settings**, then **Test SABnzbd**. Test results appear in a floating
   notification that remains visible regardless of scroll position.
3. Configure your VPN split tunnel to exclude the **NZB Relay** app/process.
4. Click **Check IP**. It always performs a fresh lookup through NZB Relay itself.
   Compare the displayed address before and after connecting your VPN to confirm
   that NZB Relay follows the route you intended.
5. In Prowlarr, add or edit the SABnzbd download client with:

   - Host: `127.0.0.1`
   - Port: `9788`
   - SSL: off
   - URL Base: blank
   - API Key: the **local endpoint** key shown by NZB Relay
   - Category: your normal SAB category

6. Test the client in Prowlarr and perform one manual grab. NZB Relay's activity log
   should show `uploaded`, the indexer host, filename, byte count, relay egress IP,
   and SAB job ID.

## Saved NZB inbox

The app saves each fetched NZB in its private `nzbs` directory before contacting
SAB. The **Saved NZBs** panel shows the filename, indexer host, byte count, short
SHA-256 proof, and SAB submission history. From there you can:

- push any saved NZB to SAB again;
- delete an individual saved NZB;
- open the storage folder in Finder; and
- retain files for a custom number of hours or days, or choose **Forever**.

The default retention is seven days. Cleanup runs at startup, when settings are
saved, when the inbox is viewed, and before new grabs. Manual resubmission preserves
the original category, priority, post-processing, script, password, display name,
and duplicate-handling options.

### Important split-tunnel detail

This app controls only the **grab handoff**. Prowlarr still makes its own indexer
search/API requests, so route Prowlarr according to your own requirements. Excluding
NZB Relay is what determines the route used to fetch the NZB file. SABnzbd's Usenet
connections remain completely separate.

No home address is hardcoded or compared. This is intentional because residential
addresses may change. Use the compact **Check IP** bar whenever you change VPN state;
each click bypasses the cache and displays the address currently used by this app.

## Data and security

- The HTTP service is hard-bound to `127.0.0.1`; remote machines cannot connect.
- Configuration is stored in the app's macOS user-data directory with owner-only
  file permissions. The SAB key is encrypted using Electron's Keychain-backed safe
  storage, and the UI never returns it.
- A random 192-bit local bridge key protects the SAB-compatible endpoint.
- Mutating UI endpoints require a custom header to prevent browser-to-localhost CSRF.
- The in-memory activity log is cleared whenever the app exits and redacts keys from
  errors.
- Indexer responses are limited to 64 MB by default (configurable from 1–256 MB).
- Saved NZBs and their metadata use owner-only file permissions. The metadata never
  stores the original indexer download URL or indexer API key.

Headless Node mode does not use Keychain and stores its key in the owner-only config
file. See [SECURITY.md](SECURITY.md) before exposing or distributing a build.

## Compatibility scope

Version 0.2 targets Prowlarr's SABnzbd client contract and SABnzbd's documented API:

- `addurl` is transformed into `addfile`.
- Query-string and URL-encoded `addurl` parameters are accepted.
- Category, priority, post-processing, script, password, display name, and duplicate
  handling parameters are preserved.
- Other SAB API modes pass through unchanged with the real SAB key substituted.
- HTTP redirects from indexers are followed.
- Plain NZB XML, ZIP, and GZIP payloads are accepted.

This release does not search indexers itself, proxy Prowlarr's indexer searches, or
manage SAB's NNTP download traffic.

## Development

```bash
npm test
npm run electron
```

The relay core uses Node's built-in HTTP and Fetch APIs. Integration tests start mock
indexer and SAB servers and verify byte-for-byte upload behavior without external
accounts or network access.

Project layout:

```text
src/relay-server.mjs   Local SAB-compatible server and admin API
src/nzb-fetcher.mjs    Bounded NZB download and validation
src/nzb-archive.mjs    Persistent inbox, metadata, retry, and retention
src/sab-client.mjs     SAB pass-through and multipart addfile client
src/egress-checker.mjs Same-process public-IP check and enforcement
src/electron-main.mjs  macOS desktop shell
src/ui/                Local configuration interface
test/                  Unit and protocol-level integration tests
```

## License

MIT. See [LICENSE](LICENSE).
