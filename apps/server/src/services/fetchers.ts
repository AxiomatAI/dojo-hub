import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { SourceKind } from '@dojohub/contract';
import { type FileMap, readArchive, sha256Hex, stripSingleRoot, subTree, utf8 } from '@dojohub/core';
import { AppError, badRequest } from '../lib/errors';

const exec = promisify(execFile);

export interface FetchResult {
  files: FileMap;
  commit: string | null;
  /** Normalised https URL of the upstream (for provenance). */
  url: string;
  ref: string | null;
  warnings: string[];
}

export interface ResolvedGitSource {
  cloneUrl: string;
  webUrl: string;
  ref: string | null;
  subPath: string;
  host: string;
}

/** Parse GitHub/GitLab shorthands and tree URLs (owner/repo, https://github.com/o/r/tree/ref/path). */
export function resolveGitSource(kind: SourceKind, rawUrl: string, ref?: string | null): ResolvedGitSource {
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (kind === 'github' || kind === 'skills_sh') {
    const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.+))?$/.exec(url);
    if (short && !url.includes('://')) {
      return {
        cloneUrl: `https://github.com/${short[1]}/${short[2]}.git`,
        webUrl: `https://github.com/${short[1]}/${short[2]}`,
        ref: ref ?? null,
        subPath: short[3] ?? '',
        host: 'github.com',
      };
    }
    const skillsSh = /^https?:\/\/(?:www\.)?skills\.sh\/([\w.-]+)\/([\w.-]+)(?:\/([\w.-]+))?/.exec(url);
    if (skillsSh) {
      return {
        cloneUrl: `https://github.com/${skillsSh[1]}/${skillsSh[2]}.git`,
        webUrl: `https://github.com/${skillsSh[1]}/${skillsSh[2]}`,
        ref: ref ?? null,
        subPath: '',
        host: 'github.com',
      };
    }
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest(`Invalid repository URL: ${rawUrl}`);
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) throw badRequest('Unsupported URL protocol');
  const segs = u.pathname.split('/').filter(Boolean);
  // GitLab: /group/sub/repo/-/tree/ref/path
  const dash = segs.indexOf('-');
  if (dash > 0 && segs[dash + 1] === 'tree') {
    return {
      cloneUrl: `${u.origin}/${segs.slice(0, dash).join('/')}.git`,
      webUrl: `${u.origin}/${segs.slice(0, dash).join('/')}`,
      ref: ref ?? segs[dash + 2] ?? null,
      subPath: segs.slice(dash + 3).join('/'),
      host: u.host,
    };
  }
  // GitHub (incl. Enterprise): /owner/repo/tree/ref/path
  if (segs[2] === 'tree' && segs.length >= 4) {
    return {
      cloneUrl: `${u.origin}/${segs[0]}/${segs[1]}.git`,
      webUrl: `${u.origin}/${segs[0]}/${segs[1]}`,
      ref: ref ?? segs[3] ?? null,
      subPath: segs.slice(4).join('/'),
      host: u.host,
    };
  }
  const base = `${u.origin}/${segs.join('/').replace(/\.git$/, '')}`;
  return { cloneUrl: `${base}.git`, webUrl: base, ref: ref ?? null, subPath: '', host: u.host };
}

const MAX_REPO_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);

async function readTree(root: string, warnings: string[]): Promise<FileMap> {
  const files: FileMap = new Map();
  let total = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`Symlink skipped: ${relative(root, full)}`);
        continue;
      }
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const st = await stat(full);
        if (st.size > MAX_FILE_BYTES) {
          warnings.push(`Large file skipped (${st.size} bytes): ${relative(root, full)}`);
          continue;
        }
        total += st.size;
        if (total > MAX_REPO_BYTES)
          throw new AppError(413, 'repo_too_large', 'Repository snapshot exceeds 200 MB');
        files.set(relative(root, full).split('\\').join('/'), new Uint8Array(await readFile(full)));
      }
    }
  };
  await walk(root);
  return files;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  };
}

/** Shallow-clone a repository at a ref and return a full local snapshot of its files. */
export async function fetchGit(
  src: ResolvedGitSource,
  credential: string | null,
  workDir?: string,
): Promise<FetchResult> {
  const dir = await mkdtemp(join(workDir ?? tmpdir(), 'dojo-src-'));
  const warnings: string[] = [];
  const auth: string[] = [];
  if (credential) {
    const basic = Buffer.from(`x-access-token:${credential}`).toString('base64');
    auth.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
  }
  try {
    const isSha = !!src.ref && /^[0-9a-f]{7,40}$/i.test(src.ref);
    const args = [
      ...auth,
      '-c',
      'core.symlinks=false',
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
    ];
    if (src.ref && !isSha) args.push('--branch', src.ref);
    args.push(src.cloneUrl, dir);
    await exec('git', args, { env: gitEnv(), timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    if (isSha) {
      await exec('git', [...auth, '-C', dir, 'fetch', '--depth', '1', 'origin', src.ref!], {
        env: gitEnv(),
        timeout: 120_000,
      });
      await exec('git', ['-C', dir, 'checkout', '--quiet', 'FETCH_HEAD'], { env: gitEnv() });
    }
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: gitEnv() });
    let files = await readTree(dir, warnings);
    const lfs = [...files].filter(([, b]) =>
      utf8.decode(b.subarray(0, 40)).startsWith('version https://git-lfs'),
    );
    if (lfs.length) {
      try {
        await exec('git', [...auth, '-C', dir, 'lfs', 'pull'], { env: gitEnv(), timeout: 120_000 });
        files = await readTree(dir, warnings);
      } catch {
        warnings.push(`${lfs.length} Git LFS pointer(s) could not be resolved (git-lfs unavailable)`);
      }
    }
    if (files.has('.gitmodules'))
      warnings.push('Repository uses git submodules; submodules are not followed');
    return {
      files: src.subPath ? subTree(files, src.subPath) : files,
      commit: stdout.trim(),
      url: src.webUrl + (src.subPath ? `/tree/${src.ref ?? 'HEAD'}/${src.subPath}` : ''),
      ref: src.ref,
      warnings,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message)
      .replace(/Authorization: Basic \S+/g, 'Authorization: ***')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ');
    throw new AppError(502, 'fetch_failed', `Could not clone ${src.webUrl}: ${msg}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const WK_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

/** Fetch skills published through the agent-skills well-known discovery protocol. */
export async function fetchWellKnown(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<FetchResult> {
  const u = new URL(rawUrl);
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const candidates = [
    `${base}/.well-known/agent-skills/index.json`,
    `${base}/.well-known/skills/index.json`,
    ...(u.pathname !== '/' && u.pathname !== '' ? [`${u.origin}/.well-known/agent-skills/index.json`] : []),
  ];
  const warnings: string[] = [];
  for (const indexUrl of candidates) {
    const res = await fetchImpl(indexUrl, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) continue;
    const index = (await res.json()) as { $schema?: string; skills?: Record<string, unknown>[] };
    if (!Array.isArray(index.skills)) continue;
    const files: FileMap = new Map();
    for (const entry of index.skills) {
      const name = String(entry.name ?? '');
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        warnings.push(`Skipped invalid skill name "${name}"`);
        continue;
      }
      try {
        if (index.$schema === WK_SCHEMA) {
          const artifactUrl = new URL(String(entry.url), indexUrl).toString();
          const r = await fetchImpl(artifactUrl, { signal: AbortSignal.timeout(30_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (entry.digest && `sha256:${await sha256Hex(bytes)}` !== entry.digest)
            throw new Error('digest mismatch');
          const skillFiles =
            entry.type === 'archive' ? stripSingleRoot(readArchive(bytes)) : new Map([['SKILL.md', bytes]]);
          for (const [p, b] of skillFiles) files.set(`skills/${name}/${p}`, b);
        } else {
          const list = Array.isArray(entry.files) ? (entry.files as string[]) : ['SKILL.md'];
          const dir = indexUrl.replace(/index\.json$/, `${name}/`);
          for (const f of list) {
            if (f.includes('..') || f.startsWith('/')) continue;
            const r = await fetchImpl(new URL(f, dir), { signal: AbortSignal.timeout(30_000) });
            if (r.ok) files.set(`skills/${name}/${f}`, new Uint8Array(await r.arrayBuffer()));
          }
        }
      } catch (err) {
        warnings.push(`${name}: ${(err as Error).message}`);
      }
    }
    return { files, commit: null, url: indexUrl, ref: null, warnings };
  }
  throw new AppError(502, 'fetch_failed', `No agent-skills discovery index found at ${rawUrl}`);
}

export interface SkillsShResult {
  id: string;
  name: string;
  source: string;
  installs: number;
}

export async function searchSkillsSh(q: string, fetchImpl: typeof fetch = fetch): Promise<SkillsShResult[]> {
  const res = await fetchImpl(`https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=30`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new AppError(502, 'skills_sh_unavailable', `skills.sh search failed (HTTP ${res.status})`);
  const data = (await res.json()) as {
    skills?: { id: string; name: string; source: string; installs?: number }[];
  };
  return (data.skills ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    source: s.source,
    installs: s.installs ?? 0,
  }));
}

export function uploadSnapshot(bytes: Uint8Array): FileMap {
  return stripSingleRoot(
    readArchive(bytes, { maxFiles: 5000, maxTotalBytes: 200 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024 }),
  );
}
