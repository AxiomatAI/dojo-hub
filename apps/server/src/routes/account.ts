import { createTokenBody, type Me, type SetupStatus, setupBody } from '@dojohub/contract';
import {
  accessToken,
  deviceCode,
  llmConfig,
  namespace,
  namespaceMember,
  notification,
  organization,
  orgMember,
  skill,
  ssoProvider,
  user,
} from '@dojohub/db';
import { and, count, desc, eq, gt, ilike, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { loadActor } from '../auth/actor';
import type { SsoProviderMeta } from '../auth/auth';
import { permissionList } from '../auth/permissions';
import type { AppContext } from '../context';
import { Api } from '../lib/api';
import { randomToken, safeEqual, sha256, userCode } from '../lib/crypto';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import { audit } from '../services/audit';
import { ensureOrg, getOrgId, getSetting, resetOrgCache } from '../services/org';
import { createAccessToken } from '../services/tokens';

export const VERSION = process.env.DOJO_VERSION ?? '0.1.0';

/** Create a local (email + password) user through Better Auth's internal adapter. */
export async function createLocalUser(
  ctx: AppContext,
  input: { name: string; email: string; password: string },
) {
  const authCtx = await ctx.auth.$context;
  const existing = await authCtx.internalAdapter.findUserByEmail(input.email.toLowerCase());
  if (existing) throw conflict('A user with this email already exists');
  const created = await authCtx.internalAdapter.createUser(
    { name: input.name, email: input.email.toLowerCase(), emailVerified: true },
    { method: 'admin' },
  );
  await authCtx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: await authCtx.password.hash(input.password),
  });
  return created;
}

export function accountRoutes() {
  const api = new Api();

  api.op(
    {
      method: 'get',
      path: '/setup/status',
      summary: 'Installation and onboarding status',
      tags: ['Setup'],
      public: true,
    },
    async ({ ctx }) => {
      const [{ n: users }] = (await ctx.db.select({ n: count() }).from(user)) as [{ n: number }];
      const [org] = await ctx.db.select().from(organization).limit(1);
      const providers = await ctx.db
        .select({ providerId: ssoProvider.providerId, domain: ssoProvider.domain })
        .from(ssoProvider);
      const orgId = org?.id;
      const meta = orgId
        ? await getSetting<Record<string, SsoProviderMeta>>(ctx, orgId, 'sso.providers', {})
        : {};
      const onboarding = { hasSso: providers.length > 0, hasLlm: false, hasTeam: false, hasSkills: false };
      if (orgId) {
        const [[llm], [teams], [skills]] = await Promise.all([
          ctx.db.select({ n: count() }).from(llmConfig).where(eq(llmConfig.orgId, orgId)),
          ctx.db
            .select({ n: count() })
            .from(namespace)
            .where(and(eq(namespace.orgId, orgId), eq(namespace.kind, 'team'))),
          ctx.db.select({ n: count() }).from(skill).where(eq(skill.orgId, orgId)),
        ]);
        onboarding.hasLlm = (llm?.n ?? 0) > 0;
        onboarding.hasTeam = (teams?.n ?? 0) > 0;
        onboarding.hasSkills = (skills?.n ?? 0) > 0;
      }
      const status: SetupStatus = {
        needsSetup: users === 0,
        orgName: org?.name ?? null,
        localAuth: ctx.config.DOJO_AUTH_LOCAL ?? true,
        ssoProviders: providers.map((p) => ({ ...p, name: meta[p.providerId]?.name ?? p.providerId })),
        version: VERSION,
        onboarding,
      };
      return status;
    },
  );

  api.op(
    {
      method: 'post',
      path: '/setup',
      summary: 'First-run setup: organisation and first administrator',
      tags: ['Setup'],
      public: true,
      body: setupBody,
    },
    async ({ ctx, body }) => {
      const [{ n }] = (await ctx.db.select({ n: count() }).from(user)) as [{ n: number }];
      if (n > 0) throw conflict('DojoHub is already set up');
      if (ctx.config.DOJO_SETUP_TOKEN && !safeEqual(body.token ?? '', ctx.config.DOJO_SETUP_TOKEN))
        throw forbidden('Invalid setup token');
      if (!body.admin) throw badRequest('An administrator account is required');
      resetOrgCache();
      const orgId = await ensureOrg(ctx, body.orgName);
      await ctx.db.update(organization).set({ name: body.orgName }).where(eq(organization.id, orgId));
      await ctx.db
        .update(namespace)
        .set({ displayName: body.orgName })
        .where(and(eq(namespace.orgId, orgId), eq(namespace.kind, 'org')));
      const u = await createLocalUser(ctx, body.admin);
      await ctx.db.update(user).set({ locale: body.locale }).where(eq(user.id, u.id));
      await ctx.db
        .insert(orgMember)
        .values({ orgId, userId: u.id, role: 'owner' })
        .onConflictDoUpdate({ target: [orgMember.orgId, orgMember.userId], set: { role: 'owner' } });
      await audit(ctx, { orgId, actorId: u.id, action: 'setup.completed' });
      return { ok: true };
    },
  );

  api.op(
    { method: 'get', path: '/me', summary: 'Current user, roles and teams', tags: ['Account'] },
    async ({ ctx, actor, orgId }) => {
      const [u] = await ctx.db.select().from(user).where(eq(user.id, actor.userId));
      const [org] = await ctx.db.select().from(organization).where(eq(organization.id, orgId));
      const nss = await ctx.db
        .select({
          id: namespace.id,
          slug: namespace.slug,
          displayName: namespace.displayName,
          role: namespaceMember.role,
        })
        .from(namespaceMember)
        .innerJoin(namespace, eq(namespace.id, namespaceMember.namespaceId))
        .where(and(eq(namespaceMember.userId, actor.userId), isNull(namespace.archivedAt)));
      const me: Me = {
        id: actor.userId,
        name: actor.name,
        email: actor.email,
        image: u?.image ?? null,
        orgId,
        orgName: org?.name ?? '',
        orgSlug: org?.slug ?? '',
        role: actor.orgRole,
        locale: u?.locale ?? null,
        namespaces: nss,
        permissions: permissionList(actor),
      };
      return me;
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/me',
      summary: 'Update profile preferences',
      tags: ['Account'],
      body: z.object({
        locale: z.enum(['en-US', 'en-GB', 'pl']).optional(),
        name: z.string().min(1).max(80).optional(),
      }),
    },
    async ({ ctx, actor, body }) => {
      await ctx.db.update(user).set(body).where(eq(user.id, actor.userId));
      return { ok: true };
    },
  );

  api.op(
    { method: 'get', path: '/tokens', summary: 'My access tokens', tags: ['Account'] },
    async ({ ctx, actor }) => {
      const rows = await ctx.db
        .select()
        .from(accessToken)
        .where(and(eq(accessToken.userId, actor.userId), isNull(accessToken.revokedAt)))
        .orderBy(desc(accessToken.createdAt));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        kind: r.kind,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/tokens',
      summary: 'Create a personal access token',
      tags: ['Account'],
      body: createTokenBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      if (actor.via === 'token') throw forbidden('Tokens cannot mint other tokens');
      if (body.scopes.includes('admin') && !['owner', 'admin'].includes(actor.orgRole))
        throw forbidden('Only administrators can create admin tokens');
      const { token, record } = await createAccessToken(ctx, {
        orgId,
        userId: actor.userId,
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
      });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'token.created',
        targetType: 'access_token',
        targetId: record.id,
        metadata: { scopes: body.scopes },
      });
      return { token, id: record.id, prefix: record.prefix };
    },
  );

  api.op(
    { method: 'delete', path: '/tokens/:id', summary: 'Revoke a token', tags: ['Account'] },
    async ({ ctx, actor, orgId, params }) => {
      const res = await ctx.db
        .update(accessToken)
        .set({ revokedAt: new Date() })
        .where(and(eq(accessToken.id, params.id!), eq(accessToken.userId, actor.userId)))
        .returning({ id: accessToken.id });
      if (!res.length) throw notFound('Token');
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'token.revoked',
        targetType: 'access_token',
        targetId: params.id,
      });
      return { ok: true };
    },
  );

  // ── OAuth 2.0 device authorization grant (RFC 8628) for `dojo login` ──
  api.op(
    {
      method: 'post',
      path: '/cli/device',
      summary: 'Start a CLI device login',
      tags: ['CLI'],
      public: true,
      body: z.object({ clientName: z.string().max(80).default('dojo CLI') }),
    },
    async ({ ctx, body }) => {
      const device = randomToken(32);
      const code = userCode();
      await ctx.db.insert(deviceCode).values({
        deviceCodeHash: sha256(device),
        userCode: code,
        clientName: body.clientName,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      const base = ctx.config.DOJO_BASE_URL;
      return {
        deviceCode: device,
        userCode: code,
        verificationUri: `${base}/device`,
        verificationUriComplete: `${base}/device?code=${code}`,
        expiresIn: 600,
        interval: 3,
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/cli/token',
      summary: 'Poll for the CLI token',
      tags: ['CLI'],
      public: true,
      body: z.object({ deviceCode: z.string() }),
    },
    async ({ c, ctx, body }) => {
      const [row] = await ctx.db
        .select()
        .from(deviceCode)
        .where(eq(deviceCode.deviceCodeHash, sha256(body.deviceCode)));
      if (!row) return c.json({ error: 'invalid_grant' }, 400);
      if (row.expiresAt.getTime() < Date.now()) return c.json({ error: 'expired_token' }, 400);
      if (row.lastPolledAt && Date.now() - row.lastPolledAt.getTime() < 2000)
        return c.json({ error: 'slow_down' }, 400);
      await ctx.db
        .update(deviceCode)
        .set({ lastPolledAt: new Date() })
        .where(eq(deviceCode.deviceCodeHash, row.deviceCodeHash));
      if (row.status === 'pending') return c.json({ error: 'authorization_pending' }, 400);
      if (row.status === 'denied') return c.json({ error: 'access_denied' }, 400);
      if (row.status === 'consumed') return c.json({ error: 'invalid_grant' }, 400);
      const consumed = await ctx.db
        .update(deviceCode)
        .set({ status: 'consumed' })
        .where(and(eq(deviceCode.deviceCodeHash, row.deviceCodeHash), eq(deviceCode.status, 'approved')))
        .returning();
      if (!consumed.length || !row.userId || !row.orgId) return c.json({ error: 'invalid_grant' }, 400);
      const { token } = await createAccessToken(ctx, {
        orgId: row.orgId,
        userId: row.userId,
        name: row.clientName,
        scopes: ['read', 'install', 'submit'],
        expiresInDays: 365,
        kind: 'cli',
      });
      const [u] = await ctx.db.select().from(user).where(eq(user.id, row.userId));
      return { accessToken: token, tokenType: 'Bearer', user: { id: u!.id, name: u!.name, email: u!.email } };
    },
  );

  api.op(
    { method: 'get', path: '/cli/device/:code', summary: 'Look up a pending device login', tags: ['CLI'] },
    async ({ ctx, params }) => {
      const [row] = await ctx.db
        .select()
        .from(deviceCode)
        .where(
          and(eq(deviceCode.userCode, params.code!.toUpperCase()), gt(deviceCode.expiresAt, new Date())),
        );
      if (!row || row.status !== 'pending') throw notFound('Device code');
      return { clientName: row.clientName, userCode: row.userCode, createdAt: row.createdAt };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/cli/device/approve',
      summary: 'Approve or deny a device login',
      tags: ['CLI'],
      body: z.object({ userCode: z.string(), approve: z.boolean() }),
    },
    async ({ ctx, actor, orgId, body }) => {
      if (actor.via !== 'session') throw forbidden('Approve device logins from the web app');
      const res = await ctx.db
        .update(deviceCode)
        .set({ status: body.approve ? 'approved' : 'denied', userId: actor.userId, orgId })
        .where(
          and(
            eq(deviceCode.userCode, body.userCode.toUpperCase()),
            eq(deviceCode.status, 'pending'),
            gt(deviceCode.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!res.length) throw notFound('Device code');
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: body.approve ? 'cli.login_approved' : 'cli.login_denied',
        metadata: { client: res[0]!.clientName },
      });
      return { ok: true };
    },
  );

  api.op(
    { method: 'get', path: '/notifications', summary: 'My notifications', tags: ['Account'] },
    async ({ ctx, actor }) => {
      const rows = await ctx.db
        .select()
        .from(notification)
        .where(eq(notification.userId, actor.userId))
        .orderBy(desc(notification.createdAt))
        .limit(50);
      return rows;
    },
  );

  api.op(
    {
      method: 'post',
      path: '/notifications/read',
      summary: 'Mark notifications as read',
      tags: ['Account'],
      body: z.object({ ids: z.array(z.string()).optional() }),
    },
    async ({ ctx, actor, body }) => {
      const where = body.ids?.length
        ? and(eq(notification.userId, actor.userId), or(...body.ids.map((id) => eq(notification.id, id))))
        : eq(notification.userId, actor.userId);
      await ctx.db.update(notification).set({ readAt: new Date() }).where(where);
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/users',
      summary: 'Search organisation members',
      tags: ['Account'],
      query: z.object({ q: z.string().optional() }),
    },
    async ({ ctx, orgId, query }) => {
      const like = `%${query.q ?? ''}%`;
      return ctx.db
        .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: orgMember.role })
        .from(orgMember)
        .innerJoin(user, eq(user.id, orgMember.userId))
        .where(and(eq(orgMember.orgId, orgId), or(ilike(user.name, like), ilike(user.email, like))))
        .orderBy(user.name)
        .limit(50);
    },
  );

  return api;
}

export { AppError, getOrgId, loadActor, unauthorized };
