import { z } from 'zod';

export const ModIndexUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    if (!z.url().safeParse(value).success) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/[\w.-]+\/[\w.-]+(?:\/tree\/[\w./-]+)?\/?$/.test(url.pathname)
    );
  }, 'Paste a GitHub mod-index repository URL, optionally including its branch.');

export function indexLocation(value: string) {
  const url = new URL(ModIndexUrl.parse(value));
  const [owner, name, , ...branch] = url.pathname.replace(/\/$/, '').split('/').slice(1);
  const repo = `${owner}/${name!.replace(/\.git$/, '')}`;
  return {
    repo,
    url: `https://github.com/${repo}${branch.length ? `/tree/${branch.join('/')}` : ''}`,
  };
}
