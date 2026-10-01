import { version } from '../../package.json';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
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
export function validateRemoteUrl(value: string) {
  HttpsUrl.parse(value);
  const url = new URL(value);
  if (!DOWNLOAD_HOSTS.has(url.hostname) || (url.port && url.port !== '443'))
    throw new UserError(
      'Automatic downloads currently support HTTPS GitHub sources only. Open the repository for manual instructions.',
    );
  return url;
}
export async function safeFetch(url: string, signal?: AbortSignal): Promise<Response> {
  let current = url;
  for (let i = 0; i < 6; i++) {
    validateRemoteUrl(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(30000),
      headers: { 'User-Agent': `Modatro/${version}`, Accept: 'application/vnd.github+json' },
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
      throw new UserError(
        response.status === 403 || response.status === 429
          ? 'GitHub’s request limit was reached. Your cached catalogue is still available; try refreshing later.'
          : `The server returned ${response.status}. Try again later.`,
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
export async function remoteText(url: string): Promise<string> {
  return (await boundedBody(await safeFetch(url), 100000)).toString('utf8');
}
export class DownloadService {
  constructor(private directory: string) {}
  async download(
    url: string,
    signal: AbortSignal,
    progress: (percent?: number) => void,
  ): Promise<string> {
    const part = path.join(this.directory, `${randomUUID()}.part`),
      final = part.replace('.part', '.download');
    try {
      const response = await safeFetch(url, signal);
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
