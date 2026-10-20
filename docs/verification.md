# Release verification

This guide maps the current application to its automated checks. It describes
coverage rather than certifying third-party mods or claiming that every platform
has passed manual real-game testing.

## Scope and evidence

Unit and service tests use temporary, non-runnable Balatro fixtures. Browser tests
use the read-only preview or a mocked desktop bridge. Electron smoke tests set
`MODATRO_TEST_DATA`, isolate application data and the single-instance lock, and
avoid discovering or modifying a real game.

Windows has received the most complete manual testing. macOS, Linux and Steam Deck
feedback remains valuable. CI packages Windows x64, Apple Silicon and Intel macOS,
and Linux x64, and checks packaged startup on each target. A configured workflow or
successful installer build alone does not establish real-game compatibility.

## Automated coverage

| Area                         | Behavior checked                                                                                                                                                  | Principal suites                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Game discovery               | Steam libraries, platform validation, separate game/Mods roots and Balatro archive version detection                                                              | `detection.test.ts`, `application.test.ts`, `launch.test.ts`                           |
| Discovery sources            | Live Thunderstore, validated caches, optional GitHub indexes, deduplication and unsupported manager filtering                                                     | `catalogue.test.ts`, `mod-index.test.ts`, `thunderstore.test.ts`                       |
| Dependencies                 | Package/runtime version separation, Steamodded beta/date formats, Balatro letter versions, recursive shared dependencies and explicit consent for unknown loaders | `dependencies.test.ts`, `source-migration.test.ts`, `unverified-prerequisites.test.ts` |
| Archive layouts              | Nested roots, wrapper error patches, patch-only mods, malformed metadata, ambiguous archives and safe managed repair                                              | `archive.test.ts`, `wrapped-mods.test.ts`, `installer.test.ts`                         |
| File management              | Ownership, original backups, changed files, updates, disable/enable, uninstall and external adoption                                                              | `installer.test.ts`, `external-mods.test.ts`, `local-mods.test.ts`                     |
| Recovery                     | Atomic batches, rollback, journal/state validation, protected edits and commit-marker recovery                                                                    | `recovery.test.ts`, `storage.test.ts`, `source-migration.test.ts`                      |
| Lovely                       | Library evidence, supported platform assets, version verification, conflicting injectors and protected game-file plans                                            | `lovely.test.ts`, `local-mods.test.ts`, `launch.test.ts`                               |
| Downloads and trust          | HTTPS/redirect boundaries, checksums, immutable releases, independent restrictions and author-manifest validation                                                 | `download.test.ts`, `trust.test.ts`, `thunderstore.test.ts`                            |
| GitHub limits and popularity | Shared cooldowns, fresh API metadata reuse, uncached raw policies, star counts and persisted request budgets                                                      | `github-requests.test.ts`, `github-stars.test.ts`                                      |
| App updates                  | Quiet release notices, validated platform assets, cached metadata and explicit download actions                                                                   | `app-updates.test.ts`, `ui-requests.spec.ts`                                           |
| Creator                      | Stable IDs/collisions, escaped recipes, deterministic ZIPs, PNG/alpha limits, draft/build separation, source history, restoration and failed replacements         | `creator.test.ts`, `application.test.ts`, `desktop.spec.ts`                            |
| Releases                     | Baseline version assignment, unique beta tags, all-platform assets, checksums, draft retries and signing reports                                                  | `build-version.test.mjs`, `release.test.mjs`, `signing.test.mjs`                       |
| Interface and isolation      | Search, categories, details, themes, dependency confirmations, error handling, focus and isolated Electron startup                                                | `ui.spec.ts`, `ui-requests.spec.ts`, `desktop.spec.ts`                                 |

Test counts change with the implementation. Use the output of the current run and
its CI logs as evidence; older totals are not a record of the current checkout.
Some filesystem-specific tests may skip when the host cannot represent the required
case-sensitive or symbolic-link scenario.

## Reproduce checks

Use Node.js 24 or newer and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec install-electron
pnpm exec playwright install chromium
pnpm test:ui
pnpm exec playwright test --config playwright.website.config.mjs
node scripts/screenshots.mjs
```

`pnpm check` covers formatting, catalogue generation, types, unit/service tests and
production builds. On headless Linux, install Playwright's runtime dependencies and
run browser/Electron tests under Xvfb, as the release workflow does.

After packaging, set `MODATRO_PACKAGED_EXECUTABLE` to the unpacked app's executable
and run `pnpm exec playwright test tests/desktop.spec.ts`. The smoke test still uses
isolated data. See [Contributing](../CONTRIBUTING.md) for packaging commands and
[screenshot regeneration](../CONTRIBUTING.md#documentation-screenshots).

## Release gates

Packaging and publication are conditional on `scripts/release-scope.mjs`: docs,
website, test-only and fixture-only changes run checks without producing installers.
`release-scope.test.mjs` verifies mixed changes, deleted/renamed inputs, PR merge-base
diffs, initial pushes and explicit tag/manual packaging. Website browser checks run
in the shared job independently of desktop packaging.

When packaging is required, the shared validation job compiles the application once
after checks. Four platform jobs restore that exact build and version, package
installers, and test startup.
Publication waits for all five installer files and the two matching macOS signing
reports. The release script validates hashes before making GitHub changes, uploads
to a draft, and publishes only after success. Retrying an existing completed release
does not replace its downloads.

macOS packaging verifies bundle signatures. Developer ID mode additionally requires
notarization, a stapled ticket and Gatekeeper acceptance. Only the specific busy-volume
DMG ejection failure gets bounded retries; unrelated failures stop the build.
Credential-dependent tests verify control flow, not successful notarization with a
real Apple account. Windows publisher signing is not configured.

## Manual acceptance and limits

For each platform release, check a downloaded installer on a clean machine, connect a
real Steam game, and exercise supported Lovely and mod installation, launch, update,
uninstall and recovery with backed-up data. Record the release tag, operating system,
architecture, game/loader versions and actual result.

- Balatro's `version.jkr` is read from supported game archives without executing the
  game. Missing, invalid or ambiguous version data remains unknown.
- Supported Steamodded beta/date formats are compared. Unsupported constraints,
  dependency alternatives and unfamiliar archive formats still need manual handling.
- Lovely installation supports Windows, macOS and Linux with Proton. Native Linux
  LÖVE launching and ARM Linux are outside this integration.
- Mods update individually. App update checks provide a notice and link; downloading
  and running the installer require user action.
- Mods that replace game files cannot be disabled. Their uninstall restores verified
  original backups, subject to conflict review.
- macOS ad-hoc builds are not notarized; Windows beta installers are unsigned.
  Checksums do not replace publisher signatures.

See [catalogue hardening coverage](catalogue-verification.md),
[the Thunderstore migration](thunderstore-migration.md), and
[release signing](signing.md) for the relevant boundaries.

## Profiles, reports and creator acceptance

Profile tests cover migration backups, active/inactive install selections, required
loader retention, repeated switching without duplicates, external edits, stale
tokens and rollback. Diagnostic tests cover read-only checks, bounded opt-in log
excerpts, honest unknown states, redaction and reviewed export. Actual desktop IPC
is tested with disposable fixtures beneath the real home so production path rules
still apply. Real personal logs, games and saves remain excluded.

Creator tests cover the three guided builders and separate Custom Lua workspace
against Steamodded 26.1002.0 documentation and tagged source. A test-only Lua VM
checks ordered effects, context guards, setup and redemption contracts. Tests also
verify migration backups, all fifteen artwork choices, JSON/Lua escaping, atlas
sizes, alpha, deterministic hashes, private-file exclusion and optimistic save
conflicts. The real installer stages two revisions, restores an older build and
rolls back an injected replacement failure while preserving drafts and both ZIPs.
Uninstall and project archiving have separate fixture coverage. Custom Lua with
runtime actions is parsed without executing it.

Electron coverage includes first-use acknowledgement, persisted preferences, the
save reminder, project creation, unsaved navigation/window protection, custom-source
preservation before regeneration and building without installation. Native dialogs
use controlled responses. Screenshot capture checks all seven main pages at 1440,
1024, 768 and 375 pixels; the website checks all four screenshot modals.

**No in-game creator tests have run as part of this feature.** Static validation
does not prove game behaviour, code safety or compatibility with other mods.
Before release, test each recipe with backed-up saves and the declared loader
versions, recording exact versions and actual outcomes. See [Mod Creator](mod-creator.md)
for builder semantics, resource limits, custom-code restrictions and restoration.

Profile sharing tests cover corruption, constrained source references, unique names,
native-picker cancellation, dependency-first downloads, confirmation and restoration
after cancellation or invalid archives. Announcement tests cover every dismissal route,
durable settings, version changes, onboarding and navigation without feature enablement.

Version tests cover semantic ordering, PR title prefixes, merged PR lookup,
published-history gaps, draft exclusion and retries. A child-process regression
uses a temporary checkout without node_modules to match the dependency-free
publishing job. Publication verifies the assigned version and every platform asset
before modifying GitHub Releases.
