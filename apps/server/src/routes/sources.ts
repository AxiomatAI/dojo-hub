import { createSourceBody, importItemsBody, type SourceDto, SOURCE_ITEM_STATUSES, type SourceItemStatus } from '@dojohub/contract';
import { discover } from '@dojohub/core';
import { namespace, source, sourceItem, sourceSnapshot } from '@dojohub/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canManageNamespace, canReadNamespace } from '../auth/permissions';
import type { AppContext } from '../context';
import { Api } from '../lib/api';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { fetchGit, fetchWellKnown, resolveGitSource, searchSkillsSh } from '../services/fetchers';
import { getNamespace } from '../services/namespaces';
import { importItems, PRESET_SOURCES, storeSourceUpload, syncSource } from '../services/sources';

async function toDto(ctx: AppContext, s: typeof source.$inferSelect, nsSlug: string): Promise<SourceDto> {
  const items = await ctx.db.select({ status: sourceItem.status }).from(sourceItem).where(eq(sourceItem.sourceId, s.id));
  const counts = Object.fromEntries(SOURCE_ITEM_STATUSES.map((st) => [st, 0])) as Record<SourceItemStatus, number>;
  for (const i of items) counts[i.status]++;
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    url: s.url,
    ref: s.ref,
    namespace: nsSlug,
    status: s.status,
    lastError: s.lastError,
    lastCommit: s.lastCommit,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    autoTrack: s.autoTrack,
    syncCron: s.syncCron,
    namePrefix: s.namePrefix,
    include: s.include,
    exclude: s.exclude,
    itemCounts: counts,
  };
}

export function sourceRoutes() {
  const api = new Api();

  const load = async (ctx: AppContext, orgId: string, id: string) => {
    const [row] = await ctx.db.select({ source, namespace }).from(source).innerJoin(namespace, eq(namespace.id, source.namespaceId)).where(and(eq(source.orgId, orgId), eq(source.id, id)));
    if (!row) throw notFound('Source');
    return row;
  };

  api.op({ method: 'get', path: '/sources/presets', summary: 'Curated upstream skill repositories', tags: ['Sources'] }, async () => PRESET_SOURCES);

  api.op({ method: 'get', path: '/sources', summary: 'List downstream sources', tags: ['Sources'] }, async ({ ctx, actor, orgId }) => {
    const rows = await ctx.db.select({ source, namespace }).from(source).innerJoin(namespace, eq(namespace.id, source.namespaceId)).where(eq(source.orgId, orgId)).orderBy(desc(source.createdAt));
    return Promise.all(rows.filter((r) => canReadNamespace(actor, r.namespace)).map((r) => toDto(ctx, r.source, r.namespace.slug)));
  });

  api.op(
    {
      method: 'post',
      path: '/sources/preview',
      summary: 'Discover skills and suites in a repository without saving',
      tags: ['Sources'],
      body: z.object({ kind: createSourceBody.shape.kind, url: z.string(), ref: z.string().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }),
    },
    async ({ ctx, body }) => {
      const fetched =
        body.kind === 'well_known'
          ? await fetchWellKnown(body.url)
          : await fetchGit(resolveGitSource(body.kind, body.url, body.ref), body.kind === 'github' ? (ctx.config.GITHUB_TOKEN ?? null) : null);
      const found = discover(fetched.files, { include: body.include, exclude: body.exclude });
      return {
        commit: fetched.commit,
        warnings: [...fetched.warnings, ...found.warnings],
        skills: found.skills.map((s) => ({ name: s.name, path: s.path, description: s.description, files: s.files.size, errors: s.issues.filter((i) => i.level === 'error').map((i) => i.message), suites: s.pluginNames })),
        suites: found.suites.map((s) => ({ name: s.name, description: s.description, version: s.version, skills: s.skillPaths })),
      };
    },
  );

  api.op({ method: 'post', path: '/sources', summary: 'Add a downstream source', tags: ['Sources'], body: createSourceBody }, async ({ ctx, actor, orgId, body }) => {
    const ns = await getNamespace(ctx, orgId, body.namespace);
    if (!canManageNamespace(actor, ns)) throw forbidden('You need maintainer rights on the target namespace');
    if (body.kind !== 'upload' && body.kind !== 'well_known') resolveGitSource(body.kind, body.url, body.ref);
    const [row] = await ctx.db
      .insert(source)
      .values({
        orgId,
        namespaceId: ns.id,
        kind: body.kind,
        name: body.name,
        url: body.url,
        ref: body.ref ?? null,
        include: body.include,
        exclude: body.exclude,
        credentialEnc: body.credential ? ctx.secrets.encrypt(body.credential) : null,
        syncCron: body.syncCron ?? null,
        autoTrack: body.autoTrack,
        namePrefix: body.namePrefix ?? null,
        createdBy: actor.userId,
      })
      .returning();
    await audit(ctx, { orgId, actorId: actor.userId, action: 'source.created', targetType: 'source', targetId: row!.id, metadata: { url: body.url, kind: body.kind } });
    if (body.kind !== 'upload') {
      try {
        await syncSource(ctx, row!.id, actor.userId);
      } catch (err) {
        ctx.logger.warn({ err }, 'initial source sync failed');
      }
    }
    return toDto(ctx, (await load(ctx, orgId, row!.id)).source, ns.slug);
  });

  api.op({ method: 'get', path: '/sources/:id', summary: 'Source detail', tags: ['Sources'] }, async ({ ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canReadNamespace(actor, row.namespace)) throw notFound('Source');
    const [snap] = await ctx.db.select().from(sourceSnapshot).where(eq(sourceSnapshot.sourceId, row.source.id)).orderBy(desc(sourceSnapshot.fetchedAt)).limit(1);
    return { ...(await toDto(ctx, row.source, row.namespace.slug)), warnings: snap?.warnings ?? [], canManage: canManageNamespace(actor, row.namespace) };
  });

  api.op(
    {
      method: 'patch',
      path: '/sources/:id',
      summary: 'Update source settings',
      tags: ['Sources'],
      body: createSourceBody.pick({ name: true, ref: true, include: true, exclude: true, syncCron: true, autoTrack: true, namePrefix: true, credential: true }).partial(),
    },
    async ({ ctx, actor, orgId, params, body }) => {
      const row = await load(ctx, orgId, params.id!);
      if (!canManageNamespace(actor, row.namespace)) throw forbidden();
      const { credential, ...rest } = body;
      await ctx.db
        .update(source)
        .set({ ...rest, ...(credential !== undefined ? { credentialEnc: credential ? ctx.secrets.encrypt(credential) : null } : {}), updatedAt: new Date() })
        .where(eq(source.id, row.source.id));
      return { ok: true };
    },
  );

  api.op({ method: 'delete', path: '/sources/:id', summary: 'Remove a source (imported skills stay)', tags: ['Sources'] }, async ({ ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canManageNamespace(actor, row.namespace)) throw forbidden();
    await ctx.db.delete(source).where(eq(source.id, row.source.id));
    await audit(ctx, { orgId, actorId: actor.userId, action: 'source.deleted', targetType: 'source', targetId: row.source.id });
    return { ok: true };
  });

  api.op({ method: 'post', path: '/sources/:id/sync', summary: 'Check the upstream for changes now', tags: ['Sources'] }, async ({ ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canManageNamespace(actor, row.namespace)) throw forbidden();
    return syncSource(ctx, row.source.id, actor.userId);
  });

  api.op({ method: 'post', path: '/sources/:id/upload', summary: 'Upload a repository archive for an upload source', tags: ['Sources'] }, async ({ c, ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canManageNamespace(actor, row.namespace)) throw forbidden();
    if (row.source.kind !== 'upload') throw badRequest('Only upload sources accept archives');
    let bytes: Uint8Array;
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const file = (await c.req.parseBody()).file;
      if (!(file instanceof File)) throw badRequest('Missing "file"');
      bytes = new Uint8Array(await file.arrayBuffer());
    } else bytes = new Uint8Array(await c.req.arrayBuffer());
    await storeSourceUpload(ctx, row.source, bytes);
    return syncSource(ctx, row.source.id, actor.userId);
  });

  api.op({ method: 'get', path: '/sources/:id/items', summary: 'Discovered upstream skills and suites', tags: ['Sources'] }, async ({ ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canReadNamespace(actor, row.namespace)) throw notFound('Source');
    const items = await ctx.db.select().from(sourceItem).where(eq(sourceItem.sourceId, row.source.id)).orderBy(sourceItem.kind, sourceItem.upstreamName);
    return items.map((i) => ({ id: i.id, kind: i.kind, upstreamPath: i.upstreamPath, upstreamName: i.upstreamName, description: i.description, status: i.status, skillId: i.skillId, suiteId: i.suiteId, meta: i.meta }));
  });

  api.op({ method: 'post', path: '/sources/:id/import', summary: 'Import selected skills/suites as local copies', tags: ['Sources'], body: importItemsBody }, async ({ ctx, actor, orgId, params, body }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canManageNamespace(actor, row.namespace)) throw forbidden();
    return { results: await importItems(ctx, row.source.id, body.items, actor.userId) };
  });

  api.op({ method: 'post', path: '/sources/:id/items/:itemId/ignore', summary: 'Ignore a discovered item', tags: ['Sources'] }, async ({ ctx, actor, orgId, params }) => {
    const row = await load(ctx, orgId, params.id!);
    if (!canManageNamespace(actor, row.namespace)) throw forbidden();
    await ctx.db.update(sourceItem).set({ status: 'ignored' }).where(and(eq(sourceItem.id, params.itemId!), eq(sourceItem.sourceId, row.source.id)));
    return { ok: true };
  });

  api.op({ method: 'get', path: '/discover/skills-sh', summary: 'Search the public skills.sh directory', tags: ['Sources'], query: z.object({ q: z.string().min(1) }) }, async ({ query }) =>
    searchSkillsSh(query.q),
  );

  return api;
}
