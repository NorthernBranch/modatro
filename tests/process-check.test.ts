import { describe, expect, it, vi } from 'vitest';
import { LaunchService } from '../electron/services/detection';

describe('game process safety check', () => {
  it('queries only Balatro on Windows and accepts the no-match response', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      stderr: '',
    });
    await expect(new LaunchService('win32', run).assertClosed()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Balatro.exe'],
      { timeout: 15000, windowsHide: true },
    );
  });

  it('still blocks a running game', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '"Balatro.exe","1234","Console"', stderr: '' });
    await expect(new LaunchService('win32', run).assertClosed()).rejects.toThrow('Close Balatro');
  });

  it.each([
    { code: 'ENOENT', stderr: 'Command unavailable' },
    { code: 1, stderr: 'Access is denied.' },
    { code: null, killed: true, signal: 'SIGTERM', stderr: '' },
  ])('keeps file changes blocked and retains failure details: %j', async (details) => {
    const failure = Object.assign(new Error('Command failed: tasklist.exe'), details);
    const run = vi.fn().mockRejectedValue(failure);
    const error = await new LaunchService('win32', run).assertClosed().catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: expect.stringContaining('could not check whether Balatro is running'),
      context: { retryable: true },
      details: expect.stringContaining('Command failed: tasklist.exe'),
    });
    if (details.stderr)
      expect(error).toHaveProperty('details', expect.stringContaining(details.stderr));
    if ('killed' in details)
      expect(error).toHaveProperty('details', expect.stringContaining('terminated'));
  });

  it('preserves the Unix process check', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: '/Applications/Balatro.app/Contents/MacOS/love', stderr: '' });
    await expect(new LaunchService('darwin', run).assertClosed()).rejects.toThrow('Close Balatro');
    expect(run).toHaveBeenCalledWith('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
  });
});
