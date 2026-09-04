# Changelog

## Unreleased

- Rebuild the interface as a macOS utility. A sidebar replaces the single
  scrolling page, so settings no longer compete for space with the saved-NZB
  inbox, and the window starts at 900x620 instead of 980x760.
- Make the observed public IP the primary element of the Status view and record
  the previous reading beside it, so comparing before and after a VPN change no
  longer depends on remembering the earlier value. The previous reading is held
  in memory only, matching the activity log.
- Follow the system light or dark appearance instead of forcing a dark theme.
- Show the byte count in the activity list, which was recorded for every grab
  but never displayed.
- Replace the application icon. The previous mark combined a document, a
  download arrow and a pair of nodes in thin outlines, which merged into an
  unreadable shape at Dock sizes; the new one draws two routes converging into
  one and is built on the macOS icon grid.
- Treat a non-API response from SABnzbd as a failed submission. SABnzbd serves its web
  interface with HTTP 200 when the URL or URL base is wrong, and that was recorded as a
  successful upload with an empty job ID, so a grab that never reached SABnzbd looked
  like it had succeeded. The saved NZB is now marked as failed and kept for retry, and
  the error names the likely cause.

## 0.2.2

- Name the release artifacts as GitHub publishes them before generating
  `SHA256SUMS.txt`, so `shasum -c SHA256SUMS.txt` verifies a downloaded DMG or ZIP
  directly. Previously the checksum file listed names containing spaces while the
  published assets had dots, so verification failed despite correct hashes.
- Derive the reported version and outgoing User-Agent strings from `package.json`
  instead of hardcoding them, so a release bump can no longer leave stale values in
  the health endpoint or indexer requests.
- Correct the fetcher User-Agent project URL to `github.com/ilariima/nzb-relay`.
- Upgrade the GitHub Actions checkout, setup-node, and upload-artifact steps to v7,
  clearing the deprecated Node 20 runtime warnings.
- Scope the test script to `test/**/*.test.mjs` so the shared helper module is no
  longer collected and counted as an empty passing test file.

## 0.2.1

- Remove the fixed expected-IP setting and mismatch enforcement so a dynamic home
  address cannot become stale and block grabs.
- Add a compact public-IP bar at the top of the window. Every button press performs
  a fresh public-IP lookup and shows the lookup time.
- Perform a fresh public-IP lookup before every NZB fetch and record that actual
  address with the saved file and audit entry.
- Add free ad-hoc signing to macOS builds so downloaded releases no longer require
  users to run `codesign` themselves.
- Make version tags publish verified DMG/ZIP artifacts and SHA-256 checksums through
  GitHub Actions automatically.

## 0.2.0

- Save every fetched NZB locally before submitting it to SABnzbd.
- Add a persistent Saved NZBs inbox with byte count, indexer host, SHA-256 proof,
  submission history, manual Push to SAB, Delete, and Open folder actions.
- Add configurable retention in hours or days, with a Forever option.
- Replace scroll-dependent notices with floating viewport notifications.
- Make SAB connection testing reject false HTTP-200 responses and show clear errors.
- Normalize local SAB addresses such as `127.0.0.1:8080` to HTTP automatically.

## 0.1.1

- Fixed SABnzbd `addfile` uploads failing with `TypeError: cannot use 'list' as a
  dict key`. Upload parameters are now sent once in the multipart form instead of
  being duplicated between the query string and form body.
- Added regression assertions that reject duplicate `mode`, category, and priority
  parameters.
- Show SAB connection-test progress and results directly beside the Test button.

## 0.1.0

- Initial macOS relay, egress guard, local configuration UI, secure secret storage,
  SAB API pass-through, and `addurl` to `addfile` conversion.

---

Releases before 0.2.2 predate this repository and are not published here.
