# Linux and Steam Deck

Modatro provides x64 Linux packages, including an AppImage suitable for Steam Deck
Desktop Mode. Game integration uses the Windows Steam version of Balatro through
Proton. Modatro does not execute downloaded shell scripts or change SteamOS's
read-only filesystem or operating-system security settings.

## Install Modatro

Download `Modatro-<version>-x86_64.AppImage` from
[GitHub Releases](https://github.com/NorthernBranch/modatro/releases). In Desktop Mode,
use the file manager's permissions to mark it executable, then open it. The file
includes the desktop app's runtime and does not require a system package installation.
Keep it somewhere persistent, such as your home directory. To update, close Modatro
and replace the AppImage; keep its application data and backups.

For Debian/Ubuntu, install `Modatro-<version>-amd64.deb` with the distribution's
package installer. The launcher appears in the desktop application menu. The DEB
requires a system package installation and is not the Steam Deck installation method.

## Connect Balatro

Install and launch Balatro through Steam/Proton once so Steam creates its compatibility
prefix. Close the game, open Modatro and use **Find automatically**. Discovery checks
the usual Steam roots, Flatpak Steam and libraries listed in `libraryfolders.vdf`,
including additional drives.

The validated game directory contains `Balatro.exe`. The suggested Mods directory
is in that library's Proton prefix:

```text
steamapps/compatdata/2379780/pfx/drive_c/users/steamuser/AppData/Roaming/Balatro/Mods
```

If Steam keeps the prefix in another library, select its existing `Mods` folder in
**Settings**. The common main-library locations are `~/.local/share/Steam/steamapps/`
and `~/.steam/steam/steamapps/`; Flatpak Steam also uses roots under
`~/.var/app/com.valvesoftware.Steam/`. Choose the folder used by the game, especially
when using an SD card or multiple Steam installations.

Existing mods in the selected Mods directory appear automatically. **Adopt into
Modatro** is an explicit choice for metadata-identified folders and Lua files.
Unidentified or duplicate copies remain external; Modatro does not overwrite them.

## Lovely and launching

For Proton, use Lovely's Windows distribution. Automatic installation stages and
validates the ZIP and shows the actual game-file plan before you confirm. Follow
[Lovely's official Proton instructions](https://github.com/ethangreen-dev/lovely-injector#manual-installation)
to set Balatro's Steam launch options:

```text
WINEDLLOVERRIDES="winmm=n,b" %command%
```

Launch through Steam, including when using Modatro's launch button. Modatro does
not edit Steam configuration or run a downloaded launcher. An older `version.dll`
installation requires Lovely's upstream upgrade procedure. Existing DLLs need
positive library evidence; the filename alone does not establish identity or version.

## Compatibility

Linux packages are x64; ARM Linux is not covered. A separately configured native
LÖVE installation and `liblovely.so` follow different upstream instructions and are
not managed by this integration. Native Steam Deck hardware and real-game launch
testing remain separate from Linux CI and package generation.

The app keeps Electron's sandbox enabled. If an AppImage cannot run because of a
distribution's FUSE or sandbox requirements, use the DEB on a compatible distribution
or report the exact error; Modatro does not bypass those protections.
