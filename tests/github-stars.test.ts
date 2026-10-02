import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubStars } from '../electron/services/github-stars';
import { UserError } from '../electron/services/errors';
import { mod, setup, thunderstorePackage } from './helpers';
import { normalizeThunderstore } from '../src/shared/thunderstore';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it('deduplicates repository lookups and preserves zero and cached counts across restarts', async () => {
  const f = await setup();
  roots.push(f.root);
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ full_name: 'fixture/mod', stargazers_count: 0 })),
  );
  const source = new GitHubStars(f.storage, fetch);
  const mods = [mod(), mod({ id: 'second', repositoryUrl: 'https://github.com/Fixture/Mod.git' })];
  expect(await source.get(mods)).toEqual({ 'test-mod': 0, second: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await new GitHubStars(f.storage, fetch).get(mods)).toEqual({ 'test-mod': 0, second: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves stale counts on failure and does not invent counts for unsupported or unavailable repositories', async () => {
  const f = await setup();
  roots.push(f.root);
  await f.storage.write('catalogue-cache/github-stars.json', {
    'fixture/mod': { stars: 123, checkedAt: 0 },
  });
  const fetch = vi.fn(async () => {
    throw new UserError('rate limited', undefined, undefined, undefined, 403);
  });
  const source = new GitHubStars(f.storage, fetch);
  const mods = [
    mod(),
    mod({ id: 'other', repositoryUrl: 'https://github.com/fixture/other' }),
    mod({ id: 'unsupported', repositoryUrl: 'https://example.com/mod' }),
  ];
  expect(await source.get(mods)).toEqual({ 'test-mod': 123 });
  expect(await source.get(mods)).toEqual({ 'test-mod': 123 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reserves GitHub capacity for installations and rejects mismatched repository responses', async () => {
  const f = await setup();
  roots.push(f.root);
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ full_name: 'fixture/mod', stargazers_count: 20 }), {
        headers: { 'x-ratelimit-remaining': '20' },
      }),
  );
  const mods = [mod(), mod({ id: 'other', repositoryUrl: 'https://github.com/fixture/other' })];
  expect(await new GitHubStars(f.storage, fetch).get(mods)).toEqual({ 'test-mod': 20 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const mismatch = vi.fn(
    async () =>
      new Response(JSON.stringify({ full_name: 'unrelated/project', stargazers_count: 999 })),
  );
  expect(await new GitHubStars(f.storage, mismatch).get([mods[1]!])).toEqual({});
});

it('fetches Thunderstore stars before an optional index consumes the request budget', async () => {
  const f = await setup();
  roots.push(f.root);
  const registry = normalizeThunderstore(
    thunderstorePackage({ website: 'https://github.com/Author/Demo/releases/latest' }),
  )!;
  const indexMods = Array.from({ length: 45 }, (_, i) =>
    mod({
      id: `index-${i}`,
      repositoryUrl: `https://github.com/index/mod-${i}`,
      source: { provider: 'mod-index', externalId: `index-${i}` },
    }),
  );
  const fetch = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify({ full_name: url.split('/repos/')[1], stargazers_count: 123 }), {
        headers: { 'x-ratelimit-remaining': '20' },
      }),
  );
  const result = await new GitHubStars(f.storage, fetch).get([...indexMods, registry]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe('https://api.github.com/repos/author/demo');
  expect(result).toEqual({ [registry.id]: 123 });
  expect(indexMods[0]!.id).toBe('index-0');
});

it('maps redirected repository stars to Thunderstore package IDs without trusting unrelated responses', async () => {
  const f = await setup();
  roots.push(f.root);
  const registry = normalizeThunderstore(
    thunderstorePackage({ website: 'https://github.com/OldOwner/Demo' }),
  )!;
  const fetch = vi.fn(async () => {
    const response = new Response(
      JSON.stringify({ full_name: 'NewOwner/Demo', stargazers_count: 456 }),
    );
    Object.defineProperty(response, 'url', { value: 'https://api.github.com/repos/NewOwner/Demo' });
    return response;
  });
  const source = new GitHubStars(f.storage, fetch);
  const renamed = mod({ id: 'renamed', repositoryUrl: 'https://github.com/NewOwner/Demo' });
  expect(await source.get([registry, renamed])).toEqual({ [registry.id]: 456, renamed: 456 });
  expect(await source.get([registry])).toEqual({ [registry.id]: 456 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
