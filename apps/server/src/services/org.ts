import { DEFAULT_POLICY } from '@dojohub/contract';
import { namespace, organization, policy, setting } from '@dojohub/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';

let cachedOrgId: string | null = null;

/** Self-hosted installs run a single organisation; the schema is tenant-ready (org_id everywhere). */
export async function getOrgId(ctx: AppContext): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const [org] = await ctx.db.select({ id: organization.id }).from(organization).limit(1);
  if (org) {
    cachedOrgId = org.id;
    return org.id;
  }
  return ensureOrg(ctx, ctx.config.DOJO_ORG_NAME);
}

export function resetOrgCache() {
  cachedOrgId = null;
}

export async function ensureOrg(ctx: AppContext, name: string): Promise<string> {
  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: organization.id }).from(organization).limit(1);
    if (existing) return existing.id;
    const [org] = await tx
      .insert(organization)
      .values({ slug: 'default', name })
      .returning({ id: organization.id });
    const orgId = org!.id;
    await tx.insert(namespace).values({
      orgId,
      slug: 'org',
      kind: 'org',
      displayName: name,
      description: 'Organisation-wide skills available to everyone.',
      visibility: 'internal',
    });
    await tx.insert(policy).values({ orgId, namespaceId: null, document: DEFAULT_POLICY });
    cachedOrgId = orgId;
    return orgId;
  });
}

export async function getSetting<T>(ctx: AppContext, orgId: string, key: string, fallback: T): Promise<T> {
  const [row] = await ctx.db
    .select({ value: setting.value })
    .from(setting)
    .where(and(eq(setting.orgId, orgId), eq(setting.key, key)));
  return (row?.value as T | undefined) ?? fallback;
}

export async function putSetting(ctx: AppContext, orgId: string, key: string, value: unknown) {
  await ctx.db
    .insert(setting)
    .values({ orgId, key, value })
    .onConflictDoUpdate({ target: [setting.orgId, setting.key], set: { value, updatedAt: new Date() } });
}
