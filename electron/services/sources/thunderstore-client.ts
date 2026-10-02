import { z } from 'zod';
import { THUNDERSTORE_ENDPOINT } from '../../../src/shared/thunderstore';
import { remoteThunderstoreJson, validateRemoteUrl } from '../network';

// The index is a gzip-compressed list of immutable CDN chunk URLs. Fetch a
// bounded number at a time in the main process, never in React.
export async function readThunderstoreCatalogue(json = remoteThunderstoreJson): Promise<unknown[]> {
  const chunks = z
    .array(z.string())
    .min(1)
    .max(256)
    .parse(await json(THUNDERSTORE_ENDPOINT));
  if (new Set(chunks).size !== chunks.length) throw new Error('Duplicate catalogue chunks.');
  for (const url of chunks) {
    const parsed = validateRemoteUrl(url, 'thunderstore');
    if (!/^\/live\/blob-storage\/sha256\//.test(parsed.pathname))
      throw new Error('Invalid catalogue chunk URL.');
  }
  const pages = new Array<unknown[]>(chunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const index = next++;
        pages[index] = z
          .array(z.unknown())
          .max(10000)
          .parse(await json(chunks[index]!));
      }
    }),
  );
  return z.array(z.unknown()).min(1).max(10000).parse(pages.flat());
}
