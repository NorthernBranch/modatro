# Named mod profiles

Use the **Profile** selector beside Launch to review a switch. **Manage profiles**
creates a profile from the current managed selection and offers rename, duplicate
and delete actions. Names must be unique, ignoring case and Unicode normalization,
and contain 1–60 characters. Up to 100 profiles are supported.

![Profile management with representative mod selections](images/profiles.png)

## What a profile shares

A profile records enabled or disabled states by stable managed installation identity,
including source-qualified identities. Installed versions and configurations are
shared: updating a mod affects all profiles using it. Profiles are not Balatro save
slots. Switching never moves, replaces or deletes save files. Creator builds share
one installed revision across profiles too; switching does not select an older
project build. Back up Balatro saves separately from mod files.

Unmanaged mods remain untouched and can still affect gameplay. Review them in
**Installed** and use the existing adoption action where supported. Lovely's native
game files remain installed as a shared prerequisite. Other game-file replacements
cannot safely be disabled through profiles; review their normal uninstall workflow.

Successful installs automatically save the installed mods and any newly installed
dependencies as enabled in the active profile. Each new managed mod is also recorded
as disabled in every inactive profile; existing choices in those profiles are preserved.
Adopting an external mod follows the same rule. File changes and the saved install
selections commit together, so a failed installation cannot leave a partially updated
profile. Unrelated unsaved manual changes stay unsaved.

## Review and apply a selection

1. Close Balatro and choose a profile, or choose **Review switch** in profile management.
2. Review every enable and disable, retained dependency, warning and blocker.
3. Confirm the effective selection. The saved profile adopts any required managed
   dependencies retained by the reviewed plan.

The preview separates Enable and Disable lists, shows dependencies staying enabled,
and groups warnings and blockers before the confirmation controls.

![Profile switch preview with synthetic enable, disable and dependency details](images/profile-switch.png)

Managed mods absent from the saved profile are previewed for disabling where safe.
Already installed required dependencies are retained or enabled; missing dependencies
are never downloaded by switching. Missing mods, incompatible or unknown versions,
ambiguous identities, external changes and unsafe destinations block the switch.
Follow **Review Prerequisites** or **Review Installed mods**, then use Discover or
the normal installation workflow to resolve missing packages. Review a fresh preview
after any change. Confirmation expires after five minutes and is single-use.

All moves and the active-profile identity commit through one transaction. A failed
switch restores the previous files and keeps the previous profile. After an interrupted
switch, startup checks the durable state commit marker and either completes the
committed journal or rolls back verified changes. External edits or missing backups
can stop recovery and lock file operations; keep the application data and backups
and open **Troubleshooting**. Recovery does not discard unverified edits.
During a switch, the dialog shows progress and cannot be dismissed with Close,
Cancel, Escape or a click outside. It closes after success; a failed switch leaves
the controls available again. Empty folders left by earlier switches are ignored
by discovery, and new switches remove empty source directories after committing.

## Unsaved selections

Manual uninstalls, enables and disables show **Unsaved changes** when the
actual managed selection differs from the active profile. This persists across restarts.
Version-only updates do not count as selection changes.

- **Save to profile** records the current selection in the active profile.
- **Save as new profile** captures the current selection under a new active name.
- **Revert to saved selection** opens the same reviewed, transactional switch.

An uninstalled mod saved as enabled in a profile is explained as missing; it is not
automatically reinstalled. Saving the current selection removes that stale reference.
An uninstalled mod saved as disabled does not block switching into that profile.
Deleting a profile never uninstalls anything. Deleting the active profile requires
explicit confirmation to preserve the current selection as a newly named Default
profile; it does not silently apply another profile's files.

## State upgrade

Saved state upgrades from schema 1 or 2 to schema 3, containing a validated profile
schema 1. A Default profile captures the existing managed selection exactly. Original
state is backed up in `data/state-v1.backup.json` or a content-addressed
`data/state-v1-<hash>.backup.json` / `data/state-v2-<hash>.backup.json` before writing
the upgrade. Ownership, hashes, original-file backups, provenance and transaction
markers remain intact; migration does not move game or mod files.

Prepared journals are recovered against the unchanged old state before migration.
A backup or state-write failure locks file operations and preserves recovery material.
Keep the entire application-data directory when upgrading. Older Modatro versions
do not understand schema 3; avoid running an older build against upgraded app data.
