import { NAMESPACE_ROLES, ORG_ROLES, type NamespaceRole, type OrgRole } from '@dojohub/contract';
import { groupMapping, groupMembership, idpGroup, namespaceMember, orgMember } from '@dojohub/db';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { AppContext } from '../context';

type GroupSource = 'claim' | 'scim' | 'directory_sync' | 'manual';

/** Org roles ordered from most to least privileged. */
const ORG_RANK: OrgRole[] = ['owner', 'admin', 'security_reviewer', 'auditor', 'member'];
const NS_RANK: NamespaceRole[] = ['owner', 'maintainer', 'reviewer', 'member'];

export async function upsertGroups(
  ctx: AppContext,
  orgId: string,
  groups: { externalId: string; displayName?: string }[],
  source: GroupSource,
  providerId?: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const g of groups) {
    const [row] = await ctx.db
      .insert(idpGroup)
      .values({ orgId, externalId: g.externalId, displayName: g.displayName ?? g.externalId, source, providerId })
      .onConflictDoUpdate({
        target: [idpGroup.orgId, idpGroup.externalId],
        set: g.displayName ? { displayName: g.displayName } : { externalId: g.externalId },
      })
      .returning({ id: idpGroup.id });
    ids.set(g.externalId, row!.id);
  }
  return ids;
}

/** Replace a user's memberships from one source (claims, SCIM, directory sync) and re-apply role mappings. */
export async function syncUserGroups(
  ctx: AppContext,
  orgId: string,
  userId: string,
  groups: { externalId: string; displayName?: string }[],
  source: GroupSource,
  providerId?: string,
) {
  const ids = await upsertGroups(ctx, orgId, groups, source, providerId);
  const groupIds = [...ids.values()];
  await ctx.db.transaction(async (tx) => {
    const existing = await tx
      .select({ groupId: groupMembership.groupId })
      .from(groupMembership)
      .where(and(eq(groupMembership.userId, userId), eq(groupMembership.source, source)));
    const stale = existing.map((e) => e.groupId).filter((g) => !groupIds.includes(g));
    if (stale.length) {
      await tx
        .delete(groupMembership)
        .where(and(eq(groupMembership.userId, userId), eq(groupMembership.source, source), inArray(groupMembership.groupId, stale)));
    }
    for (const gid of groupIds) {
      await tx
        .insert(groupMembership)
        .values({ groupId: gid, userId, source })
        .onConflictDoUpdate({ target: [groupMembership.groupId, groupMembership.userId], set: { syncedAt: new Date(), source } });
    }
  });
  await applyGroupMappings(ctx, orgId, userId);
}

/** Recompute managed org role + namespace memberships from IdP group mappings. */
export async function applyGroupMappings(ctx: AppContext, orgId: string, userId: string) {
  const memberships = await ctx.db
    .select({ groupId: groupMembership.groupId })
    .from(groupMembership)
    .innerJoin(idpGroup, eq(idpGroup.id, groupMembership.groupId))
    .where(and(eq(groupMembership.userId, userId), eq(idpGroup.orgId, orgId)));
  const groupIds = memberships.map((m) => m.groupId);
  const mappings = groupIds.length
    ? await ctx.db.select().from(groupMapping).where(and(eq(groupMapping.orgId, orgId), inArray(groupMapping.groupId, groupIds)))
    : [];

  // Org role
  const orgRoles = mappings.filter((m) => !m.namespaceId && m.orgRole).map((m) => m.orgRole!);
  const [current] = await ctx.db
    .select()
    .from(orgMember)
    .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, userId)));
  if (current) {
    const mapped = ORG_RANK.find((r) => orgRoles.includes(r));
    if (mapped && mapped !== current.role && (current.managed || ORG_RANK.indexOf(mapped) < ORG_RANK.indexOf(current.role))) {
      await ctx.db
        .update(orgMember)
        .set({ role: mapped, managed: true })
        .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, userId)));
    } else if (!mapped && current.managed && current.role !== 'member') {
      await ctx.db
        .update(orgMember)
        .set({ role: 'member', managed: false })
        .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, userId)));
    }
  }

  // Namespace memberships
  const best = new Map<string, NamespaceRole>();
  for (const m of mappings) {
    if (!m.namespaceId || !m.namespaceRole) continue;
    const prev = best.get(m.namespaceId);
    if (!prev || NS_RANK.indexOf(m.namespaceRole) < NS_RANK.indexOf(prev)) best.set(m.namespaceId, m.namespaceRole);
  }
  const managed = await ctx.db
    .select()
    .from(namespaceMember)
    .where(and(eq(namespaceMember.userId, userId), eq(namespaceMember.managed, true)));
  for (const row of managed) {
    if (!best.has(row.namespaceId)) {
      await ctx.db
        .delete(namespaceMember)
        .where(and(eq(namespaceMember.namespaceId, row.namespaceId), eq(namespaceMember.userId, userId)));
    }
  }
  for (const [namespaceId, role] of best) {
    const [existing] = await ctx.db
      .select()
      .from(namespaceMember)
      .where(and(eq(namespaceMember.namespaceId, namespaceId), eq(namespaceMember.userId, userId)));
    if (!existing) await ctx.db.insert(namespaceMember).values({ namespaceId, userId, role, managed: true });
    else if (existing.managed && existing.role !== role) {
      await ctx.db
        .update(namespaceMember)
        .set({ role })
        .where(and(eq(namespaceMember.namespaceId, namespaceId), eq(namespaceMember.userId, userId)));
    } else if (!existing.managed && NS_RANK.indexOf(role) < NS_RANK.indexOf(existing.role)) {
      await ctx.db
        .update(namespaceMember)
        .set({ role, managed: true })
        .where(and(eq(namespaceMember.namespaceId, namespaceId), eq(namespaceMember.userId, userId)));
    }
  }
}

/** Re-apply mappings for every member of a group (after mapping changes). */
export async function reapplyForGroup(ctx: AppContext, orgId: string, groupId: string) {
  const users = await ctx.db.select({ userId: groupMembership.userId }).from(groupMembership).where(eq(groupMembership.groupId, groupId));
  for (const u of users) await applyGroupMappings(ctx, orgId, u.userId);
}

export function extractGroupClaims(claims: Record<string, unknown>, claimPath: string): string[] {
  const value = claimPath.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), claims);
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') v.split(/[,\s]+/).filter(Boolean).forEach((s) => out.add(s));
    else if (Array.isArray(v)) v.forEach(add);
  };
  add(value);
  // Entra app roles arrive in `roles`; treat them as groups too.
  if (claimPath === 'groups') add(claims.roles);
  return [...out];
}

export function decodeJwtPayload(token: string | undefined | null): Record<string, unknown> {
  if (!token) return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export { NAMESPACE_ROLES, ORG_ROLES, notInArray };
