import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DiagnosticRequestSchema,
  ReportSections,
  type ReportSection,
  type DiagnosticLog,
  type Finding,
  type Troubleshooting,
  type DiagnosticRequest,
} from '../../src/shared/features';
import type { Snapshot } from '../../src/shared/model';
import { evaluateDependencies } from '../../src/shared/dependencies';
import { profileSummary } from '../../src/shared/profile-selection';
import { safeDestination, atomicWrite, contained } from './files';
import { Storage } from './storage';
import { OperationHistoryStore } from './history';
import { ProfileService } from './profiles';
import { TransactionEngine } from './transaction';
import { UserError } from './errors';

const MAX_READ = 64 * 1024,
  MAX_EXCERPT = 8000;
async function within<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new UserError('The log processing time limit was reached. Select fewer files.')),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function redact(
  text: string,
  roots: { home?: string; mods?: string; game?: string; data?: string } = {},
) {
  let result = text;
  for (const [key, value] of Object.entries(roots).sort(
    (a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0),
  ))
    if (value) {
      for (const variant of new Set([
        value,
        value.replaceAll('\\', '/'),
        value.replaceAll('\\', '\\\\'),
      ])) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'gi'), `<${key}>`);
      }
    }
  return result
    .replace(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '<home>')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '<home>')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://<redacted>@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '<redacted>')
    .replace(/\b(Bearer\s+)[\w.\-]+/gi, '$1<redacted>')
    .replace(
      /((?:token|password|secret|authorization|api[_-]?key|username|user)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
      '$1<redacted>',
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');
}
export async function readLog(
  file: string,
): Promise<{ text: string; modifiedAt: string; truncated: boolean }> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new UserError('Only regular text log files can be read.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev)
      throw new UserError('The log changed while it was being opened. Refresh.');
    const length = Math.min(stat.size, MAX_READ),
      buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    const raw = buffer.subarray(0, bytesRead);
    if (raw.includes(0))
      throw new UserError('This file contains binary data. Choose a plain-text log.');
    let text = raw.toString('utf8');
    if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
    return {
      text: text.slice(-MAX_EXCERPT),
      modifiedAt: stat.mtime.toISOString(),
      truncated: stat.size > MAX_EXCERPT,
    };
  } finally {
    await handle.close();
  }
}
export function diagnosticFindings(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  if (snapshot.safetyError)
    findings.push({
      kind: 'problem',
      observed: snapshot.safetyError,
      why: 'File management is locked to preserve recoverable data.',
      next: 'Keep backups and export a support report.',
      action: 'logs',
    });
  if (!snapshot.validation?.valid)
    findings.push({
      kind: snapshot.validation ? 'problem' : 'warning',
      observed: 'The Balatro installation is not verified.',
      why: 'Installation and profile switches need approved game and Mods folders.',
      next: 'Check the game location in Settings.',
      action: 'prerequisites',
    });
  if (!snapshot.validation?.detectedVersion)
    findings.push({
      kind: 'warning',
      observed: 'Balatro version is unknown.',
      why: 'Version compatibility cannot be established without reliable evidence.',
      next: 'Review the game and prerequisite information.',
      action: 'prerequisites',
    });
  for (const mod of snapshot.localMods) {
    for (const problem of mod.problems)
      findings.push({
        kind: mod.managed && !problem.includes('cannot be verified') ? 'problem' : 'warning',
        observed: `${mod.title}: ${problem}`,
        why: problem.includes('cannot be verified')
          ? 'Access or missing evidence prevents a reliable integrity check.'
          : mod.managed
            ? 'The current files do not match the managed installation record.'
            : 'Unmanaged files cannot be verified against an installation record.',
        next: 'Review this mod in Installed. Preserve external changes before reinstalling.',
        action: 'installed',
        modId: mod.id,
      });
    if (mod.disabled || mod.state === 'disabled') continue;
    for (const status of evaluateDependencies(mod.dependencies ?? [], snapshot.prerequisites))
      if (status.state !== 'satisfied')
        findings.push({
          kind:
            status.required && ['missing', 'outdated', 'incompatible'].includes(status.state)
              ? 'problem'
              : 'warning',
          observed: `${mod.title}: ${status.reason}`,
          why:
            status.state === 'unknown'
              ? 'The available version evidence does not prove compatibility.'
              : 'An enabled mod declares this dependency.',
          next: 'Review Prerequisites or the mod installation workflow.',
          action: 'prerequisites',
          modId: mod.id,
        });
  }
  if (snapshot.localMods.some((m) => !m.managed))
    findings.push({
      kind: 'warning',
      observed: 'Unmanaged mods are present.',
      why: 'Profiles leave these files untouched, so they may still affect gameplay.',
      next: 'Review Installed and adopt supported mods if you want profiles to manage them.',
      action: 'installed',
    });
  if (snapshot.profiles?.unsaved)
    findings.push({
      kind: 'warning',
      observed: `The active profile has unsaved selection differences: ${snapshot.profiles.differences.join(', ')}.`,
      why: 'The actual enabled selection differs from the saved profile.',
      next: 'Save the selection or review a revert preview.',
      action: 'profiles',
    });
  return findings.slice(0, 1000);
}
export function supportReport(
  result: Omit<Troubleshooting, 'report'>,
  sections: readonly ReportSection[] = ReportSections,
) {
  const lines = [
    `# Modatro support report`,
    `Generated: ${result.generatedAt}`,
    `Modatro ${result.appVersion}; ${result.platform} ${result.arch}`,
    `Balatro: ${result.gameVersion ?? 'unknown'}`,
    ``,
    '## Prerequisites',
    ...result.prerequisites.map(
      (p) =>
        `- ${p.id}: ${p.installed ? 'installed' : 'missing'}; version ${p.version ?? 'unknown'}`,
    ),
    '',
    '## Profile',
    result.profile
      ? `${result.profile.items.find((p) => p.id === result.profile!.activeId)?.name}; ${result.profile.unsaved ? 'unsaved differences: ' + result.profile.differences.join(', ') : 'saved selection'}`
      : 'Unavailable',
    'Versions and configurations are shared. Unmanaged mods remain untouched.',
    '',
    '## Mods',
    ...result.mods.map(
      (m) =>
        `- ${m.id}: ${m.version ?? 'unknown'}; ${m.enabled === undefined ? 'enabled state unknown' : m.enabled ? 'enabled' : 'disabled'}; ${m.managed ? 'managed' : 'unmanaged'}`,
    ),
    '',
    '## Findings',
    ...result.findings.map(
      (f) => `- [${f.kind}] ${f.observed}\n  Why: ${f.why}\n  Next: ${f.next}`,
    ),
    '',
    '## Recent operations',
    result.historyError ?? '',
    ...result.history.map(
      (h) =>
        `- ${h.time} ${h.type}: ${h.outcome}; ${h.profile ?? ''}; ${h.ids.join(', ')}${h.versions.map((v) => `; ${h.outcome === 'success' ? '' : 'planned '}${v.id}: ${v.before ?? 'not installed'} → ${v.after ?? 'not installed'}`).join('')}`,
    ),
    '',
    '## Selected log excerpts',
    ...result.logs
      .filter((l) => l.excerpt !== undefined)
      .map(
        (l) =>
          `\n${l.source}: ${l.name}; modified ${l.modifiedAt ?? 'unknown'}${l.stale ? '; older than 24 hours' : ''}\n${l.excerpt}`,
      ),
    '',
    'Logs are excluded unless explicitly selected. Automated redaction may be incomplete; inspect and edit before sharing.',
  ];
  const names: Record<string, ReportSection> = {
    '## Prerequisites': 'setup',
    '## Profile': 'profile',
    '## Mods': 'mods',
    '## Findings': 'findings',
    '## Recent operations': 'history',
  };
  let current: ReportSection | 'logs' | undefined;
  return lines
    .filter((line, index) => {
      if (names[line]) current = names[line];
      if (line === '## Selected log excerpts') current = 'logs';
      if (index === 2 || index === 3) return sections.includes('setup');
      return !current || current === 'logs' || sections.includes(current);
    })
    .join('\n')
    .slice(0, 100000);
}
export class TroubleshootingService {
  private approved = new Map<string, { file: string; source: string; picked: boolean }>();
  constructor(
    private storage: Storage,
    private transactions: TransactionEngine,
    private snapshot: () => Promise<Snapshot>,
    private profiles: ProfileService,
  ) {}
  private privacy() {
    return {
      home: os.homedir(),
      mods: this.storage.state.settings.modsPath,
      game: this.storage.state.settings.gamePath,
      data: this.storage.root,
    };
  }
  async choose(file: string) {
    if (!/\.(?:log|txt)$/i.test(file)) throw new UserError('Choose a .log or .txt file.');
    // Only the native picker calls this method. Renderer requests use opaque IDs.
    const canonicalParent = await fs.realpath(path.dirname(file));
    const approved = await safeDestination(canonicalParent, path.basename(file));
    const stat = await fs.lstat(approved);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new UserError('Choose a regular text log file.');
    const id = randomUUID();
    if (this.approved.size >= 64) this.approved.delete(this.approved.keys().next().value!);
    this.approved.set(id, { file: approved, source: 'Selected log', picked: true });
    return id;
  }
  private async discover(deadline: number) {
    const roots = [
      { root: this.storage.root, relative: 'logs', source: 'Modatro' },
      ...(this.storage.state.settings.modsPath
        ? [
            {
              root: this.storage.state.settings.modsPath,
              relative: 'lovely/log',
              source: 'Lovely / Steamodded',
            },
          ]
        : []),
    ];
    const warnings: DiagnosticLog[] = [];
    for (const root of roots) {
      try {
        const files = await within(
          (async () => {
            const directory = await safeDestination(root.root, root.relative),
              entries: { file: string; time: number }[] = [];
            const stream = await fs.opendir(directory);
            let count = 0;
            for await (const entry of stream) {
              if (++count > 200 || Date.now() >= deadline) break;
              if (!entry.isFile() || !/\.(?:log|txt)$/i.test(entry.name)) continue;
              try {
                const file = await safeDestination(root.root, `${root.relative}/${entry.name}`),
                  info = await fs.lstat(file);
                if (info.isFile()) entries.push({ file, time: info.mtimeMs });
              } catch {
                /* Rotation or an inaccessible entry must not hide other logs. */
              }
            }
            return entries.sort((a, b) => b.time - a.time).slice(0, 3);
          })(),
          deadline,
        );
        for (const [id, existing] of this.approved)
          if (
            !existing.picked &&
            existing.source === root.source &&
            !files.some((f) => f.file === existing.file)
          )
            this.approved.delete(id);
        for (const entry of files)
          if (![...this.approved.values()].some((a) => a.file === entry.file))
            this.approved.set(randomUUID(), {
              file: entry.file,
              source: root.source,
              picked: false,
            });
      } catch {
        warnings.push({
          id: `unavailable-${root.source}`,
          name: 'Logs unavailable',
          source: root.source,
          error: 'No readable log folder was found. Logs may be absent or access may be denied.',
        });
      }
    }
    return warnings;
  }
  async inspect(input: DiagnosticRequest): Promise<Troubleshooting> {
    const request = DiagnosticRequestSchema.parse(input);
    return this.transactions.inspectLocked(async () => {
      const snapshot = await this.snapshot(),
        findings = diagnosticFindings(snapshot);
      if (snapshot.profiles && !snapshot.safetyError) {
        const plan = await this.profiles.readPlan(snapshot.profiles.activeId, snapshot);
        for (const blocker of plan.blockers)
          findings.push({
            kind: 'problem',
            observed: `Saved profile cannot be applied: ${blocker}`,
            why: 'Reverting requires a safe, dependency-compatible managed selection.',
            next: 'Review the profile preview or save a corrected selection.',
            action: 'profiles',
          });
      }
      const deadline = Date.now() + 2000,
        logs = await this.discover(deadline);
      for (const id of request.logIds)
        if (!this.approved.has(id))
          throw new UserError(
            'This log selection is unavailable. Refresh or choose the log again.',
          );
      for (const [id, entry] of this.approved) {
        const log: DiagnosticLog = {
          id,
          name: redact(path.basename(entry.file), this.privacy()),
          source: entry.source,
        };
        try {
          const stat = await within(fs.lstat(entry.file), deadline);
          log.modifiedAt = stat.mtime.toISOString();
          log.stale = Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000;
          if (request.logIds.includes(id)) {
            if (Date.now() >= deadline)
              throw new UserError('The log processing time limit was reached. Select fewer files.');
            const read = await within(readLog(entry.file), deadline);
            log.modifiedAt = read.modifiedAt;
            log.excerpt = redact(read.text, this.privacy());
            if (read.truncated)
              log.excerpt = '[Excerpt limited to the last 8,000 characters]\n' + log.excerpt;
            if (/\b(?:error|crash|stack traceback|exception|failed)\b/i.test(read.text)) {
              const evidence = log.excerpt
                .split('\n')
                .filter((line) =>
                  /\b(?:error|crash|stack traceback|exception|failed)\b/i.test(line),
                )
                .slice(0, 3)
                .map((line) => line.slice(0, 300))
                .join(' | ');
              findings.push({
                kind: 'possible',
                observed: `${log.name} (${log.modifiedAt}${log.stale ? ', older than 24 hours' : ''}) contains failure-related text: ${evidence}`,
                why: 'This is log evidence, not proof that a referenced mod caused the failure. File time does not prove which game session produced it.',
                next: 'Compare the timestamp with the affected run and review the selected excerpt.',
                action: 'logs',
              });
            }
          }
        } catch (e) {
          log.error =
            e instanceof UserError
              ? e.message
              : 'This log is missing, rotated, unreadable or no longer a regular file.';
        }
        logs.push(log);
      }
      // Build the entire setup under the same lock used by file operations.
      const history = await new OperationHistoryStore(this.storage).status();
      const result: Omit<Troubleshooting, 'report'> = {
        generatedAt: new Date().toISOString(),
        appVersion: snapshot.appVersion,
        platform: snapshot.platform,
        arch: snapshot.arch,
        gameVersion: snapshot.validation?.detectedVersion,
        prerequisites: snapshot.prerequisites.map((p) => ({
          id: p.id,
          installed: p.installed,
          version: p.installedVersion,
        })),
        mods: snapshot.localMods.map((m) => {
          const record = this.storage.state.installations.find((r) => r.modId === m.id);
          return {
            id: m.id,
            title: m.title,
            version: m.version,
            enabled: record && m.managed && !m.problems.length ? !record.disabled : undefined,
            managed: m.managed,
          };
        }),
        profile: profileSummary(
          this.storage.state,
          snapshot.localMods.filter((m) => !m.managed).length,
        ),
        findings,
        history: history.entries,
        historyError: history.error,
        logs,
      };
      const clean = JSON.parse(redact(JSON.stringify(result), this.privacy())) as Omit<
        Troubleshooting,
        'report'
      >;
      return { ...clean, report: supportReport(clean, request.reportSections) };
    });
  }
  async export(file: string, text: string) {
    if (!/\.(?:md|txt)$/i.test(file))
      throw new UserError('Export the report as a .md or .txt file.');
    const parent = await fs.realpath(path.dirname(file));
    const destination = await safeDestination(parent, path.basename(file));
    for (const root of [
      this.storage.root,
      this.storage.state.settings.gamePath,
      this.storage.state.settings.modsPath,
    ])
      if (root && contained(root, destination))
        throw new UserError(
          'Save the support report outside game, Mods and application-data folders.',
        );
    await atomicWrite(destination, text);
  }
}
