import semver from 'semver';
import { z } from 'zod';
import { HttpsUrl, type Snapshot } from '../../src/shared/model';
import { remoteJson } from './network';
import { Storage } from './storage';

const repository = 'NorthernBranch/modatro';
export const APP_RELEASES_ENDPOINT = `https://api.github.com/repos/${repository}/releases?per_page=100`;
const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: HttpsUrl,
  assets: z
    .array(
      z.object({
        name: z.string(),
        browser_download_url: HttpsUrl,
        size: z.number().nonnegative(),
      }),
    )
    .max(100),
});
const Saved = z.object({
  version: z.string(),
  releaseUrl: HttpsUrl,
  downloadUrl: HttpsUrl.optional(),
  checkedAt: z.iso.datetime(),
});
function releaseVersion(tag: string) {
  const rolling = /^v(\d+\.\d+\.\d+)-beta\.build\.\d+\.[a-f0-9]{7}$/.exec(tag);
  return (
    rolling?.[1] ??
    (/^v\d+\.\d+\.\d+(?:-beta(?:\.[\w.-]+)?)?$/.test(tag)
      ? (semver.valid(tag.slice(1)) ?? undefined)
      : undefined)
  );
}
function releaseLink(value: string) {
  const url = new URL(value);
  return (
    url.hostname === 'github.com' &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(`/${repository}/releases/tag/`)
  );
}
export function newestAppRelease(
  payload: unknown,
  current: string,
  platform: string,
  arch: string,
  debian = false,
) {
  if (!semver.valid(current)) return undefined;
  const releases = z
    .array(z.unknown())
    .max(100)
    .parse(payload)
    .flatMap((raw) => {
      const parsed = Release.safeParse(raw);
      if (!parsed.success || parsed.data.draft || !releaseLink(parsed.data.html_url)) return [];
      const version = releaseVersion(parsed.data.tag_name);
      if (
        !version ||
        !semver.gt(version, current) ||
        new URL(parsed.data.html_url).pathname !==
          `/${repository}/releases/tag/${parsed.data.tag_name}`
      )
        return [];
      const name =
        platform === 'win32' && arch === 'x64'
          ? `Modatro-Setup-${version}.exe`
          : platform === 'darwin' && ['arm64', 'x64'].includes(arch)
            ? `Modatro-${version}-${arch}.dmg`
            : platform === 'linux' && arch === 'x64'
              ? `Modatro-${version}-${debian ? 'amd64.deb' : 'x86_64.AppImage'}`
              : undefined;
      const asset = parsed.data.assets.find((entry) => {
        if (entry.name !== name || !entry.size) return false;
        const url = new URL(entry.browser_download_url);
        return (
          url.hostname === 'github.com' &&
          !url.search &&
          !url.hash &&
          url.pathname === `/${repository}/releases/download/${parsed.data.tag_name}/${name}`
        );
      });
      if (name && !asset) return [];
      return [
        { version, releaseUrl: parsed.data.html_url, downloadUrl: asset?.browser_download_url },
      ];
    });
  return releases.sort((a, b) => semver.rcompare(a.version, b.version))[0];
}

export class AppUpdates {
  state: NonNullable<Snapshot['appUpdate']> = { checking: false };
  private active?: Promise<void>;
  constructor(
    private storage: Storage,
    private current: string,
    private changed: () => void,
    private json = remoteJson,
    private platform: string = process.platform,
    private arch: string = process.arch,
    private debian = process.platform === 'linux' && !process.env.APPIMAGE,
  ) {}
  async loadCache() {
    try {
      const saved = await this.storage.read('catalogue-cache/app-update.json', Saved.nullable());
      if (
        saved &&
        semver.valid(saved.version) &&
        semver.valid(this.current) &&
        semver.gt(saved.version, this.current) &&
        releaseLink(saved.releaseUrl) &&
        (!saved.downloadUrl ||
          (new URL(saved.downloadUrl).hostname === 'github.com' &&
            new URL(saved.downloadUrl).pathname.startsWith(`/${repository}/releases/download/`)))
      )
        this.state = { ...saved, checking: false };
    } catch {
      /* Update checks never lock the application. */
    }
  }
  async check() {
    if (this.active) return this.active;
    this.active = this.fetch();
    try {
      await this.active;
    } finally {
      this.active = undefined;
    }
  }
  private async fetch() {
    this.state = { ...this.state, checking: true, error: undefined };
    this.changed();
    try {
      const release = newestAppRelease(
        await this.json(APP_RELEASES_ENDPOINT),
        this.current,
        this.platform,
        this.arch,
        this.debian,
      );
      this.state = { ...release, checkedAt: new Date().toISOString(), checking: false };
      try {
        await this.storage.write(
          'catalogue-cache/app-update.json',
          release
            ? {
                ...release,
                checkedAt: this.state.checkedAt,
              }
            : null,
        );
      } catch {
        /* A cache failure does not invalidate a successful release check. */
      }
    } catch {
      this.state = {
        ...this.state,
        checking: false,
        error: 'Update checks are unavailable. Try again when connected.',
      };
    }
    this.changed();
  }
}
