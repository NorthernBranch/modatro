# Release information

Modatro is a preview of the desktop manager for Balatro on Windows,
macOS and Linux with Steam/Proton. It includes mod discovery, dependency checks, managed installations,
updates, backups and recovery for interrupted file operations.

Downloads and release notes are listed on
[GitHub Releases](https://github.com/NorthernBranch/modatro/releases).

## Automated preview downloads

Each push to `main` publishes a new preview once the Windows x64, Apple Silicon,
Intel macOS and Linux builds pass their checks. A release includes every platform's installers,
`SHA256SUMS.txt` for download verification, and a link to its exact source commit.
If any platform build or upload fails, the release remains unpublished.

Formatting, catalogue validation, type checks, unit tests and the full browser and
source desktop test suite run once in a shared job. That job compiles the application
and shares its output and assigned version with all four packaging jobs. Each platform
installs its own build dependencies, creates its installers and verifies packaged
desktop startup before uploading. Publishing waits for every platform to pass and
uses the same tested version.

Each workflow run assigns an increasing app version automatically, for example
`0.2.42`, followed by `0.2.43`. Merging into `main` triggers the same process as a
push. The renderer, Electron app, platform installers and release notes all use
that version. Retrying a workflow retains its assigned version. There are no
version-bump commits and no need to edit `package.json` for normal releases.

Preview tags also identify the run and commit, such as `v0.2.42-build.42.aaaaaaa`.
Application updates remain manual. An optional tag such as `v1.0.0` can publish a
named release; CI takes the version from the tag without a package-file edit.
Pull requests and manual workflow runs provide build artifacts without publishing.

## Included features

- Independent author-removal and release-block feeds take precedence over saved
  catalogues. Offline browsing and local management remain available.
- New downloads record their exact source, release/commit, timestamp and archive
  SHA-256. Unexpected changes under the same immutable release stop automation.
- Live Thunderstore discovery with cached offline browsing, automatic author-controlled
  GitHub release discovery, separate installation/update permissions and public removal policies.
- Automatic app version increments on pushes and merges, shared by every platform installer.
- Explicit consent when installed Lovely or Steamodded versions cannot be verified;
  missing or known incompatible requirements remain blocked.
- External folders and standalone Lua mods can be adopted without a catalogue entry.
  Existing installation records migrate with a saved-state backup and honest provenance.
- Game-file changes require confirmation of the actual plan; advanced users can
  inspect a download's file changes before installation.
- Linux AppImage and DEB packaging, Steam/Flatpak library discovery and Proton Mods
  directory integration for Steam Deck and generic Linux desktops.
- Direct prerequisite install/update/adoption actions, visible dependency chains and
  actionable archive-discovered requirements.
- Original backups survive updates that change only a filename's casing.
- Game launch shares the file-operation lock; early macOS launch failures show
  architecture and installation guidance.
- Recovery finishes pending commit markers before subsequent operations, and
  rechecks files immediately before restoration.
- External adoption requires a unique directory match; duplicate prerequisite
  installations do not establish an arbitrary version.
- Structured entry points are validated, loader requirements are enforced, and
  installation records use the version proved by downloaded metadata.
- Startup skeletons, failed prerequisite checks, Check again actions and precise
  uninstall reports improve loading and recovery feedback.
- Packaged desktop startup checks added to each CI platform target.
- macOS packages receive complete bundle signatures, checked before upload. This
  replaces incomplete inherited Electron signatures that can cause “damaged” alerts.
  Release notes distinguish ad-hoc previews from Developer ID signed, notarized builds.

See [release verification](verification.md) for specification coverage and remaining
platform validation.

## Changes in 0.1.1

- Loading feedback for discovery, folder selection, setup, refreshes, launching,
  diagnostics, imports and mod operations.
- Clear discovery results and errors, with manual setup available after a failed search.
- Retryable service errors and controls that recover after a failed request.
- Setup stays open when saving fails; Updates shows when a check is still in progress.
- Fixed startup on filesystems where Electron's `Cache` folder and `cache` refer
  to the same location. Existing settings, catalogues and backups are preserved.

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
settings. Windows preview installers are currently unsigned.

### Updating Modatro

Quit Modatro and install the newer version using the same installation method.
Updates to the application are manual. Keep the application data folder: it holds
your settings, installation records and original-file backups.

### Linux and Steam Deck

Use `Modatro-<version>-x86_64.AppImage` in Steam Deck Desktop Mode or on a generic
x64 Linux desktop. Mark it executable in your file manager and open it. Debian and
Ubuntu users can install `Modatro-<version>-amd64.deb` with their package installer.
See [Linux setup](linux.md) for Steam, Proton prefixes, Flatpak Steam and Lovely.

Linux packaging and fixture-based integration are covered by CI. Native Steam Deck
and real-game compatibility still require device testing; a build artifact alone
does not establish that verification.

## Supported mods

Modatro supports ZIP distributions with one identifiable mod root, including nested
repository folders, supported standalone Lua files, and Lovely patches. It checks
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

- **Lovely:** automatic installation is available on Windows and Linux with Proton. An older `version.dll`
  installation requires Lovely's upstream upgrade instructions. On macOS, use
  **Official instructions**, then launch through **Launch Modded Balatro** once the
  local Lovely library is detected.
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

## Preview limitations

- Linux packages target x64. Native Linux LÖVE launch and ARM Linux are not supported.
- Mods update individually; bulk updates and automatic application updates are unavailable.
- Mods that replace game files cannot be disabled. Uninstall restores their recorded originals.
- Unmanaged mods can be adopted when structured metadata identifies a unique local
  mod; catalogue updates additionally require a unique catalogue match.
- Non-semantic version strings may not produce an update notice. Balatro game-version
  requirements cannot currently be verified automatically.
- Backups are retained after uninstall and are not automatically deleted.

See [troubleshooting](troubleshooting.md) for folder selection, offline browsing,
changed files and recovery messages.
