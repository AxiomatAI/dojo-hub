import { sso } from '@better-auth/sso';
import { orgMember, schema, user as userTable } from '@dojohub/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, count, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decodeJwtPayload, extractGroupClaims, syncUserGroups } from '../services/groups';
import { getOrgId, getSetting } from '../services/org';

export interface SsoProviderMeta {
  preset: string;
  name: string;
  groupsClaim: string;
}

/** Create the org membership for a newly created user (first user / bootstrap email become owner). */
async function onUserCreated(ctx: AppContext, u: { id: string; email: string }) {
  const orgId = await getOrgId(ctx);
  const [{ n }] = (await ctx.db.select({ n: count() }).from(orgMember).where(eq(orgMember.orgId, orgId))) as [
    { n: number },
  ];
  const bootstrap = ctx.config.DOJO_BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  const role = n === 0 || (bootstrap && u.email.toLowerCase() === bootstrap) ? 'owner' : 'member';
  await ctx.db.insert(orgMember).values({ orgId, userId: u.id, role }).onConflictDoNothing();
}

export function createAuth(ctx: AppContext) {
  const { config } = ctx;
  return betterAuth({
    baseURL: config.DOJO_BASE_URL,
    basePath: '/api/auth',
    secret: config.DOJO_SECRET_KEY,
    database: drizzleAdapter(ctx.db, { provider: 'pg', schema }),
    trustedOrigins: [config.DOJO_BASE_URL, 'http://localhost:5173'],
    emailAndPassword: {
      enabled: config.DOJO_AUTH_LOCAL ?? true,
      // Self-registration is closed by default; admins create users or users arrive through SSO.
      disableSignUp: !config.DOJO_ALLOW_SIGNUP,
      minPasswordLength: 10,
    },
    user: { additionalFields: { locale: { type: 'string', required: false } } },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 300 },
    },
    advanced: { cookiePrefix: 'dojohub', useSecureCookies: config.DOJO_BASE_URL.startsWith('https://') },
    databaseHooks: {
      user: {
        create: {
          after: async (u) => {
            await onUserCreated(ctx, u);
          },
        },
      },
    },
    plugins: [
      sso({
        provisionUserOnEveryLogin: true,
        // Users may not register their own providers; admins do it through DojoHub's admin API.
        providersLimit: 0,
        provisionUser: async ({ user, userInfo, token, provider }) => {
          const orgId = await getOrgId(ctx);
          const meta = await getSetting<Record<string, SsoProviderMeta>>(ctx, orgId, 'sso.providers', {});
          const claim = meta[provider.providerId]?.groupsClaim ?? 'groups';
          const claims = { ...decodeJwtPayload(token?.idToken), ...(userInfo as Record<string, unknown>) };
          const groups = extractGroupClaims(claims, claim);
          await ctx.db
            .insert(orgMember)
            .values({ orgId, userId: user.id, role: 'member' })
            .onConflictDoNothing();
          await syncUserGroups(
            ctx,
            orgId,
            user.id,
            groups.map((g) => ({ externalId: g })),
            'claim',
            provider.providerId,
          );
          await ctx.db
            .update(orgMember)
            .set({ lastSeenAt: new Date() })
            .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, user.id)));
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export { userTable };
