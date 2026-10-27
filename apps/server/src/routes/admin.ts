import {
  decisionModelBody,
  groupMappingBody,
  llmConfigBody,
  orgRole,
  policyBody,
  ssoProviderBody,
  webhookBody,
} from '@dojohub/contract';
import {
  auditLog,
  decisionModel,
  directorySync,
  groupMapping,
  groupMembership,
  idpGroup,
  llmConfig,
  namespace,
  organization,
  orgMember,
  policy,
  scimToken,
  ssoProvider,
  user,
  webhook,
  webhookDelivery,
} from '@dojohub/db';
import { createLanguageModel, loadRulePack } from '@dojohub/scanner';
import { generateText } from 'ai';
import { and, count, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { SsoProviderMeta } from '../auth/auth';
import { type Actor, canReadAudit, isOrgAdmin } from '../auth/permissions';
import type { AppContext } from '../context';
import { Api } from '../lib/api';
import { randomToken, SCIM_PREFIX, sha256 } from '../lib/crypto';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { usersById } from '../services/dto';
import { reapplyForGroup, upsertGroups } from '../services/groups';
import { getSetting, putSetting } from '../services/org';
import { validateCondition } from '../services/policy';
import { createLocalUser } from './account';

const requireAdmin = (a: Actor) => {
  if (!isOrgAdmin(a)) throw forbidden('Administrator role required');
};

const PRESET_ISSUERS: Record<string, (domain: string) => string> = {
  google: () => 'https://accounts.google.com',
};

async function discoverOidc(issuer: string, discoveryUrl?: string) {
  const url = discoveryUrl ?? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((err: Error) => {
    throw new AppError(502, 'discovery_failed', `Could not reach ${url}: ${err.message}`);
  });
  if (!res.ok)
    throw new AppError(502, 'discovery_failed', `Discovery document returned HTTP ${res.status} (${url})`);
  const doc = (await res.json()) as Record<string, string>;
  if (!doc.authorization_endpoint || !doc.token_endpoint)
    throw new AppError(502, 'discovery_failed', 'Discovery document is missing endpoints');
  return { url, doc };
}

export function adminRoutes() {
  const api = new Api();

  // ── Organisation & members ──
  api.op(
    { method: 'get', path: '/admin/members', summary: 'Organisation members', tags: ['Admin'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      return ctx.db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: orgMember.role,
          managed: orgMember.managed,
          lastSeenAt: orgMember.lastSeenAt,
          createdAt: orgMember.createdAt,
        })
        .from(orgMember)
        .innerJoin(user, eq(user.id, orgMember.userId))
        .where(eq(orgMember.orgId, orgId))
        .orderBy(user.name);
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/admin/members/:userId',
      summary: 'Change an organisation role',
      tags: ['Admin'],
      body: z.object({ role: orgRole }),
    },
    async ({ ctx, actor, orgId, params, body }) => {
      requireAdmin(actor);
      if (params.userId === actor.userId && body.role !== 'owner' && actor.orgRole === 'owner') {
        const [{ n }] = (await ctx.db
          .select({ n: count() })
          .from(orgMember)
          .where(and(eq(orgMember.orgId, orgId), eq(orgMember.role, 'owner')))) as [{ n: number }];
        if (n <= 1) throw badRequest('The last owner cannot be demoted');
      }
      if (body.role === 'owner' && actor.orgRole !== 'owner')
        throw forbidden('Only owners can grant ownership');
      await ctx.db
        .update(orgMember)
        .set({ role: body.role, managed: false })
        .where(and(eq(orgMember.orgId, orgId), eq(orgMember.userId, params.userId!)));
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'member.role_changed',
        targetType: 'user',
        targetId: params.userId,
        metadata: body,
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/users',
      summary: 'Create a local user (non-SSO)',
      tags: ['Admin'],
      body: z.object({
        name: z.string().min(1),
        email: z.email(),
        password: z.string().min(10),
        role: orgRole.default('member'),
      }),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      if (!ctx.config.DOJO_AUTH_LOCAL)
        throw badRequest('Local accounts are disabled (DOJO_AUTH_LOCAL=false)');
      const u = await createLocalUser(ctx, body);
      await ctx.db
        .insert(orgMember)
        .values({ orgId, userId: u.id, role: body.role })
        .onConflictDoUpdate({ target: [orgMember.orgId, orgMember.userId], set: { role: body.role } });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'user.created',
        targetType: 'user',
        targetId: u.id,
      });
      return { id: u.id };
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/admin/org',
      summary: 'Rename the organisation',
      tags: ['Admin'],
      body: z.object({ name: z.string().min(1).max(80) }),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      await ctx.db.update(organization).set({ name: body.name }).where(eq(organization.id, orgId));
      return { ok: true };
    },
  );

  // ── SSO ──
  api.op(
    { method: 'get', path: '/admin/sso', summary: 'Configured SSO providers', tags: ['Admin: SSO'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const rows = await ctx.db.select().from(ssoProvider);
      const meta = await getSetting<Record<string, SsoProviderMeta>>(ctx, orgId, 'sso.providers', {});
      return rows.map((r) => ({
        providerId: r.providerId,
        domain: r.domain,
        issuer: r.issuer,
        type: r.samlConfig ? 'saml' : 'oidc',
        preset: meta[r.providerId]?.preset ?? 'oidc',
        name: meta[r.providerId]?.name ?? r.providerId,
        groupsClaim: meta[r.providerId]?.groupsClaim ?? 'groups',
        callbackUrl: r.samlConfig
          ? `${ctx.config.DOJO_BASE_URL}/api/auth/sso/saml2/callback/${r.providerId}`
          : `${ctx.config.DOJO_BASE_URL}/api/auth/sso/callback/${r.providerId}`,
      }));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/sso/test',
      summary: 'Validate an OIDC issuer (discovery)',
      tags: ['Admin: SSO'],
      body: z.object({ issuer: z.string(), discoveryUrl: z.string().optional() }),
    },
    async ({ actor, body }) => {
      requireAdmin(actor);
      const { url, doc } = await discoverOidc(body.issuer, body.discoveryUrl);
      return {
        ok: true,
        discoveryUrl: url,
        issuer: doc.issuer,
        claims: doc.claims_supported ?? [],
        scopes: doc.scopes_supported ?? [],
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/sso',
      summary: 'Add an SSO provider from a preset',
      tags: ['Admin: SSO'],
      body: ssoProviderBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const base = ctx.config.DOJO_BASE_URL;
      const name = {
        entra: 'Microsoft Entra ID',
        google: 'Google Workspace',
        okta: 'Okta',
        auth0: 'Auth0',
        keycloak: 'Keycloak',
        oidc: 'OpenID Connect',
        saml: 'SAML',
      }[body.preset];
      let oidcConfig: string | null = null;
      let samlConfig: string | null = null;
      const issuer = PRESET_ISSUERS[body.preset]?.(body.domain) ?? body.issuer;
      if (body.preset === 'saml') {
        if (!body.samlEntryPoint || !body.samlCert)
          throw badRequest('SAML requires an SSO URL and signing certificate');
        samlConfig = JSON.stringify({
          issuer: `${base}/api/auth/sso/saml2/sp/metadata?providerId=${body.providerId}`,
          entryPoint: body.samlEntryPoint,
          cert: body.samlCert,
          callbackUrl: `${base}/api/auth/sso/saml2/callback/${body.providerId}`,
          audience: `${base}/api/auth/sso/saml2/sp/metadata?providerId=${body.providerId}`,
          idpMetadata: {
            entityID: body.issuer,
            cert: body.samlCert,
            singleSignOnService: [
              {
                Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
                Location: body.samlEntryPoint,
              },
            ],
          },
          mapping: {
            email: 'email',
            name: 'displayName',
            firstName: 'givenName',
            lastName: 'surname',
            extraFields: { groups: body.groupsClaim },
          },
        });
      } else {
        if (!body.clientId || !body.clientSecret) throw badRequest('Client ID and secret are required');
        const { url, doc } = await discoverOidc(issuer, body.discoveryUrl);
        oidcConfig = JSON.stringify({
          issuer: doc.issuer ?? issuer,
          pkce: true,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          discoveryEndpoint: url,
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          userInfoEndpoint: doc.userinfo_endpoint,
          jwksEndpoint: doc.jwks_uri,
          tokenEndpointAuthentication: 'client_secret_post',
          scopes: ['openid', 'email', 'profile', ...(body.preset === 'okta' ? ['groups'] : [])],
          mapping: {
            email: 'email',
            name: 'name',
            image: 'picture',
            extraFields: { groups: body.groupsClaim },
          },
        });
      }
      await ctx.db
        .insert(ssoProvider)
        .values({
          id: crypto.randomUUID(),
          issuer,
          oidcConfig,
          samlConfig,
          userId: actor.userId,
          providerId: body.providerId,
          domain: body.domain.toLowerCase(),
        })
        .onConflictDoUpdate({
          target: ssoProvider.providerId,
          set: { issuer, oidcConfig, samlConfig, domain: body.domain.toLowerCase() },
        });
      const meta = await getSetting<Record<string, SsoProviderMeta>>(ctx, orgId, 'sso.providers', {});
      meta[body.providerId] = { preset: body.preset, name, groupsClaim: body.groupsClaim };
      await putSetting(ctx, orgId, 'sso.providers', meta);
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'sso.provider_saved',
        targetType: 'sso_provider',
        targetId: body.providerId,
        metadata: { preset: body.preset, domain: body.domain },
      });
      return {
        ok: true,
        callbackUrl: samlConfig
          ? `${base}/api/auth/sso/saml2/callback/${body.providerId}`
          : `${base}/api/auth/sso/callback/${body.providerId}`,
      };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/sso/:providerId',
      summary: 'Remove an SSO provider',
      tags: ['Admin: SSO'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      await ctx.db.delete(ssoProvider).where(eq(ssoProvider.providerId, params.providerId!));
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'sso.provider_deleted',
        targetType: 'sso_provider',
        targetId: params.providerId,
      });
      return { ok: true };
    },
  );

  // ── Groups & mappings ──
  api.op(
    { method: 'get', path: '/admin/groups', summary: 'IdP groups known to DojoHub', tags: ['Admin: Access'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const groups = await ctx.db
        .select()
        .from(idpGroup)
        .where(eq(idpGroup.orgId, orgId))
        .orderBy(idpGroup.displayName);
      const counts = await ctx.db
        .select({ groupId: groupMembership.groupId, n: count() })
        .from(groupMembership)
        .groupBy(groupMembership.groupId);
      return groups.map((g) => ({ ...g, members: counts.find((c) => c.groupId === g.id)?.n ?? 0 }));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/groups',
      summary: 'Register a group by its IdP id (before anyone logs in)',
      tags: ['Admin: Access'],
      body: z.object({ externalId: z.string().min(1), displayName: z.string().optional() }),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const ids = await upsertGroups(ctx, orgId, [body], 'manual');
      return { id: ids.get(body.externalId) };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/admin/group-mappings',
      summary: 'Group → role mappings',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      return ctx.db
        .select({
          id: groupMapping.id,
          groupId: groupMapping.groupId,
          group: idpGroup.displayName,
          externalId: idpGroup.externalId,
          namespaceId: groupMapping.namespaceId,
          namespace: namespace.slug,
          orgRole: groupMapping.orgRole,
          namespaceRole: groupMapping.namespaceRole,
        })
        .from(groupMapping)
        .innerJoin(idpGroup, eq(idpGroup.id, groupMapping.groupId))
        .leftJoin(namespace, eq(namespace.id, groupMapping.namespaceId))
        .where(eq(groupMapping.orgId, orgId));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/group-mappings',
      summary: 'Map a group to an org or team role',
      tags: ['Admin: Access'],
      body: groupMappingBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      if (!body.namespaceId && !body.orgRole) throw badRequest('Choose an organisation role or a team role');
      if (body.namespaceId && !body.namespaceRole) throw badRequest('Choose a team role');
      const [row] = await ctx.db
        .insert(groupMapping)
        .values({
          orgId,
          groupId: body.groupId,
          namespaceId: body.namespaceId ?? null,
          orgRole: body.namespaceId ? null : (body.orgRole ?? null),
          namespaceRole: body.namespaceId ? (body.namespaceRole ?? null) : null,
        })
        .returning();
      await reapplyForGroup(ctx, orgId, body.groupId);
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'group_mapping.created',
        targetType: 'group_mapping',
        targetId: row!.id,
        metadata: body,
      });
      return row;
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/group-mappings/:id',
      summary: 'Delete a group mapping',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      const [row] = await ctx.db
        .delete(groupMapping)
        .where(and(eq(groupMapping.orgId, orgId), eq(groupMapping.id, params.id!)))
        .returning();
      if (row) await reapplyForGroup(ctx, orgId, row.groupId);
      return { ok: true };
    },
  );

  // ── SCIM tokens ──
  api.op(
    {
      method: 'get',
      path: '/admin/scim-tokens',
      summary: 'SCIM provisioning tokens',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const rows = await ctx.db
        .select()
        .from(scimToken)
        .where(and(eq(scimToken.orgId, orgId), isNull(scimToken.revokedAt)));
      return {
        endpoint: `${ctx.config.DOJO_BASE_URL}/scim/v2`,
        tokens: rows.map((r) => ({
          id: r.id,
          name: r.name,
          lastUsedAt: r.lastUsedAt,
          createdAt: r.createdAt,
        })),
      };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/scim-tokens',
      summary: 'Create a SCIM token',
      tags: ['Admin: Access'],
      body: z.object({ name: z.string().min(1) }),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const token = `${SCIM_PREFIX}${randomToken(30)}`;
      await ctx.db.insert(scimToken).values({ orgId, name: body.name, tokenHash: sha256(token) });
      await audit(ctx, { orgId, actorId: actor.userId, action: 'scim.token_created' });
      return { token, endpoint: `${ctx.config.DOJO_BASE_URL}/scim/v2` };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/scim-tokens/:id',
      summary: 'Revoke a SCIM token',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      await ctx.db
        .update(scimToken)
        .set({ revokedAt: new Date() })
        .where(and(eq(scimToken.orgId, orgId), eq(scimToken.id, params.id!)));
      return { ok: true };
    },
  );

  // ── Directory sync (Microsoft Graph / Google Admin SDK) ──
  api.op(
    {
      method: 'get',
      path: '/admin/directory-sync',
      summary: 'Directory sync connections',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const rows = await ctx.db.select().from(directorySync).where(eq(directorySync.orgId, orgId));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        enabled: r.enabled,
        lastRunAt: r.lastRunAt,
        lastStatus: r.lastStatus,
      }));
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/directory-sync',
      summary: 'Configure a directory sync connection',
      tags: ['Admin: Access'],
      body: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('microsoft_graph'),
          tenantId: z.string(),
          clientId: z.string(),
          clientSecret: z.string(),
          groupFilter: z.string().optional(),
        }),
        z.object({
          kind: z.literal('google_directory'),
          serviceAccountJson: z.string(),
          adminEmail: z.email(),
          domain: z.string(),
        }),
      ]),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const [row] = await ctx.db
        .insert(directorySync)
        .values({ orgId, kind: body.kind, configEnc: ctx.secrets.encrypt(JSON.stringify(body)) })
        .returning();
      await ctx.jobs.send('directory.sync', { id: row!.id });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'directory_sync.created',
        metadata: { kind: body.kind },
      });
      return { id: row!.id };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/directory-sync/:id/run',
      summary: 'Run a directory sync now',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, params }) => {
      requireAdmin(actor);
      await ctx.jobs.send('directory.sync', { id: params.id });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/directory-sync/:id',
      summary: 'Remove a directory sync connection',
      tags: ['Admin: Access'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      await ctx.db
        .delete(directorySync)
        .where(and(eq(directorySync.orgId, orgId), eq(directorySync.id, params.id!)));
      return { ok: true };
    },
  );

  // ── LLM (BYOK) & decision model ──
  api.op(
    {
      method: 'get',
      path: '/admin/llm',
      summary: 'LLM provider configuration (BYOK)',
      tags: ['Admin: Verification'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const rows = await ctx.db.select().from(llmConfig).where(eq(llmConfig.orgId, orgId));
      return rows.map((r) => ({
        purpose: r.purpose,
        provider: r.provider,
        model: r.model,
        baseUrl: r.baseUrl,
        hasKey: !!r.apiKeyEnc,
        options: r.options,
        enabled: r.enabled,
      }));
    },
  );

  api.op(
    {
      method: 'put',
      path: '/admin/llm',
      summary: 'Save LLM provider configuration',
      tags: ['Admin: Verification'],
      body: llmConfigBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const [existing] = await ctx.db
        .select()
        .from(llmConfig)
        .where(and(eq(llmConfig.orgId, orgId), eq(llmConfig.purpose, body.purpose)));
      const apiKeyEnc = body.apiKey ? ctx.secrets.encrypt(body.apiKey) : (existing?.apiKeyEnc ?? null);
      const values = {
        orgId,
        purpose: body.purpose,
        provider: body.provider,
        model: body.model,
        baseUrl: body.baseUrl ?? null,
        apiKeyEnc,
        options: body.options,
        enabled: body.enabled,
      };
      await ctx.db
        .insert(llmConfig)
        .values(values)
        .onConflictDoUpdate({
          target: [llmConfig.orgId, llmConfig.purpose],
          set: { ...values, updatedAt: new Date() },
        });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'llm.config_saved',
        metadata: { purpose: body.purpose, provider: body.provider, model: body.model },
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/llm/:purpose',
      summary: 'Remove an LLM configuration',
      tags: ['Admin: Verification'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      await ctx.db
        .delete(llmConfig)
        .where(and(eq(llmConfig.orgId, orgId), eq(llmConfig.purpose, params.purpose as 'judge')));
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/llm/test',
      summary: 'Send a test prompt with the judge model',
      tags: ['Admin: Verification'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const [cfg] = await ctx.db
        .select()
        .from(llmConfig)
        .where(and(eq(llmConfig.orgId, orgId), eq(llmConfig.purpose, 'judge')));
      if (!cfg) throw notFound('Judge model configuration');
      const started = Date.now();
      try {
        const model = await createLanguageModel({
          provider: cfg.provider,
          model: cfg.model,
          apiKey: ctx.secrets.decryptOrNull(cfg.apiKeyEnc),
          baseUrl: cfg.baseUrl,
          options: cfg.options,
        });
        const res = await generateText({
          model,
          prompt: 'Reply with the single word: ready',
          maxOutputTokens: 16,
        });
        return { ok: true, reply: res.text.trim().slice(0, 100), latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: (err as Error).message.slice(0, 500), latencyMs: Date.now() - started };
      }
    },
  );

  api.op(
    {
      method: 'get',
      path: '/admin/decision-model',
      summary: 'External decision model',
      tags: ['Admin: Verification'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const [row] = await ctx.db.select().from(decisionModel).where(eq(decisionModel.orgId, orgId));
      return row
        ? {
            name: row.name,
            url: row.url,
            hasSecret: !!row.secretEnc,
            timeoutMs: row.timeoutMs,
            onError: row.onError,
            enabled: row.enabled,
          }
        : null;
    },
  );

  api.op(
    {
      method: 'put',
      path: '/admin/decision-model',
      summary: 'Configure the external decision model',
      tags: ['Admin: Verification'],
      body: decisionModelBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const [existing] = await ctx.db.select().from(decisionModel).where(eq(decisionModel.orgId, orgId));
      const values = {
        orgId,
        name: body.name,
        url: body.url,
        secretEnc: body.secret ? ctx.secrets.encrypt(body.secret) : (existing?.secretEnc ?? null),
        timeoutMs: body.timeoutMs,
        onError: body.onError,
        enabled: body.enabled,
      };
      await ctx.db
        .insert(decisionModel)
        .values(values)
        .onConflictDoUpdate({ target: decisionModel.orgId, set: { ...values, updatedAt: new Date() } });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'decision_model.saved',
        metadata: { url: body.url },
      });
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'delete',
      path: '/admin/decision-model',
      summary: 'Remove the decision model',
      tags: ['Admin: Verification'],
    },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      await ctx.db.delete(decisionModel).where(eq(decisionModel.orgId, orgId));
      return { ok: true };
    },
  );

  // ── Settings & policy ──
  api.op(
    { method: 'get', path: '/admin/settings', summary: 'Organisation settings', tags: ['Admin'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      return {
        anonymousInternal: await getSetting(ctx, orgId, 'distribution.anonymousInternal', true),
        securityRules: await getSetting(ctx, orgId, 'security.rules', ''),
        branding: await getSetting(ctx, orgId, 'branding', { accent: null as string | null }),
      };
    },
  );

  api.op(
    {
      method: 'put',
      path: '/admin/settings',
      summary: 'Update organisation settings',
      tags: ['Admin'],
      body: z.object({
        anonymousInternal: z.boolean().optional(),
        securityRules: z.string().max(200_000).optional(),
        branding: z.object({ accent: z.string().nullable() }).optional(),
      }),
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      if (body.securityRules !== undefined && body.securityRules.trim()) {
        try {
          loadRulePack(body.securityRules);
        } catch (err) {
          throw badRequest(`Invalid rule pack: ${(err as Error).message}`);
        }
      }
      if (body.anonymousInternal !== undefined)
        await putSetting(ctx, orgId, 'distribution.anonymousInternal', body.anonymousInternal);
      if (body.securityRules !== undefined)
        await putSetting(ctx, orgId, 'security.rules', body.securityRules);
      if (body.branding) await putSetting(ctx, orgId, 'branding', body.branding);
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'settings.updated',
        metadata: { keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  api.op(
    { method: 'get', path: '/admin/policy', summary: 'Organisation default policy', tags: ['Policies'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const [row] = await ctx.db
        .select()
        .from(policy)
        .where(and(eq(policy.orgId, orgId), isNull(policy.namespaceId)));
      return { document: row?.document, revision: row?.revision ?? 0 };
    },
  );

  api.op(
    {
      method: 'put',
      path: '/admin/policy',
      summary: 'Set the organisation default policy',
      tags: ['Policies'],
      body: policyBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      for (const s of body.document.stages) {
        const err = s.when ? validateCondition(s.when) : null;
        if (err) throw badRequest(`Invalid condition in stage "${s.name}": ${err}`);
      }
      const [row] = await ctx.db
        .select()
        .from(policy)
        .where(and(eq(policy.orgId, orgId), isNull(policy.namespaceId)));
      if (row)
        await ctx.db
          .update(policy)
          .set({ document: body.document, revision: row.revision + 1, updatedBy: actor.userId })
          .where(eq(policy.id, row.id));
      else
        await ctx.db
          .insert(policy)
          .values({ orgId, namespaceId: null, document: body.document, updatedBy: actor.userId });
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'policy.updated',
        metadata: { scope: 'org' },
      });
      return { ok: true };
    },
  );

  // ── Webhooks ──
  api.op(
    { method: 'get', path: '/admin/webhooks', summary: 'Webhooks', tags: ['Admin: Webhooks'] },
    async ({ ctx, actor, orgId }) => {
      requireAdmin(actor);
      const rows = await ctx.db
        .select()
        .from(webhook)
        .where(eq(webhook.orgId, orgId))
        .orderBy(desc(webhook.createdAt));
      return rows.map(({ secretEnc: _s, ...r }) => r);
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/webhooks',
      summary: 'Create a webhook',
      tags: ['Admin: Webhooks'],
      body: webhookBody,
    },
    async ({ ctx, actor, orgId, body }) => {
      requireAdmin(actor);
      const secret = `whsec_${randomToken(24)}`;
      const [row] = await ctx.db
        .insert(webhook)
        .values({
          orgId,
          ...body,
          namespaceId: body.namespaceId ?? null,
          secretEnc: ctx.secrets.encrypt(secret),
          createdBy: actor.userId,
        })
        .returning();
      await audit(ctx, {
        orgId,
        actorId: actor.userId,
        action: 'webhook.created',
        targetType: 'webhook',
        targetId: row!.id,
        metadata: { url: body.url },
      });
      return { id: row!.id, secret };
    },
  );

  api.op(
    {
      method: 'patch',
      path: '/admin/webhooks/:id',
      summary: 'Update a webhook',
      tags: ['Admin: Webhooks'],
      body: webhookBody.partial(),
    },
    async ({ ctx, actor, orgId, params, body }) => {
      requireAdmin(actor);
      await ctx.db
        .update(webhook)
        .set(body)
        .where(and(eq(webhook.orgId, orgId), eq(webhook.id, params.id!)));
      return { ok: true };
    },
  );

  api.op(
    { method: 'delete', path: '/admin/webhooks/:id', summary: 'Delete a webhook', tags: ['Admin: Webhooks'] },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      await ctx.db.delete(webhook).where(and(eq(webhook.orgId, orgId), eq(webhook.id, params.id!)));
      return { ok: true };
    },
  );

  api.op(
    {
      method: 'get',
      path: '/admin/webhooks/:id/deliveries',
      summary: 'Recent deliveries',
      tags: ['Admin: Webhooks'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      const [hook] = await ctx.db
        .select()
        .from(webhook)
        .where(and(eq(webhook.orgId, orgId), eq(webhook.id, params.id!)));
      if (!hook) throw notFound('Webhook');
      return ctx.db
        .select()
        .from(webhookDelivery)
        .where(eq(webhookDelivery.webhookId, hook.id))
        .orderBy(desc(webhookDelivery.createdAt))
        .limit(100);
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/webhooks/:id/test',
      summary: 'Send a ping event',
      tags: ['Admin: Webhooks'],
    },
    async ({ ctx, actor, orgId, params }) => {
      requireAdmin(actor);
      const [hook] = await ctx.db
        .select()
        .from(webhook)
        .where(and(eq(webhook.orgId, orgId), eq(webhook.id, params.id!)));
      if (!hook) throw notFound('Webhook');
      const envelope = {
        id: crypto.randomUUID(),
        type: 'version.published',
        createdAt: new Date().toISOString(),
        org: orgId,
        data: { test: true, skill: 'example-skill', version: '1.0.0' },
      };
      const [d] = await ctx.db
        .insert(webhookDelivery)
        .values({ webhookId: hook.id, eventId: envelope.id, event: 'version.published', payload: envelope })
        .returning();
      const { deliverWebhook } = await import('../services/webhooks');
      await deliverWebhook(ctx, d!.id);
      const [after] = await ctx.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, d!.id));
      return after;
    },
  );

  api.op(
    {
      method: 'post',
      path: '/admin/deliveries/:id/redeliver',
      summary: 'Redeliver a webhook event',
      tags: ['Admin: Webhooks'],
    },
    async ({ ctx, actor, params }) => {
      requireAdmin(actor);
      await ctx.db
        .update(webhookDelivery)
        .set({ status: 'pending' })
        .where(eq(webhookDelivery.id, params.id!));
      await ctx.jobs.send('webhook.deliver', { deliveryId: params.id }, { retryLimit: 0 });
      return { ok: true };
    },
  );

  // ── Audit log ──
  api.op(
    {
      method: 'get',
      path: '/admin/audit',
      summary: 'Audit log',
      tags: ['Admin'],
      query: z.object({
        before: z.coerce.number().optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ ctx, actor, orgId, query }) => {
      if (!canReadAudit(actor)) throw forbidden();
      const conds = [eq(auditLog.orgId, orgId)];
      if (query.before) conds.push(lt(auditLog.id, query.before));
      if (query.action) conds.push(eq(auditLog.action, query.action));
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(and(...conds))
        .orderBy(desc(auditLog.id))
        .limit(query.limit);
      const users = await usersById(
        ctx,
        rows.map((r) => r.actorId),
      );
      return rows.map((r) => ({
        ...r,
        actor: r.actorId ? (users.get(r.actorId) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  return api;
}
