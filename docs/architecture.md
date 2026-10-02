# Architecture

Modatro uses Electron for desktop integration, React for the interface, and strict
TypeScript for the renderer and application services. Vite builds the renderer;
esbuild bundles the main process and preload; electron-builder creates installers.

## Application layers

`src/shared/model.ts` defines domain types, runtime schemas and the `ModatroApi`
contract. The renderer receives normalized data through the preload bridge. Downloads,
archives, filesystem access and repository retrieval run in the main process.

| Layer                                                  | Responsibility                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `src/pages` and `src/components`                       | Discovery, the local collection, prerequisites, settings and dialogs             |
| `electron/preload.ts`                                  | Explicit typed methods for each IPC operation                                    |
| `electron/main.ts`                                     | Windows, protocol handling, IPC validation, native dialogs and launch actions    |
| `electron/application.ts`                              | Service orchestration, snapshots, settings and imported definitions              |
| `GameDetectionService`                                 | Steam discovery, platform validation and separate game/Mods roots                |
| `ModSource`, `ThunderstoreModSource`, `LocalModSource` | Provider boundary, normalized catalogue/versions and local definitions           |
| `ModatroCatalogueRepository`                           | Production Thunderstore catalogue, cache and explicit legacy opt-in              |
| `CatalogueTrust`                                       | Independent persistent revocations/release blocks and fresh-download eligibility |
| `ArtifactHistory`                                      | Archive provenance, supplied checksums and immutable-release change detection    |
| `InstalledModsService`                                 | Local scanning, file integrity and prerequisite evidence                         |
| `GitHubPrerequisiteProvider`                           | Latest prerequisite release checks                                               |
| Installation strategies                                | Mod-root detection, standalone Lua files and explicit game-file mappings         |
| `ModInstaller`                                         | Staging, dependency checks, file plans and installation records                  |
| `TransactionEngine` and `BackupService`                | Backups, commits, rollback and startup recovery                                  |

The renderer uses a sandbox with context isolation and no Node integration. IPC
handlers validate the sender and input at runtime. External navigation and permissions
are restricted in the main process.

## Catalogue retrieval

Thunderstore supplies the production catalogue through `/c/balatro/api/v1/package-listing-index/`.
The main process fetches and decodes its gzip index and immutable CDN chunks with bounded
concurrency and response limits. Responses are validated and normalized into Modatro models.
The adapter validates package identities, active versions, dependency declarations
and canonical download URLs. Inactive versions are excluded; deprecated packages remain
available for installed-package details and updates while new installs are blocked.
A complete validated snapshot uses cache schema 2 (schema 1 is read and normalized);
outages retain cached browsing. Old index caches are read only for transition
browsing; no network request contacts the discontinued index.

The native provider is available only with `ENABLE_LEGACY_BMI_SOURCE=true` for development.
Production startup and refresh never request its index. Existing installation identities,
ownership, backups and legacy source records remain intact. Explicit JSON imports can
still use author manifests and GitHub releases. Independent revocation and blocked-release
feeds remain authoritative safety restrictions, not a discovery catalogue.

`ModSource` exposes catalogue, individual definitions and version history without raw API
schemas. Source-qualified identities preserve namespace and package name. React uses
normalized source links and dependency requirements. Adding a provider requires an adapter,
not changes to the installer or package-specific UI code.

Catalogue refresh runs at startup, manually and every 30 minutes, deduplicating concurrent
refreshes. Index, chunk, validation or schema failures preserve the last good cache.
429 and transient server failures use bounded retries and respect `Retry-After`; long
cooldowns return a failure instead of retrying early. Diagnostics include provider, online
status, timestamp and cached package count. Descriptions and icons use publisher metadata;
icons load lazily from allowed Thunderstore CDN hosts with an application fallback.

Dependency planning visits package identities and versions recursively, detects cycles,
deduplicates shared dependencies and checks semantic minimum versions. Already installed
versions use their own dependency metadata. Install/update stages the entire required set
before changing files; conflicts, unsupported layouts or additional unsatisfied archive
requirements abort the plan. A confirmation token covers packages, versions and file hashes.
One transaction commits dependencies before dependants and rolls all of them back on failure.
Automatically installed dependencies remain recorded and are never silently removed.

The Lovely strategy is a technical loader exception, not a catalogue entry. It inspects
native library format, Lovely evidence and supported loader filenames, refuses unknown
payloads and conflicting external loaders, and uses the same game-file backup/confirmation
path. External binary evidence establishes presence, not a package version. Prerequisite
versions come from catalogue metadata where available, with official release lookup only
as a fallback. Unknown external loader versions require the existing explicit acknowledgement.

Thunderstore requests use a separate transport policy limited to the Balatro API,
canonical package downloads and supported CDN paths. GitHub redirects cannot expand
into that policy. Every redirect is validated. A downloaded package's root manifest
must agree with its selected name, version and dependency list before planning.
Package UUIDs and version UUIDs identify immutable artifacts; observed SHA-256 hashes
are retained across restarts and uninstall. Runtime versions come from loader metadata,
while package versions remain separate for update and registry dependency checks.

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

Downloaded provenance records the requested and final URL, repository, source type,
tag/commit, download time and archive SHA-256. A previously observed immutable artifact
or supplied checksum cannot be silently replaced. Game-file changes require a short-lived
confirmation token tied to the actual plan and file hashes. A changed plan requires
another review. Advanced users can inspect a staged plan without committing it.

External adoption is a local baseline operation: identified folders and standalone
Lua files are hashed without being downloaded or rewritten. Unique catalogue matches
can provide future updates; otherwise local-only IDs preserve management without
invented provenance. Updates to adopted mods retain their existing directory.

State schema 1 migrates to schema 2 only after a verified backup of the original
JSON is saved. Missing provenance becomes `legacy` or `external`. Ownership, backup
paths and transaction markers remain intact; failed migration leaves the original
state recoverable and locks further file changes.

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

Standard archives containing installer executables or shell scripts are classified
as unsupported for automation. Modatro never executes downloaded installation code.
Lovely libraries require native-format and embedded identity evidence; dependency
detection scans library capabilities rather than relying on one filename.

Dependency declarations come from index flags and supported structured metadata or
Steamodded headers. An archive can add requirements before any destination changes.
Unspecified versions remain unspecified; unsupported constraints remain unknown.
An operation can explicitly acknowledge unverified installed Lovely or Steamodded
versions. The acknowledgement identifies the prerequisite, required range and
observed installed version, and applies only to that operation. Installation and
enabling recheck dependencies before committing; missing or known incompatible
versions cannot be overridden. The unknown status remains visible after proceeding.

## Extending Modatro

Repository adapters implement `ModRepository` and return validated `ModDefinition`
records. Installation strategies produce explicit file plans for the shared transaction
engine. Archive handlers must extract into staging and enforce the same path and
resource limits.

Add regression coverage for changes to ownership, backups, dependency checks or
recovery. The [contributor guide](../CONTRIBUTING.md) describes the test suites and
isolated desktop test environment.

The [catalogue source tree](../catalogue/README.md) includes JSON schemas, a compiler,
submission/removal rules and CI validation. A verifier boundary before native parsing
allows future signed envelopes; signature verification is not implemented yet.

## Linux integration

The Linux app runs natively and packages as x64 AppImage and DEB. Game operations target
Steam's Windows Balatro through Proton, including Flatpak Steam and additional library
roots. The suggested Mods directory is the selected library's compatibility prefix;
users can select an existing prefix in another library. Game launch uses Steam's fixed
app URI and the user's configured Lovely override; Modatro never edits Steam settings.

## Application updates

Mod updates and application updates have separate responsibilities. The stable
application ID and bundled app version identify desktop releases; installation
records stay in versioned application state outside the installed executable.
Application updates are currently manual and preserve that data directory. A future
updater should use signed platform releases and validated release metadata, without
changing the mod transaction engine or accepting update commands from catalogue data.
