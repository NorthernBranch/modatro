import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GameCandidate, PathValidationResult } from '../../src/shared/model';
import { UserError } from './errors';
import { canonicalDirectory, contained, exists, readSmall } from './files';
const exec = promisify(execFile);
export const BALATRO_APP_ID = '2379780';

export function steamLibraries(vdf: string): string[] {
  const modern = [...vdf.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)].map((m) =>
    m[1]!.replaceAll('\\\\', '\\'),
  );
  const legacy = [...vdf.matchAll(/"\d+"\s*"((?:\\.|[^"\\])*)"/g)].map((m) =>
    m[1]!.replaceAll('\\\\', '\\'),
  );
  return [...new Set([...modern, ...legacy])].filter((p) => path.isAbsolute(p));
}
async function binaryMagic(file: string, platform: 'windows' | 'macos'): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    await handle.read(bytes, 0, 4, 0);
    return platform === 'windows'
      ? bytes.subarray(0, 2).toString() === 'MZ'
      : ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(
          bytes.toString('hex'),
        );
  } finally {
    await handle.close();
  }
}
export class GameDetectionService {
  constructor(
    private platform: NodeJS.Platform = process.platform,
    private home = os.homedir(),
  ) {}
  defaultModsPath(): string {
    if (this.platform === 'win32') {
      const roaming = process.env.APPDATA;
      if (!roaming)
        throw new UserError(
          'Windows did not provide an AppData directory. Choose a Mods directory in Settings.',
        );
      return path.join(roaming, 'Balatro', 'Mods');
    }
    return path.join(this.home, 'Library', 'Application Support', 'Balatro', 'Mods');
  }
  async validate(selected: string): Promise<PathValidationResult> {
    const result: PathValidationResult = { valid: false, problems: [], warnings: [] };
    try {
      let real = await canonicalDirectory(selected);
      const windows = await exists(path.join(real, 'Balatro.exe'));
      const app = real.endsWith('.app') ? real : path.join(real, 'Balatro.app');
      const mac = await exists(path.join(app, 'Contents', 'Info.plist'));
      if (windows) {
        result.detectedPlatform = 'windows';
        const executable = path.join(real, 'Balatro.exe');
        const manifest = path.resolve(real, '..', '..', `appmanifest_${BALATRO_APP_ID}.acf`);
        const steamEvidence =
          (await exists(manifest)) && /"appid"\s*"2379780"/.test(await readSmall(manifest));
        const loveEvidence =
          (await exists(path.join(real, 'love.dll'))) &&
          (await exists(path.join(real, 'SDL2.dll')));
        if (!(await binaryMagic(executable, 'windows')) || (!steamEvidence && !loveEvidence))
          result.problems.push({
            code: 'invalid-executable',
            message:
              'Balatro.exe was found, but its executable format and Steam or LÖVE support files could not be verified.',
          });
      } else if (mac) {
        result.detectedPlatform = 'macos';
        const info = await readSmall(path.join(app, 'Contents', 'Info.plist'));
        const executable = path.join(app, 'Contents', 'MacOS', 'love');
        const game = path.join(app, 'Contents', 'Resources', 'Balatro.love');
        if (
          !/Balatro/i.test(info) ||
          !(await exists(executable)) ||
          !(await binaryMagic(executable, 'macos')) ||
          !(await exists(game)) ||
          !(await fs.stat(game)).isFile()
        )
          result.problems.push({
            code: 'invalid-app',
            message:
              'The Balatro application bundle is incomplete. Expected its LÖVE executable, Info.plist and Balatro.love game data.',
          });
        // CFBundleShortVersionString may describe LÖVE rather than Balatro.
        // Leave game-version constraints unknown until game data proves them.
        // Lovely lives beside Balatro.app, not inside the bundle.
        if (real.endsWith('.app')) real = await canonicalDirectory(path.dirname(real));
      } else
        result.problems.push({
          code: 'not-balatro',
          message:
            'This does not appear to be a Balatro installation. Expected Balatro.exe (Windows) or a complete Balatro.app (macOS).',
        });
      if (
        result.detectedPlatform &&
        ((this.platform === 'darwin') !== (result.detectedPlatform === 'macos') ||
          !['darwin', 'win32'].includes(this.platform))
      )
        result.problems.push({
          code: 'wrong-platform',
          message: 'This Balatro installation is for a different operating system.',
        });
      await fs.access(real, fs.constants.R_OK | fs.constants.W_OK);
      result.canonicalPath = real;
    } catch (e) {
      result.problems.push({
        code: (e as NodeJS.ErrnoException).code ?? 'inaccessible',
        message:
          'Modatro cannot read and write this folder. Check the path and your folder permissions.',
      });
    }
    result.valid = result.problems.length === 0;
    return result;
  }
  async validateMods(selected: string, gamePath?: string, create = false): Promise<string> {
    // Create only the well-known default automatically; overrides must already exist.
    if (!(await exists(selected))) {
      if (!create || path.resolve(selected) !== path.resolve(this.defaultModsPath()))
        throw new UserError('Choose an existing Mods directory.');
      let ancestor = path.resolve(selected);
      while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
      if ((await fs.realpath(ancestor)) !== ancestor)
        throw new UserError(
          'The default Mods path passes through a symbolic link. Choose a folder manually.',
        );
      await fs.mkdir(selected, { recursive: true });
    }
    const real = await canonicalDirectory(selected);
    const home = await canonicalDirectory(this.home);
    if (
      real === home ||
      real === path.parse(real).root ||
      (!contained(home, real) && this.platform !== 'win32')
    )
      throw new UserError('Choose a dedicated Mods folder, rather than a home or system folder.');
    if (gamePath && (contained(gamePath, real) || contained(real, gamePath)))
      throw new UserError('Balatro and Mods must use separate folders.');
    if (path.basename(real).toLowerCase() !== 'mods')
      throw new UserError('For safety, the override must be a dedicated folder named Mods.');
    await fs.access(real, fs.constants.R_OK | fs.constants.W_OK);
    return real;
  }
  async discover(): Promise<GameCandidate[]> {
    const roots =
      this.platform === 'darwin'
        ? [path.join(this.home, 'Library', 'Application Support', 'Steam')]
        : [
            path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
            path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Steam'),
          ];
    if (this.platform === 'win32') {
      try {
        const { stdout } = await exec(
          'reg.exe',
          ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
          { timeout: 5000, windowsHide: true },
        );
        const p = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout)?.[1]?.trim();
        if (p) roots.push(p);
      } catch {
        /* Common Steam roots still work without registry access. */
      }
    }
    const libraries = new Set(roots);
    for (const root of roots) {
      const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
      if (await exists(vdf)) {
        try {
          for (const lib of steamLibraries(await readSmall(vdf))) libraries.add(lib);
        } catch {
          /* Ignore an unreadable Steam library. */
        }
      }
    }
    const candidates = new Map<string, GameCandidate>();
    for (const library of libraries) {
      const manifest = path.join(library, 'steamapps', `appmanifest_${BALATRO_APP_ID}.acf`);
      if (!(await exists(manifest))) continue;
      try {
        const content = await readSmall(manifest);
        if (!/"appid"\s*"2379780"/.test(content)) continue;
        const installDir = /"installdir"\s*"([^"\\/]+)"/.exec(content)?.[1];
        if (!installDir || installDir === '.' || installDir === '..') continue;
        const p = path.join(library, 'steamapps', 'common', installDir),
          validation = await this.validate(p);
        if (validation.valid && validation.canonicalPath)
          candidates.set(validation.canonicalPath, { path: validation.canonicalPath, validation });
      } catch {
        /* A missing library should not prevent discovery of other libraries. */
      }
    }
    return [...candidates.values()];
  }
}
export class LaunchService {
  async assertClosed(): Promise<void> {
    try {
      const { stdout } =
        process.platform === 'win32'
          ? await exec('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true })
          : await exec('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
      if (
        process.platform === 'win32'
          ? /"Balatro\.exe"/i.test(stdout)
          : /Balatro\.app\/Contents\/MacOS\/love|(?:^|\/)Balatro(?:\s|$)/im.test(stdout)
      )
        throw new UserError(
          'Close Balatro before changing mods or prerequisites, then check again.',
          undefined,
          undefined,
          { retryable: true },
        );
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(
        'Modatro could not check whether Balatro is running. File changes are paused; try again.',
        undefined,
        String(e),
        { retryable: true },
      );
    }
  }
}
