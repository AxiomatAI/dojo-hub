import { INSTALLABLE_STATUSES, type VersionStatus, VERSION_TRANSITIONS } from '@dojohub/contract';
import {
  createTarGz,
  contentHash,
  type FileMap,
  findExternalReferences,
  isGreater,
  isValidVersion,
  nextVersion,
  patchFrontmatter,
  suggestBump,
  utf8,
  validateSkill,
} from '@dojohub/core';
import { type Provenance, skill, skillVersion, type Transformation, versionFile } from '@dojohub/db';
import { classifyFile, mimeOf } from '@dojohub/scanner';
import { and, desc, eq, inArray } from 'drizzle-orm';
import semver from 'semver';
import type { AppContext } from '../context';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { audit } from './audit';
import { emit } from './events';
import type { NamespaceRow } from './namespaces';

export type SkillRow = typeof skill.$inferSelect;
export type VersionRow = typeof skillVersion.$inferSelect;

export interface IngestInput {
  orgId: string;
  ns: NamespaceRow;
  files: FileMap;
  actorId: string | null;
  version?: string;
  changelog?: string;
  submit: boolean;
  kind?: 'new' | 'update' | 'import';
  provenance?: Provenance;
  transformations?: Transformation[];
  sourceId?: string | null;
  upstreamPath?: string | null;
  /** Rename the skill (rewrites frontmatter `name`). */
  renameTo?: string;
  /** Existing skill to add a version to (sync path); otherwise resolved by name. */
  skillId?: string;
  /** Original repository paths referenced outside the skill directory. */
  externalRefs?: string[];
}

export interface IngestResult {
  skill: SkillRow;
  version: VersionRow;
  created: boolean;
}

const MAX_FILES = 1000;
const MAX_TOTAL = 50 * 1024 * 1024;

/**
 * Store a full local snapshot of a skill directory as a new immutable version.
 * Every file (SKILL.md, scripts/, references/, assets/, sidecars) is written to the
 * content-addressed blob store; a deterministic tar.gz is built for distribution.
 */
export async function ingestVersion(ctx: AppContext, input: IngestInput): Promise<IngestResult> {
  let files = new Map(input.files);
  const transformations = [...(input.transformations ?? [])];
  if (files.size === 0) throw badRequest('No files provided');
  if (files.size > MAX_FILES) throw new AppError(413, 'too_many_files', `A skill may contain at most ${MAX_FILES} files`);
  let total = 0;
  for (const b of files.values()) total += b.byteLength;
  if (total > MAX_TOTAL) throw new AppError(413, 'too_large', 'Skill exceeds the 50 MB size limit');

  if (input.renameTo) {
    const raw = files.get('SKILL.md');
    if (raw) {
      files.set('SKILL.md', utf8.encode(patchFrontmatter(utf8.decode(raw), { name: input.renameTo })));
      transformations.push({ kind: 'rename', detail: `name → ${input.renameTo}` });
    }
  }

  const validation = validateSkill(files);
  if (!validation.ok) {
    throw new AppError(422, 'invalid_skill', 'The skill does not follow the Agent Skills specification', validation.issues);
  }
  const name = String(validation.frontmatter.name);
  const description = String(validation.frontmatter.description);
  const hash = await contentHash(files);

  // Resolve or create the skill record. Names are unique per org (agents install by name).
  let [existing] = input.skillId
    ? await ctx.db.select().from(skill).where(and(eq(skill.orgId, input.orgId), eq(skill.id, input.skillId)))
    : await ctx.db.select().from(skill).where(and(eq(skill.orgId, input.orgId), eq(skill.name, name)));
  if (existing && existing.namespaceId !== input.ns.id && !input.skillId) {
    throw conflict(`A skill named "${name}" already exists in another namespace. Rename it or use a name prefix.`);
  }
  if (existing && existing.name !== name) {
    throw badRequest(`Skill name cannot change between versions ("${existing.name}" → "${name}")`);
  }

  let previous: VersionRow | undefined;
  if (existing) {
    [previous] = await ctx.db
      .select()
      .from(skillVersion)
      .where(eq(skillVersion.skillId, existing.id))
      .orderBy(desc(skillVersion.createdAt))
      .limit(1);
    if (previous && previous.contentHash === hash && previous.status !== 'rejected') {
      throw conflict(`No changes: content is identical to version ${previous.version}`);
    }
  }

  const fmVersion = (validation.frontmatter.metadata as Record<string, unknown> | undefined)?.version;
  let version = input.version ?? (typeof fmVersion === 'string' && isValidVersion(fmVersion) ? fmVersion : undefined);
  const latestSemver = existing ? await latestVersionString(ctx, existing.id) : null;
  if (!version) {
    const bump =
      previous && latestSemver
        ? suggestBump(previous.frontmatter, validation.frontmatter, 0)
        : 'patch';
    version = latestSemver ? nextVersion(latestSemver, bump) : '1.0.0';
  }
  if (!isValidVersion(version)) throw badRequest(`"${version}" is not a valid semantic version`);
  if (latestSemver && !isGreater(version, latestSemver)) {
    throw conflict(`Version ${version} must be greater than the latest version ${latestSemver}`);
  }

  // Persist blobs first (idempotent), then rows in a transaction.
  const manifest: { path: string; sha256: string; size: number; mime: string; flags: string[] }[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    const sha = await ctx.blobs.put(bytes);
    manifest.push({ path, sha256: sha, size: bytes.byteLength, mime: mimeOf(path, bytes), flags: classifyFile(path, bytes) });
  }
  const archive = createTarGz(files);
  const archiveSha = await ctx.blobs.put(archive);
  const externalRefs = input.externalRefs ?? findExternalReferences(files, '');

  const result = await ctx.db.transaction(async (tx) => {
    let created = false;
    if (!existing) {
      [existing] = await tx
        .insert(skill)
        .values({
          orgId: input.orgId,
          namespaceId: input.ns.id,
          name,
          displayName: titleCase(name),
          summary: description.slice(0, 300),
          ownerId: input.actorId,
          sourceId: input.sourceId ?? null,
          upstreamPath: input.upstreamPath ?? null,
          tags: extractTags(validation.frontmatter),
        })
        .returning();
      created = true;
    }
    const [v] = await tx
      .insert(skillVersion)
      .values({
        orgId: input.orgId,
        skillId: existing!.id,
        version: version!,
        status: 'draft',
        changelog: input.changelog,
        description,
        frontmatter: validation.frontmatter,
        contentHash: hash,
        archiveDigest: archiveSha,
        archiveSize: archive.byteLength,
        fileCount: files.size,
        totalSize: total,
        provenance: input.provenance ?? {},
        transformations,
        externalRefs,
        submittedBy: input.actorId,
      })
      .returning();
    await tx.insert(versionFile).values(
      manifest.map((m) => ({
        versionId: v!.id,
        path: m.path,
        sha256: m.sha256,
        size: m.size,
        mime: m.mime,
        riskFlags: m.flags as never,
      })),
    );
    await tx
      .update(skill)
      .set({ latestVersionId: v!.id, summary: description.slice(0, 300), updatedAt: new Date() })
      .where(eq(skill.id, existing!.id));
    return { skill: existing!, version: v!, created };
  });

  await audit(ctx, {
    orgId: input.orgId,
    actorId: input.actorId,
    action: result.created ? 'skill.created' : 'version.created',
    targetType: 'skill_version',
    targetId: result.version.id,
    metadata: { name, version, kind: input.kind ?? (result.created ? 'new' : 'update') },
  });
  if (input.submit) await submitVersion(ctx, input.orgId, result.version.id, input.actorId, input.kind);
  await recomputeSkill(ctx, result.skill.id);
  const [fresh] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, result.version.id));
  return { ...result, version: fresh! };
}

export async function submitVersion(
  ctx: AppContext,
  orgId: string,
  versionId: string,
  actorId: string | null,
  kind?: 'new' | 'update' | 'import',
) {
  const v = await getVersion(ctx, orgId, versionId);
  await transition(ctx, v, 'submitted', null);
  await ctx.db.update(skillVersion).set({ submittedAt: new Date(), submittedBy: actorId ?? v.submittedBy }).where(eq(skillVersion.id, v.id));
  const [s] = await ctx.db.select().from(skill).where(eq(skill.id, v.skillId));
  await emit(ctx, orgId, 'skill.submitted', { skill: s?.name, version: v.version, versionId: v.id }, { namespaceId: s?.namespaceId });
  await ctx.jobs.send('version.scan', { versionId: v.id, kind: kind ?? null }, { singletonKey: `scan:${v.id}` });
}

export async function getVersion(ctx: AppContext, orgId: string, versionId: string): Promise<VersionRow> {
  const [v] = await ctx.db
    .select()
    .from(skillVersion)
    .where(and(eq(skillVersion.orgId, orgId), eq(skillVersion.id, versionId)));
  if (!v) throw notFound('Version');
  return v;
}

/** Apply a trust-state transition, enforcing the state machine. */
export async function transition(ctx: AppContext, v: VersionRow, to: VersionStatus, reason: string | null) {
  if (v.status !== to && !VERSION_TRANSITIONS[v.status].includes(to)) {
    throw conflict(`Cannot move version from ${v.status} to ${to}`);
  }
  const patch: Partial<VersionRow> = { status: to, statusReason: reason, updatedAt: new Date() };
  if (to === 'approved' && !v.publishedAt) patch.publishedAt = new Date();
  if (['approved', 'rejected', 'blocked'].includes(to)) patch.decidedAt = new Date();
  await ctx.db.update(skillVersion).set(patch).where(eq(skillVersion.id, v.id));
  Object.assign(v, patch);
  await recomputeSkill(ctx, v.skillId);
}

/** Derive the skill's headline status/version from its versions. */
export async function recomputeSkill(ctx: AppContext, skillId: string) {
  const versions = await ctx.db.select().from(skillVersion).where(eq(skillVersion.skillId, skillId));
  if (!versions.length) return;
  const installable = versions
    .filter((v) => INSTALLABLE_STATUSES.includes(v.status))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const latest = [...versions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  const published = installable.find((v) => v.status === 'approved') ?? installable[0];
  // If the newest version is blocked, the whole skill shows as blocked.
  const headline = latest.status === 'blocked' ? latest : (published ?? latest);
  await ctx.db
    .update(skill)
    .set({
      latestVersionId: latest.id,
      publishedVersionId: published?.id ?? null,
      status: headline.status,
      riskLevel: headline.riskLevel,
      updatedAt: new Date(),
    })
    .where(eq(skill.id, skillId));
}

export async function latestVersionString(ctx: AppContext, skillId: string): Promise<string | null> {
  const rows = await ctx.db.select({ version: skillVersion.version }).from(skillVersion).where(eq(skillVersion.skillId, skillId));
  const sorted = rows.map((r) => r.version).filter((v) => semver.valid(v)).sort(semver.rcompare);
  return sorted[0] ?? null;
}

/** Rebuild a version's FileMap from the blob store. */
export async function loadVersionFiles(ctx: AppContext, versionId: string): Promise<FileMap> {
  const rows = await ctx.db.select().from(versionFile).where(eq(versionFile.versionId, versionId));
  const files: FileMap = new Map();
  for (const r of rows) {
    const bytes = await ctx.blobs.get(r.sha256);
    if (!bytes) throw new AppError(500, 'blob_missing', `Blob ${r.sha256} for ${r.path} is missing`);
    files.set(r.path, bytes);
  }
  return files;
}

export async function loadArchive(ctx: AppContext, v: VersionRow): Promise<Uint8Array> {
  const bytes = await ctx.blobs.get(v.archiveDigest);
  if (bytes) return bytes;
  const files = await loadVersionFiles(ctx, v.id);
  const archive = createTarGz(files);
  await ctx.blobs.put(archive);
  return archive;
}

/** The newest installable version of a skill (approved preferred, then deprecated). */
export async function installableVersion(ctx: AppContext, skillId: string, selector?: string | null): Promise<VersionRow | null> {
  const rows = await ctx.db
    .select()
    .from(skillVersion)
    .where(and(eq(skillVersion.skillId, skillId), inArray(skillVersion.status, [...INSTALLABLE_STATUSES])));
  if (!rows.length) return null;
  if (selector && selector !== 'latest') {
    const valid = rows.map((r) => r.version);
    const match = semver.valid(selector) ? selector : semver.maxSatisfying(valid, selector);
    return rows.find((r) => r.version === match) ?? null;
  }
  const approved = rows.filter((r) => r.status === 'approved');
  const pool = approved.length ? approved : rows;
  return pool.sort((a, b) => semver.rcompare(a.version, b.version))[0]!;
}

export async function previousApprovedVersion(ctx: AppContext, v: VersionRow): Promise<VersionRow | null> {
  const rows = await ctx.db
    .select()
    .from(skillVersion)
    .where(and(eq(skillVersion.skillId, v.skillId), inArray(skillVersion.status, ['approved', 'deprecated'])));
  const older = rows.filter((r) => r.id !== v.id && semver.lt(r.version, v.version)).sort((a, b) => semver.rcompare(a.version, b.version));
  return older[0] ?? null;
}

export function titleCase(name: string): string {
  return name
    .split('-')
    .map((w) => (w.length <= 3 && /^(pdf|api|cli|sql|aws|gcp|ui|ux|ai|llm|mcp|csv|xml|git)$/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

function extractTags(fm: Record<string, unknown>): string[] {
  const meta = (fm.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.tags ?? fm.tags;
  if (typeof raw === 'string') return raw.split(/[,\s]+/).filter(Boolean).slice(0, 10);
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string').slice(0, 10);
  return [];
}

export const fileEtag = (v: VersionRow) => sha256(`${v.id}:${v.archiveDigest}`).slice(0, 16);
