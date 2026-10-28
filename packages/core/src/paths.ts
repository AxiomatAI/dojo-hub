import type { ValidationIssue } from './types';

/** Normalise a relative POSIX path. Returns null when it escapes the root or is absolute. */
export function normalizePath(input: string): string | null {
  const p = input.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/')) ?? '';
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Resolve `ref` relative to the directory of `fromFile`, allowing escapes (returns segments with leading ..). */
export function resolveRelative(fromFile: string, ref: string): string {
  const segs = dirname(fromFile).split('/').filter(Boolean);
  for (const seg of ref.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length && segs[segs.length - 1] !== '..') segs.pop();
      else segs.push('..');
    } else segs.push(seg);
  }
  return segs.join('/');
}

/** Minimal glob → RegExp supporting `**`, `*`, `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[] | undefined): boolean {
  if (!globs?.length) return false;
  return globs.some((g) => globToRegExp(g).test(path));
}

const MAX_PATH_BYTES = 1024;
/** Code points that HFS+ ignores (and Git treats as ignorable when checking `.git`). */
const IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** Path components Git interprets as administrative data, compared after aliasing. */
const GIT_ADMIN = new Set(['.git', 'git~1', '.gitmodules', 'gitmod~1']);

/**
 * Comparison key for one path component as case-insensitive / Windows / HFS+ filesystems see it:
 * NFC, lowercase, ignorable code points removed, trailing dots and spaces dropped.
 */
function componentAlias(seg: string): string {
  return seg
    .normalize('NFC')
    .replace(IGNORABLE, '')
    .toLowerCase()
    .replace(/[. ]+$/, '');
}

/**
 * Check every stored skill path is a canonical relative POSIX path that is safe to write below a
 * directory (and inside a Git work tree). Paths are rejected, never rewritten: no absolute paths,
 * drive letters, backslashes, `.`/`..`/empty components, control characters, `.git` (or its
 * filesystem aliases), duplicates after aliasing, or a file that is also another file's directory.
 */
export function checkSafePaths(paths: Iterable<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const unsafe = (path: string, why: string) =>
    issues.push({ level: 'error', code: 'unsafe_path', message: `Unsafe file path "${path}": ${why}`, path });
  const fileKeys = new Map<string, string>();
  const dirKeys = new Map<string, string>();
  for (const path of paths) {
    if (path === '') {
      unsafe(path, 'empty path');
      continue;
    }
    if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
      unsafe(path, `longer than ${MAX_PATH_BYTES} bytes`);
      continue;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      unsafe(path, 'contains control characters');
      continue;
    }
    if (path.includes('\\')) {
      unsafe(path, 'contains a backslash');
      continue;
    }
    if (path.startsWith('/') || path.includes(':')) {
      unsafe(path, 'must be relative (no leading "/", drive letter or ":")');
      continue;
    }
    const segs = path.split('/');
    const bad = segs.find((seg) => seg === '' || seg === '.' || seg === '..');
    if (bad !== undefined) {
      unsafe(path, bad === '..' ? 'path traversal ("..")' : 'empty or "." component');
      continue;
    }
    const aliases = segs.map(componentAlias);
    if (aliases.some((a) => a === '' || GIT_ADMIN.has(a))) {
      unsafe(path, 'Git administrative or aliased component');
      continue;
    }
    const key = aliases.join('/');
    const clash = fileKeys.get(key) ?? dirKeys.get(key);
    if (clash !== undefined) {
      unsafe(path, `conflicts with "${clash}"`);
      continue;
    }
    const dirs = aliases.slice(0, -1).map((_, i) => aliases.slice(0, i + 1).join('/'));
    const file = dirs.map((d) => fileKeys.get(d)).find((f) => f !== undefined);
    if (file !== undefined) {
      unsafe(path, `"${file}" is a file, not a directory`);
      continue;
    }
    for (const d of dirs) if (!dirKeys.has(d)) dirKeys.set(d, path);
    fileKeys.set(key, path);
  }
  return issues;
}
