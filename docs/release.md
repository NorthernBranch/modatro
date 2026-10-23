# Release information

Modatro is a beta desktop mod manager for Balatro on Windows,
macOS and Linux with Steam/Proton. It includes mod discovery, dependency checks, managed installations,
updates, backups and recovery for interrupted file operations.

Downloads and release notes are listed on
[GitHub Releases](https://github.com/NorthernBranch/modatro/releases).

## Install Modatro

### Windows

Choose `Modatro-Setup-<version>.exe` for x64 Windows. Run the installer, select an
installation folder, and open Modatro from the installed shortcut. The installer
works for your user account.

### macOS

Choose the `arm64` DMG for Apple Silicon or the `x64` DMG for Intel. Open the DMG,
drag Modatro into Applications, and open the installed app.

The release notes and accompanying `signing-macos-<arch>.json` reports state whether
the Mac build is **ad-hoc signed** or **Developer ID signed and notarized by Apple**.
Ad-hoc signatures seal the packaged application but do not establish an identified
publisher or satisfy Apple's default download checks. macOS may still block them.
Developer ID builds also have their notarization ticket stapled to the app.

If macOS says the app is damaged, use a newly built installer rather than overriding
the old package's invalid signature. See [macOS troubleshooting](troubleshooting.md#macos-says-modatro-is-damaged)
and [release signing](signing.md). Modatro does not change operating-system security
settings.

### Linux and Steam Deck

Use `Modatro-<version>-x86_64.AppImage` in Steam Deck Desktop Mode or on a generic
x64 Linux desktop. Mark it executable in your file manager and open it. Debian and
Ubuntu users can install `Modatro-<version>-amd64.deb` with their package installer.
See [Linux setup](linux.md) for Steam, Proton prefixes, Flatpak Steam and Lovely.

Linux packaging and fixture-based integration are covered by CI. Native Steam Deck
and real-game compatibility still require device testing; a build artifact alone
does not establish that verification.

## Updating Modatro

Newer compatible releases appear as a quiet notice. Use **Settings → Application
updates → Download update** to open the installer in your browser.

Quit Modatro and install the newer version using the same installation method.
Updates to the application are manual. Keep the application data folder: it holds
your settings, installation records and original-file backups.

## Supported mods

Modatro supports ZIP distributions with one identifiable mod root, including nested
repository folders, supported standalone Lua files, and Lovely patches. Declared
mod metadata takes precedence over wrapper filename hints, keeping the real mod
at the correct depth and excluding outer installation-error patches. It checks
the downloaded files before copying them into the approved destination.

Game-file replacements require an explicit Modatro definition listing each archive
source and game destination. Advanced users can import a definition through
**Settings → Advanced → Add mod definition**. The
[example definition](../examples/game-replacement.modatro.json) documents this format;
replace its example metadata and mappings with those for the actual mod.

Modatro does not run downloaded installation scripts. Unsupported archive formats
and ambiguous folder layouts require the mod author's manual installation instructions.

## Prerequisites

**Prerequisites** shows installed components and the latest versions available from
their upstream projects. Each mod's requirements are checked separately.

Detected components stay marked as installed even when their version or the latest
release cannot be checked. Local loader versions remain visible separately from
Thunderstore package versions. External installations without a recorded package
version cannot establish whether a newer Thunderstore package is available.

- **Lovely:** install, manage an existing copy, or update using the official Windows,
  Proton, Intel Mac or Apple Silicon Mac release. Confirm the game-file plan;
  existing destination files are backed up and restored on uninstall. An older manual
  `version.dll` installation requires Lovely's upstream upgrade instructions before
  installing `winmm.dll`. On macOS, use **Launch Modded Balatro** after installation.
- **Steamodded:** use the mod's install/update action when a supported release meets
  its requirement. Existing external installations must be adopted before Modatro
  manages their updates.
- **Talisman:** a direct install action is available when a supported catalogue
  release satisfies a mod's big-number requirement.

If an installed Lovely or Steamodded version cannot be verified, Modatro explains
the uncertainty and offers **Proceed at my own risk** for that operation. The choice
does not persist to other installations or updates. Missing prerequisites, known
incompatible versions and unknown versions of other dependencies still block the
operation. An unknown version is never reported as verified.

When a published dependency is too old, **Try development build** can check its
upstream repository's unreleased code. This is optional: Modatro pins a commit,
verifies its runtime requirements and shows the source and changes for confirmation.
Development builds may be unstable; incompatible builds remain blocked.

## Beta limitations

- Linux packages target x64. Native Linux LÖVE launch and ARM Linux are not supported.
- Mods update individually; there is no bulk-update control. Application updates
  show a notice, but downloading and running the installer is manual.
- Mods that replace game files cannot be disabled. Uninstall restores their recorded originals.
- Unmanaged mods can be adopted when structured metadata identifies a unique local
  mod; catalogue updates additionally require a unique catalogue match.
- Arbitrary non-semantic version strings may not produce an update notice. Supported
  Steamodded beta/date formats and Balatro letter versions are compared explicitly.
  Balatro's version is read from `version.jkr` in its game archive; invalid or ambiguous
  data remains unknown.
- Required original-file backups remain available for uninstall and recovery; unused
  transaction backups are pruned automatically. Temporary uninstall copies aim for
  20 snapshots within 1 GiB; referenced or unverified copies are retained and reported.
  Back up Balatro saves separately.
- Mod Creator templates target Steamodded 26.1002.0 and require Lovely. Creation,
  PNG processing, syntax parsing and ZIP building are local. Static validation
  cannot establish game compatibility or code safety.

See [troubleshooting](troubleshooting.md) for folder selection, offline browsing,
changed files and recovery messages.

## Automated beta downloads

PRs run formatting, catalogue validation, types, unit tests, browser and source
Electron tests, website checks and a production compilation. They do not assign
release versions or build installers. Catalogue validation is part of the shared
check, rather than a separate workflow.

Relevant pushes to `main` compile once, then share the tested build and version with
Windows x64, Apple Silicon, Intel macOS and Linux packaging jobs. Each job verifies
packaged startup. Publication waits for every platform and checks the installer
hashes and macOS signing reports before publishing a draft release. The publisher
uses Node built-ins and restored artifacts without installing app dependencies.

Documentation, website, test-only and fixture-only changes run checks without a
desktop release. Sources, shipped assets, dependency files, policy feeds and packaging
configuration are release inputs; `scripts/release-scope.mjs` includes deletions and
renames when checking the diff.

Release runs stay serialized so each build can use the previous published version.
The publisher skips a second automatic release for an already-published commit;
explicit version tags can still publish a named release. New PR commits cancel
obsolete checks for that PR.

For installers before merging, use **Actions > Test, build and release > Run
workflow**, select the PR branch, and download its artifacts. Manual runs do not
publish. An explicit `v<version>` tag builds that named release instead.

### Versioning

The checked-in `package.json` version, `0.0.0`, is a local placeholder. Packaging runs
stamp the next version from published GitHub Releases before compilation. The merged
PR title selects the bump; the merge method and displayed commit message do not.

| Prefix                | From `0.5.0` |
| --------------------- | ------------ |
| `MAJOR:`              | `1.0.0`      |
| `MINOR:`              | `0.6.0`      |
| `PATCH:` or no prefix | `0.5.1`      |

Prefixes are case-insensitive. Direct pushes and manual installer builds default to
patch. If release history or the merged PR lookup fails, assignment stops.
The minimum version comes from `build/version.json`; ordinary releases use the
PR title without a package-file edit.

Drafts, failed builds and checks-only runs do not consume versions. Retrying a
published workflow preserves its original version and downloads. Beta tags identify
the version, run and commit, for example `v0.5.0-beta.build.42.aaaaaaa`. GitHub marks
these as **Pre-release** with **Modatro Beta** in the title. An explicit version tag
without a prerelease suffix creates a stable release.
