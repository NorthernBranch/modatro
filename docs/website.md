# Download website

The static landing page lives in [`website/`](../website/) alongside the desktop
app. It uses HTML, CSS and browser JavaScript; it needs no application build,
backend, signing credentials or hosted copy of the installers.

## Download behavior

The page reads public GitHub Releases at runtime, including beta releases, and
offers a matching Windows x64, Apple Silicon / Intel macOS, AppImage or DEB asset.
When a Mac's processor cannot be identified reliably, the visitor chooses it.
Unsupported or ambiguous platforms lead to the releases page. A smaller releases
link is always available so visitors can choose another download.

Failed requests, API limits and disabled JavaScript preserve a working GitHub
Releases link. The page does not download an installer until the visitor clicks.
Its headers restrict scripts and styles to the site and API connections to GitHub.

The page includes the Discover screenshot, canonical/search metadata, Open Graph
and Twitter image metadata, SoftwareApplication/WebSite JSON-LD, `robots.txt` and
`sitemap.xml`. The structured-data script has a SHA-256 allowance in `_headers`;
update that hash when editing its contents rather than weakening the CSP. Screenshot
regeneration also updates `website/images/discover.png`.

## Local preview and checks

From the repository root:

```sh
pnpm exec vite website --host 127.0.0.1 --port 5174
```

Open the printed local URL. Platform/release matching has unit coverage in
`tests/website.test.mjs`; browser checks use a separate server and configuration:

```sh
pnpm exec playwright install chromium
pnpm exec playwright test --config playwright.website.config.mjs
```

## Cloudflare Pages setup

Use Cloudflare's [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
to deploy website changes from this repository:

1. In **Workers & Pages**, create a Pages application connected to GitHub and select
   `NorthernBranch/modatro`.
2. Choose `main` as the production branch and use these settings:

| Setting                | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| Framework preset       | None                                                        |
| Root directory         | `website`                                                   |
| Build command          | Leave blank; `exit 0` also works when a command is required |
| Build output directory | `.`                                                         |
| Environment variable   | `SKIP_DEPENDENCY_INSTALL=true` for production and previews  |

3. Deploy and check the generated `pages.dev` URL. Limit build watch paths to
   `website/*` if desktop-only changes should not redeploy the site.

Only the static directory is deployed. The Pages project does not need the desktop
release workflow or access to Apple or Windows signing secrets.

## Connect modatro.app

Follow Cloudflare's [custom-domain setup](https://developers.cloudflare.com/pages/configuration/custom-domains/):

1. Open the Pages project and add `modatro.app` under **Custom domains**.
2. Use the Cloudflare account containing the domain's active DNS zone.
3. Review and confirm the DNS record offered by Cloudflare. Resolve conflicting
   records deliberately; preserve unrelated mail and verification records.
4. Wait until the domain and certificate are active, then check HTTPS and download
   links. An optional `www.modatro.app` domain can be added separately.

Register the domain with the Pages project before adding its DNS record; a CNAME
alone is not the complete association.

## Terminal uploads

With Wrangler installed through npm, authenticate and upload the static directory:

The existing `modatro` project uses Direct Upload and serves `modatro.app`; use its
production `main` branch when uploading. Local Wrangler state is excluded from Git.

```sh
npx wrangler login
npx wrangler pages deploy website --project-name modatro --branch main
```

On Windows PowerShell, use `npx.cmd` if script execution policy blocks `npx.ps1`.
The project must already exist; `wrangler pages project create modatro
--production-branch main` creates a new Direct Upload project when that workflow is
chosen. Choose Git integration when dashboard-managed Git deployments are desired.
Existing Git-integrated projects can also receive Wrangler uploads. Domain setup
can remain in the dashboard.

## Feature screenshots

The local landing page includes Discover, Profiles and Troubleshooting screenshots,
with representative selections and synthetic diagnostics. Capture all eight app views
with `node scripts/screenshots.mjs`; the script copies the three website images into
`website/images/`. Screenshot cards remain contained at desktop and mobile widths.

Publish the feature copy alongside the application release that contains profiles
and troubleshooting. This feature task updates the static source without deploying
the site or publishing an application release, so the live download stays unchanged.
