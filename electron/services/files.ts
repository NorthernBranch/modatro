import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { RelativePath } from '../../src/shared/model';
import { UserError } from './errors';

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export function contained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function canonicalDirectory(directory: string): Promise<string> {
  const real = await fs.realpath(directory);
  if (!(await fs.stat(real)).isDirectory())
    throw new UserError('Select a folder, rather than a file.');
  return real;
}
// Check every existing component, including the final file. Symlinks are never
// traversed inside an approved root, even if they currently point inside it.
export async function safeDestination(root: string, relative: string): Promise<string> {
  RelativePath.parse(relative);
  const canonical = await canonicalDirectory(root);
  if (path.resolve(root) !== canonical)
    throw new UserError('An approved folder has moved or become a symbolic link. Select it again.');
  const dest = path.resolve(canonical, ...relative.split('/'));
  if (!contained(canonical, dest) || dest === canonical)
    throw new UserError('This file would escape the approved folder.');
  let component = canonical;
  const segments = relative.split('/');
  for (let i = 0; i < segments.length; i++) {
    const parent = component;
    component = path.join(component, segments[i]!);
    if (!(await exists(component))) return path.join(component, ...segments.slice(i + 1));
    const st = await fs.lstat(component);
    if (
      st.isSymbolicLink() ||
      (i < segments.length - 1 && !st.isDirectory()) ||
      (i === segments.length - 1 && !st.isFile() && !st.isDirectory())
    )
      throw new UserError(
        'A symbolic link or special file blocks this operation. No files were changed.',
      );
    // Case-insensitive and normalization-insensitive filesystems can return a
    // different spelling for the same entry. Resolve one component at a time:
    // its real parent must still be the directory we just validated.
    const real = await fs.realpath(component);
    if (!contained(canonical, real) || path.dirname(real) !== parent)
      throw new UserError('A file resolves outside its approved location.');
    const checked = await fs.lstat(component);
    if (checked.isSymbolicLink() || checked.dev !== st.dev || checked.ino !== st.ino)
      throw new UserError('A file changed while its location was being checked. Try again.');
    component = real;
  }
  return component;
}
export async function hashFile(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new UserError('Only regular files can be managed.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
export async function atomicWrite(file: string, contents: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.modatro-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally {
    if (created) await fs.rm(temp, { force: true });
  }
}
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicCopy(
  source: string,
  destination: string,
  temporaryPath?: string,
): Promise<void> {
  const temp =
    temporaryPath ?? path.join(path.dirname(destination), `.modatro-${randomUUID()}.tmp`);
  if (path.dirname(temp) !== path.dirname(destination))
    throw new UserError('An atomic copy must use a temporary file beside its destination.');
  let created = false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.copyFile(source, temp, constants.COPYFILE_EXCL);
    created = true;
    const handle = await fs.open(temp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    if (created) await fs.rm(temp, { force: true });
  }
}
export async function walkFiles(
  root: string,
  limits = { count: 20000, bytes: 1024 * 1024 * 1024 },
): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 30) throw new UserError('This folder structure is too deeply nested.');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new UserError(
          'This mod contains symbolic links. Automatic installation is not supported.',
        );
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (entry.isFile()) {
        bytes += (await fs.stat(p)).size;
        files.push(path.relative(root, p).split(path.sep).join('/'));
        if (files.length > limits.count || bytes > limits.bytes)
          throw new UserError('This mod exceeds the file or size limit.');
      } else throw new UserError('This mod contains unsupported special files.');
    }
  }
  await walk(root, 0);
  return files;
}
export async function readSmall(file: string, limit = 2 * 1024 * 1024): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile() || (await handle.stat()).size > limit)
      throw new UserError('This metadata file is too large or is not a regular file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
export async function readPrefix(file: string, limit = 16384): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new UserError('Metadata must be a regular file.');
    const bytes = Buffer.alloc(limit);
    const result = await handle.read(bytes, 0, limit, 0);
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
