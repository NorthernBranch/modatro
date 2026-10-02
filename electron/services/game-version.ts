import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';

// Windows LÖVE games append a ZIP to the executable. Rebase archive-relative
// offsets without loading or extracting the executable. macOS .love files use offset 0.
class GameArchiveReader extends yauzl.RandomAccessReader {
  constructor(
    private file: string,
    private offset: number,
  ) {
    super();
  }
  _readStreamForRange(start: number, end: number) {
    if (start === end) return Readable.from([]);
    return createReadStream(this.file, { start: this.offset + start, end: this.offset + end - 1 });
  }
}

export async function readGameVersion(file: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(file, 'r');
    let size: number, offset: number;
    try {
      size = (await handle.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 65557));
      await handle.read(tail, 0, tail.length, size - tail.length);
      let end = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (
          tail.readUInt32LE(i) === 0x06054b50 &&
          i + 22 + tail.readUInt16LE(i + 20) === tail.length
        ) {
          end = i;
          break;
        }
      }
      if (
        end < 0 ||
        tail.readUInt16LE(end + 4) ||
        tail.readUInt16LE(end + 6) ||
        tail.readUInt16LE(end + 10) > 20000 ||
        tail.readUInt32LE(end + 12) > 4 * 1024 * 1024
      )
        return undefined;
      offset = size - tail.length + end - tail.readUInt32LE(end + 12) - tail.readUInt32LE(end + 16);
      if (offset < 0) return undefined;
    } finally {
      await handle.close();
    }
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromRandomAccessReader(
        new GameArchiveReader(file, offset),
        size - offset,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, archive) => (error ? reject(error) : resolve(archive)),
      );
    });
    return await new Promise<string | undefined>((resolve) => {
      let version: string | undefined,
        matches = 0,
        finished = false;
      const finish = (value?: string) => {
        if (finished) return;
        finished = true;
        zip.close();
        resolve(value);
      };
      zip.on('error', () => finish());
      zip.on('end', () => finish(matches === 1 ? version : undefined));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'version.jkr') {
          zip.readEntry();
          return;
        }
        if (
          ++matches > 1 ||
          entry.compressedSize > 4096 ||
          entry.uncompressedSize > 4096 ||
          entry.generalPurposeBitFlag & 1
        ) {
          finish();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            finish();
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          stream.on('error', () => finish());
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 4096) {
              stream.destroy();
              finish();
            } else chunks.push(chunk);
          });
          stream.on('end', () => {
            if (finished) return;
            const bytes = Buffer.concat(chunks);
            if (crc32(bytes) !== entry.crc32) {
              finish();
              return;
            }
            version = /^(\d+\.\d+\.\d+[a-z]?)(?:-(?:FULL|DEMO))?\s*$/i.exec(
              bytes.toString('utf8'),
            )?.[1];
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  } catch {
    return undefined;
  }
}
