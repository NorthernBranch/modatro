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

## Profile and report checks

`profiles.test.ts` exercises validated names and CRUD, explicit active deletion,
state backups and migration, persisted unsaved selection changes, shared-version updates,
required dependency retention, missing and unlisted mods, unmanaged preservation,
unsupported moves, external edits, stale tokens, rollback and startup commit recovery.
Game-running and operation-lock checks use deterministic isolated fixtures.
Coverage includes three profiles created before installation, automatic active-profile
saves, disabled entries in inactive profiles, older missing selections, repeated
switches without external duplicates, preserved unsaved toggles and atomic install
rollback. Scanner tests cover empty remnants, real external files, Windows directory
casing and invalid managed metadata. File-I/O failures drain outstanding work before
rollback; browser tests prevent dismissing an in-progress profile switch.

`troubleshooting.test.ts` checks verified versus unknown findings, disabled records,
opt-in logs, stale times, bounded tail/excerpt reads, malformed and binary input,
opaque picker IDs, rejected renderer paths, redaction, explicit reviewed export,
read-only locked diagnostics and bounded history separate from recovery material.
The desktop suite exercises keyboard profile creation, duplicate/rename, reviewed
switching, actual validated IPC, troubleshooting generation, editable report export
through a stubbed native dialog, and Escape/focus behavior. All paths and logs are
inside temporary fixtures. Real personal logs, games and saves are excluded.

The desktop fixture uses a unique disposable directory beneath the real home so
manual Mods overrides pass the same macOS/Linux folder restrictions as production.
It does not use Steam, save or installed-app folders; the fixture is removed after
the app closes. The test checks the profile-preview IPC reply explicitly so a path
validation failure is reported directly instead of timing out waiting for a dialog.
Active Default-profile deletion keeps the same displayed name, so the desktop test
waits for the edit to close and the active identity to change before issuing diagnostics.
A browser regression holds deletion pending while opening Troubleshooting, then
checks that its initial request starts only after the configuration operation finishes.

These changes have been exercised locally on Windows and in an Ubuntu 22.04 container.
macOS and Proton paths use upstream documentation and fixtures. Actual cross-platform loader logs,
filesystem permissions and native dialogs still need release testing on those platforms.
