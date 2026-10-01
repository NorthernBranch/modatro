import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadService, safeFetch, validateRemoteUrl } from '../electron/services/network';
import { tempRoot } from './helpers';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
describe('download boundaries', () => {
  it.each([
    'http://github.com/a/b',
    'https://127.0.0.1/mod.zip',
    'https://github.com.evil.test/mod.zip',
    'https://user:password@github.com/a',
    'https://github.com:444/a',
  ])('rejects unsafe source %s', (url) => {
    expect(() => validateRemoteUrl(url)).toThrow();
  });
  it('rejects a redirect to a private or arbitrary host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
      ),
    );
    await expect(safeFetch('https://github.com/a/b')).rejects.toThrow('GitHub sources only');
  });
  it('checks HTTP status rather than accepting an error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 404 })),
    );
    await expect(safeFetch('https://github.com/a/b')).rejects.toThrow('404');
  });
  it('rejects HTML downloads and cleans failed temporary files', async () => {
    const root = await tempRoot();
    roots.push(root);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    await expect(
      new DownloadService(root).download(
        'https://github.com/a/b',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('web page');
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('writes an isolated temporary download and reports completion', async () => {
    const root = await tempRoot();
    roots.push(root);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }),
      ),
    );
    const progress = vi.fn();
    const file = await new DownloadService(root).download(
      'https://github.com/a/b',
      new AbortController().signal,
      progress,
    );
    expect([...(await fs.readFile(file))]).toEqual([1, 2, 3]);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(file).toContain('.download');
  });
  it('cleans cancelled downloads', async () => {
    const root = await tempRoot();
    roots.push(root);
    const abort = new AbortController();
    abort.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    await expect(
      new DownloadService(root).download('https://github.com/a/b', abort.signal, () => {}),
    ).rejects.toThrow('cancelled');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
