import { version } from '../../package.json';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HttpsUrl } from '../../src/shared/model';
import { UserError } from './errors';
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
export type RemoteSource = 'github' | 'thunderstore';
const retryNotBefore = new Map<string, number>();
export function validateRemoteUrl(value: string, source: RemoteSource = 'github') {
  HttpsUrl.parse(value);
  const url = new URL(value);
  const supported =
    source === 'github'
      ? DOWNLOAD_HOSTS.has(url.hostname)
      : (url.hostname === 'thunderstore.io' &&
          (url.pathname === '/c/balatro/api/v1/package-listing-index/' ||
            /^\/package\/download\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/\d+\.\d+\.\d+\/$/.test(
              url.pathname,
            ))) ||
        (['ccdn.thunderstore.io', 'gcdn.thunderstore.io'].includes(url.hostname) &&
          (/^\/live\/repository\/packages\/[A-Za-z0-9_.-]+\.zip$/.test(url.pathname) ||
            /^\/live\/blob-storage\/sha256\/[a-f0-9]{64}\.[A-Za-z0-9_.-]+\.blob$/.test(
              url.pathname,
            )));
  if (
    !supported ||
    (url.port && url.port !== '443') ||
    url.hash ||
    (source === 'thunderstore' && url.search)
  )
    throw new UserError(
      source === 'github'
        ? 'Automatic downloads currently support HTTPS GitHub sources only. Open the repository for manual instructions.'
        : 'This URL is outside the supported Thunderstore catalogue and download locations.',
    );
  return url;
}
export async function safeFetch(
  url: string,
  signal?: AbortSignal,
  source: RemoteSource = 'github',
): Promise<Response> {
  let current = url;
  let retries = 0;
  for (let i = 0; i < 6; i++) {
    const target = validateRemoteUrl(current, source);
    const cooldown = source === 'thunderstore' ? retryNotBefore.get(target.hostname) : undefined;
    if (cooldown && cooldown > Date.now())
      throw new UserError(
        `Thunderstore requested a cooldown. Try refreshing again in ${Math.ceil((cooldown - Date.now()) / 1000)} seconds; your cached catalogue is available.`,
        undefined,
        undefined,
        { retryable: true },
        429,
      );
    if (cooldown) retryNotBefore.delete(target.hostname);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(30000),
      headers: {
        'User-Agent': `Modatro/${version}`,
        Accept:
          source === 'github'
            ? 'application/vnd.github+json'
            : 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new UserError('The download redirected without providing a location.');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (
        source === 'thunderstore' &&
        response.status === 429 &&
        response.headers.has('retry-after')
      ) {
        const value = response.headers.get('retry-after')!;
        const until = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
        if (Number.isFinite(until) && until > Date.now())
          retryNotBefore.set(target.hostname, until);
      }
      if (
        source === 'thunderstore' &&
        (response.status === 429 || response.status >= 500) &&
        retries < 2
      ) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now())
          : 500 * 2 ** retries;
        // Long server cooldowns are respected by ending this request; never
        // retry sooner than the server asks or tie up startup indefinitely.
        if (Number.isFinite(delay) && delay <= 30000) {
          retries++;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, delay);
            function done() {
              signal?.removeEventListener('abort', cancelled);
              resolve();
            }
            function cancelled() {
              clearTimeout(timer);
              reject(signal?.reason);
            }
            if (signal?.aborted) cancelled();
            else signal?.addEventListener('abort', cancelled, { once: true });
          });
          i--;
          continue;
        }
      }
      throw new UserError(
        response.status === 403 || response.status === 429
          ? `${source === 'github' ? 'GitHub' : 'Thunderstore'}’s request limit was reached. Your cached catalogue is still available; try refreshing later.`
          : response.status === 404 || response.status === 410
            ? 'The original download source is no longer available. Your installed copy has not been changed.'
            : `The server returned ${response.status}. Try again later.`,
        undefined,
        undefined,
        undefined,
        response.status,
      );
    }
    return response;
  }
  throw new UserError('The download redirected too many times.');
}
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new UserError('The server sent an empty response.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > limit) throw new UserError('The server response exceeds the size limit.');
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    /* Iteration cancellation closes the stream on failure. */
  }
  return Buffer.concat(chunks);
}
export async function remoteJson(url: string): Promise<unknown> {
  return JSON.parse((await boundedBody(await safeFetch(url), 20 * 1024 * 1024)).toString('utf8'));
}
export async function remoteThunderstoreJson(url: string): Promise<unknown> {
  let bytes = await boundedBody(await safeFetch(url, undefined, 'thunderstore'), 20 * 1024 * 1024);
  const expected = /\/live\/blob-storage\/sha256\/([a-f0-9]{64})\./.exec(
    new URL(url).pathname,
  )?.[1];
  if (expected && createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new UserError(
      'The catalogue chunk is incomplete or does not match its content hash. Keeping the previous catalogue.',
    );
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = gunzipSync(bytes, { maxOutputLength: 40 * 1024 * 1024 });
  return JSON.parse(bytes.toString('utf8'));
}
export async function remoteText(url: string): Promise<string> {
  return (await boundedBody(await safeFetch(url), 100000)).toString('utf8');
}
export class DownloadService {
  finalUrl?: string;
  constructor(private directory: string) {}
  async download(
    url: string,
    signal: AbortSignal,
    progress: (percent?: number) => void,
    source: RemoteSource = 'github',
  ): Promise<string> {
    const part = path.join(this.directory, `${randomUUID()}.part`),
      final = part.replace('.part', '.download');
    try {
      const response = await safeFetch(url, signal, source);
      this.finalUrl = response.url || url;
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new UserError(
          'The download is a web page rather than a mod archive. Automatic installation is not supported.',
        );
      }
      const total = Number(response.headers.get('content-length')) || undefined;
      if (total && total > 512 * 1024 * 1024) {
        await response.body?.cancel();
        throw new UserError('This download exceeds the 512 MB limit.');
      }
      if (!response.body) throw new UserError('The download is empty.');
      const handle = await fs.open(part, 'wx', 0o600);
      let received = 0,
        lastUpdate = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted();
          received += chunk.length;
          if (received > 512 * 1024 * 1024)
            throw new UserError('This download exceeds the 512 MB limit.');
          await handle.writeFile(chunk);
          if (Date.now() - lastUpdate > 150) {
            progress(total ? Math.min(99, Math.round((received / total) * 100)) : undefined);
            lastUpdate = Date.now();
          }
        }
        if (received === 0 || (total && total !== received))
          throw new UserError('The download is incomplete. Try again.');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(part, final);
      progress(100);
      return final;
    } catch (e) {
      await fs.rm(part, { force: true });
      await fs.rm(final, { force: true });
      if (signal.aborted)
        throw new UserError('Download cancelled. No installed files were changed.');
      throw e;
    }
  }
}
