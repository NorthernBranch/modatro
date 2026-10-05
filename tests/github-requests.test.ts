import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { githubApiAvailable, remoteJson, safeFetch } from '../electron/services/network';

const release = 'https://api.github.com/repos/fixture/mod/releases/latest';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T14:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('deduplicates concurrent and repeated release checks, keeping results independent', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v1.0.0' })));
  vi.stubGlobal('fetch', fetch);
  const values = await Promise.all([remoteJson(release), remoteJson(release)]);
  expect(values).toEqual([{ tag_name: 'v1.0.0' }, { tag_name: 'v1.0.0' }]);
  expect(fetch).toHaveBeenCalledTimes(1);
  (values[0] as { tag_name: string }).tag_name = 'changed';
  expect(await remoteJson(release)).toEqual({ tag_name: 'v1.0.0' });
  vi.advanceTimersByTime(5 * 60000);
  await remoteJson(release);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps release caches separate for different repositories and API endpoints', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ url })));
  vi.stubGlobal('fetch', fetch);
  const other = release.replace('/fixture/mod/', '/fixture/other/');
  const commits = release.replace('/releases/latest', '/commits/main');
  expect(await remoteJson(release)).toEqual({ url: release });
  expect(await remoteJson(other)).toEqual({ url: other });
  expect(await remoteJson(commits)).toEqual({ url: commits });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('never caches raw removal policies', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ removals: [] })));
  vi.stubGlobal('fetch', fetch);
  const policy =
    'https://raw.githubusercontent.com/NorthernBranch/modatro/main/catalogue/revocations.json';
  await remoteJson(policy);
  await remoteJson(policy);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('shares a primary API cooldown across features without blocking archive downloads or raw policies', async () => {
  const reset = Date.now() + 10 * 60000;
  const fetch = vi.fn(async (url: string) =>
    url === release
      ? new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) },
        })
      : new Response('{}'),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(remoteJson(release)).rejects.toMatchObject({
    message: expect.stringContaining('10 minutes'),
    context: { retryable: true },
  });
  expect(githubApiAvailable()).toBe(false);
  await expect(safeFetch('https://api.github.com/repos/fixture/other')).rejects.toThrow(
    'request limit',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  await safeFetch('https://github.com/fixture/mod/releases/download/v1.0.0/mod.zip');
  await remoteJson('https://raw.githubusercontent.com/fixture/mod/main/policy.json');
  expect(fetch).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(10 * 60000);
  await safeFetch('https://api.github.com/repos/fixture/other');
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(githubApiAvailable()).toBe(true);
});

it.each(['120', 'Mon, 05 Oct 2026 14:02:00 GMT'])(
  'honours a secondary cooldown expressed as %s',
  async (retryAfter) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
      )
      .mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await expect(safeFetch(release)).rejects.toThrow('2 minutes');
    vi.advanceTimersByTime(119000);
    await expect(safeFetch(release)).rejects.toThrow('request limit');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await safeFetch(release);
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it('reserves API capacity based on successful responses from any feature', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('{}', {
        headers: {
          'x-ratelimit-remaining': '39',
          'x-ratelimit-reset': String(Date.now() / 1000 + 3600),
        },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await safeFetch(release);
  expect(githubApiAvailable(40)).toBe(false);
  expect(githubApiAvailable()).toBe(true);
});

it('does not misidentify permission errors as rate limits', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  await expect(safeFetch(release)).rejects.toThrow('denied access');
  await expect(safeFetch(release)).rejects.toThrow('denied access');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(githubApiAvailable()).toBe(true);
});

it('reuses only fresh releases during a cooldown and refuses an expired release', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: 'v1.0.0' })))
    .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '600' } }));
  vi.stubGlobal('fetch', fetch);
  await remoteJson(release);
  await expect(remoteJson('https://api.github.com/repos/fixture/other')).rejects.toThrow(
    'request limit',
  );
  expect(await remoteJson(release)).toEqual({ tag_name: 'v1.0.0' });
  vi.advanceTimersByTime(5 * 60000);
  await expect(remoteJson(release)).rejects.toThrow('request limit');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('briefly caches missing releases without inventing a successful release', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  await expect(remoteJson(release)).rejects.toMatchObject({ statusCode: 404 });
  await expect(remoteJson(release)).rejects.toMatchObject({ statusCode: 404 });
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60000);
  await expect(remoteJson(release)).rejects.toMatchObject({ statusCode: 404 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
