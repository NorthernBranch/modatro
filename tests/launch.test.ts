import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as childProcesses from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { launchModdedMac } from '../electron/services/launch';
import { put, tempRoot } from './helpers';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await tempRoot();
  roots.push(root);
  await put(path.join(root, 'Balatro.app', 'Contents', 'MacOS', 'love'), 'non-runnable fixture');
  await put(path.join(root, 'liblovely.dylib'), 'non-runnable fixture');
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  let started: () => void = () => {};
  const spawning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spawn = vi.mocked(childProcesses.spawn).mockImplementation(() => {
    started();
    return child as unknown as childProcesses.ChildProcess;
  });
  return { root, child, spawn, spawning };
}
it('uses the validated native game and Lovely library without executing a launcher script', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const result = launchModdedMac(f.root);
  await f.spawning;
  expect(f.spawn).toHaveBeenCalledWith(
    path.join(f.root, 'Balatro.app', 'Contents', 'MacOS', 'love'),
    [],
    expect.objectContaining({
      cwd: f.root,
      env: expect.objectContaining({ DYLD_INSERT_LIBRARIES: path.join(f.root, 'liblovely.dylib') }),
    }),
  );
  f.child.emit('spawn');
  await vi.advanceTimersByTimeAsync(1500);
  await expect(result).resolves.toBeUndefined();
  expect(f.child.unref).toHaveBeenCalled();
});
it('surfaces an operating-system launch rejection with actionable instructions', async () => {
  const f = await fixture();
  const result = launchModdedMac(f.root);
  const rejected = expect(result).rejects.toMatchObject({
    message: expect.stringContaining('official installation instructions'),
    details: expect.stringContaining('EPERM'),
  });
  await f.spawning;
  f.child.emit('error', new Error('EPERM: operation not permitted'));
  await rejected;
});
it('does not report success when the game exits immediately after spawning', async () => {
  const f = await fixture();
  const result = launchModdedMac(f.root);
  const rejected = expect(result).rejects.toMatchObject({
    message: expect.stringContaining('architecture'),
    details: expect.stringContaining('code 1'),
  });
  await f.spawning;
  f.child.emit('spawn');
  f.child.emit('exit', 1, null);
  await rejected;
  expect(f.child.unref).not.toHaveBeenCalled();
});
