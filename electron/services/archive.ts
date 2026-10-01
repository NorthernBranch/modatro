import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { RelativePath } from '../../src/shared/model';
import { UserError } from './errors';
import { safeDestination } from './files';
export const ARCHIVE_LIMITS = {
  count: 20000,
  totalBytes: 1024 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  ratio: 300,
};
export function validateArchiveEntry(
  entry: Pick<
    yauzl.Entry,
    'fileName' | 'externalFileAttributes' | 'uncompressedSize' | 'compressedSize'
  >,
): string {
  const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
  if (!RelativePath.safeParse(name).success)
    throw new UserError(
      'This archive contains an unsafe file path. No installed files were changed.',
    );
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type && type !== 0o100000 && type !== 0o040000)
    throw new UserError('This archive contains a symbolic link or special file.');
  if (
    entry.uncompressedSize > ARCHIVE_LIMITS.fileBytes ||
    (entry.uncompressedSize > 1024 * 1024 &&
      entry.uncompressedSize / Math.max(1, entry.compressedSize) > ARCHIVE_LIMITS.ratio)
  )
    throw new UserError('This archive has an unsafe decompression size.');
  return name;
}
export class ArchiveService {
  async extract(archive: string, staging: string, signal: AbortSignal): Promise<void> {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(
        archive,
        { lazyEntries: true, validateEntrySizes: true, autoClose: true, strictFileNames: true },
        (e, file) =>
          e || !file
            ? reject(new UserError('The downloaded file is not a valid supported ZIP archive.'))
            : resolve(file),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      let count = 0,
        declared = 0,
        actual = 0,
        finished = false;
      const names = new Set<string>();
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      const aborted = () =>
        fail(new UserError('Installation cancelled. No installed files were changed.'));
      signal.addEventListener('abort', aborted, { once: true });
      zip.on('error', fail);
      zip.on('end', () => {
        if (!finished) {
          finished = true;
          signal.removeEventListener('abort', aborted);
          resolve();
        }
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          signal.throwIfAborted();
          const name = validateArchiveEntry(entry);
          if (names.has(name.toLowerCase()))
            throw new UserError('This archive contains duplicate or case-conflicting paths.');
          names.add(name.toLowerCase());
          count++;
          declared += entry.uncompressedSize;
          if (count > ARCHIVE_LIMITS.count || declared > ARCHIVE_LIMITS.totalBytes)
            throw new UserError('This archive exceeds the extraction limit.');
          const destination = await safeDestination(staging, name);
          if (entry.fileName.endsWith('/')) await fs.mkdir(destination, { recursive: true });
          else {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            const stream = await new Promise<import('node:stream').Readable>((res, rej) =>
              zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s))),
            );
            let size = 0,
              checksum = 0;
            const guard = new Transform({
              transform(chunk: Buffer, _, cb) {
                size += chunk.length;
                actual += chunk.length;
                checksum = crc32(chunk, checksum);
                cb(
                  size > entry.uncompressedSize || actual > ARCHIVE_LIMITS.totalBytes
                    ? new UserError('The archive expanded beyond its declared limits.')
                    : null,
                  chunk,
                );
              },
            });
            await pipeline(
              stream,
              guard,
              createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
              { signal },
            );
            if (size !== entry.uncompressedSize || checksum !== entry.crc32)
              throw new UserError('The archive contains an incomplete or corrupt file.');
          }
          zip.readEntry();
        })().catch(fail);
      });
      if (signal.aborted) aborted();
      else zip.readEntry();
    });
  }
}
