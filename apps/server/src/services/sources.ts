import type { PresetSource, SourceItemStatus } from '@dojohub/contract';
import {
  contentHash,
  type DiscoveredSkill,
  type DiscoveredSuite,
  discover,
  type FileMap,
  isValidSkillName,
  isValidVersion,
  nextVersion,
  resolveRelative,
  toSkillName,
  utf8,
} from '@dojohub/core';
import { namespace, setting, skill, source, sourceItem, sourceSnapshot, suite, suiteVersion } from '@dojohub/db';
import { and, eq, inArray } from 'drizzle-orm';
import semver from 'semver';
import type { AppContext } from '../context';
import { AppError, badRequest, notFound } from '../lib/errors';
import { audit } from './audit';
import { emit } from './events';
import { fetchGit, fetchWellKnown, type FetchResult, resolveGitSource, uploadSnapshot } from './fetchers';
import type { NamespaceRow } from './namespaces';
import { ingestVersion } from './skills';
import { createSuiteVersion } from './suites';

export type SourceRow = typeof source.$inferSelect;

export const PRESET_SOURCES: PresetSource[] = [
  {
    id: 'anthropics',
    kind: 'github',
    name: 'Anthropic Agent Skills',
    url: 'https://github.com/anthropics/skills',
    description: 'Official document, design and developer skills from Anthropic (PDF, DOCX, XLSX, PPTX, MCP builder…).',
    kindLabel: 'suite',
  },
  {
    id: 'vercel',
    kind: 'github',
    name: 'Vercel Agent Skills',
    url: 'https://github.com/vercel-labs/agent-skills',
    description: 'React, Next.js and web-performance best practices from Vercel.',
    kindLabel: 'collection',
  },
  {
    id: 'mattpocock',
    kind: 'github',
    name: 'Matt Pocock Skills',
    url: 'https://github.com/mattpocock/skills',
    description: 'Engineering workflow skills: TDD, domain modeling, code review, grilling and more.',
    kindLabel: 'suite',
  },
  {
    id: 'open-mercato',
    kind: 'github',
    name: 'Open Mercato Skills',
    url: 'https://github.com/open-mercato/skills',
    description: 'Agentic delivery pipeline for Open Mercato projects (59 om-* skills).',
    kindLabel: 'collection',
  },
  {
    id: 'pstack',
    kind: 'github',
    name: 'pstack (Cursor plugins)',
    url: 'https://github.com/cursor/plugins/tree/main/pstack',
    description: 'Lauren Tan\'s pstack: architecture, review and planning skills for agentic engineering.',
    kindLabel: 'suite',
  },
];

const snapshotCache = new Map<string, { at: number; result: FetchResult }>();
const CACHE_MS = 10 * 60_000;

export async function fetchSourceSnapshot(ctx: AppContext, src: SourceRow, opts: { useCache?: boolean } = {}): Promise<FetchResult> {
  const cached = snapshotCache.get(src.id);
  if (opts.useCache && cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  const credential = ctx.secrets.decryptOrNull(src.credentialEnc) ?? (src.kind === 'github' ? (ctx.config.GITHUB_TOKEN ?? null) : null);
  let result: FetchResult;
  switch (src.kind) {
    case 'github':
    case 'gitlab':
    case 'git':
    case 'skills_sh':
      result = await fetchGit(resolveGitSource(src.kind, src.url, src.ref), credential, undefined);
      break;
    case 'well_known':
      result = await fetchWellKnown(src.url);
      break;
    case 'upload': {
      const sha = await uploadedArchiveSha(ctx, src);
      if (!sha) throw badRequest('Upload a repository archive for this source first');
      const bytes = await ctx.blobs.get(sha);
      if (!bytes) throw new AppError(500, 'blob_missing', 'Uploaded archive is missing');
      result = { files: uploadSnapshot(bytes), commit: sha.slice(0, 12), url: src.url, ref: null, warnings: [] };
      break;
    }
  }
  snapshotCache.set(src.id, { at: Date.now(), result });
  return result;
}

async function uploadedArchiveSha(ctx: AppContext, src: SourceRow): Promise<string | null> {
  const [row] = await ctx.db
    .select()
    .from(setting)
    .where(and(eq(setting.orgId, src.orgId), eq(setting.key, `source.upload.${src.id}`)));
  return (row?.value as string | undefined) ?? null;
}

export async function storeSourceUpload(ctx: AppContext, src: SourceRow, bytes: Uint8Array) {
  uploadSnapshot(bytes); // validate
  const sha = await ctx.blobs.put(bytes);
  await ctx.db
    .insert(setting)
    .values({ orgId: src.orgId, key: `source.upload.${src.id}`, value: sha })
    .onConflictDoUpdate({ target: [setting.orgId, setting.key], set: { value: sha, updatedAt: new Date() } });
  snapshotCache.delete(src.id);
}

function itemKey(kind: 'skill' | 'suite', path: string, name: string) {
  return `${kind}:${path}:${name}`;
}

/**
 * Fetch the upstream, discover skills/suites and reconcile source items.
 * Tracked, already-imported skills whose content changed get a new candidate version
 * that goes through the normal scan/review pipeline.
 */
export async function syncSource(ctx: AppContext, sourceId: string, actorId: string | null = null) {
  const [src] = await ctx.db.select().from(source).where(eq(source.id, sourceId));
  if (!src) throw notFound('Source');
  await ctx.db.update(source).set({ status: 'syncing', lastError: null }).where(eq(source.id, src.id));
  try {
    const fetched = await fetchSourceSnapshot(ctx, src);
    const found = discover(fetched.files, { include: src.include, exclude: src.exclude });
    await ctx.db.insert(sourceSnapshot).values({
      sourceId: src.id,
      commit: fetched.commit,
      warnings: [...fetched.warnings, ...found.warnings],
      discovered: {
        skills: found.skills.map((s) => ({ name: s.name, path: s.path, description: s.description, issues: s.issues, files: s.files.size })),
        suites: found.suites.map((s) => ({ name: s.name, version: s.version, skills: s.skillPaths.length })),
      },
    });
    const existing = await ctx.db.select().from(sourceItem).where(eq(sourceItem.sourceId, src.id));
    const byKey = new Map(existing.map((i) => [itemKey(i.kind, i.upstreamPath, i.upstreamName), i]));
    const seen = new Set<string>();
    let updates = 0;

    for (const s of found.skills) {
      const key = itemKey('skill', s.path, s.name);
      seen.add(key);
      const hash = await contentHash(s.files);
      const meta = {
        files: s.files.size,
        issues: s.issues.filter((i) => i.level === 'error').map((i) => i.message),
        externalRefs: s.externalRefs,
        suites: s.pluginNames,
      };
      const prev = byKey.get(key);
      if (!prev) {
        await ctx.db.insert(sourceItem).values({
          orgId: src.orgId,
          sourceId: src.id,
          kind: 'skill',
          upstreamPath: s.path,
          upstreamName: s.name,
          description: s.description,
          upstreamContentHash: hash,
          meta,
        });
        continue;
      }
      let status: SourceItemStatus = prev.status === 'removed' ? (prev.skillId ? 'imported' : 'new') : prev.status;
      if (prev.skillId && prev.lastContentHash && prev.lastContentHash !== hash) {
        status = 'update_available';
        if (src.autoTrack) {
          try {
            await importSkill(ctx, src, s, fetched, prev.skillId, actorId);
            await ctx.db.update(sourceItem).set({ lastContentHash: hash }).where(eq(sourceItem.id, prev.id));
            status = 'imported';
            updates++;
          } catch (err) {
            ctx.logger.warn({ err, skill: s.name }, 'auto-track import failed');
          }
        }
      }
      await ctx.db
        .update(sourceItem)
        .set({ status, upstreamContentHash: hash, description: s.description, meta })
        .where(eq(sourceItem.id, prev.id));
      if (prev.skillId) await ctx.db.update(skill).set({ upstreamRemoved: false }).where(eq(skill.id, prev.skillId));
    }
    for (const suiteD of found.suites) {
      const key = itemKey('suite', suiteD.root, suiteD.name);
      seen.add(key);
      const meta = { version: suiteD.version, skills: suiteD.skillPaths, author: suiteD.author, license: suiteD.license, origin: suiteD.origin };
      const prev = byKey.get(key);
      if (!prev) {
        await ctx.db.insert(sourceItem).values({
          orgId: src.orgId,
          sourceId: src.id,
          kind: 'suite',
          upstreamPath: suiteD.root,
          upstreamName: suiteD.name,
          description: suiteD.description ?? null,
          meta,
        });
      } else {
        const changed = prev.suiteId && prev.meta.version !== suiteD.version;
        await ctx.db
          .update(sourceItem)
          .set({ meta, description: suiteD.description ?? null, status: changed ? 'update_available' : prev.status === 'removed' ? 'new' : prev.status })
          .where(eq(sourceItem.id, prev.id));
      }
    }
    for (const item of existing) {
      if (seen.has(itemKey(item.kind, item.upstreamPath, item.upstreamName))) continue;
      await ctx.db.update(sourceItem).set({ status: 'removed' }).where(eq(sourceItem.id, item.id));
      if (item.skillId) await ctx.db.update(skill).set({ upstreamRemoved: true }).where(eq(skill.id, item.skillId));
    }
    await ctx.db
      .update(source)
      .set({ status: 'idle', lastCommit: fetched.commit, lastSyncedAt: new Date() })
      .where(eq(source.id, src.id));
    const pending = await ctx.db
      .select({ id: sourceItem.id })
      .from(sourceItem)
      .where(and(eq(sourceItem.sourceId, src.id), eq(sourceItem.status, 'update_available')));
    await emit(ctx, src.orgId, 'source.synced', { source: src.name, sourceId: src.id, commit: fetched.commit, autoUpdated: updates }, { namespaceId: src.namespaceId });
    if (pending.length) {
      await emit(ctx, src.orgId, 'source.update_available', { source: src.name, sourceId: src.id, items: pending.length }, { namespaceId: src.namespaceId });
    }
    return { commit: fetched.commit, skills: found.skills.length, suites: found.suites.length, warnings: [...fetched.warnings, ...found.warnings] };
  } catch (err) {
    await ctx.db
      .update(source)
      .set({ status: 'error', lastError: (err as Error).message.slice(0, 1000) })
      .where(eq(source.id, src.id));
    throw err;
  }
}

/**
 * Vendor files referenced from outside the skill directory into `references/_external/`
 * so the local copy is self-contained, rewriting links in markdown files.
 */
function vendorExternal(s: DiscoveredSkill, repo: FileMap): { files: FileMap; vendored: string[] } {
  const files = new Map(s.files);
  const vendored: string[] = [];
  for (const ref of s.externalRefs) {
    if (ref.startsWith('..')) continue;
    const bytes = repo.get(ref);
    if (!bytes) continue;
    const target = `references/_external/${ref}`;
    files.set(target, bytes);
    vendored.push(ref);
  }
  if (vendored.length) {
    for (const [path, bytes] of files) {
      if (!/\.(md|mdx|txt)$/i.test(path)) continue;
      let text = utf8.decode(bytes);
      let changed = false;
      text = text.replace(/((?:\.\.\/)+[\w./-]+)/g, (m) => {
        const repoPath = resolveRelative(s.path ? `${s.path}/${path}` : path, m);
        if (!vendored.includes(repoPath)) return m;
        changed = true;
        const depth = path.split('/').length - 1;
        return `${'../'.repeat(depth)}references/_external/${repoPath}`;
      });
      if (changed) files.set(path, utf8.encode(text));
    }
  }
  return { files, vendored };
}

async function importSkill(
  ctx: AppContext,
  src: SourceRow,
  s: DiscoveredSkill,
  fetched: FetchResult,
  skillId: string | null,
  actorId: string | null,
) {
  const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, src.namespaceId));
  const { files, vendored } = vendorExternal(s, fetched.files);
  let renameTo: string | undefined;
  if (src.namePrefix) {
    const prefixed = toSkillName(`${src.namePrefix}${s.name}`);
    if (prefixed !== s.name && isValidSkillName(prefixed)) renameTo = prefixed;
  }
  const upstreamVersion = (s.frontmatter.metadata as Record<string, unknown> | undefined)?.version;
  return ingestVersion(ctx, {
    orgId: src.orgId,
    ns: ns as NamespaceRow,
    files,
    actorId,
    submit: true,
    kind: skillId ? 'update' : 'import',
    skillId: skillId ?? undefined,
    renameTo,
    version: typeof upstreamVersion === 'string' && isValidVersion(upstreamVersion) ? upstreamVersion : undefined,
    sourceId: src.id,
    upstreamPath: s.path,
    externalRefs: s.externalRefs.filter((r) => !vendored.includes(r)),
    transformations: vendored.length ? [{ kind: 'vendor_external', detail: `Vendored ${vendored.length} file(s): ${vendored.join(', ')}` }] : [],
    provenance: {
      sourceId: src.id,
      sourceKind: src.kind,
      url: fetched.url,
      ref: fetched.ref ?? undefined,
      commit: fetched.commit ?? undefined,
      path: s.path,
      license: typeof s.frontmatter.license === 'string' ? s.frontmatter.license : undefined,
      fetchedAt: new Date().toISOString(),
    },
    changelog: fetched.commit ? `Synced from ${fetched.url} @ ${fetched.commit.slice(0, 12)}` : `Imported from ${fetched.url}`,
  });
}

/** Import selected discovered items (skills and/or whole suites) as local copies. */
export async function importItems(ctx: AppContext, sourceId: string, itemIds: string[], actorId: string | null) {
  const [src] = await ctx.db.select().from(source).where(eq(source.id, sourceId));
  if (!src) throw notFound('Source');
  const items = await ctx.db
    .select()
    .from(sourceItem)
    .where(and(eq(sourceItem.sourceId, src.id), inArray(sourceItem.id, itemIds)));
  if (!items.length) throw badRequest('No items selected');
  const fetched = await fetchSourceSnapshot(ctx, src, { useCache: true });
  const found = discover(fetched.files, { include: src.include, exclude: src.exclude });
  const results: { item: string; ok: boolean; message: string }[] = [];
  const importedByPath = new Map<string, string>(); // upstream path → skill version id

  const doSkill = async (path: string, name: string) => {
    if (importedByPath.has(path)) return importedByPath.get(path)!;
    const d = found.skills.find((s) => s.path === path && s.name === name) ?? found.skills.find((s) => s.path === path);
    if (!d) throw badRequest(`Skill ${name} no longer exists upstream`);
    const [item] = await ctx.db
      .select()
      .from(sourceItem)
      .where(and(eq(sourceItem.sourceId, src.id), eq(sourceItem.kind, 'skill'), eq(sourceItem.upstreamPath, path)));
    const res = await importSkill(ctx, src, d, fetched, item?.skillId ?? null, actorId);
    const hash = await contentHash(d.files);
    if (item) {
      await ctx.db
        .update(sourceItem)
        .set({ skillId: res.skill.id, status: 'imported', lastContentHash: hash, upstreamContentHash: hash })
        .where(eq(sourceItem.id, item.id));
    }
    await ctx.db.update(skill).set({ sourceId: src.id, upstreamPath: path }).where(eq(skill.id, res.skill.id));
    importedByPath.set(path, res.version.id);
    return res.version.id;
  };

  for (const item of items.filter((i) => i.kind === 'skill')) {
    try {
      await doSkill(item.upstreamPath, item.upstreamName);
      results.push({ item: item.upstreamName, ok: true, message: 'imported' });
    } catch (err) {
      results.push({ item: item.upstreamName, ok: false, message: (err as Error).message });
    }
  }
  for (const item of items.filter((i) => i.kind === 'suite')) {
    const d = found.suites.find((s) => s.root === item.upstreamPath && s.name === item.upstreamName);
    if (!d) {
      results.push({ item: item.upstreamName, ok: false, message: 'Suite no longer exists upstream' });
      continue;
    }
    try {
      const members: { skillVersionId: string; isEntry: boolean }[] = [];
      for (const p of d.skillPaths) {
        const ds = found.skills.find((s) => s.path === p);
        if (!ds) continue;
        try {
          members.push({ skillVersionId: await doSkill(p, ds.name), isEntry: /(^|[-/])setup/.test(ds.name) });
        } catch (err) {
          // Unchanged skills already imported: reuse their latest version.
          const [existingItem] = await ctx.db
            .select()
            .from(sourceItem)
            .where(and(eq(sourceItem.sourceId, src.id), eq(sourceItem.upstreamPath, p), eq(sourceItem.kind, 'skill')));
          const [sk] = existingItem?.skillId ? await ctx.db.select().from(skill).where(eq(skill.id, existingItem.skillId)) : [];
          if (sk?.latestVersionId) members.push({ skillVersionId: sk.latestVersionId, isEntry: false });
          else throw err;
        }
      }
      const suiteName = toSkillName(d.name);
      const version = await nextSuiteVersion(ctx, src.orgId, src.namespaceId, suiteName, d.version);
      const assets = [];
      for (const p of d.assetPaths.slice(0, 200)) {
        const bytes = fetched.files.get(p);
        if (bytes) assets.push({ path: p.slice(d.root ? d.root.length + 1 : 0), sha256: await ctx.blobs.put(bytes), size: bytes.byteLength });
      }
      const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, src.namespaceId));
      const res = await createSuiteVersion(ctx, {
        orgId: src.orgId,
        ns: ns as NamespaceRow,
        actorId,
        name: suiteName,
        displayName: d.name,
        description: d.description ?? '',
        version,
        members,
        submit: true,
        assets,
        sourceId: src.id,
        author: d.author ?? null,
        license: d.license ?? null,
        homepage: d.homepage ?? null,
        tags: d.keywords,
        provenance: { sourceId: src.id, sourceKind: src.kind, url: fetched.url, commit: fetched.commit ?? undefined, path: d.root, fetchedAt: new Date().toISOString() },
      });
      await ctx.db.update(sourceItem).set({ suiteId: res.suite.id, status: 'imported' }).where(eq(sourceItem.id, item.id));
      results.push({ item: item.upstreamName, ok: true, message: `suite with ${members.length} skills` });
    } catch (err) {
      results.push({ item: item.upstreamName, ok: false, message: (err as Error).message });
    }
  }
  await audit(ctx, { orgId: src.orgId, actorId, action: 'source.import', targetType: 'source', targetId: src.id, metadata: { results } });
  return results;
}

async function nextSuiteVersion(ctx: AppContext, orgId: string, namespaceId: string, name: string, upstream?: string) {
  const [s] = await ctx.db
    .select()
    .from(suite)
    .where(and(eq(suite.orgId, orgId), eq(suite.namespaceId, namespaceId), eq(suite.name, name)));
  if (!s) return upstream && isValidVersion(upstream) ? upstream : '1.0.0';
  const versions = (await ctx.db.select({ v: suiteVersion.version }).from(suiteVersion).where(eq(suiteVersion.suiteId, s.id))).map((r) => r.v);
  const latest = versions.sort(semver.rcompare)[0];
  if (upstream && isValidVersion(upstream) && (!latest || semver.gt(upstream, latest))) return upstream;
  return nextVersion(latest ?? null, 'patch');
}

export type { DiscoveredSuite };
