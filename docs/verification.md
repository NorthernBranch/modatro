# Release verification

This document describes how Modatro's initial specification is covered by the
implementation and automated checks. It distinguishes tested application behavior
from platform and real-game validation that still requires release testing.

## Scope and evidence

The verification suites use temporary, non-runnable Balatro fixtures. Browser tests
use either the read-only preview or an explicitly mocked desktop bridge. Electron
smoke tests use isolated application data and do not discover or modify a real game.

The initial specification contains 57 sections. The table below maps each section
to its implementation and principal verification suite. A test covering a file
operation establishes the behavior of that operation under the tested conditions;
it does not certify third-party mods or replace testing on an installed game.

| Section | Requirement                      | Implementation and verification                                                                                                                                                                                                |
| ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | Technology and process isolation | Electron, React, strict TypeScript, Vite, pnpm and electron-builder; validated preload IPC. `desktop.spec.ts` checks the production renderer's isolation and bridge.                                                           |
| 2       | Core product goals               | Discover, Installed, Updates, Prerequisites, Settings, setup and launch; backend and browser suites cover the supported workflows.                                                                                             |
| 3       | Machine-readable catalogue       | `ModRepository` and commit-pinned Balatro Mod Index adapter; `catalogue.test.ts`.                                                                                                                                              |
| 4       | Normalized and validated model   | Zod schemas, category normalization and unavailable entries for malformed metadata; `catalogue.test.ts`.                                                                                                                       |
| 5       | Catalogue caching                | Immediate saved catalogue, background refresh, atomic cache writes and preservation on incomplete or failed fetches; `catalogue.test.ts`.                                                                                      |
| 6       | Browsing                         | Search, category, author and installation filters, grid/list views and mod details; `ui.spec.ts`.                                                                                                                              |
| 7       | Modern interface                 | Responsive layouts, themes, loading skeletons, progress, notifications, empty states and confirmations; `ui.spec.ts` and `ui-requests.spec.ts`.                                                                                |
| 8       | First run                        | Automatic discovery before manual selection, multiple-candidate selection and recovery after discovery errors; `application.test.ts` and `ui-requests.spec.ts`.                                                                |
| 9       | Steam discovery                  | Steam registry/common roots, modern and legacy library metadata, custom libraries and manual selection; `detection.test.ts`.                                                                                                   |
| 10      | Game validation                  | Positive platform-specific executable and supporting-file evidence, canonical paths and access checks; `detection.test.ts`.                                                                                                    |
| 11      | Separate Mods folder             | Platform defaults, validated dedicated override, automatic creation and folder actions; `detection.test.ts` and `ui-requests.spec.ts`.                                                                                         |
| 12      | Path security                    | Canonical roots, component checks, traversal and symlink rejection, reserved names and filesystem case handling; `detection.test.ts`, `archive.test.ts` and `storage.test.ts`.                                                 |
| 13      | Installation strategies          | Standard folders, supported standalone Lua files, isolated Lovely patches and explicit game-file mappings; `installer.test.ts` and `archive.test.ts`. Unsupported formats fail with instructions.                              |
| 14      | Staging and mod roots            | All archives extracted into bounded staging; wrapper handling and rejection of ambiguous roots; `archive.test.ts`.                                                                                                             |
| 15      | Installation plans               | Enumerated creation, replacement, removal, dependencies and ownership conflicts before destination writes; `installer.test.ts`.                                                                                                |
| 16      | Transactions                     | Verified backups, durable journals, atomic replacement, saved manifests and rollback; `installer.test.ts` and `recovery.test.ts`.                                                                                              |
| 17      | File manifests                   | Per-file operation, destination, SHA-256, original backup, source, version, dependencies and timestamps; `installer.test.ts`.                                                                                                  |
| 18      | Original-file backups            | Immutable before-images created and verified before replacements; baseline originals survive updates, including filename case changes; `installer.test.ts`.                                                                    |
| 19      | Changed replacements             | Hash checks and explicit Keep/Restore decisions, with Keep selected initially; `installer.test.ts`.                                                                                                                            |
| 20      | Cross-mod ownership              | A second owner is blocked and identified; case-insensitive ownership checks and conflicting-manifest validation; `installer.test.ts` and `recovery.test.ts`.                                                                   |
| 21      | Retained backups                 | Backups stored in application data and retained after uninstall; `installer.test.ts`.                                                                                                                                          |
| 22      | External mods                    | Unmanaged scanning and explicit adoption only for one confidently matched directory; `local-mods.test.ts` and `installer.test.ts`.                                                                                             |
| 23      | Generic prerequisites            | Lovely, Steamodded, Talisman, other declared mod IDs and Balatro requirements; `dependencies.test.ts`. Unverifiable game versions remain unknown.                                                                              |
| 24      | No invented versions             | Unspecified ranges remain unspecified; unsupported or unknown constrained versions block eligibility; `dependencies.test.ts`.                                                                                                  |
| 25      | Structured metadata              | Index flags, manifests, JSON entry points and legacy Steamodded headers are combined; archive requirements are rechecked. `dependencies.test.ts` and `installer.test.ts`.                                                      |
| 26      | Prerequisite screen              | Installed/latest versions, missing/update/ready/undetermined states and visible failed latest-version checks; `ui-requests.spec.ts`.                                                                                           |
| 27      | Individual requirements          | Explicit ranges, actual installed versions and reasons; recorded archive requirements remain visible for the installed version. `dependencies.test.ts` and `ui-requests.spec.ts`.                                              |
| 28      | One-click installation           | Eligible standard mods install directly, with progress and no unnecessary confirmation; `ui-requests.spec.ts` and `installer.test.ts`.                                                                                         |
| 29      | Missing prerequisites            | Supported direct install/adopt actions, visible dependency chains and no silent cascade; archive-discovered requirements expose the same actions. `ui-requests.spec.ts`.                                                       |
| 30      | Lovely detection                 | Native-library evidence required; a changed managed binary cannot inherit its recorded version; `local-mods.test.ts`.                                                                                                          |
| 31      | Steamodded detection             | Structured identity and literal version evidence independent of folder name; duplicate installations do not establish a single version. `local-mods.test.ts`.                                                                  |
| 32      | Latest prerequisites             | Dynamic upstream release checks; failure preserves installed status and last known release, with an explicit error; `ui-requests.spec.ts`.                                                                                     |
| 33      | Prerequisite updates             | Direct update for a managed, supported catalogue release that meets the declared range; eligibility is reevaluated after success. `ui-requests.spec.ts`.                                                                       |
| 34      | Local state                      | Records plus actual file hashes distinguish installed, disabled, updated, broken and unmanaged mods; `local-mods.test.ts` and `installer.test.ts`.                                                                             |
| 35      | Update discovery                 | Semantic comparison, installed/latest display and an Updates page; actual staged versions take precedence over stale catalogue versions. `dependencies.test.ts`, `installer.test.ts` and `ui-requests.spec.ts`.                |
| 36      | Safe updates                     | Stage and validate before a transactional update; previous state and baseline backups preserved; `installer.test.ts`.                                                                                                          |
| 37      | Safe uninstall                   | Only recorded files removed, originals verified/restored, changes require choices, resulting state verified and retained files/cleanup failures reported; `installer.test.ts`.                                                 |
| 38      | Disable/enable                   | Created mod files move to application storage and return after dependency/ownership checks; persisted state and protected game replacements; `installer.test.ts`.                                                              |
| 39      | Local data                       | Validated atomic application state outside the game; corruption locks file changes; `storage.test.ts` and `recovery.test.ts`.                                                                                                  |
| 40      | Downloads                        | HTTPS allowlist, validated redirects/status, bounded temporary downloads, progress, cancellation and cleanup; `download.test.ts`.                                                                                              |
| 41      | Archive safety                   | Traversal, absolute paths, symlinks, case collisions, CRC corruption and extraction limits rejected; `archive.test.ts`.                                                                                                        |
| 42      | Integrity                        | SHA-256 used for installed files, originals, change checks and recovery; `installer.test.ts` and `recovery.test.ts`.                                                                                                           |
| 43      | Security                         | Downloaded installers/scripts are not executed; no elevation or OS-security bypass; validated IPC, roots and external links. `desktop.spec.ts`, `archive.test.ts` and `launch.test.ts`.                                        |
| 44      | Windows behavior                 | Separate Lovely/game and Mods roots, Steam launch and native folder actions; fixtures and Windows CI configured. Native Windows 10/11 real-game validation remains required.                                                   |
| 45      | macOS behavior                   | Apple Silicon/Intel packaging, architecture-specific Lovely instructions and native modded launch with early-exit handling; `launch.test.ts` and Apple Silicon packaged smoke. Intel and real-game validation remain required. |
| 46      | Game-running checks              | Process checks before operations and commit; launch shares the operation lock; retryable errors offer Check again. `application.test.ts` and `ui-requests.spec.ts`.                                                            |
| 47      | Errors                           | Plain-language errors, optional technical details, retry paths and restored controls for failed requests; `ui-requests.spec.ts`.                                                                                               |
| 48      | Logging                          | Local rotating logs cover discovery/validation, catalogue, downloads, plans, transactions, rollback and errors; diagnostic copy and folder actions tested in `ui-requests.spec.ts`.                                            |
| 49      | Accessibility                    | Semantic controls, labels, keyboard navigation, visible focus, native modal focus handling, status text and reduced-motion support; `ui.spec.ts`. Formal WCAG conformance has not been certified.                              |
| 50      | Settings                         | Game/Mods roots, theme, refresh/cache, backups, diagnostics, imports and About; `ui.spec.ts` and `ui-requests.spec.ts`.                                                                                                        |
| 51      | About                            | App/Electron versions, platform/architecture, game/framework status, upstream links and independent-project notice; renderer implementation.                                                                                   |
| 52      | Application distribution         | Bundled runtime, Windows NSIS and macOS DMGs, native CI packaging and packaged startup checks. App updates are manual; signing/notarization and publication require release credentials.                                       |
| 53      | Automated testing                | Temporary fixtures cover paths, dependencies, roots, plans, ownership, manifests and recovery; isolated browser and Electron suites.                                                                                           |
| 54      | Critical acceptance cases        | All 16 fixture-based scenarios are covered by the suites listed below.                                                                                                                                                         |
| 55      | Development milestones           | Foundation, detection, catalogue, local scanning, installation, dependencies, backups, updates, macOS integration and release tooling are present.                                                                             |
| 56      | Safety principles                | Unknown inputs fail closed, originals are retained, destructive actions check hashes and paths, dependency requirements are evidence-based; security and recovery regression suites.                                           |
| 57      | Initial release workflows        | Installer/runtime artifacts plus automated coverage of the 16 core workflows; full native real-game acceptance remains a release verification step.                                                                            |

## Critical acceptance coverage

| Scenario                                                                 | Principal suite                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Valid Balatro fixture accepted; unrelated folders rejected               | `detection.test.ts`                                                 |
| Standard mod installs into Mods; uninstall leaves unrelated files        | `installer.test.ts`                                                 |
| Existing game file backed up; uninstall restores its original            | `installer.test.ts`                                                 |
| Modified replacement requires a decision; cross-mod ownership is blocked | `installer.test.ts`                                                 |
| Missing/outdated Steamodded, unspecified version and missing Lovely      | `dependencies.test.ts`, `local-mods.test.ts`, `ui-requests.spec.ts` |
| Interrupted install restores previous files and state                    | `recovery.test.ts`, `installer.test.ts`                             |
| Broken download/archive never reaches Mods                               | `download.test.ts`, `archive.test.ts`, `installer.test.ts`          |
| Malicious archive cannot escape staging                                  | `archive.test.ts`                                                   |
| Catalogue unavailable preserves previously cached mods                   | `catalogue.test.ts`                                                 |

## Platform and compatibility limits

Local verification runs on Apple Silicon macOS. Windows and Intel macOS installers
can be built here, but producing an artifact does not verify its native installation
or a real Steam/Lovely game launch. CI runs the checks and packaged startup smoke on
all three build targets; a configured workflow is not evidence that a remote run passed.

Balatro version requirements currently remain unknown rather than using the LÖVE
bundle version as the game's version. Supported semantic ranges are evaluated;
Steamodded revision/beta syntax that cannot be represented safely, dependency
alternatives and unsupported archive formats block automatic installation with an
explanation. See the upstream [Steamodded metadata specification](https://docs.smods.dev/API%20Documentation/Mod-Metadata/)
for its full version and dependency language.

Lovely installation on macOS is manual. Modatro launches the validated native game
with Lovely's library using the environment and working-directory approach in the
[official launcher](https://github.com/ethangreen-dev/lovely-injector/blob/master/crates/lovely-unix/run_lovely_macos.sh),
without executing a downloaded script. A startup grace period catches immediate
loader failures; it cannot detect every later game or mod crash.

Individual mod updates are supported. Bulk updates, portable Windows distributions,
Linux installers and automatic application updates are outside the initial release.
Preview installers are unsigned, and macOS builds are not notarized.

## Verified preview build

For Modatro **0.1.2**, local verification on Apple Silicon macOS completed with:

- Formatting, strict TypeScript checks and production builds passing.
- 124 backend tests passing; one filesystem-specific case-sensitivity test skipped
  because the local filesystem is case-insensitive.
- 31 browser/desktop tests passing, including discovery failures, prerequisite
  actions, dependency chains, duplicate-click protection and uninstall reports.
- A separate packaged Apple Silicon startup/isolation smoke test passing.
- Apple Silicon and Intel macOS DMGs and a Windows x64 NSIS installer built.

These results do not establish native Windows/Intel game compatibility or signing
and notarization. The preview artifacts are unsigned.

## Reproducing verification

Run the commands in the [contributor guide](../CONTRIBUTING.md):

```sh
pnpm check
pnpm test:ui
```

After packaging, set `MODATRO_PACKAGED_EXECUTABLE` to the unpacked application's
executable and run `pnpm exec playwright test tests/desktop.spec.ts`. This checks the
packaged runtime with temporary application data, while preserving any running
installed copy and its settings.
