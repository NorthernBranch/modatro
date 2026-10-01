# Architecture

Modatro uses Electron for desktop integration, React for the interface, and strict
TypeScript for the renderer and application services. Vite builds the renderer;
esbuild bundles the main process and preload; electron-builder creates installers.

## Application layers

`src/shared/model.ts` defines domain types, runtime schemas and the `ModatroApi`
contract. The renderer receives normalized data through the preload bridge. Downloads,
archives, filesystem access and repository retrieval run in the main process.

| Layer                                   | Responsibility                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `src/pages` and `src/components`        | Discovery, the local collection, prerequisites, settings and dialogs          |
| `electron/preload.ts`                   | Explicit typed methods for each IPC operation                                 |
| `electron/main.ts`                      | Windows, protocol handling, IPC validation, native dialogs and launch actions |
| `electron/application.ts`               | Service orchestration, snapshots, settings and imported definitions           |
| `GameDetectionService`                  | Steam discovery, platform validation and separate game/Mods roots             |
| `BalatroModIndexRepository`             | Commit-pinned index retrieval, normalization and caching                      |
| `InstalledModsService`                  | Local scanning, file integrity and prerequisite evidence                      |
| `GitHubPrerequisiteProvider`            | Latest prerequisite release checks                                            |
| Installation strategies                 | Mod-root detection, standalone Lua files and explicit game-file mappings      |
| `ModInstaller`                          | Staging, dependency checks, file plans and installation records               |
| `TransactionEngine` and `BackupService` | Backups, commits, rollback and startup recovery                               |

The renderer uses a sandbox with context isolation and no Node integration. IPC
handlers validate the sender and input at runtime. External navigation and permissions
are restricted in the main process.

## Catalogue retrieval

The repository adapter reads the Balatro Mod Index's commit, Git tree and raw metadata.
All entries in a refresh come from the selected commit. Descriptions are displayed as
text. GitHub HTML is not scraped.

A transport failure or incomplete tree preserves the previous catalogue. A malformed
individual entry appears as unavailable. Validated catalogues are saved in
`catalogue-cache/`, separate from Electron's browser cache. Legacy catalogues in
`cache/` are read and copied to the new location without deleting browser data.

## File operations

Game launch, settings changes and the installer share an operation lock. The installer
holds it while it prepares and commits a change:

1. Revalidate approved roots and confirm that Balatro is closed.
2. Download and extract into application staging, inspect metadata, select the
   installation strategy, and enumerate affected files.
3. Check dependencies, file ownership and existing hashes; capture verified backups.
4. Persist a prepared transaction journal before changing game or mod files.
5. Apply each change using a sibling temporary file and atomic rename, then verify its hash.
6. Atomically save the installation record and transaction ID in application state.
7. Mark the journal committed. A pending commit-marker write is recovered before
   another operation can supersede its state marker.

The transaction ID in saved state is the commit marker if the process stops between
the final two steps. A failure before that marker restores verified before-images
and removes files created by the transaction. A subsequent external edit blocks
rollback rather than being overwritten.

Startup recovery validates prepared journals against saved settings and previous
state before applying them. Corrupt state, mismatched roots, changed files or invalid
backups lock file operations and preserve the recovery data.

## Paths and external input

Destinations are relative to canonical approved roots. The path validator checks
every existing component, rejects symbolic links and special files, and verifies
that each resolved component remains under its validated parent. Filesystem case
aliases are resolved to their actual spelling without folding distinct paths on
case-sensitive filesystems.

Relative paths reject traversal, absolute and drive paths, reserved Windows names
and alternate data streams. ZIP extraction also checks duplicate paths, case collisions,
CRC integrity, file counts, sizes and expansion ratios. Download redirects are checked
against the HTTPS GitHub host allowlist.

Dependency declarations come from index flags and supported structured metadata or
Steamodded headers. An archive can add requirements before any destination changes.
Unspecified versions remain unspecified; unsupported constraints remain unknown.

## Extending Modatro

Repository adapters implement `ModRepository` and return validated `ModDefinition`
records. Installation strategies produce explicit file plans for the shared transaction
engine. Archive handlers must extract into staging and enforce the same path and
resource limits.

Add regression coverage for changes to ownership, backups, dependency checks or
recovery. The [contributor guide](../CONTRIBUTING.md) describes the test suites and
isolated desktop test environment.

## Application updates

Mod updates and application updates have separate responsibilities. The stable
application ID and bundled app version identify desktop releases; installation
records stay in versioned application state outside the installed executable.
Application updates are currently manual and preserve that data directory. A future
updater should use signed platform releases and validated release metadata, without
changing the mod transaction engine or accepting update commands from catalogue data.
