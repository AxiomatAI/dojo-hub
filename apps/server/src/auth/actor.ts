import type { NamespaceRole } from '@dojohub/contract';
import { namespace, namespaceMember, orgMember, scimUser, user } from '@dojohub/db';
import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../context';
import { unauthorized } from '../lib/errors';
import { getOrgId } from '../services/org';
import { verifyAccessToken } from '../services/tokens';
import type { Actor } from './permissions';

export type Env = { Variables: { ctx: AppContext; actor: Actor | null; orgId: string } };

export async function loadActor(
  ctx: AppContext,
  userId: string,
  via: Actor['via'],
  scopes: Actor['scopes'],
  tokenId?: string,
): Promise<Actor | null> {
  const orgId = await getOrgId(ctx);
  const [u] = await ctx.db.select().from(user).where(eq(user.id, userId));
  if (!u) return null;
  const [deactivated] = await ctx.db
    .select({ active: scimUser.active })
    .from(scimUser)
    .where(and(eq(scimUser.orgId, orgId), eq(scimUser.userId, userId), eq(scimUser.active, false)));
  if (deactivated) return null;
  let [member] = await ctx.db
    .select()
    .from(orgMember)
    .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, userId)));
  if (!member) {
    [member] = await ctx.db
      .insert(orgMember)
      .values({ orgId, userId, role: 'member' })
      .onConflictDoNothing()
      .returning();
    if (!member) return null;
  }
  const nsRows = await ctx.db
    .select({ id: namespaceMember.namespaceId, role: namespaceMember.role })
    .from(namespaceMember)
    .innerJoin(namespace, eq(namespace.id, namespaceMember.namespaceId))
    .where(and(eq(namespaceMember.userId, userId), eq(namespace.orgId, orgId)));
  return {
    userId,
    orgId,
    email: u.email,
    name: u.name,
    orgRole: member.role,
    ns: new Map(nsRows.map((r) => [r.id, r.role as NamespaceRole])),
    via,
    scopes,
    tokenId,
  };
}

/** Resolve the caller from a PAT (Bearer or git Basic auth) or a Better Auth session cookie. */
export async function resolveActor(ctx: AppContext, headers: Headers): Promise<Actor | null> {
  const authz = headers.get('authorization');
  let secret: string | null = null;
  if (authz?.startsWith('Bearer ')) secret = authz.slice(7).trim();
  else if (authz?.startsWith('Basic ')) {
    const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
    secret = decoded.slice(decoded.indexOf(':') + 1);
  }
  if (secret?.startsWith('dojo_pat_')) {
    const token = await verifyAccessToken(ctx, secret);
    if (!token) return null;
    return loadActor(ctx, token.userId, 'token', token.scopes, token.id);
  }
  const session = await ctx.auth.api.getSession({ headers }).catch(() => null);
  if (!session) return null;
  return loadActor(ctx, session.user.id, 'session', null);
}

export function actorMiddleware(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set('ctx', ctx);
    c.set('orgId', await getOrgId(ctx));
    c.set('actor', await resolveActor(ctx, c.req.raw.headers));
    await next();
  };
}

export function requireActor(c: { get: (k: 'actor') => Actor | null }): Actor {
  const a = c.get('actor');
  if (!a) throw unauthorized();
  return a;
}
