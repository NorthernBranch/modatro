import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { z } from 'zod';
import { ModSchema, type LocalMod, type ModDefinition } from '../../src/shared/model';
import {
  CREATOR_TARGET,
  CreatorDraftSchema,
  CreatorProjectSchema,
  CreatorRequestSchema,
  creatorIdentities,
  type CreatorDraft,
  type CreatorProject,
  type CreatorRequest,
  type CreatorResponse,
  type CreatorSummary,
} from '../../src/shared/creator';
import { generateLua, luaDiagnostics } from '../../src/shared/creator-lua';
import { atomicWrite, contained, exists, hashFile, readSmall, safeDestination } from './files';
import { UserError } from './errors';
import { type Storage } from './storage';
import { type TransactionEngine } from './transaction';
import { cardArtwork, decodeArtwork, placeholderArtwork } from './creator-art';
import { parseLuaHeader } from './metadata';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const buildRecord = z
  .object({ definition: ModSchema, projectId: z.uuid(), id: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export class CreatorService {
  constructor(
    private storage: Storage,
    private transactions: TransactionEngine,
    private localMods: () => Promise<LocalMod[]>,
    private register: (definition: ModDefinition) => Promise<void>,
    public native: {
      artwork: () => Promise<string | undefined>;
      export: (name: string) => Promise<string | undefined>;
      open: (folder: string) => Promise<void>;
    } = { artwork: async () => undefined, export: async () => undefined, open: async () => {} },
  ) {}
  private async file(relative: string) {
    return safeDestination(this.storage.root, `creator/${relative}`);
  }
  private async mkdir(relative: string) {
    const file = await this.file(relative);
    await fs.mkdir(file, { recursive: true });
    return file;
  }
  private async json(relative: string, value: unknown) {
    await atomicWrite(await this.file(relative), JSON.stringify(value, null, 2) + '\n');
  }
  private location(id: string) {
    return `projects/${z.uuid().parse(id)}`;
  }
  private async readBytes(file: string) {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new UserError('Choose a regular file.');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        throw new UserError('Choose a file no larger than 8 MiB.');
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size)
        throw new UserError('The artwork changed while reading it. Try again.');
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  private async read(id: string) {
    const location = this.location(id);
    const raw = await readSmall(await this.file(`${location}/project.json`));
    const stored = CreatorProjectSchema.parse(JSON.parse(raw));
    if (stored.id !== id) throw new UserError('The project identity has changed.');
    const lua = await readSmall(await this.file(`${location}/main.lua`), 128 * 1024);
    let artwork: CreatorProject['artwork'];
    let image = placeholderArtwork(stored.draft.recipe === 'deck');
    if (stored.artHash) {
      const bytes = await this.readBytes(await this.file(`${location}/art/${stored.artHash}.png`));
      if (digest(bytes) !== stored.artHash)
        throw new UserError(
          'Original artwork changed externally. Restore the project copy before continuing.',
        );
      image = decodeArtwork(bytes);
      artwork = {
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        width: image.width,
        height: image.height,
      };
    }
    const externalChanges = lua !== stored.draft.lua;
    const draft = {
      ...stored.draft,
      lua,
      mode: externalChanges ? ('custom' as const) : stored.draft.mode,
    };
    const project: CreatorProject = {
      ...stored,
      draft,
      artwork,
      externalChanges,
      token: digest(raw + '\0' + lua),
      previewUrl: `data:image/png;base64,${cardArtwork(image, stored.artHash ? draft.crop : { x: 0.5, y: 0.5, zoom: 1 }, 2).toString('base64')}`,
      installedBuild: this.storage.state.installations.find(
        (r) => r.provenance?.creator?.projectId === id,
      )?.provenance?.creator?.buildId,
    };
    return { stored, raw, project, location };
  }
  private async checked(id: string, token: string) {
    const result = await this.read(id);
    if (result.project.token !== token)
      throw new UserError(
        'The project changed on disk. Reload it before saving; your unsaved editor text is still available.',
      );
    return result;
  }
  async list(): Promise<CreatorSummary[]> {
    const dir = await this.mkdir('projects');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.length > 200)
      throw new UserError('The creator supports up to 200 active projects.');
    const projects: CreatorSummary[] = [];
    for (const entry of entries) {
      if (!z.uuid().safeParse(entry.name).success) continue;
      const file = await this.file(`${this.location(entry.name)}/project.json`);
      const project = CreatorProjectSchema.parse(JSON.parse(await readSmall(file)));
      if (project.id !== entry.name)
        throw new UserError('A project has inconsistent identity metadata.');
      projects.push({
        id: project.id,
        name: project.draft.name,
        updatedAt: project.updatedAt,
        builds: project.builds.length,
        installedBuild: this.storage.state.installations.find(
          (r) => r.provenance?.creator?.projectId === project.id,
        )?.provenance?.creator?.buildId,
      });
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async collision(id: string, draft: CreatorDraft) {
    for (const item of await this.list()) {
      if (item.id === id) continue;
      const { stored } = await this.read(item.id);
      if (
        stored.draft.modId.toLowerCase() === draft.modId.toLowerCase() ||
        stored.draft.prefix === draft.prefix
      )
        throw new UserError('Another local project uses this mod ID or prefix.');
    }
    for (const mod of await this.localMods()) {
      if (mod.provenance?.creator?.projectId === id) continue;
      if ((mod.metadataId ?? mod.id).toLowerCase() === draft.modId.toLowerCase())
        throw new UserError('An installed mod already uses this mod ID.');
      const record = this.storage.state.installations.find((r) => r.modId === mod.id);
      const root = record?.disabled
        ? this.storage.file('disabled')
        : this.storage.state.settings.modsPath;
      if (!root) continue;
      const candidates = record
        ? record.files
            .filter(
              (f) =>
                f.root === (record.disabled ? 'disabled' : 'mods') && /\.(json|lua)$/.test(f.path),
            )
            .map((f) => f.path)
        : [];
      if (!record && !mod.folderName.endsWith('.lua')) {
        const folder = await safeDestination(root, mod.folderName);
        for (const name of (await fs.readdir(folder))
          .filter((name) => /\.(json|lua)$/.test(name))
          .slice(0, 30))
          candidates.push(`${mod.folderName}/${name}`);
      }
      if (!record && mod.folderName.endsWith('.lua')) candidates.push(mod.folderName);
      candidates.sort(
        (a, b) =>
          a.split('/').length - b.split('/').length ||
          Number(a.endsWith('.lua')) - Number(b.endsWith('.lua')) ||
          a.localeCompare(b),
      );
      for (const file of candidates.slice(0, 30)) {
        if (!(await exists(await safeDestination(root, file)))) continue;
        const text = await readSmall(await safeDestination(root, file));
        if (file.endsWith('.lua')) {
          const legacy = parseLuaHeader(text);
          const prefix =
            /^\s*---\s*PREFIX:\s*(\S+)/m.exec(text)?.[1] ?? legacy?.id?.slice(0, 4).toLowerCase();
          if (prefix?.toLowerCase() === draft.prefix.toLowerCase())
            throw new UserError('An installed mod already uses this prefix.');
          continue;
        }
        let meta: { prefix?: unknown };
        try {
          meta = JSON.parse(text);
        } catch {
          continue;
        }
        if (
          typeof meta.prefix === 'string' &&
          meta.prefix.toLowerCase() === draft.prefix.toLowerCase()
        )
          throw new UserError('An installed mod already uses this prefix.');
      }
    }
  }
  private async save(id: string, token: string, input: CreatorDraft, regenerate = false) {
    const current = await this.checked(id, token);
    const draft = CreatorDraftSchema.parse(input);
    if (
      current.stored.builds.length &&
      (draft.modId !== current.stored.draft.modId || draft.prefix !== current.stored.draft.prefix)
    )
      throw new UserError(
        'Mod ID and prefix are fixed after the first build. Create another project to use a new identity.',
      );
    await this.collision(id, draft);
    if (draft.mode === 'template' && current.project.draft.mode === 'custom' && !regenerate)
      throw new UserError(
        'Returning to template mode requires confirmation. Custom source will be preserved in history.',
      );
    await this.mkdir(`${current.location}/history`);
    await atomicWrite(
      await this.file(`${current.location}/history/${digest(current.project.draft.lua)}.lua`),
      current.project.draft.lua,
    );
    await atomicWrite(
      await this.file(`${current.location}/history/${digest(current.raw)}.json`),
      current.raw,
    );
    draft.lua = draft.mode === 'template' ? generateLua(draft) : draft.lua;
    const stored = CreatorProjectSchema.parse({
      ...current.stored,
      draft,
      updatedAt: new Date().toISOString(),
    });
    const main = await this.file(`${current.location}/main.lua`);
    await this.checked(id, token);
    await atomicWrite(main, draft.lua);
    try {
      await this.json(`${current.location}/project.json`, stored);
    } catch (error) {
      if ((await readSmall(main, 128 * 1024)) === draft.lua)
        await atomicWrite(main, current.project.draft.lua);
      throw error;
    }
    return (await this.read(id)).project;
  }
  async archiveFor(origin: { projectId: string; buildId: string }) {
    const id = z.uuid().parse(origin.projectId),
      hash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(origin.buildId);
    const file = await this.file(`builds/${id}/${hash}.zip`);
    if ((await hashFile(file)) !== hash)
      throw new UserError(
        'The local build archive changed. Rebuild the project before installing.',
      );
    return file;
  }
  async perform(input: CreatorRequest): Promise<CreatorResponse> {
    const request = CreatorRequestSchema.parse(input);
    this.storage.assertSafe();
    if (
      !this.storage.state.settings.creatorEnabled ||
      !this.storage.state.settings.creatorAcknowledged
    )
      throw new UserError(
        'Enable Mod Creator in Settings and acknowledge its experimental status first.',
      );
    let chosen: string | undefined;
    if (request.operation === 'import-art') chosen = await this.native.artwork();
    if (request.operation === 'export')
      chosen = await this.native.export(`modatro-created-${request.id.slice(0, 8)}.zip`);
    return this.transactions.locked(async () => {
      this.storage.assertSafe();
      if (
        !this.storage.state.settings.creatorEnabled ||
        !this.storage.state.settings.creatorAcknowledged
      )
        throw new UserError('Mod Creator was disabled while this operation was pending.');
      let project: CreatorProject | undefined,
        definition: ModDefinition | undefined,
        exported: boolean | undefined;
      if (request.operation === 'create') {
        if ((await this.list()).length >= 200)
          throw new UserError('Archive a project before creating another.');
        const id = randomUUID(),
          time = new Date().toISOString();
        const draft: CreatorDraft = {
          name: request.name,
          author: request.author,
          description: 'A locally created experimental mod.',
          version: '1.0.0',
          ...creatorIdentities(id),
          recipe: request.recipe,
          amount: request.recipe === 'joker-chips' ? 30 : 4,
          suit: 'Hearts',
          dollars: 10,
          hands: 1,
          discards: 0,
          mode: 'template',
          lua: '',
          crop: { x: 0.5, y: 0.5, zoom: 1 },
        };
        draft.lua = generateLua(draft);
        await this.collision(id, draft);
        const location = this.location(id);
        await this.mkdir(location);
        await atomicWrite(await this.file(`${location}/main.lua`), draft.lua);
        await this.json(`${location}/project.json`, {
          schemaVersion: 1,
          id,
          draft,
          createdAt: time,
          updatedAt: time,
          builds: [],
        });
        project = (await this.read(id)).project;
      } else if (request.operation === 'load') project = (await this.read(request.id)).project;
      else if (request.operation === 'save')
        project = await this.save(request.id, request.token, request.draft, request.regenerate);
      else if (request.operation === 'build') {
        const {
          stored,
          project: current,
          location,
        } = await this.checked(request.id, request.token);
        if (current.externalChanges)
          throw new UserError(
            'main.lua was changed externally. Reload and save the draft before building.',
          );
        await this.collision(request.id, stored.draft);
        const diagnostics = luaDiagnostics(stored.draft.lua);
        if (diagnostics.length)
          throw new UserError(
            'main.lua has syntax errors. Save the draft, fix the listed locations and build again.',
            undefined,
            diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.message}`).join('\n'),
          );
        if (stored.builds.length >= 1000)
          throw new UserError(
            'This project has reached its 1000-build limit. Export and archive it before starting another.',
          );
        const source = stored.artHash
          ? decodeArtwork(Buffer.from(current.artwork!.dataUrl.split(',')[1]!, 'base64'))
          : placeholderArtwork(stored.draft.recipe === 'deck');
        const d = stored.draft;
        const files: Record<string, Uint8Array> = {
          'mod.json': strToU8(
            JSON.stringify(
              {
                id: d.modId,
                name: d.name,
                author: [d.author],
                description: d.description,
                prefix: d.prefix,
                main_file: 'main.lua',
                version: d.version,
                dependencies: [`Steamodded (>=${CREATOR_TARGET})`, 'Lovely'],
              },
              null,
              2,
            ) + '\n',
          ),
          'main.lua': strToU8(d.lua),
          'assets/1x/card.png': cardArtwork(
            source,
            stored.artHash ? d.crop : { x: 0.5, y: 0.5, zoom: 1 },
            1,
          ),
          'assets/2x/card.png': cardArtwork(
            source,
            stored.artHash ? d.crop : { x: 0.5, y: 0.5, zoom: 1 },
            2,
          ),
          'MODATRO-ARTWORK-LICENSE.txt': strToU8(
            'Original Modatro placeholder artwork is released under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Imported artwork remains subject to its owner’s permissions. This permission does not license your Lua or third-party artwork.\n',
          ),
          'README.txt': strToU8(
            `Experimental locally created mod. Requires Balatro, Lovely and Steamodded >=${CREATOR_TARGET}. Extract this folder into Mods. Build validation is not an in-game test or a safety guarantee. Back up your Balatro saves before testing.\n`,
          ),
        };
        const archive = zipSync(
          Object.fromEntries(
            Object.keys(files)
              .sort()
              .map((name) => [`${d.modId}/${name}`, files[name]!]),
          ),
          { level: 6, mtime: new Date(1980, 0, 1) },
        );
        const hash = digest(archive);
        const origin = { projectId: stored.id, buildId: hash };
        definition = ModSchema.parse({
          id: `local/creator_${stored.id}`,
          metadataId: d.modId,
          title: d.name,
          author: d.author,
          version: d.version,
          description: d.description,
          descriptionProvenance: 'author-supplied',
          folderName: `ModatroCreated_${stored.id.replaceAll('-', '')}`,
          downloadUrl: 'https://github.com/NorthernBranch/modatro',
          source: { provider: 'local', externalId: `creator_${stored.id}` },
          categories: ['Created locally'],
          prerequisites: [
            {
              id: 'Steamodded',
              displayName: 'Steamodded',
              required: true,
              versionConstraint: `>=${CREATOR_TARGET}`,
            },
            { id: 'Lovely', displayName: 'Lovely', required: true },
          ],
          installation: { type: 'standard' },
          creator: origin,
        });
        await this.mkdir(`builds/${stored.id}`);
        const archiveFile = await this.file(`builds/${stored.id}/${hash}.zip`);
        if (await exists(archiveFile)) {
          if ((await hashFile(archiveFile)) !== hash)
            throw new UserError(
              'An existing build was modified externally. It will not be overwritten.',
            );
        } else await atomicWrite(archiveFile, Buffer.from(archive));
        await this.json(`builds/${stored.id}/${hash}.json`, {
          definition,
          projectId: stored.id,
          id: hash,
        });
        if (!stored.builds.some((b) => b.id === hash))
          await this.json(`${location}/project.json`, {
            ...stored,
            builds: [
              ...stored.builds,
              {
                id: hash,
                revision: stored.builds.length + 1,
                version: d.version,
                createdAt: new Date().toISOString(),
              },
            ],
          });
        await this.register(definition);
        project = (await this.read(stored.id)).project;
      } else if (request.operation === 'prepare-install') {
        await this.archiveFor({ projectId: request.id, buildId: request.buildId });
        const info = buildRecord.parse(
          JSON.parse(
            await readSmall(await this.file(`builds/${request.id}/${request.buildId}.json`)),
          ),
        );
        if (
          info.projectId !== request.id ||
          info.id !== request.buildId ||
          info.definition.creator?.projectId !== request.id ||
          info.definition.creator?.buildId !== request.buildId
        )
          throw new UserError('The build identity could not be verified.');
        definition = info.definition;
        await this.register(definition);
        project = (await this.read(request.id)).project;
      } else if (request.operation === 'import-art' || request.operation === 'reset-art') {
        const { stored, location } = await this.checked(request.id, request.token);
        if (request.operation === 'import-art' && !chosen)
          return { projects: await this.list(), project: (await this.read(request.id)).project };
        let artHash: string | undefined;
        if (chosen) {
          const bytes = await this.readBytes(chosen);
          decodeArtwork(bytes);
          const sanitized = bytes; // Preserve the original; generated atlas PNGs strip ancillary metadata.
          artHash = digest(sanitized);
          await this.mkdir(`${location}/art`);
          await atomicWrite(await this.file(`${location}/art/${artHash}.png`), sanitized);
        }
        await this.json(`${location}/project.json`, {
          ...stored,
          artHash,
          draft: { ...stored.draft, crop: { x: 0.5, y: 0.5, zoom: 1 } },
          updatedAt: new Date().toISOString(),
        });
        project = (await this.read(request.id)).project;
      } else if (request.operation === 'delete') {
        const { location } = await this.checked(request.id, request.token);
        await this.mkdir('deleted');
        await fs.rename(
          await this.file(location),
          await this.file(`deleted/${request.id}-${randomUUID()}`),
        );
      } else if (request.operation === 'open') {
        await this.read(request.id);
        await this.native.open(await this.file(this.location(request.id)));
      } else if (request.operation === 'export') {
        if (chosen) {
          const archive = await this.archiveFor({
            projectId: request.id,
            buildId: request.buildId,
          });
          const destination = path.resolve(chosen);
          const parent = await fs.realpath(path.dirname(destination));
          if (parent !== path.dirname(destination))
            throw new UserError('Export to a folder without symbolic links.');
          await safeDestination(parent, path.basename(destination));
          if (path.extname(destination).toLowerCase() !== '.zip')
            throw new UserError('Export with a .zip extension.');
          for (const root of [
            this.storage.root,
            this.storage.state.settings.gamePath,
            this.storage.state.settings.modsPath,
          ]) {
            if (root && contained(root, destination))
              throw new UserError('Export outside Modatro data, game and Mods folders.');
          }
          if ((await exists(destination)) && (await fs.lstat(destination)).isSymbolicLink())
            throw new UserError('Export to a regular file, not a symbolic link.');
          if (
            destination.startsWith(this.storage.root + path.sep) ||
            destination === this.storage.root
          )
            throw new UserError('Export outside Modatro’s internal data folder.');
          const bytes = await this.readBytes(archive);
          if (digest(bytes) !== request.buildId)
            throw new UserError('The build changed before export. Rebuild it and try again.');
          await atomicWrite(destination, bytes);
          exported = true;
        } else exported = false;
      }
      return { projects: await this.list(), project, definition, exported };
    });
  }
}
