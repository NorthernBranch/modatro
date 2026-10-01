import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  RelativePath,
  type DependencyRequirement,
  type ModDefinition,
} from '../../src/shared/model';
import { UserError } from './errors';
import { AuthorManifestSchema } from '../../src/shared/catalogue-schema';
import { exists, readPrefix, readSmall, safeDestination, walkFiles } from './files';
const Manifest = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  version_number: z.string().optional(),
  main_file: z.string().optional(),
  author: z.union([z.string(), z.array(z.string())]).optional(),
  dependencies: z.array(z.string()).optional(),
  conflicts: z.array(z.string()).optional(),
});
export interface ModMetadata {
  id?: string;
  name?: string;
  version?: string;
  requirements: DependencyRequirement[];
  conflicts: DependencyRequirement[];
}
export function catalogueMatches(
  metadata: ModMetadata,
  catalogue: ModDefinition[],
): ModDefinition[] {
  if (!metadata.id) return [];
  return catalogue.filter((mod) =>
    [
      mod.metadataId,
      mod.id,
      mod.id.split(/[@/]/).pop(),
      ...(mod.legacyIds ?? []).map((id) => id.split(/[@/]/).pop()),
    ].some((id) => id?.toLowerCase() === metadata.id!.toLowerCase()),
  );
}
export function dependencyId(id: string): string {
  return (
    (
      {
        steamodded: 'Steamodded',
        smods: 'Steamodded',
        lovely: 'Lovely',
        talisman: 'Talisman',
        balatro: 'Balatro',
      } as Record<string, string>
    )[id.toLowerCase()] ?? id
  );
}
export function parseRequirement(text: string): DependencyRequirement {
  const thunderstore = /^Thunderstore-lovely-(\d+\.\d+\.\d+)$/.exec(text);
  if (thunderstore)
    return {
      id: 'Lovely',
      displayName: 'Lovely',
      versionConstraint: `>=${thunderstore[1]}`,
      required: true,
    };
  const match = /^([\w.-]+)(.*)$/.exec(text.trim());
  if (!match)
    throw new UserError(`The dependency “${text}” is not in a supported structured format.`);
  const id = dependencyId(match[1]!);
  const suffix = match[2]!.trim();
  let versionConstraint: string | undefined;
  if (suffix) {
    const range = /^(?:\([^()]+\)\s*)+$/.test(suffix)
      ? [...suffix.matchAll(/\(([^()]+)\)/g)].map((part) => part[1]!.trim()).join(' ')
      : suffix;
    const comparators = [
      ...range.matchAll(/(>=|<=|==|>>|<<|>|<|=)\s*([^<>=]+?)(?=\s*(?:>=|<=|==|>>|<<|>|<|=)|$)/g),
    ];
    if (
      comparators.length &&
      comparators
        .map((part) => part[0])
        .join('')
        .replace(/\s/g, '') === range.replace(/\s/g, '')
    )
      versionConstraint = comparators
        .map(
          (part) =>
            `${({ '==': '=', '>>': '>', '<<': '<' } as Record<string, string>)[part[1]!] ?? part[1]}${part[2]!.trim()}`,
        )
        .join(' ');
    else if (/^(?:\^|~|\*|\d)/.test(range) && suffix.startsWith('(')) versionConstraint = range;
    else throw new UserError(`The dependency “${text}” is not in a supported structured format.`);
  }
  return {
    id,
    displayName: id,
    versionConstraint,
    required: true,
  };
}
export function parseLuaHeader(text: string): ModMetadata | undefined {
  const header = text.slice(0, 16000);
  if (!/^--- STEAMODDED HEADER(?:\r?\n|$)/.test(header)) return undefined;
  const field = (name: string) =>
    new RegExp(`^---\\s*${name}:\\s*(.+)$`, 'm').exec(header)?.[1]?.trim();
  const list = (name: string) =>
    (
      field(name)
        ?.replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? []
    ).map(parseRequirement);
  const requirements = list('DEPENDENCIES');
  if (
    dependencyId(field('MOD_ID') ?? '') !== 'Steamodded' &&
    !requirements.some((requirement) => requirement.id === 'Steamodded')
  )
    requirements.push({ id: 'Steamodded', displayName: 'Steamodded', required: true });
  return {
    id: field('MOD_ID'),
    name: field('MOD_NAME'),
    version: field('VERSION'),
    requirements,
    conflicts: list('CONFLICTS'),
  };
}
export async function inspectMetadata(root: string): Promise<ModMetadata> {
  const results: ModMetadata[] = [];
  let authorMetadata: ModMetadata | undefined;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(root, entry.name);
    if (entry.name === 'modatro.json') {
      const manifest = AuthorManifestSchema.parse(JSON.parse(await readSmall(file)));
      authorMetadata = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        requirements: Object.entries(manifest.requirements).map(([id, versionConstraint]) => ({
          id: dependencyId(id),
          displayName: id,
          versionConstraint,
          required: true,
        })),
        conflicts: [],
      };
    }
    if (entry.name.endsWith('.json') && entry.name !== 'modatro.json') {
      let raw: unknown;
      try {
        raw = JSON.parse(await readSmall(file));
      } catch {
        if (['manifest.json', 'mod.json'].includes(entry.name))
          throw new UserError(
            'This mod’s manifest is malformed. Automatic installation is blocked.',
          );
        continue;
      }
      const parsed = Manifest.safeParse(raw);
      if (!parsed.success) {
        if (raw && typeof raw === 'object' && ('id' in raw || entry.name === 'manifest.json'))
          throw new UserError('This mod’s structured metadata is invalid.');
        continue;
      }
      const m = parsed.data;
      if (m.id || (entry.name === 'manifest.json' && m.name)) {
        const requirements = (m.dependencies ?? []).map(parseRequirement);
        if (m.main_file) {
          if (!RelativePath.safeParse(m.main_file).success)
            throw new UserError('This mod declares an unsafe entry-point path.');
          const main = await safeDestination(root, m.main_file);
          if (!(await exists(main)) || !(await fs.lstat(main)).isFile())
            throw new UserError('This mod’s declared entry-point file is missing.');
          if (
            dependencyId(m.id ?? '') !== 'Steamodded' &&
            !requirements.some((requirement) => requirement.id === 'Steamodded')
          )
            requirements.push({ id: 'Steamodded', displayName: 'Steamodded', required: true });
        }
        results.push({
          id: m.id ?? (m.name === 'Steamodded' ? 'Steamodded' : undefined),
          name: m.name,
          version: m.version ?? m.version_number,
          requirements,
          conflicts: (m.conflicts ?? []).map(parseRequirement),
        });
      }
    }
    if (entry.name.endsWith('.lua')) {
      const header = parseLuaHeader(await readPrefix(file));
      if (header) results.push(header);
    }
  }
  if (authorMetadata) {
    if (results.some((result) => result.version && result.version !== authorMetadata!.version))
      throw new UserError('The author manifest and loader metadata declare different versions.');
    results.push(
      results.some((result) => result.id) ? { ...authorMetadata, id: undefined } : authorMetadata,
    );
  }
  const identities = new Set(results.map((m) => m.id).filter(Boolean));
  if (identities.size > 1)
    throw new UserError(
      'This folder contains multiple mod identities. Automatic installation is ambiguous.',
    );
  const merged: ModMetadata = {
    id: results.find((r) => r.id)?.id,
    name: results.find((r) => r.name)?.name,
    version: results.find((r) => r.version)?.version,
    requirements: results.flatMap((r) => r.requirements),
    conflicts: results.flatMap((r) => r.conflicts),
  };
  if (merged.id === 'Steamodded' && (await exists(path.join(root, 'version.lua')))) {
    // Read a literal return value; never evaluate Lua.
    merged.version =
      /^\s*return\s+["']([^"']+)["']\s*$/.exec(
        await readSmall(path.join(root, 'version.lua')),
      )?.[1] ?? merged.version;
  }
  return merged;
}
export function mergeRequirements(...groups: DependencyRequirement[][]): DependencyRequirement[] {
  // Keep every explicit constraint; never weaken a requirement with an unversioned duplicate.
  const map = new Map<string, DependencyRequirement>();
  for (const r of groups.flat()) {
    const normalized = { ...r, id: dependencyId(r.id) };
    const key = `${normalized.id}:${r.versionConstraint ?? ''}`;
    map.set(key, { ...normalized, required: r.required || map.get(key)?.required === true });
  }
  return [...map.values()];
}
export async function detectModRoot(staging: string): Promise<string> {
  const files = await walkFiles(staging);
  const dirs = new Set(['']);
  for (const file of files) {
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++) dirs.add(parts.slice(0, count).join('/'));
  }
  const candidates: string[] = [];
  for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    if (candidates.some((parent) => parent === '' || dir.startsWith(`${parent}/`))) continue;
    const prefix = dir ? `${dir}/` : '';
    const children = files.filter((f) => f.startsWith(prefix));
    if (
      children.includes(`${prefix}lovely.toml`) ||
      children.some((f) => f.startsWith(`${prefix}lovely/`) && f.endsWith('.toml')) ||
      children.includes(`${prefix}main.lua`)
    ) {
      candidates.push(dir);
      continue;
    }
    const meta = await inspectMetadata(path.join(staging, dir));
    if (meta.id) candidates.push(dir);
  }
  if (candidates.length !== 1)
    throw new UserError(
      candidates.length
        ? 'This archive contains multiple possible mod folders. Automatic installation is not supported yet.'
        : 'Modatro could not identify a supported mod folder. Automatic installation is not supported yet.',
    );
  return path.join(staging, candidates[0]!);
}
