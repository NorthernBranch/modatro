# Modatro

> **Platform testing:** Modatro has only been fully tested on Windows. Feedback from macOS, Linux and Steam Deck users would be appreciated. Please report your experience or any issues through [GitHub Issues](https://github.com/NorthernBranch/modatro/issues).

**An independent community mod manager for Balatro.** Find new mods, check what they need, and
manage your collection from one place.

Modatro browses the live [Thunderstore Balatro catalogue](https://thunderstore.io/c/balatro/)
and keeps a record of the files it installs. Backups, change detection and recovery
help preserve your existing game files when you update or remove a mod.

Discover uses Thunderstore's live Balatro listing index and a validated local cache.
New packages, versions, categories and dependencies appear on refresh without a Modatro
release. Required package changes are staged together, reviewed when necessary, and
installed in dependency order in one transaction. Local ZIP files and explicit GitHub
definitions remain available under Settings → Advanced.

An additional Balatro mod index can be added during first-time setup or under
**Settings → Mod sources**. Paste its GitHub repository URL (including `/tree/branch` if
needed). Modatro reads `mods/<id>/meta.json` from that repository and merges the results
with Thunderstore. Matching GitHub repositories and known identities are deduplicated,
with Thunderstore taking priority. Mod details and installation previews identify the
source. Clear the URL and choose **Remove index** to return to Thunderstore alone;
installed mods remain manageable. Index metadata is cached separately for each URL.

Discover shows GitHub repository stars beside mod titles and offers a popularity sort.
Counts are fetched at runtime and cached for offline browsing. Repositories shared by
multiple listings use the same count; unavailable counts appear last when sorting by
popularity. GitHub rate limits never block catalogue browsing or installation.

## Download

Visit [Releases](https://github.com/NorthernBranch/modatro/releases) for available downloads
and version notes. Choose the installer for your computer:

| Computer                    | Installer                           |
| --------------------------- | ----------------------------------- |
| Windows, x64                | `Modatro-Setup-<version>.exe`       |
| Mac with Apple Silicon      | `Modatro-<version>-arm64.dmg`       |
| Mac with an Intel processor | `Modatro-<version>-x64.dmg`         |
| Steam Deck / Linux, x64     | `Modatro-<version>-x86_64.AppImage` |
| Debian / Ubuntu, x64        | `Modatro-<version>-amd64.deb`       |

Each successful push to `main` publishes a beta with installers for every platform and
SHA-256 checksums. The release notes identify its build number and source commit.
App versions increase automatically with each workflow run, including merges into `main`;
the displayed version, installers and release notes use the same generated version.

Modatro is currently in beta. Windows builds are unsigned. macOS beta builds use
ad-hoc signatures unless Apple signing credentials are configured; those builds
are not Apple-verified or notarized and macOS may block opening them. Each release
reports its signing status. See [release information](docs/release.md) for installation
instructions and supported mod formats. The desktop app includes its runtime;
you do not need Node.js or pnpm to use it.

Modatro checks GitHub Releases at startup and quietly indicates when a newer beta or
stable version is available. Use **Settings → Application updates → Download update**
to open your platform's installer in the browser. Nothing downloads automatically.
Close Modatro before running the installer; application data and mod backups remain
in their existing locations. **Check for updates** can also be used manually.

On Steam Deck, run the AppImage in Desktop Mode. Linux game integration uses Steam
and Proton; see [Linux and Steam Deck setup](docs/linux.md).

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

Identified external folders and standalone Lua mods can be adopted explicitly,
including mods absent from the catalogue. Adoption records their current files;
it does not download a replacement or invent their original source. Catalogue
updates require a unique identity match. Unidentified or ambiguous copies stay external.

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

Mod authors retain ownership of their mods. Modatro does not claim ownership and
normally downloads directly from upstream distribution sources instead of rehosting
archives. Authors may request removal, which stops future installations and updates
without remotely changing existing user copies. Read the [content and removal policy](docs/content-policy.md)
and [catalogue contribution rules](catalogue/README.md).

## Help and contributions

Read the [troubleshooting guide](docs/troubleshooting.md) if setup, startup or a mod
operation fails. Report reproducible problems through
[GitHub Issues](https://github.com/NorthernBranch/modatro/issues), including your Modatro
version, operating system and the exact error message.

Contributions are welcome. The [contributor guide](CONTRIBUTING.md) covers local
development, formatting, tests and packaging. The [architecture guide](docs/architecture.md)
explains how catalogue retrieval and file operations work. The [release verification guide](docs/verification.md) maps the initial specification to implementation and test coverage, with platform limits stated explicitly.

Modatro is available under the [MIT license](LICENSE). It is an independent community
project and is not affiliated with, endorsed by, or sponsored by LocalThunk or Playstack.
