import type { PatScope } from '@dojohub/contract';
import { accessToken } from '@dojohub/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { PAT_PREFIX, randomToken, sha256 } from '../lib/crypto';

export async function createAccessToken(
  ctx: AppContext,
  input: { orgId: string; userId: string; name: string; scopes: PatScope[]; expiresInDays?: number | null; kind?: 'personal' | 'service' | 'cli' },
) {
  const secret = `${PAT_PREFIX}${randomToken(30)}`;
  const [row] = await ctx.db
    .insert(accessToken)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      name: input.name,
      prefix: secret.slice(0, PAT_PREFIX.length + 6),
      tokenHash: sha256(secret),
      scopes: input.scopes,
      kind: input.kind ?? 'personal',
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null,
    })
    .returning();
  return { token: secret, record: row! };
}

export async function verifyAccessToken(ctx: AppContext, secret: string) {
  if (!secret.startsWith(PAT_PREFIX)) return null;
  const [row] = await ctx.db
    .select()
    .from(accessToken)
    .where(and(eq(accessToken.tokenHash, sha256(secret)), isNull(accessToken.revokedAt)));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  // Throttle last-used writes to once a minute.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await ctx.db.update(accessToken).set({ lastUsedAt: new Date() }).where(eq(accessToken.id, row.id));
  }
  return row;
}
