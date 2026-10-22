# Release information

Modatro is a beta desktop mod manager for Balatro on Windows,
macOS and Linux with Steam/Proton. It includes mod discovery, dependency checks, managed installations,
updates, backups and recovery for interrupted file operations.

Downloads and release notes are listed on
[GitHub Releases](https://github.com/NorthernBranch/modatro/releases).

## Automated beta downloads

Pushes to `main` that change desktop release inputs publish a new beta once the Windows x64, Apple Silicon,
Intel macOS and Linux builds pass their checks. A release includes every platform's installers,
`SHA256SUMS.txt` for download verification, and a link to its exact source commit.
If any platform build or upload fails, the release remains unpublished.

Formatting, catalogue validation, type checks, unit tests and the full browser and
source desktop test suite run once in a shared job. That job compiles the application
and shares its output and assigned version with all four packaging jobs. Each platform
installs its own build dependencies, creates its installers and verifies packaged
desktop startup before uploading. Publishing waits for every platform to pass and
uses the same tested version.

The publishing job restores the tested build and installer artifacts without
installing application dependencies. Release and version-assignment scripts use
only Node built-ins so that this clean checkout can verify and publish the artifacts.

Documentation, website, test-only and fixture-only changes still run shared checks,
including the website browser checks. They skip build-artifact upload, all four
packaging jobs and release publication. App sources, bundled policy JSON, dependency
files, shipped assets and packaging configuration are release inputs, as defined
in `scripts/release-scope.mjs`. Git deletions and renames are included. Version tags
and manual runs explicitly request packaging; manual runs do not publish releases.

Each packaging-enabled workflow run assigns the next app version automatically, for example
`0.4.0`, followed by `0.4.1`. Merging into `main` triggers the same process as a
push. The renderer, Electron app, platform installers and release notes all use
that version. Retrying a published workflow retains its original version. There are no
version-bump commits and no need to edit `package.json` for normal releases.

The checked-in `package.json` version is `0.0.0`, a placeholder used by local builds.
CI replaces it with the assigned release version before compiling or packaging.

Version assignment reads published GitHub Releases, including betas, using the CI
token. The merged PR title selects how the highest published semantic version advances:

| PR title prefix | Example from `0.4.3` |
| --------------- | -------------------- |
| `MAJOR:`        | `1.0.0`              |
| `MINOR:`        | `0.5.0`              |
| `PATCH:`        | `0.4.4`              |
| No prefix       | `0.4.4`              |

Prefixes are case-insensitive and must start the title. The merge method and commit
message do not select the bump: CI reads the merged PR associated with the main
commit. Direct pushes default to a patch. PR builds use their event's title; the
final merged title controls publication. The selected bump is passed from validation
to publishing so every installer uses the same tested version.

Merged-PR lookup explicitly uses GitHub's supported `2022-11-28` REST contract,
which includes the `merge_commit_sha` needed to verify the PR against the main
commit. The `2026-03-10` contract removed that field. Missing merge identity now
stops assignment instead of silently selecting a patch. The older contract is
[supported until March 10, 2028](https://docs.github.com/en/rest/about-the-rest-api/api-versions#supported-api-versions);
release-history requests continue using the current API contract.

Intervening PR, documentation, website or failed workflow runs do not consume
versions. Draft releases and bare Git tags do not consume versions either.
If release history cannot be read, the build stops rather than guessing a version.
Release workflows run serially so overlapping pushes cannot reserve the same next
version. A failed, unpublished build does not permanently consume its version.

The baseline in `build/version.json` sets the minimum version, currently `0.4.0`.
For a deliberate minor or major bump, set it to the new `X.Y.0` version. Normal
releases use the title prefix above and default to patches. Documentation and
website-only PRs still skip application releases, regardless of their title prefix.

Beta tags also identify the run and commit, such as `v0.4.0-beta.build.42.aaaaaaa`.
GitHub marks these as **Pre-release**, with **Modatro Beta 0.4.0** in the release
title. Beta is the development stage; pre-release is GitHub's corresponding status.
The app checks GitHub Releases at startup and shows a small update notice when a newer
beta or stable release has an installer for your platform. In Settings, use **Check for
updates** to check again or **Download update** to open the installer in your browser.
Nothing downloads automatically. Close Modatro before running the installer; preserve
the existing application data directory and mod backups.

An optional tag such as `v1.0.0` can publish a
named release; CI takes the version from the tag without a package-file edit.
Pull requests and manual workflow runs provide build artifacts without publishing.

## Application scope

See the [README](../README.md#what-modatro-does) for current capabilities,
[profiles](profiles.md) for shared selections, and [Mod Creator](mod-creator.md)
for the optional experimental project editor. The creator is off by default;
its build checks do not establish in-game compatibility. Modatro's recovery
backups protect recorded mod-file changes, not Balatro saves.

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
settings. Windows beta installers are currently unsigned.

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
- Mod-file backups are retained after uninstall and are not automatically deleted.
  Back up Balatro saves separately; the reminder and guidance are in Settings.
- Mod Creator templates target Steamodded 26.1002.0 and require Lovely. Creation,
  PNG processing, syntax parsing and ZIP building are local. Static validation
  cannot establish game compatibility or code safety.

See [troubleshooting](troubleshooting.md) for folder selection, offline browsing,
changed files and recovery messages.
