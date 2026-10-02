# Thunderstore migration verification

Production discovery uses the live Balatro listing index, not Skyline or a maintained
Modatro package list. The development legacy adapter is disabled by default.
Existing ownership records, provenance, backups and uninstall behavior are retained;
no source migration changes installed files or claims ownership by display name.

`tests/catalogue.test.ts` verifies chunk retrieval, concurrent refresh deduplication,
normalized cache reload, offline browsing, invalid-response preservation, quarantine,
deprecation retention and production isolation from the legacy provider.

`tests/source-migration.test.ts` covers arbitrary new packages and categories, semantic
version history, gzip decoding, immutable chunk hashes, rate-limit backoff, recursive
and shared dependencies, multiple update roots, dependency version changes, namespaces,
cycles, unsupported layouts, confirmation plans, atomic multi-package commit and full
rollback. Local ZIPs use the same staging/plan/transaction path without remote lookup.
Lovely tests cover binary evidence, unknown external versions, supported library layouts
and safe refusal of unfamiliar payloads. Active prerequisite lookup ignores deprecated
packages with the same name without merging their identities.

`tests/thunderstore.test.ts` continues to verify immutable archive hashes, package
manifest agreement, managed update detection, runtime/package version separation and
UUID continuity. Existing archive, installer, recovery, adoption, launch, storage and
dependency suites remain in place. Browser tests cover the package/file confirmation
dialog and token, local import errors and existing discovery/management interactions.

`tests/signing.test.mjs` verifies blank Actions signing variables are removed before
electron-builder runs, the environment is restored even after failure, partial signing
credentials fail explicitly and ad-hoc/Developer ID signatures are verified correctly.
Both macOS architectures share this packaging wrapper. Native macOS packaging still
requires a macOS runner; Windows tests cannot execute `codesign` or notarization.

An unrecognized Balatro package layout or installer declaration remains manual-only.
External loader presence never invents a Thunderstore package version. An arbitrary
source name or matching folder cannot satisfy another namespace's dependency. Unknown
external Lovely/Steamodded versions use the existing explicit consent flow; missing or
outdated packages require a resolved plan. Dependencies are not silently removed when
a dependant is uninstalled. Nexus is intentionally outside this migration.
