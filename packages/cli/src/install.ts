import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { contentHash, type FileMap, readArchive, stripSingleRoot } from '@dojohub/core';
import { type Agent, CANONICAL_GLOBAL, CANONICAL_PROJECT } from './agents';
import type { Client } from './client';
import { CONFIG_DIR } from './config';

export interface SkillDetail {
  id: string;
  name: string;
  namespace: string;
  status: string;
  publishedVersion: string | null;
  summary: string;
  versions: { id: string; version: string; status: string; archiveDigest: string }[];
  install: { gitUrl: string; wellKnownUrl: string | null };
}

export interface InstallOptions {
  agents: Agent[];
  global: boolean;
  cwd: string;
  update?: boolean;
}

export interface LockEntry {
  source: string;
  sourceUrl: string;
  sourceType: 'git';
  computedHash: string;
  dojo: { registry: string; namespace: string; version: string; versionId: string; digest: string; installedAt: string };
}

interface LockFile {
  version: number;
  skills: Record<string, Record<string, unknown>>;
}

const lockPath = (opts: { global: boolean; cwd: string }) => (opts.global ? join(CONFIG_DIR, 'installed.json') : join(opts.cwd, 'skills-lock.json'));

export async function readLock(opts: { global: boolean; cwd: string }): Promise<LockFile> {
  try {
    return JSON.parse(await readFile(lockPath(opts), 'utf8')) as LockFile;
  } catch {
    return { version: 1, skills: {} };
  }
}

async function writeLock(opts: { global: boolean; cwd: string }, lock: LockFile) {
  const sorted: LockFile = { version: lock.version ?? 1, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) };
  await mkdir(dirname(lockPath(opts)), { recursive: true });
  await writeFile(lockPath(opts), `${JSON.stringify(sorted, null, 2)}\n`);
}

export function dojoEntries(lock: LockFile): [string, LockEntry][] {
  return Object.entries(lock.skills).filter(([, v]) => v && typeof v === 'object' && 'dojo' in v) as unknown as [string, LockEntry][];
}

async function writeFiles(dir: string, files: FileMap) {
  await rm(dir, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const full = resolve(dir, path);
    if (!full.startsWith(resolve(dir))) throw new Error(`Refusing to write outside ${dir}: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    const exec = bytes[0] === 0x23 && bytes[1] === 0x21;
    await writeFile(full, bytes, { mode: exec ? 0o755 : 0o644 });
  }
}

async function linkInto(agentDir: string, name: string, canonical: string) {
  const target = join(agentDir, name);
  if (resolve(target) === resolve(canonical)) return;
  await mkdir(agentDir, { recursive: true });
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink() || st.isDirectory()) await rm(target, { recursive: true, force: true });
  } catch {
    /* not present */
  }
  try {
    await symlink(relative(agentDir, canonical), target, 'junction');
  } catch {
    // Filesystems without symlink support (some Windows setups): copy instead.
    const files: FileMap = new Map();
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else files.set(relative(canonical, p), new Uint8Array(await readFile(p)));
      }
    };
    await walk(canonical);
    await writeFiles(target, files);
  }
}

export async function fetchSkill(client: Client, ref: string): Promise<SkillDetail> {
  return client.request<SkillDetail>('GET', `/skills/${encodeURIComponent(ref)}`);
}

/** Download, verify and install one skill version into the canonical dir + agent dirs. */
export async function installSkill(client: Client, skill: SkillDetail, version: string, opts: InstallOptions): Promise<{ path: string; version: string; warnings: string[] }> {
  const warnings: string[] = [];
  const v = skill.versions.find((x) => x.version === version);
  if (!v) throw new Error(`${skill.name}@${version} does not exist`);
  if (v.status === 'blocked') throw new Error(`${skill.name}@${version} is BLOCKED by your security team and cannot be installed`);
  if (!['approved', 'deprecated'].includes(v.status)) throw new Error(`${skill.name}@${version} is ${v.status} and not installable yet`);
  if (v.status === 'deprecated') warnings.push(`${skill.name}@${version} is deprecated`);
  const res = await client.raw(`/api/v1/skills/${encodeURIComponent(skill.name)}/versions/${encodeURIComponent(version)}/download?channel=cli${opts.update ? '&update=1' : ''}`);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== v.archiveDigest) throw new Error(`Digest mismatch for ${skill.name}@${version}: expected ${v.archiveDigest}, got ${digest}`);
  const files = stripSingleRoot(readArchive(bytes));
  if (!files.has('SKILL.md')) throw new Error('Archive does not contain SKILL.md');
  const base = opts.global ? CANONICAL_GLOBAL : join(opts.cwd, CANONICAL_PROJECT);
  const canonical = join(base, skill.name);
  await writeFiles(canonical, files);
  for (const agent of opts.agents) {
    const dir = opts.global ? agent.global : join(opts.cwd, agent.project);
    await linkInto(dir, skill.name, canonical);
  }
  const lock = await readLock(opts);
  const entry: LockEntry = {
    source: new URL(client.url).host,
    sourceUrl: skill.install.gitUrl,
    sourceType: 'git',
    computedHash: await contentHash(files),
    dojo: { registry: client.registry, namespace: skill.namespace, version, versionId: v.id, digest: `sha256:${digest}`, installedAt: new Date().toISOString() },
  };
  lock.skills[skill.name] = entry as unknown as Record<string, unknown>;
  await writeLock(opts, lock);
  return { path: canonical, version, warnings };
}

export async function removeSkill(name: string, opts: InstallOptions) {
  const base = opts.global ? CANONICAL_GLOBAL : join(opts.cwd, CANONICAL_PROJECT);
  await rm(join(base, name), { recursive: true, force: true });
  for (const agent of opts.agents) {
    const dir = opts.global ? agent.global : join(opts.cwd, agent.project);
    const target = join(dir, name);
    if (existsSync(target) || (await lstat(target).catch(() => null))) await rm(target, { recursive: true, force: true });
  }
  const lock = await readLock(opts);
  delete lock.skills[name];
  await writeLock(opts, lock);
}

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv']);

export async function readSkillDir(dir: string): Promise<FileMap> {
  const files: FileMap = new Map();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (IGNORE.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.set(relative(dir, p).split('\\').join('/'), new Uint8Array(await readFile(p)));
    }
  };
  await walk(dir);
  return files;
}

export const homeDir = homedir();
