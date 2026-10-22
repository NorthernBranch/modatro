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

## Deploy to the existing site

The `modatro` Cloudflare Pages project uses Direct Upload and serves `modatro.app`.
From the repository root, authenticate once and deploy:

```sh
pnpm dlx wrangler@4 login
pnpm deploy:website
```

The script uploads local `website/` files to the production `main` branch, including
when run from a feature branch. Review and test the files first. It uses Wrangler 4
through `pnpm dlx`; no global installation or desktop build is needed. On PowerShell,
use `pnpm.cmd` if execution policy blocks `pnpm.ps1`. Local Wrangler state is ignored
by Git.

## Set up another Pages project

For automatic deployments from GitHub, create a separate project using Cloudflare's
[Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/):

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

## Feature screenshots

The landing page includes Discover, Profiles, Troubleshooting and Creator screenshots,
with representative selections, synthetic diagnostics and an example local project.
The creator is listed as an optional experimental feature. Capture the documented views
with `node scripts/screenshots.mjs`; the script copies the four website images into
`website/images/`. Screenshot cards remain contained at desktop and mobile widths.

Clicking any screenshot opens an enlarged, labelled dialog inside the page. Close
it with the Close button, Escape or a click outside; keyboard focus returns to the
original screenshot link. Background scrolling is paused while the viewer is open.
Without JavaScript, each link still opens the original image.

Website-only changes run shared checks, including website browser tests, but skip
desktop packaging and release publication. This includes HTML, CSS, scripts and
screenshot assets under `website/`. Deploy the website separately through Pages;
its download button always reads the latest published application release.
