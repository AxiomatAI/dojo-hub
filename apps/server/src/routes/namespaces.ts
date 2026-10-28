import {
  addMemberBody,
  catalogEntryBody,
  createNamespaceBody,
  policyBody,
  updateNamespaceBody,
} from '@dojohub/contract';
import { catalogEntry, namespace, namespaceMember, policy, skill, suite, user } from '@dojohub/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { canAdminNamespace, canManageNamespace, isOrgAdmin } from '../auth/permissions';
import {
  anonymousAllowed,
  anonymousInternalEnabled,
  anonymousReadable,
  installCommands,
  teamBundle,
} from '../distribution/resolve';
import { Api } from '../lib/api';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { toSkillSummaries } from '../services/dto';
import { getReadableNamespace, listNamespaces } from '../services/namespaces';
import { loadPolicy, validateCondition } from '../services/policy';

export function namespaceRoutes() {
  const api = new Api();

  api.op(
    {
      method: 'get',
      path: '/namespaces',
      summary: 'List teams and namespaces',
      tags: ['Teams'],
      public: true,
    },
    async ({ ctx, actor, orgId }) => listNamespaces(ctx, actor, orgId),
  );

  api.op(
    {
      method: 'post',
      path: '/namespaces',
      summary: 'Create a team namespace',
      tags: ['Teams'],
      body: createNamespaceBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      if (!isOrgAdmin(actor)) throw forbidden('Only administrators can create teams');
      const [exists] = await ctx.db
        .select()
        .from(namespace)
        .where(and(eq(namespace.orgId, orgId), eq(namespace.slug, body.slug)));
      if (exists) throw conflict(`A namespace "${body.slug}" already exists`);
      const [ns] = await ctx.db
        .insert(namespace)
        .values({ orgId, kind: 'team', ...body })
        .returning();
      await ctx.db
        .insert(namespaceMember)
        .values({ namespaceId: ns!.id, userId: actor.userId, role: 'owner' });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'namespace.created',
        targetType: 'namespace',
        targetId: ns!.id,
        metadata: { slug: body.slug },
      });
      return ns;
    },
  );

  api.op(
    {
      method: 'get',
      path: '/namespaces/:slug',
      summary: 'Team overview with its catalog',
      tags: ['Teams'],
      public: true,
    },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      const all = await listNamespaces(ctx, actor, orgId);
      const dto = all.find((n) => n.id === ns.id)!;
      const entries = await ctx.db.select().from(catalogEntry).where(eq(catalogEntry.namespaceId, ns.id));
      const skillIds = entries.map((e) => e.skillId).filter((x): x is string => !!x);
      const internalEnabled = actor ? false : await anonymousInternalEnabled(ctx, orgId);
      // Catalog entries can point at skills and suites owned by other teams: without credentials
      // each of them is filtered by its own namespace's visibility, like the distribution does.
      const anonVisible = (row: { namespace: typeof namespace.$inferSelect }) =>
        anonymousReadable(row.namespace, internalEnabled);
      const skillRows = skillIds.length
        ? await ctx.db
            .select({ skill, namespace })
            .from(skill)
            .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
            .where(and(eq(skill.orgId, orgId), isNull(skill.archivedAt)))
        : [];
      const summaries = await toSkillSummaries(
        ctx,
        skillRows.filter(
          (r) => skillIds.includes(r.skill.id) && (actor || (anonVisible(r) && !!r.skill.publishedVersionId)),
        ),
      );
      const suiteIds = entries.map((e) => e.suiteId).filter((x): x is string => !!x);
      const suiteRows = suiteIds.length
        ? (
            await ctx.db
              .select({ suite, namespace })
              .from(suite)
              .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
              .where(eq(suite.orgId, orgId))
          ).filter(
            (r) =>
              suiteIds.includes(r.suite.id) && (actor || (anonVisible(r) && !!r.suite.publishedVersionId)),
          )
        : [];
      const visibleIds = new Set(summaries.map((s) => s.id));
      const visibleSuites = new Set(suiteRows.map((r) => r.suite.id));
      const bundle = await teamBundle(ctx, ns);
      const installable = actor ? bundle : bundle.filter((b) => anonVisible(b));
      return {
        ...dto,
        catalog: entries
          .filter(
            (e) =>
              (e.skillId ? visibleIds.has(e.skillId) : false) ||
              (e.suiteId ? visibleSuites.has(e.suiteId) : false),
          )
          .map((e) => ({
            id: e.id,
            level: e.level,
            pinnedVersion: e.pinnedVersion,
            note: e.note,
            skill: e.skillId ? (summaries.find((s) => s.id === e.skillId) ?? null) : null,
            suite: e.suiteId
              ? (() => {
                  const r = suiteRows.find((x) => x.suite.id === e.suiteId);
                  return r
                    ? {
                        id: r.suite.id,
                        name: r.suite.name,
                        displayName: r.suite.displayName,
                        namespace: r.namespace.slug,
                        status: r.suite.status,
                        description: r.suite.description,
                      }
                    : null;
                })()
              : null,
          })),
        installableCount: installable.length,
        install: installCommands(
          ctx.config.DOJO_BASE_URL,
          { kind: 'team', ns: ns.slug },
          await anonymousAllowed(ctx, ns),
        ),
        canManage: !!actor && canManageNamespace(actor, ns),
        canAdmin: !!actor && canAdminNamespace(actor, ns),
      };
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/namespaces/:slug',
      summary: 'Update a team',
      tags: ['Teams'],
      body: updateNamespaceBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canAdminNamespace(actor, ns)) throw forbidden();
      if (ns.kind === 'org' && body.visibility === 'private')
        throw badRequest('The organisation namespace cannot be private');
      await ctx.db
        .update(namespace)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(namespace.id, ns.id));
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'namespace.updated',
        targetType: 'namespace',
        targetId: ns.id,
        metadata: body,
      });
      return { ok: true };
    },
  );

  api.op(
    { method: 'delete', path: '/namespaces/:slug', summary: 'Archive a team', tags: ['Teams'] },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!isOrgAdmin(actor) || ns.kind === 'org') throw forbidden();
      await ctx.db.update(namespace).set({ archivedAt: new Date() }).where(eq(namespace.id, ns.id));
      return { ok: true };
    },
  );

  api.op(
    { method: 'get', path: '/namespaces/:slug/members', summary: 'List team members', tags: ['Teams'] },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      return ctx.db
        .select({
          userId: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: namespaceMember.role,
          managed: namespaceMember.managed,
        })
        .from(namespaceMember)
        .innerJoin(user, eq(user.id, namespaceMember.userId))
        .where(eq(namespaceMember.namespaceId, ns.id))
        .orderBy(user.name);
    },
  );

  api.op(
    {
      method: 'post',
      path: '/namespaces/:slug/members',
      summary: 'Add or update a member',
      tags: ['Teams'],
      body: addMemberBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canAdminNamespace(actor, ns)) throw forbidden();
      await ctx.db
        .insert(namespaceMember)
        .values({ namespaceId: ns.id, userId: body.userId, role: body.role })
        .onConflictDoUpdate({
          target: [namespaceMember.namespaceId, namespaceMember.userId],
          set: { role: body.role, managed: false },
        });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'namespace.member_set',
        targetType: 'namespace',
        targetId: ns.id,
        metadata: body,
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/namespaces/:slug/members/:userId',
      summary: 'Remove a member',
      tags: ['Teams'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canAdminNamespace(actor, ns)) throw forbidden();
      await ctx.db
        .delete(namespaceMember)
        .where(and(eq(namespaceMember.namespaceId, ns.id), eq(namespaceMember.userId, params.userId!)));
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/namespaces/:slug/catalog',
      summary: 'Recommend a skill or suite to this team',
      tags: ['Teams'],
      body: catalogEntryBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canManageNamespace(actor, ns)) throw forbidden();
      if (!body.skillId === !body.suiteId) throw badRequest('Provide exactly one of skillId or suiteId');
      if (body.skillId) {
        const [s] = await ctx.db
          .select()
          .from(skill)
          .where(and(eq(skill.orgId, orgId), eq(skill.id, body.skillId)));
        if (!s) throw notFound('Skill');
      }
      if (body.suiteId) {
        const [s] = await ctx.db
          .select()
          .from(suite)
          .where(and(eq(suite.orgId, orgId), eq(suite.id, body.suiteId)));
        if (!s) throw notFound('Suite');
      }
      const values = {
        orgId,
        namespaceId: ns.id,
        skillId: body.skillId ?? null,
        suiteId: body.suiteId ?? null,
        pinnedVersion: body.pinnedVersion ?? null,
        level: body.level,
        note: body.note,
        addedBy: actor.userId,
      };
      const [row] = await ctx.db
        .insert(catalogEntry)
        .values(values)
        .onConflictDoUpdate({
          target: body.skillId
            ? [catalogEntry.namespaceId, catalogEntry.skillId]
            : [catalogEntry.namespaceId, catalogEntry.suiteId],
          set: { level: body.level, pinnedVersion: body.pinnedVersion ?? null, note: body.note },
        })
        .returning();
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'catalog.added',
        targetType: 'namespace',
        targetId: ns.id,
        metadata: body,
      });
      return row;
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/namespaces/:slug/catalog/:id',
      summary: 'Change level or pin of a catalog entry',
      tags: ['Teams'],
      body: catalogEntryBody.pick({ level: true, pinnedVersion: true, note: true }).partial(),
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canManageNamespace(actor, ns)) throw forbidden();
      await ctx.db
        .update(catalogEntry)
        .set(body)
        .where(and(eq(catalogEntry.id, params.id!), eq(catalogEntry.namespaceId, ns.id)));
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/namespaces/:slug/catalog/:id',
      summary: 'Remove from team catalog',
      tags: ['Teams'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canManageNamespace(actor, ns)) throw forbidden();
      await ctx.db
        .delete(catalogEntry)
        .where(and(eq(catalogEntry.id, params.id!), eq(catalogEntry.namespaceId, ns.id)));
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/namespaces/:slug/policy',
      summary: 'Effective approval policy',
      tags: ['Policies'],
    },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      const [own] = await ctx.db
        .select()
        .from(policy)
        .where(and(eq(policy.orgId, orgId), eq(policy.namespaceId, ns.id)));
      return {
        inherited: !own,
        document: await loadPolicy(ctx, orgId, ns.id),
        revision: own?.revision ?? null,
        canEdit: canManageNamespace(actor, ns),
      };
    },
  );

  api.op(
    {
      method: 'put',
      path: '/namespaces/:slug/policy',
      summary: 'Set the team approval policy',
      tags: ['Policies'],
      body: policyBody,
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canManageNamespace(actor, ns)) throw forbidden();
      for (const s of body.document.stages) {
        const err = s.when ? validateCondition(s.when) : null;
        if (err) throw badRequest(`Invalid condition in stage "${s.name}": ${err}`);
      }
      await ctx.db
        .insert(policy)
        .values({ orgId, namespaceId: ns.id, document: body.document, updatedBy: actor.userId })
        .onConflictDoUpdate({
          target: [policy.orgId, policy.namespaceId],
          set: { document: body.document, updatedBy: actor.userId, updatedAt: new Date() },
        });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'policy.updated',
        targetType: 'namespace',
        targetId: ns.id,
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/namespaces/:slug/policy',
      summary: 'Revert to the organisation default policy',
      tags: ['Policies'],
      query: z.object({}).optional(),
    },
    async ({ ctx, actor, orgId, params }) => {
      const ns = await getReadableNamespace(ctx, actor, orgId, params.slug!);
      if (!canManageNamespace(actor, ns)) throw forbidden();
      await ctx.db.delete(policy).where(and(eq(policy.orgId, orgId), eq(policy.namespaceId, ns.id)));
      return { ok: true };
    },
  );

  return api;
}
