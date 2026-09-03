# Contributing

Contributions are welcome. Keep the core promise testable: `addurl` must be fetched by
the relay process and SABnzbd must receive bytes through `addfile`.

## Local checks

```bash
npm ci
npm test
npm run electron
```

Please add a protocol-level test for changes to request handling. Tests must not call
real indexers, public-IP services, or SAB instances. Use local mock HTTP servers and
never commit account credentials or captured download URLs.

## Design constraints

[CLAUDE.md](CLAUDE.md) lists the behavioral invariants this project depends on, with the
reasoning behind each. Read it before changing request handling, storage, or anything
touching keys or egress. It is the single source for those rules — this file
deliberately does not restate them, so the two cannot drift apart.

[ARCHITECTURE.md](ARCHITECTURE.md) explains why the design is shaped the way it is,
including the decisions most likely to be undone by an otherwise reasonable refactor.

Before opening a pull request, include the platform, macOS version, Prowlarr version,
SABnzbd version, expected behavior, and sanitized relay activity entry.

## Releases

The public release workflow is tag-driven. Bump `version` in `package.json` — the only
place it is defined — and run `npm install` so `package-lock.json` follows. Move the
changelog's `Unreleased` section under the new heading, merge, then push an annotated
tag of the form `vX.Y.Z`.

GitHub Actions runs the test and audit suites, builds on an Apple Silicon macOS runner,
applies and verifies an ad-hoc signature, produces checksums, and attaches the DMG and
ZIP to the GitHub release.

The ad-hoc signature is the deliberately free distribution route. It prevents users
from having to run `codesign` locally, but it is not a Developer ID signature and
does not bypass Gatekeeper's one-time **Open Anyway** confirmation.
