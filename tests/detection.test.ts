import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GameDetectionService, steamLibraries } from '../electron/services/detection';
import { exists, safeDestination } from '../electron/services/files';
import { fakeGame, put, tempRoot } from './helpers';
const roots: string[] = [];
async function root() {
  const p = await tempRoot();
  roots.push(p);
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0)) await fs.rm(p, { recursive: true, force: true });
});
describe('Balatro path validation', () => {
  it('accepts a Windows fixture with executable evidence and support files', async () => {
    const r = await root(),
      game = await fakeGame(r);
    expect(await new GameDetectionService('win32', r).validate(game)).toMatchObject({
      valid: true,
      canonicalPath: game,
      detectedPlatform: 'windows',
    });
  });
  it('rejects a folder simply named Balatro', async () => {
    const r = await root(),
      game = path.join(r, 'Balatro');
    await fs.mkdir(game);
    expect((await new GameDetectionService('win32', r).validate(game)).valid).toBe(false);
  });
  it('rejects a fake exe without a binary signature', async () => {
    const r = await root(),
      game = await fakeGame(r);
    await put(path.join(game, 'Balatro.exe'), 'not an executable');
    expect((await new GameDetectionService('win32', r).validate(game)).valid).toBe(false);
  });
  it('validates the complete macOS bundle and returns its containing game directory', async () => {
    const r = await root(),
      game = path.join(r, 'Balatro'),
      app = path.join(game, 'Balatro.app');
    await put(
      path.join(app, 'Contents', 'Info.plist'),
      '<key>CFBundleName</key><string>Balatro</string>',
    );
    await put(path.join(app, 'Contents', 'Resources', 'Balatro.love'));
    await fs.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents', 'MacOS', 'love'), Buffer.from('cffaedfe', 'hex'));
    expect(await new GameDetectionService('darwin', r).validate(app)).toMatchObject({
      valid: true,
      canonicalPath: game,
      detectedPlatform: 'macos',
    });
  });
  it('rejects an installation from the wrong platform', async () => {
    const r = await root();
    expect(
      (await new GameDetectionService('darwin', r).validate(await fakeGame(r))).problems.some(
        (p) => p.code === 'wrong-platform',
      ),
    ).toBe(true);
  });
  it('keeps the game and Mods directories separate', async () => {
    const r = await root(),
      game = await fakeGame(r),
      mods = path.join(game, 'Mods');
    await fs.mkdir(mods);
    await expect(new GameDetectionService('win32', r).validateMods(mods, game)).rejects.toThrow(
      'separate',
    );
  });
  it('rejects a system/home directory as a Mods override', async () => {
    const r = await root();
    await expect(new GameDetectionService('win32', r).validateMods(r)).rejects.toThrow(
      'home or system',
    );
  });
  it('reads custom Steam library paths and legacy VDF paths', () => {
    const posix =
      '"libraryfolders" { "0" { "path" "/Volumes/Games/Steam" } "1" "/another/library" }';
    expect(steamLibraries(posix)).toEqual(['/Volumes/Games/Steam', '/another/library']);
  });
});
describe('canonical destination safety', () => {
  it('accepts existing case aliases while retaining the real path spelling', async ({ skip }) => {
    const r = await root();
    await put(path.join(r, 'Content', 'Main.lua'));
    if (!(await exists(path.join(r, 'content', 'main.lua')))) skip();
    expect(await safeDestination(r, 'content/main.lua')).toBe(path.join(r, 'Content', 'Main.lua'));
    expect(await safeDestination(r, 'content/new/file.lua')).toBe(
      path.join(r, 'Content', 'new', 'file.lua'),
    );
  });
  it('keeps distinct case-sensitive directories separate', async ({ skip }) => {
    const r = await root();
    await put(path.join(r, 'Content', 'main.lua'), 'upper');
    if (await exists(path.join(r, 'content'))) skip();
    await put(path.join(r, 'content', 'main.lua'), 'lower');
    expect(await fs.readFile(await safeDestination(r, 'Content/main.lua'), 'utf8')).toBe('upper');
    expect(await fs.readFile(await safeDestination(r, 'content/main.lua'), 'utf8')).toBe('lower');
  });
  it.each([
    '../escape',
    '../../escape',
    '/etc/file',
    'C:/Windows/file',
    'nested/../../../escape',
    'nested\\escape',
    'file:stream',
    'CON',
    'folder/..',
    'folder/evil.',
  ])('rejects %s', async (bad) => {
    await expect(safeDestination(await root(), bad)).rejects.toThrow();
  });
  it('rejects symlink traversal even when the target is inside the root', async () => {
    const r = await root();
    await fs.mkdir(path.join(r, 'real'));
    await fs.symlink(
      path.join(r, 'real'),
      path.join(r, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(safeDestination(r, 'link/mod.lua')).rejects.toThrow('symbolic');
  });
  it('rejects a symlink final file', async (context) => {
    const r = await root();
    await put(path.join(r, 'real.lua'));
    try {
      await fs.symlink(path.join(r, 'real.lua'), path.join(r, 'mod.lua'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(safeDestination(r, 'mod.lua')).rejects.toThrow('symbolic');
  });
  it('rejects a root changed into a symlink', async () => {
    const r = await root(),
      approved = path.join(r, 'approved');
    await fs.mkdir(approved);
    await fs.rename(approved, path.join(r, 'elsewhere'));
    await fs.symlink(
      path.join(r, 'elsewhere'),
      approved,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(safeDestination(approved, 'mod.lua')).rejects.toThrow('symbolic');
  });
});
