import * as fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { RelativePath } from '../../src/shared/model';
import { safeDestination } from './files';
import { UserError } from './errors';

// Official macOS Lovely archives contain a dylib and a launcher. Stage regular
// files only; the installation strategy selects the library and never runs scripts.
export async function extractLovelyTar(archive: string, staging: string, signal: AbortSignal) {
  const fail = () =>
    new UserError(
      'This Lovely archive has an unsupported or unsafe layout. No game files were changed.',
    );
  if ((await fs.stat(archive)).size > 32 * 1024 * 1024) throw fail();
  signal.throwIfAborted();
  const tar = gunzipSync(await fs.readFile(archive), { maxOutputLength: 64 * 1024 * 1024 });
  const seen = new Set<string>();
  const octal = (bytes: Buffer) => {
    const value = bytes.toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(value)) throw fail();
    return Number.parseInt(value, 8);
  };
  let ended = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    signal.throwIfAborted();
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(header.subarray(148, 156))) throw fail();
    const text = (start: number, end: number) =>
      header.subarray(start, end).toString('utf8').split('\0')[0]!;
    const prefix = text(345, 500),
      name = text(0, 100);
    const relative = `${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\//, '').replace(/\/$/, '');
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    if (
      !RelativePath.safeParse(relative).success ||
      seen.has(relative.toLowerCase()) ||
      seen.size >= 32 ||
      size > 32 * 1024 * 1024 ||
      offset + 512 + size > tar.length ||
      ![0, 48, 53].includes(type!)
    )
      throw fail();
    seen.add(relative.toLowerCase());
    const destination = await safeDestination(staging, relative);
    if (type === 53) {
      if (size !== 0) throw fail();
      await fs.mkdir(destination, { recursive: true });
    } else {
      // Current official archives have no nested payload or arbitrary extra files.
      if (
        !/^(liblovely\.dylib|run_lovely_macos\.sh|readme(?:\.md)?|license(?:\.md|\.txt)?)$/i.test(
          relative,
        )
      )
        throw fail();
      await fs.writeFile(destination, tar.subarray(offset + 512, offset + 512 + size), {
        flag: 'wx',
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !seen.has('liblovely.dylib')) throw fail();
}
