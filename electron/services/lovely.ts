import * as fs from 'node:fs/promises';
import { hashFile } from './files';

export function nativeLibrary(bytes: Buffer, platform = process.platform) {
  const magic = bytes.subarray(0, 4).toString('hex');
  return platform === 'darwin'
    ? [
        'cffaedfe',
        'cefaedfe',
        'feedfacf',
        'feedface',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic)
    : bytes.subarray(0, 2).toString() === 'MZ';
}

export async function inspectLovelyLibrary(
  file: string,
  ownedHash?: string,
  platform = process.platform,
) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return { identified: false, owned: false };
    const bytes = Buffer.alloc(Math.min(info.size, 16 * 1024 * 1024));
    await handle.read(bytes, 0, bytes.length, 0);
    const owned = !!ownedHash && (await hashFile(file)) === ownedHash;
    return {
      identified:
        nativeLibrary(bytes, platform) && (owned || /lovely/i.test(bytes.toString('latin1'))),
      owned,
    };
  } finally {
    await handle.close();
  }
}
