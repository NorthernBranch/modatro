# Modatro

**An independent community mod manager for Balatro.** Discover mods, check their
requirements, and manage your collection with backups and a record of every file change.

**Beta · Windows · macOS · Linux / Steam Deck**

[Download Modatro](https://github.com/NorthernBranch/modatro/releases) ·
[Report an issue](https://github.com/NorthernBranch/modatro/issues) ·
[Contribute](CONTRIBUTING.md)

![Modatro Discover showing mod browsing, search, categories and installation status](docs/images/discover.png)

| Your collection                                                                                                      | Prerequisite checks                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [![Installed mods with management actions and source records](docs/images/installed.png)](docs/images/installed.png) | [![Lovely, Steamodded and Talisman installation and version checks](docs/images/prerequisites.png)](docs/images/prerequisites.png) |

Screenshots show the current interface with representative catalogue and installation
data. Click either smaller image to view it at full size.

## Download

Choose an installer from [GitHub Releases](https://github.com/NorthernBranch/modatro/releases):

| Computer                | Installer                           |
| ----------------------- | ----------------------------------- |
| Windows, x64            | `Modatro-Setup-<version>.exe`       |
| Apple Silicon Mac       | `Modatro-<version>-arm64.dmg`       |
| Intel Mac               | `Modatro-<version>-x64.dmg`         |
| Linux / Steam Deck, x64 | `Modatro-<version>-x86_64.AppImage` |
| Debian / Ubuntu, x64    | `Modatro-<version>-amd64.deb`       |

The desktop app includes its runtime; you do not need Node.js or pnpm to use it.
Each successful release includes SHA-256 checksums and macOS signing reports.

The platform-aware download website is in [`website/`](website/). Maintainers can
use the [Cloudflare hosting and domain guide](docs/website.md) to deploy it.

> **Platform testing:** Windows has received the most complete manual testing.
> Feedback from macOS, Linux and Steam Deck users is welcome through
> [GitHub Issues](https://github.com/NorthernBranch/modatro/issues).

Windows beta installers are unsigned. macOS packages use verified ad-hoc signatures
unless Apple signing credentials are configured; ad-hoc builds are not notarized
and macOS may block opening them. Check the release notes and
[installation guide](docs/release.md) for the build's actual signing status.

## What Modatro does

- **Discover:** browse the live [Thunderstore Balatro catalogue](https://thunderstore.io/c/balatro/),
  search and filter mods, and sort by available GitHub star counts.
- **Additional sources:** optionally add a Balatro mod index by GitHub repository
  URL. Listings are fetched at runtime and deduplicated, with Thunderstore preferred.
  Details and install previews identify the source used.
- **Dependencies:** check installed versions, review required supported dependencies,
  and install them before the requested mod in one transaction.
- **Prerequisites:** detect and manage Lovely and Steamodded, including supported
  Lovely installation on Windows, macOS and Linux with Proton. Talisman is optional
  unless a mod requires it.
- **Your collection:** install, update, enable, disable and uninstall supported mods;
  adopt identified existing mods explicitly.
- **File records:** retain provenance, hashes and original-file backups. Changed
  files require review, and interrupted transactions have recovery records.
- **Offline browsing:** keep the last validated catalogue and locally manage
  installed mods. New downloads require current source and removal checks.
- **Application updates:** quietly indicate newer GitHub releases. Downloading and
  installing an update always requires your action.
- **Appearance:** choose a dark, light or system theme.

GitHub counts are cached and refreshed in small batches to preserve API capacity
for releases and installations. Missing counts are shown honestly; API limits can
temporarily prevent new release checks without removing your cached catalogue.

## Get started

1. Install Modatro and close Balatro before changing mods.
2. Select your Balatro installation during setup. Use Steam discovery or choose
   the game folder manually; the game and Mods folders remain separate.
3. Open **Prerequisites** to check Lovely, Steamodded and any additional requirements.
4. Browse **Discover**, open a mod's details, and review its installation plan
   when prompted. Required supported dependencies are installed after confirmation.
5. Use **Installed** to manage your collection and **Updates** to check mod versions.

Add or remove an optional index under **Settings → Mod sources**. The URL can include
`/tree/branch`; compatible indexes contain `mods/<id>/meta.json`. Removing an index
does not remove installed mods. Local ZIPs and explicit definitions are available
under **Settings → Advanced**.

If you already have outdated mods or loaders, starting with a fresh Balatro
installation is recommended. Back up saves and mods first. Modatro can try supported
updates in place, but older setups can still have compatibility problems.

On Steam Deck, use Desktop Mode and follow the [Steam/Proton setup guide](docs/linux.md).
For application updates, use **Settings → Application updates → Download update**,
then close Modatro and run the new installer. Keep application data and backups.

## Documentation and contributions

| Guide                                      | Covers                                                       |
| ------------------------------------------ | ------------------------------------------------------------ |
| [Troubleshooting](docs/troubleshooting.md) | Setup, dependencies, rate limits, changed files and recovery |
| [Releases](docs/release.md)                | Downloads, supported formats and release workflow            |
| [Linux and Steam Deck](docs/linux.md)      | AppImage / DEB installation and Proton integration           |
| [Signing](docs/signing.md)                 | Actual release signing status and maintainer setup           |
| [Contributing](CONTRIBUTING.md)            | Development, checks, packaging and screenshot capture        |
| [Architecture](docs/architecture.md)       | Services, provider boundaries and transactions               |
| [Verification](docs/verification.md)       | Automated coverage and manual testing limits                 |
| [Catalogue](catalogue/README.md)           | Metadata, permissions, exceptions and removal feeds          |
| [Website](docs/website.md)                 | Platform downloads, Cloudflare Pages and domain setup        |

Mods are third-party code. Modatro checks metadata, paths and file integrity; it
does not certify mod safety or guarantee that mods work together. Authors retain
ownership, and verified removal requests stop future downloads without remotely
changing installed copies. Read the [content and removal policy](docs/content-policy.md).

Modatro is licensed under [MIT](LICENSE). It is not affiliated with, endorsed by,
or sponsored by LocalThunk or Playstack.
