import type { NamespaceRole } from '@dojohub/contract';
import { catalogEntry, namespace, namespaceMember, skill } from '@dojohub/db';
import { and, count, eq, isNull } from 'drizzle-orm';
import { type Actor, canReadNamespace } from '../auth/permissions';
import type { AppContext } from '../context';
import { forbidden, notFound } from '../lib/errors';

export type NamespaceRow = typeof namespace.$inferSelect;

export async function getNamespace(ctx: AppContext, orgId: string, slugOrId: string): Promise<NamespaceRow> {
  const slug = slugOrId.replace(/^@/, '');
  const [row] = await ctx.db
    .select()
    .from(namespace)
    .where(and(eq(namespace.orgId, orgId), eq(namespace.slug, slug), isNull(namespace.archivedAt)));
  if (row) return row;
  const [byId] = await ctx.db
    .select()
    .from(namespace)
    .where(and(eq(namespace.orgId, orgId), eq(namespace.id, slug)));
  if (!byId) throw notFound('Namespace');
  return byId;
}

export async function getReadableNamespace(
  ctx: AppContext,
  actor: Actor | null,
  orgId: string,
  slug: string,
) {
  const ns = await getNamespace(ctx, orgId, slug);
  if (!canReadNamespace(actor, ns)) throw actor ? forbidden() : notFound('Namespace');
  return ns;
}

export async function listNamespaces(ctx: AppContext, actor: Actor | null, orgId: string) {
  const rows = await ctx.db
    .select()
    .from(namespace)
    .where(and(eq(namespace.orgId, orgId), isNull(namespace.archivedAt)))
    .orderBy(namespace.kind, namespace.displayName);
  const visible = rows.filter((r) => canReadNamespace(actor, r));
  const out = [];
  for (const ns of visible) {
    const [[m], [s], [c]] = await Promise.all([
      ctx.db.select({ n: count() }).from(namespaceMember).where(eq(namespaceMember.namespaceId, ns.id)),
      ctx.db
        .select({ n: count() })
        .from(skill)
        .where(and(eq(skill.namespaceId, ns.id), isNull(skill.archivedAt))),
      ctx.db.select({ n: count() }).from(catalogEntry).where(eq(catalogEntry.namespaceId, ns.id)),
    ]);
    out.push({
      id: ns.id,
      slug: ns.slug,
      kind: ns.kind,
      displayName: ns.displayName,
      description: ns.description,
      visibility: ns.visibility,
      color: ns.color,
      memberCount: m?.n ?? 0,
      skillCount: s?.n ?? 0,
      catalogCount: c?.n ?? 0,
      myRole: (actor?.ns.get(ns.id) as NamespaceRole | undefined) ?? null,
    });
  }
  return out;
}
