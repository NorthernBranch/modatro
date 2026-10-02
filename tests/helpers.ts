import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GameDetectionService, LaunchService } from '../electron/services/detection';
import { ModInstaller } from '../electron/services/installer';
import { Logger, Storage } from '../electron/services/storage';
import { TransactionEngine } from '../electron/services/transaction';
import { ModSchema, type ModDefinition, type Prerequisite } from '../src/shared/model';
import revocations from '../catalogue/revocations.json';
import blocked from '../catalogue/blocked-releases.json';

export function policyResponse(url: string): Response | undefined {
  const base = 'https://raw.githubusercontent.com/NorthernBranch/modatro/main/catalogue';
  const policy =
    url === `${base}/revocations.json`
      ? revocations
      : url === `${base}/blocked-releases.json`
        ? blocked
        : undefined;
  return policy
    ? new Response(JSON.stringify(policy), { headers: { 'content-type': 'application/json' } })
    : undefined;
}
export async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-test-')));
}
export async function put(file: string, contents = 'fixture') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}
export async function fakeGame(root: string) {
  const game = path.join(root, 'steamapps', 'common', 'Balatro');
  await fs.cp(fileURLToPath(new URL('../fixtures/balatro-valid/', import.meta.url)), game, {
    recursive: true,
  });
  return game;
}
export function mod(overrides: Partial<ModDefinition> = {}): ModDefinition {
  return ModSchema.parse({
    id: 'test-mod',
    title: 'Test mod',
    author: 'Fixture',
    version: '1.0.0',
    downloadUrl: 'https://github.com/fixture/mod/archive/v1.0.0.zip',
    repositoryUrl: 'https://github.com/fixture/mod',
    categories: ['Content'],
    prerequisites: [],
    installation: { type: 'standard' },
    ...overrides,
  });
}
export function thunderstorePackage(
  options: {
    namespace?: string;
    name?: string;
    version?: string;
    dependencies?: string[];
    website?: string;
    deprecated?: boolean;
    categories?: string[];
  } = {},
) {
  const namespace = options.namespace ?? 'Author',
    name = options.name ?? 'Demo',
    version = options.version ?? '1.0.0';
  return {
    uuid4: `11111111-1111-4111-8111-${createHash('sha256').update(`${namespace}-${name}`).digest('hex').slice(0, 12)}`,
    owner: namespace,
    name,
    full_name: `${namespace}-${name}`,
    package_url: `https://thunderstore.io/c/balatro/p/${namespace}/${name}/`,
    date_updated: '2026-10-01T12:00:00Z',
    categories: options.categories ?? ['Mods', 'Quality of Life'],
    is_deprecated: options.deprecated ?? false,
    versions: [
      {
        uuid4: `22222222-2222-4222-8222-${createHash('sha256').update(`${namespace}-${name}-${version}`).digest('hex').slice(0, 12)}`,
        name,
        full_name: `${namespace}-${name}-${version}`,
        version_number: version,
        is_active: true,
        dependencies: options.dependencies ?? [],
        download_url: `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`,
        website_url: options.website ?? 'https://github.com/author/demo',
      },
    ],
  };
}
export async function setup(checkpoint?: (phase: string, index?: number) => Promise<void>) {
  const root = await tempRoot(),
    storage = new Storage(path.join(root, 'app'));
  await storage.initialize();
  const game = await fakeGame(root),
    mods = path.join(root, 'Mods');
  await fs.mkdir(mods);
  await storage.save({
    ...storage.state,
    settings: { theme: 'dark', setupComplete: true, gamePath: game, modsPath: mods },
  });
  const logger = new Logger(storage, root),
    transactions = new TransactionEngine(storage, logger, checkpoint);
  const prerequisites: Prerequisite[] = [];
  const launcher = { assertClosed: async () => {} } as LaunchService;
  const installer = new ModInstaller(
    storage,
    transactions,
    new GameDetectionService('win32', root),
    launcher,
    logger,
    () => {},
    async () => prerequisites,
  );
  const stage = path.join(root, 'stage');
  await fs.mkdir(stage);
  return { root, storage, logger, transactions, installer, game, mods, stage, prerequisites };
}
// Deliberately simple stored ZIP writer gives the security tests control over
// paths, Unix modes, CRC errors and declarations without an extractor dependency.
export function zip(
  entries: {
    name: string;
    data?: string;
    mode?: number;
    badCrc?: boolean;
    uncompressedSize?: number;
  }[],
): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data ?? ''),
      checksum = entry.badCrc ? 42 : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.uncompressedSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(entry.uncompressedSize ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const c = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
