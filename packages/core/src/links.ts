import { resolveRelative } from './paths';
import type { FileMap } from './types';
import { utf8 } from './types';

const MD_LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE_REL_RE = /(?:^|[\s`'"(])((?:\.\.\/)+[\w./-]+)/g;

/** Find links in markdown/text files of a skill that resolve outside the skill directory. */
export function findExternalReferences(skillFiles: FileMap, skillDir: string): string[] {
  const out = new Set<string>();
  for (const [path, bytes] of skillFiles) {
    if (!/\.(md|mdx|txt)$/i.test(path)) continue;
    const text = utf8.decode(bytes);
    const refs = new Set<string>();
    for (const m of text.matchAll(MD_LINK_RE)) refs.add(m[1]!);
    for (const m of text.matchAll(BARE_REL_RE)) refs.add(m[1]!);
    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#') || ref.startsWith('/')) continue;
      const clean = ref.split('#')[0]!.split('?')[0]!;
      const resolved = resolveRelative(path, clean);
      if (!resolved.startsWith('..')) continue;
      // Re-anchor against the repository root.
      const repoPath = resolveRelative(skillDir ? `${skillDir}/x` : 'x', resolved);
      if (repoPath.startsWith('..')) out.add(resolved);
      else out.add(repoPath);
    }
  }
  return [...out].sort();
}
