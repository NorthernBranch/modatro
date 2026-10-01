# Modatro

**A desktop mod manager for Balatro.** Find new mods, check what they need, and
manage your collection from one place.

Modatro browses the community [Balatro Mod Index](https://github.com/skyline69/balatro-mod-index)
and keeps a record of the files it installs. Backups, change detection and recovery
help preserve your existing game files when you update or remove a mod.

## Download

Visit [Releases](https://github.com/kylehepple/modatro/releases) for available downloads
and version notes. Choose the installer for your computer:

| Computer                    | Installer                     |
| --------------------------- | ----------------------------- |
| Windows, x64                | `Modatro-Setup-<version>.exe` |
| Mac with Apple Silicon      | `Modatro-<version>-arm64.dmg` |
| Mac with an Intel processor | `Modatro-<version>-x64.dmg`   |

Modatro is currently a preview. The current builds are unsigned; macOS builds are
also not notarized. See [release information](docs/release.md) for installation
instructions and supported mod formats. The desktop app includes its runtime;
you do not need Node.js or pnpm to use it.

## Get started

1. Install Modatro and close Balatro before changing mods.
2. Select your Balatro installation during setup. Modatro can discover Steam
   libraries, or you can choose the game folder yourself.
3. Check **Prerequisites** for Lovely, Steamodded and any additional requirements.
   Lovely installation on macOS follows the linked upstream instructions.
4. Browse **Discover**, open a mod's details, and install a supported mod.
5. Use **Installed** to manage your collection and **Updates** to check for new versions.

Your game folder and Mods folder are separate. You can review both in **Settings**.
Already-installed mods appear as unmanaged until Modatro can identify them and you
choose to adopt them.

## Your collection, with a record of every change

- Search mods and filter by category, author or installation status.
- Check dependencies and installed versions before installation.
- Install, update, uninstall, and enable or disable supported managed mods.
- Restore backed-up originals when removing mods that replace game files.
- Keep files you have edited when an uninstall detects a conflict.
- Browse the last saved catalogue while offline.
- Choose a dark, light or system theme.

Mods are third-party code. Review their source and requirements before installing.
Modatro checks file integrity and installation paths; it does not certify mod safety
or guarantee that mods work together.

## Help and contributions

Read the [troubleshooting guide](docs/troubleshooting.md) if setup, startup or a mod
operation fails. Report reproducible problems through
[GitHub Issues](https://github.com/kylehepple/modatro/issues), including your Modatro
version, operating system and the exact error message.

Contributions are welcome. The [contributor guide](CONTRIBUTING.md) covers local
development, formatting, tests and packaging. The [architecture guide](docs/architecture.md)
explains how catalogue retrieval and file operations work. The [release verification guide](docs/verification.md) maps the initial specification to implementation and test coverage, with platform limits stated explicitly.

Modatro is available under the [MIT license](LICENSE). It is an independent community
project, unaffiliated with Balatro, LocalThunk or Playstack.
