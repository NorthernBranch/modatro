# Architecture

Modatro uses Electron for desktop integration, React for the interface, and strict
TypeScript for the renderer and application services. Vite builds the renderer;
esbuild bundles the main process and preload; electron-builder creates installers.

## Application layers

`src/shared/model.ts` defines domain types, runtime schemas and the `ModatroApi`
contract. The renderer receives normalized data through the preload bridge. Downloads,
archives, filesystem access and repository retrieval run in the main process.

| Layer                                                  | Responsibility                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/pages` and `src/components`                       | Discovery, local collection, creator, prerequisites, settings and dialogs              |
| `electron/preload.ts`                                  | Explicit typed methods for each IPC operation                                          |
| `electron/main.ts`                                     | Windows, protocol handling, IPC validation, native dialogs and launch actions          |
| `electron/application.ts`                              | Service orchestration, snapshots, settings and imported definitions                    |
| `GameDetectionService`                                 | Steam discovery, platform validation and separate game/Mods roots                      |
| `ModSource`, `ThunderstoreModSource`, `LocalModSource` | Provider boundary, normalized catalogue/versions and local definitions                 |
| `ModatroCatalogueRepository`                           | Production Thunderstore catalogue, cache and explicit legacy opt-in                    |
| `CatalogueTrust`                                       | Independent persistent revocations/release blocks and fresh-download eligibility       |
| `ArtifactHistory`                                      | Archive provenance, supplied checksums and immutable-release change detection          |
| `InstalledModsService`                                 | Local scanning, file integrity and prerequisite evidence                               |
| `GitHubPrerequisiteProvider`                           | Latest prerequisite release checks                                                     |
| Installation strategies                                | Mod-root detection, standalone Lua files and explicit game-file mappings               |
| `CreatorService`                                       | Local projects, source history, collision checks, PNG atlases and immutable build ZIPs |
| `ModInstaller`                                         | Staging, dependency checks, file plans and installation records                        |
| `TransactionEngine` and `BackupService`                | Backups, commits, rollback and startup recovery                                        |

`ConfiguredModIndex` supplies the optional user-configured source, `GitHubStars`
handles cached popularity, and `AppUpdates` checks desktop releases independently
of mod installation.

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

Users can separately configure a Balatro mod index during setup or in Settings. Its
GitHub URL identifies a repository and optional branch; commit-pinned metadata at
`mods/<id>/meta.json` is fetched at runtime. Each URL has its own cache. Matching
repositories and known identities are deduplicated with Thunderstore preferred.
Removing this source leaves installed files and ownership records intact. Mod-manager
packages are filtered from Thunderstore; hidden AI Generated tags fall back to Other
when no useful category remains.

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

GitHub API JSON requests share concurrent lookups and reuse successful responses for
five minutes; missing API resources are cached for one minute. Raw restriction feeds
are not cached by this layer. Response headers establish shared API cooldowns and a
retry time. Optional stars use a persisted limit of 15 repository requests per hour
and stop when reported API capacity reaches the 40-request installation reserve.
Successful counts are cached for 24 hours, including across restarts. Cached browsing
remains available during a limit; expired release checks can still prevent installs.

Dependency planning visits package identities and versions recursively, detects cycles,
deduplicates shared dependencies and checks semantic minimum versions. Already installed
versions use their own dependency metadata. Install/update stages the entire required set
before changing files; conflicts, unsupported layouts or additional unsatisfied archive
requirements abort the plan. A confirmation token covers packages, versions and file hashes.
One transaction commits dependencies before dependants and rolls all of them back on failure.
Automatically installed dependencies remain recorded and are never silently removed.
The complete staged plan is checked against affected managed, disabled and external
mods. Compatibility errors identify every affected mod and requirement; unreadable
metadata is reported as unknown. Published version selection keeps each provider's
archive identity and dependencies together. GitHub release choices stay pinned, and
development retries keep explicit consent and commit review rather than depending
on a particular error dialog.

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

Creator schemas in `src/shared/creator.ts` validate explicit IPC operations; no
renderer-supplied project paths are accepted. Settings gate access with persisted
experimental acknowledgement. Projects live in `creator/projects/<uuid>/`, separate
from installed destinations. Optimistic content tokens reject stale writes after
external edits. Custom source and prior project JSON are preserved in local history
before template regeneration. This is recoverable file saving, not a claim of an
atomic multi-file project transaction. Versioned content models in
`creator-content.ts` separate Joker rules, Deck setup and Voucher redemption;
Custom Lua is a source workspace, never decoded into guided controls. Schema-1
projects receive a metadata/source/art backup before schema-2 migration. Built-in
art IDs and retained uploads are independent of installed builds.

`luaparse` parses LuaJIT syntax without execution. `pngjs` validates PNG CRCs after
byte/dimension checks; interlaced inflation is explicitly bounded. Originals remain
in the project and manual nearest-neighbour sampling produces 71×95 and 142×190
atlases. `fflate` creates deterministic ZIPs from an explicit six-file allowlist;
private state and unrelated files are never globbed into exports.

Build ZIPs live outside editable projects at `creator/builds/<uuid>/<sha256>.zip`.
Stable local definitions reuse the normal installer with a verified local archive,
without remote source lookups. Installation provenance stores project/build IDs.
Previous ZIPs remain available for explicit restoration through the same update
path. Catalogue definitions cannot replace a managed creator identity. Uninstall
leaves source and builds; project archiving leaves installed files. The native
export picker writes only ZIPs outside game, Mods and internal data roots.

Archive-root detection prefers a declared mod identity over overlapping `main.lua`
or Lovely filename hints. This avoids installing wrapper folders and their error
patches around the real mod. Identified roots retain their resources; independent
mods or patch-only roots remain ambiguous. Explicit source roots still undergo
metadata validation. Runtime versions come from staged loader metadata, not arbitrary
index timestamps or release labels.

Confirmation retains up to 512 MiB of downloaded archives for ten minutes. Reuse
checks their hashes and repeats extraction, file planning and prerequisite checks;
it never commits a stale file plan. Completion, cancellation and failure clear the
cache; startup also prunes abandoned downloads older than a day.
An explicit development-dependency choice resolves the author repository's default
branch to one commit. Its archive metadata must satisfy the original requirements
before confirmation, and shared updates must also satisfy affected installed mods.

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

After startup recovery and settled file operations, completed journals are retired
and unreferenced `.original` files and abandoned backup-copy temporaries are pruned.
Originals referenced by installed records or validated state-upgrade snapshots remain;
blocked or uncertain recovery
prevents cleanup. Unknown backup entries, creator history/builds and Balatro saves
are outside this cleanup. Compact operation history retains the last 100 outcomes.

Uninstall snapshots use the existing verified backup copies under
`backups/removed/<uuid>/`, with a validated manifest containing installation metadata
and their own copies of replaced originals. Capture must succeed before removal.
Restore checks hashes, ownership and dependency compatibility, then uses the normal
transaction engine and profile-install bookkeeping. After successful uninstall and
at startup, retention removes the oldest eligible snapshots until at most 20 remain
and their combined file size is at most 1 GiB. A single oversized snapshot is verified
before uninstall proceeds, then may be removed by retention immediately.
Cleanup and manual deletion use the transaction operation lock and shared original-file
reference checks. Active installations, migration snapshots and pending recovery records
protect required originals. Invalid or unreadable records are preserved; uncertain
references defer all deletion. Protected or unverified copies can exceed the limits,
with a warning in Installed. Storage totals include retained records and manifests;
unreadable sizes are shown as a lower bound. Individual deletion and Clear all require
confirmation and never remove protected copies. Transaction scratch pruning does not
touch these snapshots, and this cleanup does not touch saves or creator files.

Independent preflight/backup reads and disposable staging copies run in bounded
batches. Scratch staging does not fsync each file; rollback backups, final writes
and state still use durable atomic copies. Mutation order, path checks, hash
verification and rollback barriers remain intact. The synthetic Windows benchmark
can be repeated with `node scripts/benchmark-file-operations.mjs`; it creates only
temporary data and reports startup cleanup separately from steady-state operations.

Downloaded provenance records the requested and final URL, repository, source type,
tag/commit, download time and archive SHA-256. A previously observed immutable artifact
or supplied checksum cannot be silently replaced. Game-file changes require a short-lived
confirmation token tied to the actual plan and file hashes. A changed plan requires
another review. Advanced users can inspect a staged plan without committing it.

External adoption is a local baseline operation: identified folders and standalone
Lua files are hashed without being downloaded or rewritten. Unique catalogue matches
can provide future updates; otherwise local-only IDs preserve management without
invented provenance. Updates to adopted mods retain their existing directory.

State schemas 1 and 2 migrate to schema 3 only after a verified backup of the original
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
against the appropriate HTTPS GitHub or Thunderstore transport allowlist.

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
At startup, the main process checks this project's GitHub Releases for a newer beta or
stable version and a matching platform installer. Release tags, repository links and
asset names are validated; drafts and versions older than the installed app are excluded.
Update metadata is cached separately from mod sources. Checks never download an installer
or modify the mod transaction engine. A quiet notice opens Settings, where an explicit
Download update action opens the installer in the browser. Installing it is manual and
preserves the existing application data directory. Catalogue data cannot control application updates.

## Profiles and troubleshooting

The typed bridge and runtime schemas in `src/shared/features.ts` cover profile
persistence, CRUD inputs, switch previews and confirmations, diagnostic log selections
and reviewed report export. State schema 3 contains profile schema 1 with stable
managed identities and the active profile. `profile-selection.ts` compares selection
only, so a version update never creates a false unsaved indicator.
The shared `withInstalledMods` state builder saves installed or adopted identities
to the active selection and adds new disabled entries to inactive selections.
Existing inactive choices and unrelated unsaved toggles are preserved. Single and
dependency-batch installs use this builder inside their file transaction.
Uninstall removes the identity from every profile in the same transaction as file
removal, preserving unrelated unsaved selections.

`ProfileTransferService` validates a bounded, checksummed portable manifest through
native open/save pickers. It resolves catalogue identities, constrains pinned GitHub
artifacts to the declared repository, then uses dependency planning, batch installation
and reviewed profile transactions. An import gets a new UUID and unique name;
cancellation restores the prior profile. Source JSON cannot supply installation paths
or bypass trust policy. Settings retain announcement dismissal IDs independently of
application versions, profiles and experimental-feature enablement.

`ProfileService` reviews targets under the existing transaction lock and game-closed
guard. It uses the same dependency evaluator as installation, source-qualified package
identities and recorded versions, refreshing file integrity before confirmation.
Unlisted managed mods are disabled where safe, required installed dependencies are
retained, and native Lovely game files remain shared. Missing, incompatible, unknown
or ambiguous dependencies and unsafe moves block the plan. The installer exposes
one shared `planToggle` implementation for folder, ownership, hash and destination
checks. All sources are staged before one transaction commits file moves and profile
metadata. Single-use five-minute tokens cover the saved state and effective plan.
Switches reuse their initial move preparation, perform independent integrity reads
and staging copies in batches of at most eight, and drain outstanding I/O before
reporting failure. Final game-running and full integrity checks still run before
commit. Empty-directory cleanup uses non-recursive removal after a durable commit;
scans ignore empty remnants and resolve actual filesystem casing for ownership.

Storage defers migration while prepared journals exist. Application initialization
recovers those journals against their original state, then backs up and migrates.
The upgrade preserves ownership, provenance, file backups and durable commit markers.
Failed upgrades lock file changes. Default profiles capture existing enabled states
without touching game files, configurations or saves.

`TroubleshootingService` uses `TransactionEngine.inspectLocked` for a read-only
consistent setup snapshot. This lock does not trigger recovery or require safe state,
so locked recovery can still be diagnosed. Findings reuse the shared version and
dependency checks; active-profile blockers reuse the profile planner without mutation.
Filesystem and log access remain in the main process. Discovered files and native-picker
selections receive opaque IDs, with bounded directory scans, tail reads, excerpts and
response times. Binary files and symlinks are rejected. Log evidence is labelled as
possible evidence, never proof of a named mod's responsibility.

`OperationHistoryStore` keeps at most 100 records in `data/operation-history.json`.
Transactions record uncertain preparation, verified success or rollback failure status;
startup recovery reconciles known journal outcomes. History failures do not interrupt
rollback; backup cleanup is handled separately by the transaction engine. It contains
identities, timestamps and version transitions rather than raw journals or file paths.
Reports redact common secrets and approved root paths, exclude unselected logs, and
remain editable before explicit clipboard copying or native-save export. Nothing is
uploaded automatically.
