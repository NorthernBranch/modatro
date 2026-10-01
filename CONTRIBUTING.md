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

`pnpm check` verifies formatting, runs strict TypeScript checks and the backend test
suite, then builds the renderer, main process and preload. `pnpm test` runs the backend
suite on its own.

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
real game folders.

## Build installers

After building the app, package a platform explicitly:

```sh
pnpm build
pnpm exec electron-builder --mac --arm64 --x64 --publish never
```

On Windows:

```sh
pnpm build
pnpm exec electron-builder --win --x64 --publish never
```

Installers are written to `release/`. Signing requires platform credentials; local
builds without them are unsigned. CI validates the project and uploads installer
artifacts without publishing a release.

To smoke-test an unpacked application, point `MODATRO_PACKAGED_EXECUTABLE` at its
executable and run `pnpm exec playwright test tests/desktop.spec.ts`. The test still
uses isolated application data.

## Pull requests and bug reports

Describe the problem, the resulting behavior and how you verified the change. Include
regression tests when changing file ownership, path validation, transactions or recovery.
See the [architecture guide](docs/architecture.md) for service boundaries.

For bug reports, include the Modatro version, operating system, steps to reproduce and
exact error text. **Settings → Copy diagnostics** provides a useful starting point.
Review diagnostics and logs for personal information before attaching them to a public
issue. Report problems in a particular mod to its author when they also occur outside
Modatro.
