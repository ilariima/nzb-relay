# CLAUDE.md

Operating notes for anyone — human or AI — working in this repository.

Read this before changing code. [README.md](README.md) explains what the app does for
users; [ARCHITECTURE.md](ARCHITECTURE.md) explains why it is built this way.
This file covers how to work here without breaking it.

## Orientation

NZB Relay is a localhost bridge that sits between Prowlarr and SABnzbd. Prowlarr
normally hands SAB an indexer URL and SAB fetches the NZB itself, which can expose a
second public IP to the indexer. This app impersonates SAB, intercepts `mode=addurl`,
fetches and archives the NZB through its own network route, and forwards the bytes to
the real SAB with `mode=addfile`.

The scope is deliberately narrow. It does not search indexers, replace Prowlarr, or
touch SAB's NNTP traffic.

## Commands

```bash
npm ci                 # install (lockfile-exact)
npm test               # 15 tests, no network or accounts needed
npm audit --audit-level=high
npm start              # headless relay on 127.0.0.1:9788
npm run electron       # desktop app
npm run dist:mac       # DMG + ZIP into dist/
```

Node 22 or newer is required. If `node` is missing on a machine that has it installed
via Homebrew's keg-only `node@22`, see `CLAUDE.local.md` (untracked, machine-specific).

Always run `npm test` before proposing a change is complete. It is fast (~200 ms) and
needs no external services.

## Invariants

These are load-bearing. Breaking one silently defeats the purpose of the app, and
several would leak data or lose a user's download. Do not change them without an
explicit decision from the maintainer.

1. **No hardcoded or "expected" home IP.** Residential addresses are dynamic. An
   earlier version compared against a fixed address and blocked grabs when it went
   stale. Never reintroduce that. The IP display is an observation tool, not a gate.

2. **A fresh egress lookup runs before every automatic grab, and a failed lookup
   aborts the grab.** `EgressChecker.enforce()` forces `{ force: true }` so the
   recorded address reflects the route in use at that moment. Never let a cached
   value satisfy a grab.

3. **The NZB is written to disk before SAB submission.** Order is: fetch → validate →
   save → upload. A failed SAB submission must leave the file on disk so the user can
   retry from the inbox.

4. **SAB receives bytes via `addfile`, never the indexer URL.** If `addurl` ever
   reaches the real SAB, the app has failed at its one job.

5. **Manual "Push to SAB" reads the saved file and never re-contacts the indexer.**

6. **Full indexer URLs and indexer API keys never reach archive metadata or logs.**
   Only the hostname is stored. `publicError()` redacts `apikey`/`token`/`key` query
   parameters from error strings before they are logged or returned.

7. **The real SAB API key is never returned by `/relay/config`.** `getPublic()` blanks
   it and reports only whether one is configured.

8. **Desktop mode stays bound to `127.0.0.1`.** `normalizeConfig()` hard-codes
   `listenHost` and ignores any supplied value. A container build would need its own
   deliberate design, not a relaxed bind address here.

9. **SAB submission options are preserved.** `FORWARDED_ADD_PARAMETERS` — `cat`,
   `priority`, `pp`, `script`, `password`, `nzbname`, `dupe_key`, `dupe_score`,
   `dupe_mode` — must survive both the live conversion and a manual retry. The bridge
   changes *how* the NZB arrives, never the user's choices about it.

10. **Retention `0` means Forever.** `NzbArchive.cleanup()` returns early on `0`.
    Do not "fix" this into deleting everything.

11. **Mutating endpoints require the `x-nzb-relay-ui: 1` header.** This blocks
    browser-to-localhost CSRF from an ordinary web page.

12. **The bridge key and the real SAB key stay separate**, compared with
    `timingSafeEqual` on equal-length buffers.

There are regression tests for most of these. If you change behavior around one and
the tests still pass, assume the test is inadequate rather than the invariant obsolete.

## Code map

```text
src/relay-server.mjs    HTTP server, /api SAB endpoint, admin routes, addurl interception
src/nzb-fetcher.mjs     Bounded fetch, redirect handling, content validation, filenames
src/nzb-archive.mjs     Persistent inbox: metadata sidecars, checksums, retention, retry
src/sab-client.mjs      SAB URL building, key substitution, multipart addfile, pass-through
src/egress-checker.mjs  Public-IP lookup and per-grab enforcement
src/config-store.mjs    Defaults, normalization, bridge-key generation, protected storage
src/audit-log.mjs       In-memory activity ring buffer (200 entries, not persisted)
src/version.mjs         Single source of version and User-Agent strings
src/electron-main.mjs   Desktop shell, safeStorage codec, Finder integration
src/main.mjs            Headless entry point
src/ui/                 Local configuration interface (vanilla JS, no framework)
test/                   Unit and protocol-level integration tests
```

The request path worth knowing by heart is in `relay-server.mjs`: everything that is
not `mode=addurl` is forwarded untouched to the real SAB; `addurl` is the one mode that
gets intercepted.

## Conventions

**Zero runtime dependencies.** The app uses only Node built-ins — `node:http`, `fetch`,
`FormData`, `node:crypto`, `node:fs/promises`. `electron` and `electron-builder` are
devDependencies. Do not add a runtime dependency without a strong reason; the small
supply-chain surface is a feature of a tool that handles API keys.

**ESM everywhere** (`"type": "module"`, `.mjs`). The one exception is
`build/after-pack.cjs`, which electron-builder loads as CommonJS.

**Version lives only in `package.json`.** `src/version.mjs` reads it at runtime. Never
hardcode a version string anywhere else.

**Commit messages** explain *why*, not just what. No attribution trailers, no tool
footers, no `Co-Authored-By` lines. Same for pull request descriptions.

**Errors that reach a user or a log go through `publicError()`** so credentials in URLs
are redacted.

## Testing

Tests use `node --test` with the glob `test/**/*.test.mjs`. Helper modules live in
`test/helpers.mjs` and are deliberately excluded from that glob — a bare `node --test`
would collect the helper as an empty passing test file and inflate the count.

Integration tests spin up mock indexer and SAB servers on ephemeral ports. Nothing
touches the network or needs real accounts. Use `203.0.113.x` (RFC 5737) and `.invalid`
hostnames (RFC 2606) for fixtures — never a real indexer or a real IP.

Known gaps, in case they matter to what you are doing: no end-to-end test against a
live Prowlarr/SAB, no Electron UI automation, no coverage report.

## Release process

1. Bump `version` in `package.json` (this is the only place it lives) and run
   `npm install` so the lockfile follows.
2. Move the changelog's `Unreleased` section under the new version heading.
3. Merge to `main` and confirm CI is green.
4. Push an annotated tag: `git tag -a vX.Y.Z -m "NZB Relay vX.Y.Z" && git push origin vX.Y.Z`.

The tag triggers the build, ad-hoc signing, checksum generation, and release upload.
`--publish never` is set on `dist:mac` so electron-builder does not try to publish on
its own; the workflow uploads artifacts explicitly.

The checksum step renames artifacts to the dotted names GitHub serves before hashing,
so `shasum -c SHA256SUMS.txt` works on a downloaded file. Do not remove that rename.

## Decisions already made

Do not relitigate these without new information:

- **NZBHydra2 was considered and rejected.** It replaces more of the Prowlarr workflow
  than desired and does not give the native desktop experience this project wants.
- **Ad-hoc signing is the deliberate free distribution route.** It makes the bundle
  runnable without users invoking `codesign`. It is not Developer ID and not notarized;
  first launch still needs *Open Anyway*. Paid signing is a cost decision, not an
  oversight.
- **The localhost bind is a security boundary, not a default.** See invariant 8.
- **The audit log is in-memory and ephemeral by design.** Persisting it would put
  indexer hostnames and egress IPs on disk; that needs a privacy decision first.

## Not yet built

Docker/headless container image, Intel and universal macOS builds, Windows and Linux
builds, notarization, auto-update, persistent audit history, configurable archive
location, disk quota, bulk inbox operations, inbox search, SBOM and build provenance.

Stronger SSRF protection is a prerequisite for any non-localhost deployment: anyone
holding the bridge key can currently ask the relay to fetch an arbitrary HTTP(S) URL.
Scheme restrictions, size caps, timeouts, and content validation reduce this but do
not eliminate it.
