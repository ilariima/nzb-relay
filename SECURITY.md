# Security policy

## Intended deployment

NZB Relay is a single-user localhost application. It is not designed to be exposed
through a reverse proxy, port-forwarded, or bound to a LAN address. The listen host
is deliberately fixed to `127.0.0.1`.

The relay is a routing control, not an anonymity guarantee. Its displayed address is
the egress IP observed by the configured public-IP service from the Electron/Node
process. A VPN implementation, DNS policy, IPv4/IPv6 policy, system proxy, or future
OS networking change can still affect traffic. Test the complete setup with your own
accounts and logs.

## Secret handling

- A random bridge key authenticates Prowlarr to the local endpoint.
- The real SABnzbd key is substituted only on relay-to-SAB requests.
- The SAB key is stored in the configuration file, mode `0600` in a mode `0700`
  directory. It is not encrypted at rest.
- The settings API reports only whether a SAB key exists, never its value.
- Audit errors remove common key/token query parameters.
- Saved NZBs and sidecar metadata use owner-only permissions. Source download URLs
  and indexer API keys are never stored. Original SAB options, including an optional
  unpack password, are retained in the protected sidecar so manual retries behave
  the same as the first submission.

Earlier builds encrypted the key through Electron's `safeStorage`, backed by the
macOS Keychain. That was removed. Because the application is ad-hoc signed, its
code identity is a hash of the bundle and changes with every release, so macOS
treated each update as a different program requesting the existing Keychain item
and challenged the user for a password on launch.

The protection it bought was thin: SABnzbd keeps the same API key in plaintext in
its own configuration file on the same machine, so encrypting this copy guarded a
secret already readable a few directories away. Anything running as the user can
read the key from either file. Desktop and headless mode now behave identically.

Restoring encryption at rest without the repeated password prompt needs a
Developer ID certificate, which gives the application a stable code identity
across releases.

## Network behavior

The application makes outbound requests only for:

1. the configured public-IP check URL;
2. an `http` or `https` NZB URL received on an authenticated `addurl` request; and
3. the configured SABnzbd URL.

The bridge key should still be treated as a secret. Any local process that possesses
it can ask the relay to retrieve an HTTP(S) URL. Response size, timeout, content
validation, and scheme restrictions reduce risk but do not turn this into a safe
multi-user or remotely exposed service.

Separately, the read-only administrative routes — health, settings, activity, and the
saved-NZB listing — are served over localhost without requiring the UI header, which
only guards mutating requests. A browser on another site cannot read them because of
same-origin rules, but another process running as the same user on the same machine
can. None of them return the real SABnzbd key. Both this and the fetch behavior above
are acceptable for a single-user localhost tool and would need to be addressed before
any LAN, container, or reverse-proxied deployment.

## Reporting a vulnerability

Do not include live indexer URLs, indexer API keys, SAB API keys, or public IP
addresses in a public issue. Open a private security advisory in the project's GitHub
repository once a canonical community repository has been established.

## macOS release identity

Community release artifacts are ad-hoc signed on GitHub's macOS runner so their code
signatures can be validated and Apple Silicon can execute them. They are not signed
with a paid Apple Developer ID and are not notarized. An ad-hoc signature verifies
bundle integrity; it does not prove the publisher's Apple identity. Verify release
checksums and source provenance before overriding Gatekeeper.
