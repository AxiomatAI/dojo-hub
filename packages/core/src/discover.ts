import { findExternalReferences } from './links';
import { basename, dirname, joinPath, matchesAny, normalizePath } from './paths';
import { validateSkill } from './spec';
import type { FileMap, ValidationIssue } from './types';
import { subTree, utf8 } from './types';

export interface DiscoveredSkill {
  /** Frontmatter name, falling back to the directory name. */
  name: string;
  /** Directory of the skill within the repository ('' = repository root). */
  path: string;
  description: string;
  frontmatter: Record<string, unknown>;
  files: FileMap;
  issues: ValidationIssue[];
  /** Repository paths referenced by the skill that live outside its directory. */
  externalRefs: string[];
  pluginNames: string[];
}

export interface DiscoveredSuite {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  homepage?: string;
  keywords: string[];
  origin: 'claude-marketplace' | 'claude-plugin' | 'cursor-plugin' | 'cursor-marketplace';
  /** Root of the plugin within the repository. */
  root: string;
  skillPaths: string[];
  /** Non-skill plugin assets (agents/, docs/, logo…) relative to the repo. */
  assetPaths: string[];
}

export interface DiscoveryOptions {
  include?: string[];
  exclude?: string[];
  fullDepth?: boolean;
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[];
  suites: DiscoveredSuite[];
  warnings: string[];
}

/** Mirrors the container directories searched by the `skills` CLI. */
export const SKILL_CONTAINER_DIRS = [
  'skills',
  'skills/.curated',
  'skills/.experimental',
  'skills/.system',
  '.agents/skills',
  '.claude/skills',
  '.github/skills',
  '.cursor/skills',
  '.codex/skills',
  '.gemini/skills',
  '.windsurf/skills',
  '.opencode/skills',
];
const CONTAINER_DEPTH = 3;
const FALLBACK_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);
const ASSET_DIRS = ['agents', 'docs', 'assets', 'commands', 'hooks', 'automations'];

function readJson(files: FileMap, path: string, warnings: string[]): Record<string, unknown> | null {
  const raw = files.get(path);
  if (!raw) return null;
  try {
    const data = JSON.parse(utf8.decode(raw)) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch (err) {
    warnings.push(`${path}: invalid JSON (${(err as Error).message})`);
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function authorName(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
    return (v as { name: string }).name;
  }
  return undefined;
}

function skillDirsUnder(files: FileMap, root: string, maxDepth: number): string[] {
  const prefix = root ? `${root}/` : '';
  const out: string[] = [];
  for (const p of files.keys()) {
    if (!p.startsWith(prefix) || basename(p) !== 'SKILL.md') continue;
    const rel = p.slice(prefix.length);
    const segs = rel.split('/');
    if (segs.some((s) => SKIP_DIRS.has(s))) continue;
    const depth = segs.length - 1;
    if (depth < 1 || depth > maxDepth) continue;
    out.push(dirname(p));
  }
  return out;
}

function pluginSkillPaths(files: FileMap, base: string, skills: unknown): string[] {
  if (Array.isArray(skills)) {
    return skills
      .filter((s): s is string => typeof s === 'string')
      .map((s) => joinPath(base, s))
      .filter((p) => files.has(p ? `${p}/SKILL.md` : 'SKILL.md') || skillDirsUnder(files, p, 2).length > 0)
      .flatMap((p) => (files.has(p ? `${p}/SKILL.md` : 'SKILL.md') ? [p] : skillDirsUnder(files, p, 2)));
  }
  const dir = typeof skills === 'string' ? joinPath(base, skills) : joinPath(base, 'skills');
  return skillDirsUnder(files, dir, CONTAINER_DEPTH);
}

function pluginAssets(files: FileMap, base: string): string[] {
  const out: string[] = [];
  for (const p of files.keys()) {
    const rel = base ? (p.startsWith(`${base}/`) ? p.slice(base.length + 1) : null) : p;
    if (rel === null) continue;
    const top = rel.split('/')[0]!;
    if (ASSET_DIRS.includes(top)) out.push(p);
  }
  return out.sort();
}

function suiteFromPluginJson(
  files: FileMap,
  base: string,
  manifestPath: string,
  origin: DiscoveredSuite['origin'],
  warnings: string[],
): DiscoveredSuite | null {
  const pj = readJson(files, manifestPath, warnings);
  if (!pj) return null;
  return {
    name: str(pj.name) ?? (basename(base) || 'suite'),
    description: str(pj.description),
    version: str(pj.version),
    author: authorName(pj.author),
    license: str(pj.license),
    homepage: str(pj.homepage) ?? str(pj.repository),
    keywords: [
      ...(Array.isArray(pj.keywords) ? pj.keywords : []),
      ...(Array.isArray(pj.tags) ? pj.tags : []),
    ].filter((k): k is string => typeof k === 'string'),
    origin,
    root: base,
    skillPaths: pluginSkillPaths(files, base, pj.skills),
    assetPaths: pluginAssets(files, base),
  };
}

function discoverManifests(files: FileMap, warnings: string[]): DiscoveredSuite[] {
  const suites: DiscoveredSuite[] = [];
  for (const [mpPath, origin, pluginDir] of [
    ['.claude-plugin/marketplace.json', 'claude-marketplace', '.claude-plugin'],
    ['.cursor-plugin/marketplace.json', 'cursor-marketplace', '.cursor-plugin'],
  ] as const) {
    const mp = readJson(files, mpPath, warnings);
    if (!mp || !Array.isArray(mp.plugins)) continue;
    const meta = (mp.metadata ?? {}) as Record<string, unknown>;
    const pluginRoot = normalizePath(str(meta.pluginRoot) ?? '') ?? '';
    const mpVersion = str(meta.version);
    for (const plugin of mp.plugins as Record<string, unknown>[]) {
      if (!plugin || typeof plugin !== 'object') continue;
      const source = plugin.source;
      if (typeof source !== 'string') {
        warnings.push(`${mpPath}: plugin "${String(plugin.name)}" has a remote source and was skipped`);
        continue;
      }
      const base = normalizePath(joinPath(pluginRoot, source)) ?? '';
      const nested = suiteFromPluginJson(
        files,
        base,
        joinPath(base, `${pluginDir}/plugin.json`),
        origin,
        warnings,
      );
      const skillPaths = plugin.skills
        ? pluginSkillPaths(files, base, plugin.skills)
        : (nested?.skillPaths ?? pluginSkillPaths(files, base, undefined));
      suites.push({
        name: str(plugin.name) ?? nested?.name ?? (basename(base) || 'suite'),
        description: str(plugin.description) ?? nested?.description,
        version: str(plugin.version) ?? nested?.version ?? mpVersion,
        author: authorName(plugin.author) ?? nested?.author ?? authorName(mp.owner),
        license: str(plugin.license) ?? nested?.license,
        homepage: str(plugin.homepage) ?? nested?.homepage,
        keywords: [
          ...(Array.isArray(plugin.keywords) ? plugin.keywords : []),
          ...(nested?.keywords ?? []),
        ].filter((k): k is string => typeof k === 'string'),
        origin,
        root: base,
        skillPaths,
        assetPaths: base ? pluginAssets(files, base) : [],
      });
    }
  }
  if (!suites.length) {
    for (const [pjPath, origin] of [
      ['.claude-plugin/plugin.json', 'claude-plugin'],
      ['.cursor-plugin/plugin.json', 'cursor-plugin'],
    ] as const) {
      const s = suiteFromPluginJson(files, '', pjPath, origin, warnings);
      if (s) {
        suites.push(s);
        break;
      }
    }
  }
  return suites;
}

/**
 * Discover skills and suites in a repository snapshot. Follows the same search
 * order as the `skills` CLI so that what DojoHub imports matches what users expect.
 */
export function discover(files: FileMap, opts: DiscoveryOptions = {}): DiscoveryResult {
  const warnings: string[] = [];
  const dirs = new Set<string>();

  if (files.has('SKILL.md') && !opts.fullDepth) {
    dirs.add('');
  } else {
    const suites = discoverManifests(files, warnings);
    for (const s of suites) for (const p of s.skillPaths) dirs.add(p);
    for (const c of SKILL_CONTAINER_DIRS)
      for (const d of skillDirsUnder(files, c, CONTAINER_DEPTH)) dirs.add(d);
    if (dirs.size === 0 || opts.fullDepth) {
      for (const d of skillDirsUnder(files, '', FALLBACK_DEPTH)) dirs.add(d);
      if (files.has('SKILL.md')) dirs.add('');
    }
    return finish(files, dirs, suites, warnings, opts);
  }
  return finish(files, dirs, [], warnings, opts);
}

function finish(
  files: FileMap,
  dirs: Set<string>,
  suites: DiscoveredSuite[],
  warnings: string[],
  opts: DiscoveryOptions,
): DiscoveryResult {
  const selected = [...dirs]
    .filter((d) => (opts.include?.length ? matchesAny(d, opts.include) : true))
    .filter((d) => !matchesAny(d, opts.exclude))
    .sort();
  // A skill directory nested inside another skill directory is a resource of the parent, not a skill.
  const roots = selected.filter((d) => !selected.some((o) => o !== d && o !== '' && d.startsWith(`${o}/`)));
  const skills: DiscoveredSkill[] = roots.map((path) => {
    const sub = subTree(files, path);
    // Drop VCS/build noise; a root-level skill must not swallow sibling skills' files.
    for (const key of [...sub.keys()]) {
      if (key.split('/').some((s) => SKIP_DIRS.has(s))) sub.delete(key);
      else if (path === '' && roots.some((o) => o !== '' && key.startsWith(`${o}/`))) sub.delete(key);
    }
    const dirName = path ? basename(path) : undefined;
    const v = validateSkill(sub, dirName);
    const name = typeof v.frontmatter.name === 'string' ? v.frontmatter.name : (dirName ?? 'skill');
    return {
      name,
      path,
      description: typeof v.frontmatter.description === 'string' ? v.frontmatter.description : '',
      frontmatter: v.frontmatter,
      files: sub,
      issues: v.issues,
      externalRefs: findExternalReferences(sub, path),
      pluginNames: suites.filter((s) => s.skillPaths.includes(path)).map((s) => s.name),
    };
  });
  const names = new Map<string, number>();
  for (const s of skills) names.set(s.name, (names.get(s.name) ?? 0) + 1);
  for (const [n, c] of names) if (c > 1) warnings.push(`Duplicate skill name "${n}" found ${c} times`);
  return {
    skills,
    suites: suites.map((s) => ({ ...s, skillPaths: s.skillPaths.filter((p) => roots.includes(p)) })),
    warnings,
  };
}
