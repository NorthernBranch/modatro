import path from 'node:path';
import type { FileRoot, ModDefinition } from '../../src/shared/model';
import { RelativePath, SafeName } from '../../src/shared/model';
import { UserError } from './errors';
import { exists, readSmall, safeDestination, walkFiles } from './files';
import { detectModRoot, inspectMetadata, parseLuaHeader } from './metadata';
import { defaultFolder } from '../../src/shared/trust';
export interface InstallContext {
  mod: ModDefinition;
  staging: string;
  directFile?: boolean;
}
export interface StrategyFile {
  root: FileRoot;
  path: string;
  source: string;
}
export interface InstallationStrategy {
  canHandle(context: InstallContext): boolean;
  plan(context: InstallContext): Promise<StrategyFile[]>;
}
function folder(mod: ModDefinition): string {
  return SafeName.parse(defaultFolder(mod));
}
export class StandardModStrategy implements InstallationStrategy {
  canHandle({ mod, directFile }: InstallContext) {
    return !directFile && ['auto', 'standard', 'lovely-patch'].includes(mod.installation.type);
  }
  async plan(context: InstallContext) {
    const { mod, staging } = context;
    const root =
      mod.installation.type === 'standard' && mod.installation.sourceRoot
        ? await safeDestination(staging, mod.installation.sourceRoot)
        : await detectModRoot(staging);
    // An explicit root still needs positive supported-mod evidence.
    const metadata = await inspectMetadata(root);
    if (
      !metadata.id &&
      !(await exists(path.join(root, 'main.lua'))) &&
      !(await exists(path.join(root, 'lovely.toml'))) &&
      !(await exists(path.join(root, 'lovely')))
    )
      throw new UserError('The specified mod folder could not be identified.');
    const files = await walkFiles(root);
    if (
      files.some(
        (file) =>
          /\.(?:exe|msi|bat|cmd|ps1|sh|command)$/i.test(file) ||
          file
            .toLowerCase()
            .split('/')
            .some((part) => part.endsWith('.app')),
      )
    )
      throw new UserError(
        'This archive contains an external installer or script. Automatic installation is unsupported; view the upstream instructions.',
      );
    if (!files.length) throw new UserError('This mod folder is empty.');
    return files
      .filter(
        (f) =>
          !f.startsWith('.git/') &&
          !f.startsWith('.github/') &&
          !f.startsWith('__MACOSX/') &&
          f !== '.DS_Store',
      )
      .map((f) => ({
        root: 'mods' as const,
        path: RelativePath.parse(`${folder(mod)}/${f}`),
        source: path.join(root, ...f.split('/')),
      }));
  }
}
export class SingleFileStrategy implements InstallationStrategy {
  canHandle({ mod, directFile }: InstallContext) {
    return !!directFile || mod.installation.type === 'single-file';
  }
  async plan({ mod, staging }: InstallContext) {
    const files = await walkFiles(staging);
    if (files.length !== 1 || !files[0]?.endsWith('.lua'))
      throw new UserError('A single-file mod must contain exactly one Lua file.');
    const source = path.join(staging, files[0]);
    if (!parseLuaHeader(await readSmall(source)))
      throw new UserError(
        'The single Lua file has no supported Steamodded header. Automatic installation is unavailable.',
      );
    return [{ root: 'mods' as const, path: RelativePath.parse(`${folder(mod)}.lua`), source }];
  }
}
export class GameReplacementStrategy implements InstallationStrategy {
  canHandle({ mod }: InstallContext) {
    return mod.installation.type === 'game-replacement';
  }
  async plan({ mod, staging }: InstallContext) {
    if (mod.installation.type !== 'game-replacement')
      throw new UserError('Unsupported installation strategy.');
    return Promise.all(
      mod.installation.files.map(async (f) => ({
        root: 'game' as const,
        path: RelativePath.parse(f.destination),
        source: await safeDestination(staging, f.source),
      })),
    );
  }
}
export function selectStrategy(context: InstallContext): InstallationStrategy {
  const strategy = [
    new GameReplacementStrategy(),
    new SingleFileStrategy(),
    new StandardModStrategy(),
  ].find((s) => s.canHandle(context));
  if (!strategy)
    throw new UserError(
      'Automatic installation is not supported for this mod yet. Open its repository for instructions.',
    );
  return strategy;
}
