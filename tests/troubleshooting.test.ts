import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, put } from './helpers';
import {
  TroubleshootingService,
  diagnosticFindings,
  readLog,
  redact,
} from '../electron/services/troubleshooting';
import { ProfileService } from '../electron/services/profiles';
import { OperationHistoryStore } from '../electron/services/history';
import { profileSummary } from '../src/shared/profile-selection';
import { DiagnosticRequestSchema, ReportExportSchema } from '../src/shared/features';
import type { Snapshot } from '../src/shared/model';
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  const snapshot: Snapshot = {
    settings: f.storage.state.settings,
    validation: { valid: true, problems: [], warnings: [] },
    catalogue: { mods: [], stale: false, refreshing: false, rejected: 0 },
    localMods: [],
    prerequisites: [
      {
        id: 'Lovely',
        displayName: 'Lovely',
        installed: true,
        sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
      },
    ],
    candidates: [],
    platform: 'win32',
    arch: 'x64',
    appVersion: '0.3.0',
    electronVersion: 'fixture',
    profiles: profileSummary(f.storage.state),
  };
  const profiles = new ProfileService(f.storage, f.installer, async () => snapshot);
  const service = new TroubleshootingService(
    f.storage,
    f.transactions,
    async () => snapshot,
    profiles,
  );
  return { ...f, service, snapshot };
}
it('separates missing, incompatible and unknown dependency evidence and preserves actual disabled state', async () => {
  const f = await fixture();
  f.snapshot.localMods = [
    {
      id: 'consumer',
      title: 'Consumer',
      managed: true,
      state: 'broken',
      canAdopt: false,
      folderName: 'consumer',
      problems: ['main.lua has changed outside Modatro.'],
      dependencies: [
        { id: 'Lovely', displayName: 'Lovely', versionConstraint: '>=0.10.0', required: true },
        { id: 'missing', displayName: 'Missing dependency', required: true },
      ],
    },
  ];
  const findings = diagnosticFindings(f.snapshot);
  expect(findings).toContainEqual(
    expect.objectContaining({
      kind: 'problem',
      observed: expect.stringContaining('changed outside'),
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({
      kind: 'warning',
      observed: expect.stringContaining('Cannot verify'),
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: 'problem', observed: expect.stringContaining('required') }),
  );
  f.snapshot.prerequisites[0]!.installedVersion = '0.9.0';
  expect(diagnosticFindings(f.snapshot).filter((e) => e.kind === 'problem')).toHaveLength(3);
  f.snapshot.localMods[0]!.dependencies![0]!.versionConstraint = '<0.9.0';
  expect(diagnosticFindings(f.snapshot).filter((e) => e.kind === 'problem')).toHaveLength(3);
  f.snapshot.localMods[0]!.disabled = true;
  expect(diagnosticFindings(f.snapshot).filter((e) => e.kind === 'problem')).toHaveLength(1);
});
it('excludes logs by default, labels stale evidence and never claims a referenced mod caused the crash', async () => {
  const f = await fixture(),
    log = path.join(f.mods, 'lovely', 'log', 'fixture.log');
  await put(
    log,
    'ERROR: [SMODS Handy steamodded.lua]: fixture crash\nC:\\Users\\Example\\Mods\\Handy\\main.lua\nAuthorization: Bearer ghp_fixtureSecretValue',
  );
  await fs.utimes(log, new Date('2020-01-01'), new Date('2020-01-01'));
  const before = await f.service.inspect({ logIds: [] });
  const item = before.logs.find((l) => l.name === 'fixture.log')!;
  expect(item.stale).toBe(true);
  expect(item.excerpt).toBeUndefined();
  expect(before.report).not.toContain('fixture crash');
  expect(before.findings.some((f) => f.kind === 'possible')).toBe(false);
  const selected = await f.service.inspect({ logIds: [item.id] });
  expect(selected.report).toContain('fixture crash');
  expect(selected.report).not.toContain('Example');
  expect(selected.report).not.toContain('ghp_fixtureSecretValue');
  expect(selected.findings.find((f) => f.kind === 'possible')).toMatchObject({
    why: expect.stringContaining('not proof'),
    observed: expect.stringContaining('older than 24 hours'),
  });
  await fs.unlink(log);
  const rotated = await f.service.inspect({ logIds: [] });
  expect(rotated.logs.some((l) => l.name === 'fixture.log')).toBe(false);
  await expect(f.service.inspect({ logIds: [item.id] })).rejects.toThrow('unavailable');
});
it('bounds log reads and handles malformed and binary content, missing folders and invalid selections', async () => {
  const f = await fixture(),
    log = path.join(f.root, 'large.txt');
  await put(log, 'x'.repeat(2 * 1024 * 1024) + '\nERROR: tail');
  const read = await readLog(log);
  expect(read.text.length).toBeLessThanOrEqual(8000);
  expect(read.text).toContain('ERROR: tail');
  expect(read.truncated).toBe(true);
  await fs.writeFile(log, Buffer.from([0xff, 0xfe, 65, 66]));
  expect((await readLog(log)).text).toContain('�');
  await fs.writeFile(log, Buffer.from([0, 65]));
  await expect(readLog(log)).rejects.toThrow('binary');
  expect((await f.service.inspect({ logIds: [] })).logs).toContainEqual(
    expect.objectContaining({ error: expect.any(String) }),
  );
  expect(DiagnosticRequestSchema.safeParse({ logIds: [], path: 'C:\\private.log' }).success).toBe(
    false,
  );
  await expect(f.service.inspect({ logIds: ['../../private.log'] })).rejects.toThrow('unavailable');
  await expect(f.service.choose(path.join(f.root, 'script.exe'))).rejects.toThrow('.log');
  await expect(readLog(f.root)).rejects.toThrow('regular');
  expect(ReportExportSchema.safeParse({ text: 'x'.repeat(100001) }).success).toBe(false);
});
it('scopes native-picked logs to opaque IDs and exports the explicitly reviewed text only', async () => {
  const f = await fixture(),
    log = path.join(f.root, 'selected.txt');
  await put(log, 'ERROR: selected fixture');
  const id = await f.service.choose(log);
  expect(id).not.toContain(f.root);
  const report = await f.service.inspect({ logIds: [id] });
  expect(report.report).toContain('selected fixture');
  expect(JSON.stringify(report)).not.toContain(f.root);
  const destination = path.join(f.root, 'reviewed.md');
  await f.service.export(destination, 'User reviewed text');
  expect(await fs.readFile(destination, 'utf8')).toBe('User reviewed text');
  await expect(
    f.service.export(path.join(f.root, '..', 'bad', 'report.md'), 'text'),
  ).rejects.toThrow();
  await expect(f.service.export(path.join(f.game, 'save.jkr'), 'text')).rejects.toThrow('.md');
  await expect(f.service.export(path.join(f.mods, 'config.txt'), 'text')).rejects.toThrow(
    'outside',
  );
  await expect(f.service.export(f.storage.file('data/report.txt'), 'text')).rejects.toThrow(
    'outside',
  );
});
it('redacts usernames, home roots, URL credentials and secrets while retaining relative mod identities', () => {
  const text =
    'C:\\Users\\Alice\\Mods\\Handy\\main.lua\n/home/alice/Mods/Handy/main.lua\nhttps://alice:password@example.com\ntoken=abc123&api_key=secret123\nAuthorization: Bearer supersecret\ngithub_pat_12345';
  const clean = redact(text, { mods: 'C:\\Users\\Alice\\Mods', home: '/home/alice' });
  expect(clean).toContain('<mods>\\Handy\\main.lua');
  expect(clean).toContain('<home>/Mods/Handy/main.lua');
  for (const secret of [
    'Alice',
    'alice',
    'abc123',
    'secret123',
    'supersecret',
    'github_pat_12345',
    'password@example',
  ])
    expect(clean).not.toContain(secret);
});
it('keeps diagnostic snapshots read-only even when safety is locked and rejects concurrent changes', async () => {
  const f = await fixture();
  f.storage.safetyError = 'Recovery fixture requires attention';
  f.snapshot.safetyError = f.storage.safetyError;
  const recover = vi.spyOn(f.transactions, 'recover');
  const result = await f.service.inspect({ logIds: [] });
  expect(result.findings).toContainEqual(
    expect.objectContaining({ kind: 'problem', observed: f.storage.safetyError }),
  );
  expect(recover).not.toHaveBeenCalled();
  f.storage.safetyError = undefined;
  await f.transactions.inspectLocked(async () => {
    await expect(f.service.inspect({ logIds: [] })).rejects.toThrow('Refresh Troubleshooting');
  });
});
it('rejects symlink logs, reports permission errors and returns when log processing exceeds its budget', async () => {
  const f = await fixture(),
    log = path.join(f.root, 'selected.log');
  await put(log, 'ERROR: fixture');
  const id = await f.service.choose(log);
  const { lstat: actual } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.spyOn(fs, 'lstat').mockImplementation((async (file: Parameters<typeof fs.lstat>[0]) => {
    if (String(file) === log) {
      const result = await actual(file);
      Object.defineProperty(result, 'isSymbolicLink', { value: () => true });
      return result;
    }
    return actual(file);
  }) as typeof fs.lstat);
  await expect(readLog(log)).rejects.toThrow('regular');
  vi.restoreAllMocks();
  vi.spyOn(fs, 'lstat').mockImplementation((async (file: Parameters<typeof fs.lstat>[0]) => {
    if (String(file) === log) throw new Error('EACCES fixture');
    return actual(file);
  }) as typeof fs.lstat);
  expect(
    (await f.service.inspect({ logIds: [id] })).logs.find((l) => l.id === id)?.error,
  ).toContain('unreadable');
  vi.restoreAllMocks();
  vi.spyOn(fs, 'lstat').mockImplementation((async (file: Parameters<typeof fs.lstat>[0]) => {
    if (String(file) === log) return new Promise(() => {});
    return actual(file);
  }) as typeof fs.lstat);
  const started = Date.now(),
    result = await f.service.inspect({ logIds: [id] });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(result.logs.find((l) => l.id === id)?.error).toContain('time limit');
});
it('labels unavailable operation history rather than implying no operations occurred', async () => {
  const f = await fixture();
  await put(f.storage.file('data/operation-history.json'), 'not valid JSON');
  const result = await f.service.inspect({ logIds: [] });
  expect(result.historyError).toContain('cannot be verified');
  expect(result.report).toContain(result.historyError);
});
it('includes only the report sections requested while retaining the privacy notice', async () => {
  const f = await fixture();
  const result = await f.service.inspect({ logIds: [], reportSections: ['profile'] });
  expect(result.report).toContain('## Profile');
  expect(result.report).not.toContain('## Mods');
  expect(result.report).not.toContain('## Prerequisites');
  expect(result.report).not.toContain('## Recent operations');
  expect(result.report).toContain('redaction may be incomplete');
  expect(
    DiagnosticRequestSchema.safeParse({ logIds: [], reportSections: ['secrets'] }).success,
  ).toBe(false);
});
it('leaves enabled state unknown for unmanaged or unverified files and does not claim permission errors prove corruption', async () => {
  const f = await fixture();
  f.snapshot.localMods = [
    {
      id: 'outside',
      title: 'Outside',
      managed: false,
      state: 'unmanaged',
      folderName: 'outside',
      canAdopt: false,
      problems: [],
    },
    {
      id: 'unverified',
      title: 'Unverified',
      managed: true,
      state: 'broken',
      folderName: 'unverified',
      canAdopt: false,
      problems: ['main.lua cannot be verified.'],
    },
  ];
  const result = await f.service.inspect({ logIds: [] });
  expect(result.mods.every((m) => m.enabled === undefined)).toBe(true);
  expect(result.report).toContain('enabled state unknown');
  expect(result.findings.find((f) => f.observed.includes('cannot be verified'))).toMatchObject({
    kind: 'warning',
    why: expect.stringContaining('prevents a reliable integrity check'),
  });
});
it('limits persistent operation history independently from journals and marks interrupted outcomes uncertain', async () => {
  const f = await fixture(),
    history = new OperationHistoryStore(f.storage),
    retained = f.storage.file('transactions/fixture.json');
  await put(retained, 'recovery fixture');
  for (let i = 0; i < 105; i++)
    await history.record(
      randomUUID(),
      f.storage.state,
      f.storage.state,
      i === 104 ? 'uncertain' : 'success',
      i === 104 ? 'profile-switch' : 'update',
    );
  const entries = await history.read();
  expect(entries).toHaveLength(100);
  expect(entries.at(-1)?.outcome).toBe('uncertain');
  expect(await fs.readFile(retained, 'utf8')).toBe('recovery fixture');
  await history.recovered(entries.at(-1)!.id, 'failed');
  expect((await history.read()).at(-1)?.outcome).toBe('failed');
});
