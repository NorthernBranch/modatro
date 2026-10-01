import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  NativeCatalogueSchema,
  NativeEntrySchema,
  AuthorManifestSchema,
} from '../src/shared/catalogue-schema';
import { BlockedReleasesSchema, RevocationsSchema, sourceType } from '../src/shared/trust';
import { validateRemoteUrl } from '../electron/services/network';

export async function compileCatalogue(root: string, check = false) {
  const mods: z.infer<typeof NativeEntrySchema>[] = [];
  const directory = path.join(root, 'mods');
  for (const author of await fs.readdir(directory, { withFileTypes: true })) {
    if (author.name.startsWith('.')) continue;
    if (!author.isDirectory() || author.isSymbolicLink())
      throw new Error('Catalogue authors must be real directories.');
    for (const slug of await fs.readdir(path.join(directory, author.name), {
      withFileTypes: true,
    })) {
      if (!slug.isDirectory() || slug.isSymbolicLink())
        throw new Error('Catalogue entries must be real directories.');
      const file = path.join(directory, author.name, slug.name, 'meta.json');
      if ((await fs.lstat(file)).isSymbolicLink())
        throw new Error('Catalogue metadata cannot be a symlink.');
      const entry = NativeEntrySchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (entry.id !== `${author.name}/${slug.name}`)
        throw new Error(`The ID does not match its directory: ${entry.id}`);
      for (const url of [
        entry.downloadUrl,
        entry.manifestUrl,
        entry.repositoryUrl,
        entry.approvalEvidence,
        entry.iconUrl,
      ].filter((v): v is string => !!v))
        validateRemoteUrl(url);
      if (!entry.approvalStatus)
        console.warn(`${entry.id}: approval status missing; pending review.`);
      if (!entry.licence) console.warn(`${entry.id}: licence metadata missing.`);
      if (entry.downloadUrl && sourceType(entry.downloadUrl) === 'branch')
        console.warn(`${entry.id}: moving branch source.`);
      if (!entry.releaseSource?.sha256) console.warn(`${entry.id}: archive checksum not supplied.`);
      mods.push({ ...entry, approvalStatus: entry.approvalStatus ?? 'pending-review' });
    }
  }
  RevocationsSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'revocations.json'), 'utf8')),
  );
  BlockedReleasesSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'blocked-releases.json'), 'utf8')),
  );
  const file = path.join(root, 'index.json');
  const existing = check
    ? NativeCatalogueSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
    : undefined;
  const catalogue = NativeCatalogueSchema.parse({
    schemaVersion: 1,
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    mods: mods.sort((a, b) => a.id.localeCompare(b.id)),
  });
  const output = `${JSON.stringify(catalogue, null, 2)}\n`;
  if (check) {
    if (JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))) !== JSON.stringify(catalogue))
      throw new Error(
        'The compiled catalogue is outdated. Run pnpm catalogue:build and commit index.json.',
      );
  } else {
    await fs.writeFile(file, output);
    await fs.mkdir(path.join(root, 'schema'), { recursive: true });
    for (const [name, schema] of Object.entries({
      entry: NativeEntrySchema,
      manifest: AuthorManifestSchema,
      revocations: RevocationsSchema,
      'blocked-releases': BlockedReleasesSchema,
    })) {
      await fs.writeFile(
        path.join(root, 'schema', `${name}.schema.json`),
        `${JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }), null, 2)}\n`,
      );
    }
  }
  return catalogue;
}
