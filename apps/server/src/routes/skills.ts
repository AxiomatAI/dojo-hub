import { createSkillBody, type SkillDetailDto, versionStatusBody } from '@dojohub/contract';
import {
  ArchiveError,
  diffManifests,
  discover,
  type FileMap,
  readArchive,
  stripSingleRoot,
  unifiedDiff,
  utf8,
} from '@dojohub/core';
import {
  approvalRequest,
  catalogEntry,
  duplicateMatch,
  namespace,
  scanRun,
  skill,
  skillVersion,
  source,
  suite,
  suiteMember,
  suiteVersion,
  versionFile,
} from '@dojohub/db';
import { buildAnalyzers, isProbablyText } from '@dojohub/scanner';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import semver from 'semver';
import { z } from 'zod';
import {
  type Actor,
  canManageNamespace,
  canReadNamespace,
  canSubmitTo,
  hasGlobalRead,
  isOrgAdmin,
  isSecurityReviewer,
} from '../auth/permissions';
import type { AppContext } from '../context';
import {
  anonymousAllowed,
  anonymousInternalEnabled,
  anonymousReadable,
  installCommands,
} from '../distribution/resolve';
import { Api } from '../lib/api';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { cancelOpenRequests } from '../services/approvals';
import { audit } from '../services/audit';
import { toSkillSummaries, toVersionDto, usersById } from '../services/dto';
import { emit } from '../services/events';
import { getNamespace } from '../services/namespaces';
import { ingestVersion, loadArchive, loadVersionFiles, submitVersion, transition } from '../services/skills';
import { recordInstall } from '../services/stats';

const listQuery = z.object({
  q: z.string().optional(),
  namespace: z.string().optional(),
  team: z.string().optional(),
  status: z.string().optional(),
  risk: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  sort: z.enum(['updated', 'installs', 'name']).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

type Row = { skill: typeof skill.$inferSelect; namespace: typeof namespace.$inferSelect };

/** Visibility of a skill to an actor: namespace readable, and unpublished work only to involved people. */
export function canSeeSkill(actor: Actor, row: Row): boolean {
  if (!canReadNamespace(actor, row.namespace)) return false;
  if (['approved', 'deprecated', 'blocked'].includes(row.skill.status) || row.skill.publishedVersionId)
    return true;
  return (
    row.skill.ownerId === actor.userId ||
    actor.ns.has(row.namespace.id) ||
    hasGlobalRead(actor) ||
    row.namespace.kind === 'org'
  );
}

/**
 * Load a skill for a caller that may be anonymous (`public` operations). Without credentials only
 * installable skills in anonymously readable namespaces exist — unpublished drafts are never exposed.
 */
export async function loadSkill(
  ctx: AppContext,
  actor: Actor | null,
  orgId: string,
  name: string,
): Promise<Row> {
  const [row] = await ctx.db
    .select({ skill, namespace })
    .from(skill)
    .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
    .where(
      and(eq(skill.orgId, orgId), or(eq(skill.name, name), eq(skill.id, name)), isNull(skill.archivedAt)),
    );
  if (!row) throw notFound('Skill');
  if (!actor) {
    if (!row.skill.publishedVersionId || !(await anonymousAllowed(ctx, row.namespace)))
      throw notFound('Skill');
    return row;
  }
  if (!canSeeSkill(actor, row)) throw notFound('Skill');
  return row;
}

/**
 * Anonymous callers only ever see versions the distribution endpoints would hand out: unpublished
 * drafts, review state and scan output stay behind a session.
 */
function limitAnonymousVersion(actor: Actor | null, v: { status: string }) {
  if (!actor && !['approved', 'deprecated'].includes(v.status)) throw notFound('Version');
}

async function loadVersionRow(ctx: AppContext, skillId: string, version: string) {
  const [v] = await ctx.db
    .select()
    .from(skillVersion)
    .where(
      and(
        eq(skillVersion.skillId, skillId),
        or(eq(skillVersion.version, version), eq(skillVersion.id, version)),
      ),
    );
  if (!v) throw notFound('Version');
  return v;
}

async function readUpload(c: {
  req: {
    header: (n: string) => string | undefined;
    parseBody: () => Promise<Record<string, unknown>>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
}): Promise<{ bytes: Uint8Array; filename?: string }> {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('Missing "file" field');
    return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
  }
  return { bytes: new Uint8Array(await c.req.arrayBuffer()) };
}

function filesFromArchive(bytes: Uint8Array): FileMap {
  try {
    return stripSingleRoot(readArchive(bytes));
  } catch (err) {
    if (err instanceof ArchiveError) throw new AppError(422, err.code, err.message);
    throw err;
  }
}

export function skillRoutes() {
  const api = new Api();

  api.op(
    {
      method: 'get',
      path: '/skills',
      summary: 'List and search skills',
      tags: ['Skills'],
      query: listQuery,
      public: true,
    },
    async ({ ctx, actor, orgId, query }) => {
      const conds = [eq(skill.orgId, orgId), isNull(skill.archivedAt)];
      if (query.q) {
        const like = `%${query.q.replace(/[%_]/g, '\\$&')}%`;
        conds.push(
          or(
            ilike(skill.name, like),
            ilike(skill.displayName, like),
            ilike(skill.summary, like),
            sql`${query.q.toLowerCase()} = ANY(${skill.tags})`,
          )!,
        );
      }
      if (query.namespace) conds.push(eq(namespace.slug, query.namespace));
      if (query.status) conds.push(inArray(skill.status, query.status.split(',') as never[]));
      if (query.risk) conds.push(inArray(skill.riskLevel, query.risk.split(',') as never[]));
      if (query.category) conds.push(eq(skill.category, query.category));
      if (query.source) conds.push(eq(skill.sourceId, query.source));
      if (query.mine && actor) conds.push(eq(skill.ownerId, actor.userId));
      if (query.team) {
        const ns = await getNamespace(ctx, orgId, query.team);
        const ids = (
          await ctx.db
            .select({ id: catalogEntry.skillId })
            .from(catalogEntry)
            .where(eq(catalogEntry.namespaceId, ns.id))
        )
          .map((r) => r.id)
          .filter((x): x is string => !!x);
        const suiteIds = (
          await ctx.db
            .select({ id: catalogEntry.suiteId })
            .from(catalogEntry)
            .where(eq(catalogEntry.namespaceId, ns.id))
        )
          .map((r) => r.id)
          .filter((x): x is string => !!x);
        if (suiteIds.length) {
          const memberSkills = await ctx.db
            .select({ id: skillVersion.skillId })
            .from(suiteMember)
            .innerJoin(suiteVersion, eq(suiteVersion.id, suiteMember.suiteVersionId))
            .innerJoin(skillVersion, eq(skillVersion.id, suiteMember.skillVersionId))
            .where(inArray(suiteVersion.suiteId, suiteIds));
          ids.push(...memberSkills.map((m) => m.id));
        }
        conds.push(ids.length ? inArray(skill.id, [...new Set(ids)]) : sql`false`);
      }
      const order =
        query.sort === 'installs'
          ? desc(skill.installCount)
          : query.sort === 'name'
            ? skill.name
            : desc(skill.updatedAt);
      const matched = await ctx.db
        .select({ skill, namespace })
        .from(skill)
        .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
        .where(and(...conds))
        .orderBy(order);
      // Anonymous callers get exactly what the distribution endpoints would hand out: installable
      // skills in namespaces served without a token.
      const internalEnabled = actor ? false : await anonymousInternalEnabled(ctx, orgId);
      const rows = matched.filter((r) =>
        actor
          ? canSeeSkill(actor, r)
          : !!r.skill.publishedVersionId && anonymousReadable(r.namespace, internalEnabled),
      );
      const page = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
      return {
        items: await toSkillSummaries(ctx, page),
        total: rows.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name',
      summary: 'Get a skill with its version history',
      tags: ['Skills'],
      public: true,
    },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const [summary] = await toSkillSummaries(ctx, [row]);
      const allVersions = (
        await ctx.db.select().from(skillVersion).where(eq(skillVersion.skillId, row.skill.id))
      ).sort((a, b) => semver.rcompare(a.version, b.version));
      // Anonymous browsing mirrors the catalog: installable versions only, no authorship.
      const versions = actor
        ? allVersions
        : allVersions.filter((v) => ['approved', 'deprecated'].includes(v.status));
      const users = await usersById(ctx, [...versions.map((v) => v.submittedBy), row.skill.ownerId]);
      const [src] = row.skill.sourceId
        ? await ctx.db.select().from(source).where(eq(source.id, row.skill.sourceId))
        : [];
      const suites = await ctx.db
        .selectDistinct({ id: suite.id, name: suite.name, namespace: namespace.slug })
        .from(suiteMember)
        .innerJoin(suiteVersion, eq(suiteVersion.id, suiteMember.suiteVersionId))
        .innerJoin(suite, eq(suite.id, suiteVersion.suiteId))
        .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
        .where(
          inArray(
            suiteMember.skillVersionId,
            versions.map((v) => v.id).length ? versions.map((v) => v.id) : ['-'],
          ),
        );
      const detail: SkillDetailDto = {
        ...summary!,
        owner: actor && row.skill.ownerId ? (users.get(row.skill.ownerId) ?? null) : null,
        upstreamPath: row.skill.upstreamPath,
        upstreamRemoved: row.skill.upstreamRemoved,
        source: src ? { id: src.id, name: src.name, url: src.url, kind: src.kind } : null,
        versions: versions.map((v) => toVersionDto(v, users)),
        suites,
        install: installCommands(
          ctx.config.DOJO_BASE_URL,
          { kind: 'skill', ns: row.namespace.slug, name: row.skill.name },
          await anonymousAllowed(ctx, row.namespace),
        ),
        canEdit: !!actor && (canManageNamespace(actor, row.namespace) || row.skill.ownerId === actor.userId),
        canReview: !!actor && (isSecurityReviewer(actor) || canManageNamespace(actor, row.namespace)),
      };
      return detail;
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills',
      summary: 'Create a skill or new version from files (in-browser authoring)',
      tags: ['Skills'],
      body: createSkillBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      const ns = await getNamespace(ctx, orgId, body.namespace);
      if (!canSubmitTo(actor, ns)) throw forbidden('You cannot submit skills to this namespace');
      const files: FileMap = new Map(Object.entries(body.files).map(([p, t]) => [p, utf8.encode(t)]));
      const res = await ingestVersion(ctx, {
        orgId,
        ns,
        files,
        actorId: actor.userId,
        version: body.version,
        changelog: body.changelog,
        submit: body.submit,
        provenance: { uploadedFilename: 'editor' },
      });
      return {
        skill: res.skill.name,
        version: res.version.version,
        versionId: res.version.id,
        status: res.version.status,
        created: res.created,
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/upload',
      summary: 'Upload a skill archive (zip, tar.gz) or SKILL.md',
      tags: ['Skills'],
      description: 'Send the archive as the raw request body or as multipart field "file".',
      query: z.object({
        namespace: z.string(),
        version: z.string().optional(),
        changelog: z.string().optional(),
        path: z.string().optional(),
        submit: z
          .enum(['true', 'false'])
          .default('true')
          .transform((v) => v === 'true'),
      }),
    },
    async ({ c, ctx, actor, orgId, query }) => {
      const ns = await getNamespace(ctx, orgId, query.namespace);
      if (!canSubmitTo(actor, ns)) throw forbidden('You cannot submit skills to this namespace');
      const { bytes, filename } = await readUpload(c);
      const all = filesFromArchive(bytes);
      const found = discover(all);
      const chosen =
        query.path !== undefined
          ? found.skills.find((s) => s.path === query.path)
          : found.skills.length === 1
            ? found.skills[0]
            : undefined;
      if (!chosen) {
        throw new AppError(
          422,
          'multiple_skills',
          found.skills.length
            ? 'The archive contains several skills; choose one with ?path= or add it as a source'
            : 'No SKILL.md found in the archive',
          {
            skills: found.skills.map((s) => ({ name: s.name, path: s.path })),
          },
        );
      }
      const res = await ingestVersion(ctx, {
        orgId,
        ns,
        files: chosen.files,
        actorId: actor.userId,
        version: query.version,
        changelog: query.changelog,
        submit: query.submit,
        externalRefs: chosen.externalRefs,
        provenance: { uploadedFilename: filename },
      });
      return {
        skill: res.skill.name,
        version: res.version.version,
        versionId: res.version.id,
        status: res.version.status,
        created: res.created,
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/validate',
      summary: 'Validate and pre-scan an archive without saving it',
      tags: ['Skills'],
    },
    async ({ c }) => {
      const type = c.req.header('content-type') ?? '';
      let files: FileMap;
      if (type.includes('application/json')) {
        const body = (await c.req.json()) as { files?: Record<string, string> };
        files = new Map(Object.entries(body.files ?? {}).map(([p, t]) => [p, utf8.encode(t)]));
      } else files = filesFromArchive((await readUpload(c)).bytes);
      const found = discover(files);
      const skills = [];
      for (const s of found.skills) {
        const results = await Promise.all(
          buildAnalyzers().map((a) =>
            a.run({
              name: s.name,
              description: s.description,
              frontmatter: s.frontmatter,
              files: s.files,
              version: '0.0.0',
              externalRefs: s.externalRefs,
            }),
          ),
        );
        skills.push({
          name: s.name,
          path: s.path,
          description: s.description,
          issues: s.issues,
          externalRefs: s.externalRefs,
          files: [...s.files.entries()].map(([p, b]) => ({ path: p, size: b.byteLength })),
          findings: results.flatMap((r) => r.findings).filter((f) => f.severity !== 'info'),
        });
      }
      return {
        skills,
        suites: found.suites.map((s) => ({ name: s.name, version: s.version, skills: s.skillPaths })),
        warnings: found.warnings,
      };
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/skills/:name',
      summary: 'Update skill metadata',
      tags: ['Skills'],
      body: z.object({
        displayName: z.string().min(1).max(120).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        category: z.string().max(60).nullable().optional(),
      }),
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      if (!canManageNamespace(actor, row.namespace) && row.skill.ownerId !== actor.userId) throw forbidden();
      await ctx.db
        .update(skill)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(skill.id, row.skill.id));
      return { ok: true };
    },
  );

  api.op(
    { method: 'delete', path: '/skills/:name', summary: 'Archive a skill', tags: ['Skills'] },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      if (!canManageNamespace(actor, row.namespace)) throw forbidden();
      await ctx.db.update(skill).set({ archivedAt: new Date() }).where(eq(skill.id, row.skill.id));
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'skill.archived',
        targetType: 'skill',
        targetId: row.skill.id,
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/versions/:version',
      summary: 'Version detail: files, scans, duplicates and review',
      tags: ['Skills'],
      public: true,
    },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      limitAnonymousVersion(actor, v);
      const users = await usersById(ctx, [v.submittedBy]);
      const files = await ctx.db
        .select()
        .from(versionFile)
        .where(eq(versionFile.versionId, v.id))
        .orderBy(versionFile.path);
      const scans = await ctx.db.select().from(scanRun).where(eq(scanRun.skillVersionId, v.id));
      const dups = await ctx.db
        .select({
          kind: duplicateMatch.kind,
          score: duplicateMatch.score,
          versionId: skillVersion.id,
          version: skillVersion.version,
          skillName: skill.name,
          namespace: namespace.slug,
        })
        .from(duplicateMatch)
        .innerJoin(skillVersion, eq(skillVersion.id, duplicateMatch.otherVersionId))
        .innerJoin(skill, eq(skill.id, skillVersion.skillId))
        .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
        .where(eq(duplicateMatch.versionId, v.id))
        .orderBy(desc(duplicateMatch.score));
      const [review] = await ctx.db
        .select({ id: approvalRequest.id, status: approvalRequest.status })
        .from(approvalRequest)
        .where(eq(approvalRequest.skillVersionId, v.id))
        .orderBy(desc(approvalRequest.createdAt))
        .limit(1);
      return {
        ...toVersionDto(v, users),
        files: files.map((f) => ({
          path: f.path,
          sha256: f.sha256,
          size: f.size,
          mime: f.mime,
          riskFlags: f.riskFlags,
        })),
        scans: scans.map((s) => ({
          analyzer: s.analyzer,
          status: s.status,
          verdict: s.verdict,
          riskScore: s.riskScore,
          findings: s.findings,
          report: s.report,
          model: s.model,
          error: s.error,
          finishedAt: s.finishedAt?.toISOString() ?? null,
        })),
        duplicates: dups,
        review: review ?? null,
        canSubmit:
          !!actor &&
          ['draft', 'rejected'].includes(v.status) &&
          (v.submittedBy === actor.userId || canManageNamespace(actor, row.namespace)),
        canManage: !!actor && (canManageNamespace(actor, row.namespace) || isSecurityReviewer(actor)),
      };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/versions/:version/files/*',
      summary: 'Read a file of a version',
      tags: ['Skills'],
      public: true,
    },
    async ({ c, ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      limitAnonymousVersion(actor, v);
      const path = decodeURIComponent(c.req.path.split('/files/').slice(1).join('/files/'));
      const [f] = await ctx.db
        .select()
        .from(versionFile)
        .where(and(eq(versionFile.versionId, v.id), eq(versionFile.path, path)));
      if (!f) throw notFound('File');
      const bytes = await ctx.blobs.get(f.sha256);
      if (!bytes) throw notFound('File content');
      const text = isProbablyText(f.path, bytes);
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': text ? 'text/plain; charset=utf-8' : f.mime,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
          'cache-control': 'private, max-age=31536000, immutable',
          ...(text ? {} : { 'content-disposition': `attachment; filename="${f.path.split('/').pop()}"` }),
        },
      });
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/versions/:version/download',
      summary: 'Download a version as tar.gz',
      tags: ['Skills'],
      public: true,
      query: z.object({
        channel: z.enum(['cli', 'web', 'api', 'mcp']).default('api'),
        update: z.string().optional(),
      }),
    },
    async ({ ctx, actor, orgId, params, query }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      const installable = ['approved', 'deprecated'].includes(v.status);
      if (
        !installable &&
        !(
          actor &&
          (canManageNamespace(actor, row.namespace) ||
            isSecurityReviewer(actor) ||
            v.submittedBy === actor.userId)
        )
      ) {
        throw forbidden('This version is not published');
      }
      const archive = await loadArchive(ctx, v);
      if (installable) {
        await recordInstall(ctx, {
          orgId,
          channel: query.channel,
          skillId: row.skill.id,
          skillVersionId: v.id,
          namespaceId: row.namespace.id,
          actorId: actor?.userId ?? null,
          isUpdate: query.update === '1',
        });
      }
      return new Response(archive as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${row.skill.name}-${v.version}.tar.gz"`,
          'x-dojo-digest': `sha256:${v.archiveDigest}`,
        },
      });
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/diff',
      summary: 'Diff two versions',
      tags: ['Skills'],
      query: z.object({ from: z.string(), to: z.string() }),
    },
    async ({ ctx, actor, orgId, params, query }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const a = await loadVersionRow(ctx, row.skill.id, query.from);
      const b = await loadVersionRow(ctx, row.skill.id, query.to);
      const [fa, fb] = await Promise.all([
        ctx.db.select().from(versionFile).where(eq(versionFile.versionId, a.id)),
        ctx.db.select().from(versionFile).where(eq(versionFile.versionId, b.id)),
      ]);
      const changes = diffManifests(fa, fb);
      const out = [];
      for (const ch of changes) {
        const before = ch.before ? await ctx.blobs.get(ch.before) : null;
        const after = ch.after ? await ctx.blobs.get(ch.after) : null;
        const textual =
          (before ? isProbablyText(ch.path, before) : true) &&
          (after ? isProbablyText(ch.path, after) : true);
        out.push({
          ...ch,
          binary: !textual,
          beforeText: textual && before ? utf8.decode(before).slice(0, 200_000) : null,
          afterText: textual && after ? utf8.decode(after).slice(0, 200_000) : null,
          patch: textual
            ? unifiedDiff(ch.path, before ? utf8.decode(before) : '', after ? utf8.decode(after) : '')
            : null,
        });
      }
      return {
        from: a.version,
        to: b.version,
        changes: out,
        frontmatterChanged: JSON.stringify(a.frontmatter) !== JSON.stringify(b.frontmatter),
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/:name/versions/:version/submit',
      summary: 'Submit a draft for review',
      tags: ['Skills'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      if (v.submittedBy !== actor.userId && !canManageNamespace(actor, row.namespace)) throw forbidden();
      if (v.status === 'rejected') await transition(ctx, v, 'draft', null);
      await submitVersion(ctx, orgId, v.id, actor.userId);
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/:name/versions/:version/withdraw',
      summary: 'Withdraw a version from review',
      tags: ['Skills'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      if (v.submittedBy !== actor.userId && !canManageNamespace(actor, row.namespace)) throw forbidden();
      if (v.status !== 'in_review') throw badRequest('Only versions under review can be withdrawn');
      await cancelOpenRequests(ctx, v.id);
      await transition(ctx, v, 'draft', 'Withdrawn by submitter');
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/:name/versions/:version/rescan',
      summary: 'Re-run the security scan',
      tags: ['Skills'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      if (!isSecurityReviewer(actor) && !canManageNamespace(actor, row.namespace)) throw forbidden();
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      if (!['in_review', 'submitted', 'scanning'].includes(v.status))
        throw badRequest('Only versions in the pipeline can be rescanned');
      await cancelOpenRequests(ctx, v.id);
      await ctx.db.update(skillVersion).set({ status: 'submitted' }).where(eq(skillVersion.id, v.id));
      await ctx.jobs.send(
        'version.scan',
        { versionId: v.id },
        { singletonKey: `scan:${v.id}:${Date.now()}` },
      );
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/skills/:name/versions/:version/status',
      summary: 'Deprecate, block or unblock a version',
      tags: ['Skills'],
      body: versionStatusBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const v = await loadVersionRow(ctx, row.skill.id, params.version!);
      const allowed =
        body.status === 'deprecated'
          ? canManageNamespace(actor, row.namespace) || isSecurityReviewer(actor)
          : isSecurityReviewer(actor) || isOrgAdmin(actor);
      if (!allowed)
        throw forbidden(
          body.status === 'blocked' ? 'Only security reviewers and admins can block skills' : undefined,
        );
      if (body.status === 'blocked' && !body.reason)
        throw badRequest('A reason is required to block a version');
      await transition(ctx, v, body.status, body.reason ?? null);
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: `version.${body.status}`,
        targetType: 'skill_version',
        targetId: v.id,
        metadata: { reason: body.reason, skill: row.skill.name, version: v.version },
      });
      if (body.status !== 'approved') {
        await emit(
          ctx,
          orgId,
          body.status === 'blocked' ? 'version.blocked' : 'version.deprecated',
          { skill: row.skill.name, version: v.version, versionId: v.id, reason: body.reason },
          { namespaceId: row.namespace.id },
        );
      }
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/files',
      summary: 'All files of the latest installable version (JSON)',
      tags: ['Skills'],
      query: z.object({ version: z.string().optional() }),
    },
    async ({ ctx, actor, orgId, params, query }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const vid = query.version
        ? (await loadVersionRow(ctx, row.skill.id, query.version)).id
        : (row.skill.publishedVersionId ?? row.skill.latestVersionId);
      if (!vid) throw notFound('Version');
      const files = await loadVersionFiles(ctx, vid);
      return {
        files: [...files].map(([path, b]) => ({
          path,
          size: b.byteLength,
          content: isProbablyText(path, b) ? utf8.decode(b) : null,
        })),
      };
    },
  );

  return api;
}
