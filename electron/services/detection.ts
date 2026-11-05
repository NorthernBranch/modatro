import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GameCandidate, PathValidationResult } from '../../src/shared/model';
import { UserError } from './errors';
import { canonicalDirectory, contained, exists, readSmall } from './files';
import { readGameVersion } from './game-version';
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
  defaultModsPath(gamePath?: string): string {
    if (this.platform === 'win32') {
      const roaming = process.env.APPDATA;
      if (!roaming)
        throw new UserError(
          'Windows did not provide an AppData directory. Choose a Mods directory in Settings.',
        );
      return path.join(roaming, 'Balatro', 'Mods');
    }
    if (this.platform === 'linux') {
      const steam = gamePath
        ? path.resolve(gamePath, '..', '..')
        : path.join(this.home, '.local', 'share', 'Steam', 'steamapps');
      return path.join(
        steam,
        'compatdata',
        BALATRO_APP_ID,
        'pfx',
        'drive_c',
        'users',
        'steamuser',
        'AppData',
        'Roaming',
        'Balatro',
        'Mods',
      );
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
        if (!result.problems.length) result.detectedVersion = await readGameVersion(executable);
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
        // Read the game data instead; never infer the game's version from LÖVE.
        if (!result.problems.length) result.detectedVersion = await readGameVersion(game);
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
          !['darwin', 'win32', 'linux'].includes(this.platform))
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
      if (!create || path.resolve(selected) !== path.resolve(this.defaultModsPath(gamePath)))
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
      (!contained(home, real) &&
        this.platform !== 'win32' &&
        !(
          this.platform === 'linux' &&
          gamePath &&
          path.resolve(real) === path.resolve(this.defaultModsPath(gamePath))
        ))
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
        : this.platform === 'linux'
          ? [
              path.join(this.home, '.local', 'share', 'Steam'),
              path.join(this.home, '.steam', 'steam'),
              path.join(
                this.home,
                '.var',
                'app',
                'com.valvesoftware.Steam',
                '.local',
                'share',
                'Steam',
              ),
              path.join(this.home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
            ]
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
  constructor(
    private platform: NodeJS.Platform = process.platform,
    private run = exec,
  ) {}
  private async windowsRunning(): Promise<boolean> {
    try {
      const { stdout } = await this.run(
        'tasklist.exe',
        ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Balatro.exe'],
        { timeout: 15000, windowsHide: true },
      );
      return /"Balatro\.exe"/i.test(stdout);
    } catch (tasklistError) {
      try {
        const { stdout, stderr } = await this.run(
          path.win32.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference = 'Stop'; [Console]::Write([System.Diagnostics.Process]::GetProcessesByName('Balatro').Length)",
          ],
          { timeout: 10000, windowsHide: true },
        );
        const count = stdout.trim();
        if (stderr.trim() || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))
          throw new Error('The fallback process check did not return a valid process count.');
        return Number(count) > 0;
      } catch (fallbackError) {
        throw new AggregateError(
          [tasklistError, fallbackError],
          'Both Windows process checks failed.',
        );
      }
    }
  }
  async assertClosed(): Promise<void> {
    try {
      const running =
        this.platform === 'win32'
          ? await this.windowsRunning()
          : /Balatro\.app\/Contents\/MacOS\/love|(?:^|\/)Balatro(?:\.exe)?(?:\s|$)/im.test(
              (await this.run('/bin/ps', ['-axo', 'comm='], { timeout: 5000 })).stdout,
            );
      if (running)
        throw new UserError(
          'Close Balatro before changing mods or prerequisites, then check again.',
          undefined,
          undefined,
          { retryable: true, code: 'game-process-check' },
        );
    } catch (e) {
      if (e instanceof UserError) throw e;
      const details = (e instanceof AggregateError ? e.errors : [e])
        .map((error) => {
          const failure = error as NodeJS.ErrnoException & {
            stderr?: string;
            killed?: boolean;
            signal?: string;
          };
          return [
            String(error),
            failure.code !== undefined ? `Code: ${failure.code}` : '',
            failure.killed ? 'Process check was terminated (possibly timed out).' : '',
            failure.signal ? `Signal: ${failure.signal}` : '',
            failure.stderr?.trim(),
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
      throw new UserError(
        'Modatro could not check whether Balatro is running. File changes are paused; try again.',
        undefined,
        details,
        { retryable: true, code: 'game-process-check' },
      );
    }
  }
}
