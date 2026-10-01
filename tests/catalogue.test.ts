import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BalatroModIndexRepository, normalizeMod } from '../electron/services/catalogue';
import { setup } from './helpers';
const roots: string[] = [];
const source = {
  title: 'Demo',
  author: 'Author',
  version: '1.0.0',
  repo: 'https://github.com/author/demo',
  downloadURL: 'https://github.com/author/demo/archive/v1.zip',
  categories: ['Joker', 'API'],
  'requires-steamodded': true,
  'requires-talisman': false,
};
const tree = {
  sha: 'a'.repeat(40),
  truncated: false,
  tree: [{ path: 'mods/Author@Demo/meta.json', type: 'blob', sha: 'b'.repeat(40) }],
};
const commit = { sha: 'c'.repeat(40), commit: { tree: { sha: tree.sha } } };
const json =
  (value: unknown = tree) =>
  async (url: string) =>
    url.includes('/commits/') ? commit : value;
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
describe('machine-readable catalogue and caching', () => {
  it('normalises index flags and display categories without changing source metadata', () => {
    const m = normalizeMod('Author@Demo', source);
    expect(m.categories).toEqual(['Jokers', 'APIs']);
    expect(m.sourceCategories).toEqual(['Joker', 'API']);
    expect(m.prerequisites[0]?.versionConstraint).toBeUndefined();
  });
  it('validates source URLs and folder names', () => {
    expect(() =>
      normalizeMod('Author@Demo', { ...source, downloadURL: 'http://insecure.example/mod.zip' }),
    ).toThrow();
    expect(() => normalizeMod('Author@Demo', { ...source, folderName: '../escape' })).toThrow();
  });
  it('caches a complete validated refresh and immediately reloads it on restart', async () => {
    const f = await fixture(),
      text = vi.fn(async (_url: string) => JSON.stringify(source));
    const repository = new BalatroModIndexRepository(f.storage, f.logger, undefined, json(), text);
    await repository.refresh();
    expect(repository.catalogue.stale).toBe(false);
    expect(text.mock.calls[0]?.[0]).toContain(`${commit.sha}/mods/Author%40Demo/meta.json`);
    const loaded = new BalatroModIndexRepository(f.storage, f.logger);
    await loaded.loadCache();
    expect(loaded.catalogue.mods[0]?.title).toBe('Demo');
    expect(loaded.catalogue.stale).toBe(true);
  });
  it('continues serving the saved catalogue when GitHub is unavailable', async () => {
    const f = await fixture();
    await f.storage.write('catalogue-cache/catalogue.json', {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      mods: [normalizeMod('Author@Demo', source)],
      rejected: 0,
    });
    const repository = new BalatroModIndexRepository(f.storage, f.logger, undefined, async () => {
      throw new Error('offline');
    });
    await repository.loadCache();
    await repository.refresh();
    expect(repository.catalogue.mods[0]?.title).toBe('Demo');
    expect(repository.catalogue.stale).toBe(true);
    expect(repository.catalogue.error).toBe('offline');
  });
  it('migrates the legacy catalogue without changing Electron cache files', async () => {
    const f = await fixture();
    await fs.mkdir(f.storage.file('Cache'));
    await fs.writeFile(f.storage.file('Cache/browser-data'), 'chromium cache');
    const legacy = {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      mods: [normalizeMod('Author@Demo', source)],
      rejected: 0,
    };
    await f.storage.write('cache/catalogue.json', legacy);
    const repository = new BalatroModIndexRepository(f.storage, f.logger);
    await repository.loadCache();
    expect(repository.catalogue.mods[0]?.title).toBe('Demo');
    expect(
      JSON.parse(await fs.readFile(f.storage.file('catalogue-cache/catalogue.json'), 'utf8')),
    ).toEqual(legacy);
    expect(await fs.readFile(f.storage.file('Cache/browser-data'), 'utf8')).toBe('chromium cache');
    expect(JSON.parse(await fs.readFile(f.storage.file('cache/catalogue.json'), 'utf8'))).toEqual(
      legacy,
    );
  });
  it('never replaces a good cache with a truncated tree', async () => {
    const f = await fixture();
    const repository = new BalatroModIndexRepository(
      f.storage,
      f.logger,
      undefined,
      json({ ...tree, truncated: true }),
    );
    repository.catalogue.mods = [normalizeMod('Author@Demo', source)];
    await repository.refresh();
    expect(repository.catalogue.mods[0]?.title).toBe('Demo');
    expect(repository.catalogue.error).toBeTruthy();
  });
  it('rejects partial transport failure instead of saving an incomplete catalogue', async () => {
    const f = await fixture();
    const repository = new BalatroModIndexRepository(
      f.storage,
      f.logger,
      undefined,
      json(),
      async () => {
        throw new Error('incomplete download');
      },
    );
    repository.catalogue.mods = [normalizeMod('Author@Demo', source)];
    await repository.refresh();
    expect(repository.catalogue.mods).toHaveLength(1);
    expect(repository.catalogue.error).toBe('incomplete download');
  });
  it('rejects a tree which does not match the selected commit', async () => {
    const f = await fixture();
    const repository = new BalatroModIndexRepository(
      f.storage,
      f.logger,
      undefined,
      json({ ...tree, sha: 'd'.repeat(40) }),
    );
    repository.catalogue.mods = [normalizeMod('Author@Demo', source)];
    await repository.refresh();
    expect(repository.catalogue.error).toContain('does not match');
    expect(repository.catalogue.mods[0]?.title).toBe('Demo');
  });
  it('marks malformed individual mods unavailable without crashing valid entries', async () => {
    const f = await fixture();
    const t = {
      ...tree,
      tree: [...tree.tree, { path: 'mods/Other@Bad/meta.json', type: 'blob', sha: 'c'.repeat(40) }],
    };
    const repository = new BalatroModIndexRepository(
      f.storage,
      f.logger,
      undefined,
      json(t),
      async (url) => (url.includes('Other%40Bad') ? '{malformed' : JSON.stringify(source)),
    );
    await repository.refresh();
    expect(repository.catalogue.mods).toHaveLength(2);
    expect(repository.catalogue.rejected).toBe(1);
    expect(
      repository.catalogue.mods.find((m) => m.id === 'Other@Bad')?.unavailableReason,
    ).toBeTruthy();
  });
});
