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

- Keep the service bound to loopback.
- Preserve the separation between the public bridge key and the real SAB key.
- Run the egress guard before any indexer request.
- Bound network response sizes and durations.
- Do not write NZB contents or source URLs containing tokens to logs.
- Keep ordinary SAB API modes compatible so Prowlarr's Test button and monitoring
  continue to work.

Before opening a pull request, include the platform, macOS version, Prowlarr version,
SABnzbd version, expected behavior, and sanitized relay activity entry.

## Releases

The public release workflow is tag-driven. Keep the version in `package.json` and
`package-lock.json` aligned, commit the release, and push an annotated tag such as
`v0.2.1`. GitHub Actions runs the test and audit suites, builds on an Apple Silicon
macOS runner, applies and verifies an ad-hoc signature, produces checksums, and
attaches the DMG and ZIP to the GitHub release.

The ad-hoc signature is the deliberately free distribution route. It prevents users
from having to run `codesign` locally, but it is not a Developer ID signature and
does not bypass Gatekeeper's one-time **Open Anyway** confirmation.
