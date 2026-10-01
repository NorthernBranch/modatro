# Release information

Modatro 0.1.2 is a preview of the desktop manager for Balatro on Windows,
macOS and Linux with Steam/Proton. It includes mod discovery, dependency checks, managed installations,
updates, backups and recovery for interrupted file operations.

Downloads and release notes are listed on
[GitHub Releases](https://github.com/NorthernBranch/modatro/releases).

## Automated preview downloads

Each push to `main` publishes a new preview once the Windows x64, Apple Silicon
Intel macOS and Linux builds pass their checks. A release includes every platform's installers,
`SHA256SUMS.txt` for download verification, and a link to its exact source commit.
If any platform build or upload fails, the release remains unpublished.

Preview tags identify the version, build number and commit, for example
`v0.1.2-build.42.aaaaaaa`. The application version and installer filenames stay at
the version in `package.json`; use the release tag and commit link to distinguish
builds of the same version. Application updates remain manual.

Matching version tags such as `v0.1.2` publish named releases after the same checks.
Pull requests and manual workflow runs provide build artifacts without publishing.

## Changes in 0.1.2

- Independent author-removal and release-block feeds take precedence over saved
  catalogues. Offline browsing and local management remain available.
- New downloads record their exact source, release/commit, timestamp and archive
  SHA-256. Unexpected changes under the same immutable release stop automation.
- Legacy index labels, separate installation/update permissions, author manifests,
  a native catalogue compiler and public content/removal policies.
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

These preview builds are unsigned and the macOS builds are not notarized. Your
operating system may show a publisher or verification warning. Modatro does not
change operating-system security settings.

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

- **Lovely:** automatic installation is available on Windows and Linux with Proton. An older `version.dll`
  installation requires Lovely's upstream upgrade instructions. On macOS, use
  **Official instructions**, then launch through **Launch Modded Balatro** once the
  local Lovely library is detected.
- **Steamodded:** use the mod's install/update action when a supported release meets
  its requirement. Existing external installations must be adopted before Modatro
  manages their updates.
- **Talisman:** a direct install action is available when a supported catalogue
  release satisfies a mod's big-number requirement.

If Modatro cannot verify a required version, it blocks installation and explains the
missing information. An installed prerequisite with an unknown version is not assumed
to satisfy a version range.

## Preview limitations

- Linux packages target x64. Native Linux LÖVE launch and ARM Linux are not supported.
- Mods update individually; bulk updates and automatic application updates are unavailable.
- Mods that replace game files cannot be disabled. Uninstall restores their recorded originals.
- Unmanaged mods can be adopted only when their metadata identifies a unique catalogue entry.
- Non-semantic version strings may not produce an update notice. Balatro game-version
  requirements cannot currently be verified automatically.
- Backups are retained after uninstall and are not automatically deleted.

See [troubleshooting](troubleshooting.md) for folder selection, offline browsing,
changed files and recovery messages.
