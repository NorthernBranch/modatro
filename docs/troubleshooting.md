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
**Check prerequisites again**. On macOS, Lovely is installed manually using its
official instructions.

Installed status and version compatibility are separate checks. If a mod requires a
specific version and the local files do not prove it, Modatro blocks the installation.
Check the mod's upstream instructions for the supported prerequisite version. Direct
install/update actions appear when a supported catalogue release meets the requirement;
external installations must be adopted first. A failed latest-version check preserves
installed status and labels any last known release.

## The catalogue will not refresh

Modatro keeps the last validated catalogue when a download fails or GitHub is
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

Catalogue browsing shows the saved refresh time. Independent removal/release checks
must succeed before new downloads and updates. Local uninstall and enable/disable
remain available for managed files. Refresh when connected; an older saved catalogue
cannot override a known restriction.

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
