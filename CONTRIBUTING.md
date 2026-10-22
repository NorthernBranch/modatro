# Contributing to Modatro

Bug reports, documentation improvements and code contributions are welcome. For a
substantial new feature, open an issue describing the user need and proposed behavior
so the scope can be discussed before implementation.

## Local development

Use Node.js 24 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the Electron main process and preload, starts Vite, and opens the
desktop app. Renderer changes reload through Vite; restart the command after changing
Electron services or the preload.

If you use Corepack, replace `pnpm` with `corepack pnpm`. For packaging,
electron-builder also invokes pnpm directly. A workspace shim supplies it when needed:

```sh
corepack enable --install-directory node_modules/.bin pnpm
```

`pnpm dev:web` runs a read-only browser preview with a checked-in catalogue sample.
It does not detect games, install mods or write game files. The desktop development
app uses real application data and can discover your Steam installation.

## Formatting and validation

Prettier formats source code and documentation. Run it before submitting a change:

```sh
pnpm format
pnpm check
```

Git's `.gitattributes` and Prettier enforce LF line endings on every platform,
including Windows. Binary assets retain their original bytes.

`pnpm check` verifies formatting and generated catalogue files, runs strict TypeScript
checks and the unit/service suite, then builds the renderer, main process and preload.
`pnpm test` runs the unit/service suite on its own.

For browser and Electron smoke tests, build first and install Playwright's browser:

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test:ui
```

Backend tests use temporary copies of [test fixtures](fixtures/README.md). Desktop
tests set `MODATRO_TEST_DATA` to an isolated directory, which disables automatic game
discovery and background network refreshes and isolates Electron's browser profile
and single-instance lock. Keep file-operation tests isolated from
real game folders. Creator tests must also keep source projects, artwork and exported
ZIPs in temporary data. Parse custom Lua without executing it; do not validate
creator changes by installing into a real game or reading personal saves.

## Build installers

After building the app, package a platform explicitly:

```sh
pnpm build
pnpm package:desktop --mac --arm64 --x64
```

On Windows:

```sh
pnpm build
pnpm package:desktop --win --x64
```

On Linux (x64, including Steam Deck):

```sh
pnpm build
pnpm package:desktop --linux --x64
```

This produces an AppImage and a DEB. CI runs browser and packaged Electron smoke
tests under Xvfb on Linux. Keep Electron's sandbox enabled in production and tests.

Installers are written to `release/`. macOS builds without Apple credentials use
complete ad-hoc signatures, verified by the packaging script; they remain unnotarized
test builds. With all credentials present, packaging requires Developer ID signing,
notarization, a stapled ticket and Gatekeeper acceptance. Partial configuration fails
instead of falling back. See [signing setup](docs/signing.md). Windows builds remain
unsigned until a separate publisher-signing integration is configured.

To build installers before merging, use **Actions → Test, build and release → Run
workflow**, select the PR branch, and download the resulting artifacts. Manual runs
do not publish releases.

To smoke-test an unpacked application, point `MODATRO_PACKAGED_EXECUTABLE` at its
executable and run `pnpm exec playwright test tests/desktop.spec.ts`. The test still
uses isolated application data.

## Publishing releases

PRs run the full shared checks and production compilation without creating installers.
Relevant changes merged to `main` build and test Windows, both macOS architectures,
and Linux installers before publishing a beta. Documentation, website and test-only
changes run checks without a desktop release.

Start the PR title with `MAJOR:`, `MINOR:` or `PATCH:`; no prefix defaults to patch.
CI reads the merged title and published release history, so normal releases need no
package-version edit. Use a `v<version>` tag for a deliberately named release.
See [release rules](docs/release.md#automated-beta-downloads) and
[signing setup](docs/signing.md) for publication and credential details.

## Documentation screenshots

Capture the current interface with representative catalogue data, synthetic setup
evidence and a sample creator project. The script checks the main pages at
desktop, tablet and narrow widths; it never reads personal logs or game saves.

The screenshots use the real renderer. Setup evidence, history and any log examples
are synthetic. Regenerate them from the repository root:

```sh
pnpm exec playwright install chromium
node scripts/screenshots.mjs
```

The script starts its own Vite server on port 5183, captures app and creator views
into `docs/images/`, then closes the browser and server. Discover, Profiles,
Troubleshooting and Creator images are also copied to `website/images/`.
The prerequisite preview expands a representative source record with a synthetic
checksum so long-value wrapping is visible. The script uses a
read-only desktop bridge and blocks external requests; it cannot discover or change
your game files. Review the images and commit them with any relevant documentation
changes. The screenshot data comes from the checked-in catalogue sample and does
not claim to be a live catalogue or your own installed collection.

## Catalogue contributions

Follow the [catalogue submission rules](catalogue/README.md) and
[third-party content policy](docs/content-policy.md). Author approval, display,
installation and update permission are separate from file integrity checks.
Never infer consent from archived index inclusion or a public repository.

After editing catalogue entries or restriction feeds, run `pnpm catalogue:build`,
commit the generated files, and run `pnpm catalogue:check`. Keep removals append-only
and increment feed revisions when changing restrictions.

## Pull requests and bug reports

Describe the problem, the resulting behavior and how you verified the change. Include
regression tests when changing file ownership, path validation, transactions or recovery.
See the [architecture guide](docs/architecture.md) for service boundaries.

For bug reports, include the Modatro version, operating system, steps to reproduce and
exact error text. **Settings → Copy diagnostics** provides a useful starting point.
Review diagnostics and logs for personal information before attaching them to a public
issue. Report problems in a particular mod to its author when they also occur outside
Modatro.

Submit changes through a pull request. [CODEOWNERS](.github/CODEOWNERS) requests
review from `@NorthernBranch`; protected-branch rules must enforce approvals in
GitHub's repository settings. The file alone does not prevent direct pushes.
