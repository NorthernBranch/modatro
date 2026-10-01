# Release information

Modatro 0.1.2 is a preview of the desktop manager for Balatro on Windows
and macOS. It includes mod discovery, dependency checks, managed installations,
updates, backups and recovery for interrupted file operations.

Downloads and release notes are listed on
[GitHub Releases](https://github.com/kylehepple/modatro/releases).

## Changes in 0.1.2

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

- **Lovely:** automatic installation is available on Windows. An older `version.dll`
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

- Linux installers are not provided.
- Mods update individually; bulk updates and automatic application updates are unavailable.
- Mods that replace game files cannot be disabled. Uninstall restores their recorded originals.
- Unmanaged mods can be adopted only when their metadata identifies a unique catalogue entry.
- Non-semantic version strings may not produce an update notice. Balatro game-version
  requirements cannot currently be verified automatically.
- Backups are retained after uninstall and are not automatically deleted.

See [troubleshooting](troubleshooting.md) for folder selection, offline browsing,
changed files and recovery messages.
