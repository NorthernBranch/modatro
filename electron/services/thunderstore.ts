import type { ModDefinition } from '../../src/shared/model';
import { ThunderstoreManifestSchema } from '../../src/shared/thunderstore';
import { readSmall, safeDestination } from './files';
import { UserError } from './errors';

export async function validateThunderstoreArchive(mod: ModDefinition, staging: string) {
  if (!mod.thunderstore) return;
  const manifest = ThunderstoreManifestSchema.parse(
    JSON.parse(await readSmall(await safeDestination(staging, 'manifest.json'))),
  );
  const registry = mod.thunderstore;
  if (
    manifest.name !== registry.name ||
    manifest.version_number !== registry.packageVersion ||
    JSON.stringify([...manifest.dependencies].sort()) !==
      JSON.stringify([...registry.dependencies].sort())
  )
    throw new UserError(
      'The downloaded package manifest differs from its Thunderstore release. No installed files were changed.',
    );
  if (
    manifest.installers?.length ||
    (mod.installer !== undefined && (!Array.isArray(mod.installer) || mod.installer.length))
  )
    throw new UserError(
      'This package declares an installer Modatro does not support. Open its source page for manual installation instructions.',
    );
}
