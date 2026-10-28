import {
  createSuiteBody,
  type ReviewDto,
  reviewDecisionBody,
  type SuiteDto,
  versionStatusBody,
} from '@dojohub/contract';
import {
  approvalDecision,
  approvalRequest,
  approvalStage,
  namespace,
  skill,
  skillVersion,
  suite,
  suiteMember,
  suiteVersion,
} from '@dojohub/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import semver from 'semver';
import { z } from 'zod';
import { canManageNamespace, canReadNamespace, canSubmitTo, isSecurityReviewer } from '../auth/permissions';
import type { AppContext } from '../context';
import {
  anonymousAllowed,
  anonymousInternalEnabled,
  anonymousReadable,
  installCommands,
} from '../distribution/resolve';
import { Api } from '../lib/api';
import { forbidden, notFound } from '../lib/errors';
import { actorGroupKeys, canDecideStage, decideRequest } from '../services/approvals';
import { audit } from '../services/audit';
import { usersById } from '../services/dto';
import { getNamespace } from '../services/namespaces';
import { createSuiteVersion, recomputeSuite } from '../services/suites';

async function suiteDto(
  ctx: AppContext,
  row: { suite: typeof suite.$inferSelect; namespace: typeof namespace.$inferSelect },
  withMembers: boolean,
): Promise<SuiteDto> {
  const ids = [row.suite.latestVersionId, row.suite.publishedVersionId].filter((x): x is string => !!x);
  const versions = ids.length
    ? await ctx.db.select().from(suiteVersion).where(inArray(suiteVersion.id, ids))
    : [];
  const vOf = (id: string | null) => versions.find((v) => v.id === id)?.version ?? null;
  const targetId = row.suite.publishedVersionId ?? row.suite.latestVersionId;
  const members = targetId
    ? await ctx.db
        .select({
          skillId: skill.id,
          name: skill.name,
          displayName: skill.displayName,
          version: skillVersion.version,
          versionId: skillVersion.id,
          status: skillVersion.status,
          isEntry: suiteMember.isEntry,
        })
        .from(suiteMember)
        .innerJoin(skillVersion, eq(skillVersion.id, suiteMember.skillVersionId))
        .innerJoin(skill, eq(skill.id, skillVersion.skillId))
        .where(eq(suiteMember.suiteVersionId, targetId))
        .orderBy(asc(suiteMember.position))
    : [];
  return {
    id: row.suite.id,
    name: row.suite.name,
    displayName: row.suite.displayName,
    description: row.suite.description,
    namespace: row.namespace.slug,
    status: row.suite.status,
    latestVersion: vOf(row.suite.latestVersionId),
    publishedVersion: vOf(row.suite.publishedVersionId),
    installCount: row.suite.installCount,
    author: row.suite.author,
    license: row.suite.license,
    homepage: row.suite.homepage,
    skillCount: members.length,
    ...(withMembers
      ? {
          members,
          install: installCommands(
            ctx.config.DOJO_BASE_URL,
            { kind: 'suite', ns: row.namespace.slug, name: row.suite.name },
            await anonymousAllowed(ctx, row.namespace),
          ),
        }
      : {}),
  };
}

export function suiteRoutes() {
  const api = new Api();

  api.op(
    {
      method: 'get',
      path: '/suites',
      summary: 'List suites',
      tags: ['Suites'],
      query: z.object({ q: z.string().optional(), namespace: z.string().optional() }),
      public: true,
    },
    async ({ ctx, actor, orgId, query }) => {
      const rows = await ctx.db
        .select({ suite, namespace })
        .from(suite)
        .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
        .where(and(eq(suite.orgId, orgId), isNull(suite.archivedAt)))
        .orderBy(desc(suite.updatedAt));
      const q = query.q?.toLowerCase();
      const internalEnabled = actor ? false : await anonymousInternalEnabled(ctx, orgId);
      const visible = rows
        .filter((r) =>
          actor
            ? canReadNamespace(actor, r.namespace)
            : anonymousReadable(r.namespace, internalEnabled) && !!r.suite.publishedVersionId,
        )
        .filter((r) => !query.namespace || r.namespace.slug === query.namespace)
        .filter(
          (r) =>
            !q ||
            r.suite.name.includes(q) ||
            r.suite.displayName.toLowerCase().includes(q) ||
            r.suite.description.toLowerCase().includes(q),
        );
      return Promise.all(visible.map((r) => suiteDto(ctx, r, false)));
    },
  );

  api.op(
    {
      method: 'get',
      path: '/suites/:ns/:name',
      summary: 'Suite detail',
      tags: ['Suites'],
      public: true,
    },
    async ({ ctx, actor, orgId, params }) => {
      const [row] = await ctx.db
        .select({ suite, namespace })
        .from(suite)
        .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
        .where(and(eq(suite.orgId, orgId), eq(namespace.slug, params.ns!), eq(suite.name, params.name!)));
      if (!row) throw notFound('Suite');
      if (actor) {
        if (!canReadNamespace(actor, row.namespace)) throw notFound('Suite');
      } else if (!(await anonymousAllowed(ctx, row.namespace)) || !row.suite.publishedVersionId) {
        throw notFound('Suite');
      }
      const allVersions = (
        await ctx.db.select().from(suiteVersion).where(eq(suiteVersion.suiteId, row.suite.id))
      ).sort((a, b) => semver.rcompare(a.version, b.version));
      const versions = actor
        ? allVersions
        : allVersions.filter((v) => ['approved', 'deprecated'].includes(v.status));
      return {
        ...(await suiteDto(ctx, row, true)),
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
          statusReason: v.statusReason,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
          assets: v.assets,
          provenance: v.provenance,
        })),
        canManage: !!actor && canManageNamespace(actor, row.namespace),
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/suites',
      summary: 'Create a suite version from approved skills',
      tags: ['Suites'],
      body: createSuiteBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      const ns = await getNamespace(ctx, orgId, body.namespace);
      if (!canSubmitTo(actor, ns)) throw forbidden();
      const res = await createSuiteVersion(ctx, { orgId, ns, actorId: actor.userId, ...body });
      return { suite: res.suite.name, version: res.version.version, status: res.version.status };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/suites/:ns/:name/versions/:version/status',
      summary: 'Deprecate or block a suite version',
      tags: ['Suites'],
      body: versionStatusBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getNamespace(ctx, orgId, params.ns!);
      if (!(canManageNamespace(actor, ns) || isSecurityReviewer(actor))) throw forbidden();
      const [s] = await ctx.db
        .select()
        .from(suite)
        .where(and(eq(suite.namespaceId, ns.id), eq(suite.name, params.name!)));
      if (!s) throw notFound('Suite');
      await ctx.db
        .update(suiteVersion)
        .set({ status: body.status, statusReason: body.reason ?? null })
        .where(and(eq(suiteVersion.suiteId, s.id), eq(suiteVersion.version, params.version!)));
      await recomputeSuite(ctx, s.id);
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: `suite.${body.status}`,
        targetType: 'suite',
        targetId: s.id,
      });
      return { ok: true };
    },
  );
  return api;
}

export function reviewRoutes() {
  const api = new Api();

  const loadReview = async (ctx: AppContext, orgId: string, id: string) => {
    const [req] = await ctx.db
      .select()
      .from(approvalRequest)
      .where(and(eq(approvalRequest.orgId, orgId), eq(approvalRequest.id, id)));
    if (!req) throw notFound('Review');
    return req;
  };

  const toDto = async (
    ctx: AppContext,
    actor: Parameters<typeof canDecideStage>[0],
    req: typeof approvalRequest.$inferSelect,
    keys: string[],
  ): Promise<ReviewDto> => {
    const stages = await ctx.db
      .select()
      .from(approvalStage)
      .where(eq(approvalStage.requestId, req.id))
      .orderBy(asc(approvalStage.position));
    const decisions = await ctx.db
      .select()
      .from(approvalDecision)
      .where(eq(approvalDecision.requestId, req.id))
      .orderBy(asc(approvalDecision.createdAt));
    const users = await usersById(ctx, [req.requestedBy, ...decisions.map((d) => d.actorId)]);
    const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, req.namespaceId));
    let subject: ReviewDto['subject'];
    if (req.skillVersionId) {
      const [row] = await ctx.db
        .select({ v: skillVersion, s: skill })
        .from(skillVersion)
        .innerJoin(skill, eq(skill.id, skillVersion.skillId))
        .where(eq(skillVersion.id, req.skillVersionId));
      const prev = (
        await ctx.db
          .select()
          .from(skillVersion)
          .where(
            and(
              eq(skillVersion.skillId, row!.s.id),
              inArray(skillVersion.status, ['approved', 'deprecated']),
            ),
          )
      )
        .filter((p) => semver.lt(p.version, row!.v.version))
        .sort((a, b) => semver.rcompare(a.version, b.version))[0];
      subject = {
        type: 'skill',
        id: row!.s.id,
        name: row!.s.name,
        displayName: row!.s.displayName,
        version: row!.v.version,
        versionId: row!.v.id,
        previousVersion: prev?.version ?? null,
        previousVersionId: prev?.id ?? null,
        riskLevel: row!.v.riskLevel,
        riskScore: row!.v.riskScore,
      };
    } else {
      const [row] = await ctx.db
        .select({ v: suiteVersion, s: suite })
        .from(suiteVersion)
        .innerJoin(suite, eq(suite.id, suiteVersion.suiteId))
        .where(eq(suiteVersion.id, req.suiteVersionId!));
      subject = {
        type: 'suite',
        id: row!.s.id,
        name: row!.s.name,
        displayName: row!.s.displayName,
        version: row!.v.version,
        versionId: row!.v.id,
        previousVersion: null,
        previousVersionId: null,
        riskLevel: row!.v.riskLevel,
        riskScore: null,
      };
    }
    const stageDtos = stages.map((st) => ({
      id: st.id,
      position: st.position,
      name: st.name,
      status: st.status,
      minApprovals: st.minApprovals,
      approvers: st.approvers,
      decisions: decisions
        .filter((d) => d.stageId === st.id)
        .map((d) => ({
          actor: d.actorId ? (users.get(d.actorId) ?? null) : null,
          actorType: d.actorType,
          decision: d.decision,
          comment: d.comment,
          createdAt: d.createdAt.toISOString(),
        })),
      canDecide:
        req.status === 'pending' && canDecideStage(actor, st, req.namespaceId, keys, req.requestedBy),
    }));
    return {
      id: req.id,
      kind: req.kind,
      status: req.status,
      createdAt: req.createdAt.toISOString(),
      requestedBy: req.requestedBy ? (users.get(req.requestedBy) ?? null) : null,
      namespace: ns?.slug ?? '',
      subject,
      stages: stageDtos,
      systemDecisions: decisions
        .filter((d) => d.actorType === 'system')
        .map((d) => ({ decision: d.decision, comment: d.comment, createdAt: d.createdAt.toISOString() })),
      canDecide: stageDtos.some((s) => s.canDecide),
    };
  };

  api.op(
    {
      method: 'get',
      path: '/reviews',
      summary: 'Review queue',
      tags: ['Reviews'],
      query: z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending'),
        assigned: z.coerce.boolean().optional(),
      }),
    },
    async ({ ctx, actor, orgId, query }) => {
      const conds = [eq(approvalRequest.orgId, orgId)];
      if (query.status !== 'all') conds.push(eq(approvalRequest.status, query.status));
      const reqs = await ctx.db
        .select()
        .from(approvalRequest)
        .where(and(...conds))
        .orderBy(desc(approvalRequest.createdAt))
        .limit(300);
      const keys = await actorGroupKeys(ctx, actor);
      const out: ReviewDto[] = [];
      for (const r of reqs) {
        const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, r.namespaceId));
        if (!ns || !canReadNamespace(actor, ns)) continue;
        const dto = await toDto(ctx, actor, r, keys);
        if (query.assigned && !dto.canDecide) continue;
        if (
          !query.assigned &&
          !dto.canDecide &&
          r.requestedBy !== actor.userId &&
          !canManageNamespace(actor, ns) &&
          !isSecurityReviewer(actor) &&
          !actor.ns.has(ns.id)
        )
          continue;
        out.push(dto);
      }
      return out;
    },
  );

  api.op(
    { method: 'get', path: '/reviews/:id', summary: 'Review detail', tags: ['Reviews'] },
    async ({ ctx, actor, orgId, params }) => {
      const req = await loadReview(ctx, orgId, params.id!);
      const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, req.namespaceId));
      if (!ns || !canReadNamespace(actor, ns)) throw notFound('Review');
      return toDto(ctx, actor, req, await actorGroupKeys(ctx, actor));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/reviews/:id/decision',
      summary: 'Approve, reject or request changes',
      tags: ['Reviews'],
      body: reviewDecisionBody,
    },
    async ({ ctx, actor, params, body }) => {
      await decideRequest(ctx, actor, params.id!, body.decision, body.comment);
      return { ok: true };
    },
  );

  return api;
}
