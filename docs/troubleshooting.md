# Troubleshooting

Start with the exact message shown by Modatro. The sections below explain common
setup and file-operation problems. For installation instructions, see
[release information](release.md).

## Modatro will not start

If an earlier build reports **“A file resolves outside its approved location.”** on
startup, install the corrected build. The startup fix separates the catalogue cache
from Electron's `Cache` folder and accepts filesystem case aliases. Keep your existing
application data; deleting it removes installation records and backups.

If startup still fails, include the full error, Modatro version and operating system
in a [bug report](https://github.com/NorthernBranch/modatro/issues). Application data is
normally under `%APPDATA%\Modatro` on Windows or
`~/Library/Application Support/Modatro` on macOS. Development builds may use the
lowercase folder name `modatro`. Linux uses Electron's application-data directory
under `$XDG_CONFIG_HOME` or `~/.config/`, normally `modatro` or `Modatro`.

## macOS says Modatro is damaged

Earlier preview packages could retain an incomplete Electron signature after
packaging. The app could start in a development smoke test while failing macOS's
signature checks once downloaded. Updated builds sign the complete app, including
nested frameworks and helper apps, and verify that signature before publication.

Download a newly built DMG from the project's Releases page, choose the correct
architecture, quit Modatro and replace the app in Applications. Keep application
data and backups. Compare the download with that release's `SHA256SUMS.txt`; a matching
checksum establishes download integrity, not an Apple-verified publisher.

Check the release's signing status. An ad-hoc beta build is not notarized and may still
be blocked by Gatekeeper. For a valid beta build from this project's release that you
choose to trust, Apple's documented **System Settings → Privacy & Security → Open
Anyway** procedure may be available after attempting to open it. This does not
repair an invalid signature. If the alert remains “damaged,” report the release tag,
architecture and macOS version and use a Developer ID signed, notarized build when
one is available.

See [Apple's explanation of downloaded-app alerts](https://support.apple.com/en-gb/102445)
and [Modatro release signing](signing.md).

## Balatro was not found

**Find automatically** shows **Finding Balatro…** while checking Steam libraries.
If no installation is found, Modatro explains the result and offers manual selection.
You can retry after an error; a failed automatic search does not prevent manual setup.

Use **Settings → Balatro installation → Choose folder** to select the actual game
installation. On Windows it contains `Balatro.exe` and its support files. On macOS,
select `Balatro.app` or the folder containing it. A folder named Balatro without the
game files will not pass validation. On Linux, select the Steam/Proton Windows game
directory and its Proton Mods folder; see [Linux and Steam Deck setup](linux.md).

If Steam moved the game, select its current location. Modatro needs read and write
access to that folder. Managed mods must be uninstalled before changing the approved
folders because their installation records refer to the existing locations.

## A prerequisite is missing or its version is unknown

Open **Prerequisites**, follow the linked project instructions, and choose
**Check prerequisites again**. Lovely offers **Install Lovely**, or **Manage Lovely**
for an existing manual copy, using official platform-specific releases.

Installed status and version compatibility are separate checks. If a mod requires a
specific version and the local files do not prove it, Modatro asks you to check it.
Thunderstore package versions and loader versions are separate: adopting an external
copy does not prove which registry package it came from. **Install catalogue release**
records that package version without guessing; existing edits are still protected.
For installed Lovely and Steamodded versions that cannot be verified, installing,
updating or enabling a mod offers **Proceed at my own risk**. Continuing may cause
crashes or prevent mods from working. Your choice applies only to that operation;
it does not mark the version as verified. Missing prerequisites, known incompatible
versions and unverified versions of other dependencies still block the action.
Check the mod's upstream instructions for the supported prerequisite version. Direct
install/update actions appear when a supported catalogue release meets the requirement;
external installations must be adopted first. A failed latest-version check preserves
installed status and labels any last known release.

## The catalogue will not refresh

Modatro keeps the last validated catalogue when Thunderstore or the GitHub supplement is
unavailable. You can continue browsing it; a first launch without a saved catalogue
needs a successful refresh. Check your connection and try **Refresh** again later.

An unavailable entry means its metadata or installation method could not be verified.
Open the mod's project page for its installation instructions.

## A mod appears as unmanaged

Modatro found local files without its own installation record. It leaves those files
in place. Adoption is offered for supported metadata-identified folders and standalone
Lua files. A unique catalogue match enables catalogue updates; entries absent from
the catalogue can still be adopted for local management. Duplicate identities,
ambiguous catalogue matches and unidentified directories stay external. Adoption
records current file hashes without inventing an original download or archive hash.

## A mod was removed, blocked or its source disappeared

Modatro keeps installed copies untouched. Author removals and compromised sources
disable new installations and updates; a blocked version can be replaced by a safe
newer release if available. Open the project for context, open the mod folder, or
explicitly uninstall a managed copy. A vanished repository is not evidence of malware.

## Install is unavailable while offline

Catalogue browsing shows the saved refresh time. Thunderstore and the public
repository's removal/release feeds must be reachable for new downloads and updates.
Bundled and saved restrictions remain in effect. Local uninstall and enable/disable
remain available for managed files. Refresh when connected; an older saved catalogue
cannot override a known restriction. No private-repository configuration is required.

## Installed loaders show an unverified version

Missing supported dependencies from either the catalogue or downloaded archive are
included in an installation confirmation. Modatro lists their versions and installs
them before the requested mod after approval. Cancelling leaves installed files
unchanged; a failed dependency check blocks the whole plan. An installed loader with
an unknown version still requires explicit verification rather than automatic replacement.

Discover shows loader presence separately from version compatibility. An external
Steamodded or Lovely installation can be detected without proving which Thunderstore
package was installed. Canonical loader requirements use a known runtime version when
the package version is unrecorded. Steamodded's beta build numbers (including zero-padded
requirements such as Amulet's `1.0.0~BETA-0827c`) and newer date-based
versions are compared in their supported formats. Unknown runtime versions require the
existing per-operation consent; missing or known incompatible requirements still block.

Modatro verifies a managed Lovely version against the installed binary's recorded
hash. A manual installation may remain unversioned. Lovely writes its reported version
to `Mods/lovely/log` when Balatro starts; an old log does not prove the version of a
DLL that has since been replaced.

## GitHub downloads and manual installations

When a Thunderstore listing links to a GitHub repository, Modatro prefers the author's
GitHub manual mod archive. A uniquely named `-raw.zip` or `-manual.zip` asset takes
precedence over bundled launcher ZIPs; ambiguous releases remain blocked. Projects
without releases use a commit-pinned archive of their default branch. A failed GitHub
request does not silently switch back to a Thunderstore installer.

Registry discovery identity and restrictions remain intact, while installation
provenance records the actual GitHub URL, release or commit and archive hash. GitHub
downloads do not invent a Thunderstore package version. Archives still pass the
existing metadata, prerequisite, conflict and file-plan checks. Developer scripts in
`.github` and supported release-script files in `scripts` are excluded; external
installers elsewhere in a mod remain unsupported.

For managed GitHub copies, a verified runtime version can satisfy a requirement for
the same recorded package identity. Saved dependencies from the installed archive are
checked instead of borrowing the latest registry package's dependency tree. Unmanaged
mods cannot satisfy another namespace's requirements by sharing a name.

Lovely can be installed, updated and uninstalled on Windows, Linux with Proton,
and Intel or Apple Silicon Macs. Game-file changes require a preview and confirmation.
Existing files at the destination are backed up and restored on uninstall. Managed
releases expose their verified version immediately. Legacy manual `version.dll` copies
must follow the official upgrade instructions before installing `winmm.dll`; Modatro
refuses to leave two injectors active. Steamodded's identity manifest is retained during installation so the
Prerequisites page continues to recognize the loader; healthy older managed copies
whose manifest was omitted are recognized from verified file ownership.

Balatro version requirements use `version.jkr` read from its game-data archive,
including the Windows fused executable and macOS `.love` file. The executable is
never run to obtain its version. Invalid, oversized or ambiguous version data stays
unknown; letter releases such as `1.0.1o` are compared explicitly.

## A release's archive hash changed

Automatic installation stops if an immutable release's archive differs from the
recorded or author-supplied SHA-256. Existing files are untouched. Compare the expected
and received hashes in the error details and consult the author or report the change.
Do not clear integrity history merely to dismiss the warning.

## Uninstall reports changed files

A recorded file has changed since installation. Review each conflict before choosing:

- **Keep** preserves the current file and removes Modatro's ownership of it.
- **Restore** overwrites a changed replacement with its verified original backup.
  This choice is available only when an original can be restored.

Keep is selected by default. Backups remain available after uninstall through
**Settings → Open backups**.

## File operations are locked after recovery

Modatro could not verify saved state, a transaction, a destination or a backup. Keep
the application data folder intact, including `data/`, `backups/` and `transactions/`.
Do not delete the journal or edit installation records to dismiss the message.

Use **Settings → Copy diagnostics** and **Open logs** to collect details for a bug
report. Review attachments for personal information before posting. Include what
operation was interrupted and whether any files were edited afterward.

## Uninstall leaves files behind

Modatro reports the relative paths of preserved edits and untracked files after
uninstall. Those files are no longer managed by Modatro. Empty-directory cleanup
failures are reported separately; your backups remain available.

## Balatro is still running

Close the game, then use **Check again** to retry the requested operation. Game
launch and mod changes share an operation lock, so wait for an active installation
to finish before launching.
