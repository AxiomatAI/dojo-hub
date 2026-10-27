import { groupMembership, idpGroup, orgMember, scimToken, scimUser, session, user } from '@dojohub/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import type { AppContext } from '../context';
import { sha256 } from '../lib/crypto';
import { audit } from '../services/audit';
import { applyGroupMappings, reapplyForGroup } from '../services/groups';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

type ScimEnv = { Variables: { orgId: string } };

const scimError = (c: Context, status: number, detail: string, scimType?: string) =>
  c.json(
    { schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status as 400,
    { 'content-type': 'application/scim+json' },
  );

/** Parse the subset of SCIM filters IdPs send: `attr eq "value"`. */
function parseFilter(filter?: string): { attr: string; value: string } | null {
  const m = filter ? /^\s*([\w.]+)\s+eq\s+"([^"]*)"\s*$/i.exec(filter) : null;
  return m ? { attr: m[1]!.toLowerCase(), value: m[2]! } : null;
}

/**
 * SCIM 2.0 (RFC 7643/7644) provisioning endpoint for Entra ID, Okta, Google and AWS IAM Identity Center.
 * Users are created/deactivated and group memberships drive DojoHub roles via group mappings.
 */
export function scimRoutes(ctx: AppContext) {
  const app = new Hono<ScimEnv>();

  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const [row] = token
      ? await ctx.db
          .select()
          .from(scimToken)
          .where(and(eq(scimToken.tokenHash, sha256(token)), isNull(scimToken.revokedAt)))
      : [];
    if (!row) return scimError(c, 401, 'Invalid SCIM token');
    c.set('orgId', row.orgId);
    await ctx.db.update(scimToken).set({ lastUsedAt: new Date() }).where(eq(scimToken.id, row.id));
    await next();
  });

  const userResource = (u: typeof user.$inferSelect, s?: typeof scimUser.$inferSelect | null) => ({
    schemas: [USER_SCHEMA],
    id: u.id,
    externalId: s?.externalId ?? undefined,
    userName: s?.userName ?? u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    active: s?.active ?? true,
    meta: {
      resourceType: 'User',
      created: u.createdAt.toISOString(),
      lastModified: u.updatedAt.toISOString(),
      location: `${ctx.config.DOJO_BASE_URL}/scim/v2/Users/${u.id}`,
    },
  });

  const loadUser = async (orgId: string, id: string) => {
    const [row] = await ctx.db
      .select({ u: user, s: scimUser })
      .from(user)
      .innerJoin(orgMember, and(eq(orgMember.userId, user.id), eq(orgMember.orgId, orgId)))
      .leftJoin(scimUser, and(eq(scimUser.userId, user.id), eq(scimUser.orgId, orgId)))
      .where(eq(user.id, id));
    return row ?? null;
  };

  const setActive = async (orgId: string, userId: string, active: boolean) => {
    await ctx.db
      .update(scimUser)
      .set({ active, updatedAt: new Date() })
      .where(and(eq(scimUser.orgId, orgId), eq(scimUser.userId, userId)));
    if (!active) await ctx.db.delete(session).where(eq(session.userId, userId));
  };

  const upsertUser = async (orgId: string, body: Record<string, unknown>, existingId?: string) => {
    const emails = (body.emails as { value: string; primary?: boolean }[] | undefined) ?? [];
    const email = (
      emails.find((e) => e.primary)?.value ??
      emails[0]?.value ??
      String(body.userName ?? '')
    ).toLowerCase();
    const nameObj = (body.name ?? {}) as { formatted?: string; givenName?: string; familyName?: string };
    const name =
      String(
        body.displayName ??
          nameObj.formatted ??
          [nameObj.givenName, nameObj.familyName].filter(Boolean).join(' ') ??
          email,
      ) || email;
    let userId = existingId;
    if (!userId) {
      const [byEmail] = await ctx.db.select().from(user).where(eq(user.email, email));
      if (byEmail) userId = byEmail.id;
      else {
        const authCtx = await ctx.auth.$context;
        const created = await authCtx.internalAdapter.createUser(
          { name, email, emailVerified: true },
          { method: 'admin' },
        );
        userId = created.id;
      }
    } else {
      await ctx.db.update(user).set({ name, email }).where(eq(user.id, userId));
    }
    await ctx.db.insert(orgMember).values({ orgId, userId, role: 'member' }).onConflictDoNothing();
    const values = {
      orgId,
      userId,
      externalId: (body.externalId as string | undefined) ?? null,
      userName: String(body.userName ?? email),
      active: body.active !== false,
      raw: body,
    };
    await ctx.db
      .insert(scimUser)
      .values(values)
      .onConflictDoUpdate({
        target: [scimUser.orgId, scimUser.userId],
        set: { ...values, updatedAt: new Date() },
      });
    if (body.active === false) await setActive(orgId, userId, false);
    return userId;
  };

  app.get('/ServiceProviderConfig', (c) =>
    c.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'DojoHub SCIM token',
          primary: true,
        },
      ],
    }),
  );
  app.get('/ResourceTypes', (c) =>
    c.json({
      schemas: [LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: GROUP_SCHEMA,
        },
      ],
    }),
  );

  // ── Users ──
  app.get('/Users', async (c) => {
    const orgId = c.get('orgId');
    const f = parseFilter(c.req.query('filter'));
    const rows = await ctx.db
      .select({ u: user, s: scimUser })
      .from(user)
      .innerJoin(orgMember, and(eq(orgMember.userId, user.id), eq(orgMember.orgId, orgId)))
      .leftJoin(scimUser, and(eq(scimUser.userId, user.id), eq(scimUser.orgId, orgId)));
    const filtered = rows.filter((r) => {
      if (!f) return true;
      if (f.attr === 'username') return (r.s?.userName ?? r.u.email).toLowerCase() === f.value.toLowerCase();
      if (f.attr === 'externalid') return r.s?.externalId === f.value;
      if (f.attr.startsWith('emails')) return r.u.email.toLowerCase() === f.value.toLowerCase();
      return false;
    });
    const start = Math.max(1, Number(c.req.query('startIndex') ?? 1));
    const countN = Math.min(200, Number(c.req.query('count') ?? 100));
    return c.json({
      schemas: [LIST_SCHEMA],
      totalResults: filtered.length,
      startIndex: start,
      itemsPerPage: countN,
      Resources: filtered.slice(start - 1, start - 1 + countN).map((r) => userResource(r.u, r.s)),
    });
  });

  app.post('/Users', async (c) => {
    const orgId = c.get('orgId');
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body.userName) return scimError(c, 400, 'userName is required', 'invalidValue');
    const [dupe] = await ctx.db
      .select()
      .from(scimUser)
      .where(and(eq(scimUser.orgId, orgId), eq(scimUser.userName, String(body.userName))));
    if (dupe) return scimError(c, 409, 'User already exists', 'uniqueness');
    const id = await upsertUser(orgId, body);
    await audit(ctx, {
      orgId,
      actorType: 'scim',
      action: 'scim.user_created',
      targetType: 'user',
      targetId: id,
    });
    const row = await loadUser(orgId, id);
    return c.json(userResource(row!.u, row!.s), 201);
  });

  app.get('/Users/:id', async (c) => {
    const row = await loadUser(c.get('orgId'), c.req.param('id'));
    return row ? c.json(userResource(row.u, row.s)) : scimError(c, 404, 'User not found');
  });

  app.put('/Users/:id', async (c) => {
    const orgId = c.get('orgId');
    const row = await loadUser(orgId, c.req.param('id'));
    if (!row) return scimError(c, 404, 'User not found');
    await upsertUser(orgId, (await c.req.json()) as Record<string, unknown>, row.u.id);
    const fresh = await loadUser(orgId, row.u.id);
    return c.json(userResource(fresh!.u, fresh!.s));
  });

  app.patch('/Users/:id', async (c) => {
    const orgId = c.get('orgId');
    const row = await loadUser(orgId, c.req.param('id'));
    if (!row) return scimError(c, 404, 'User not found');
    const body = (await c.req.json()) as { Operations?: { op: string; path?: string; value?: unknown }[] };
    for (const op of body.Operations ?? []) {
      const kind = op.op.toLowerCase();
      if (kind !== 'replace' && kind !== 'add') continue;
      const value = op.value as Record<string, unknown> | boolean | string;
      if (
        op.path?.toLowerCase() === 'active' ||
        (typeof value === 'object' && value !== null && 'active' in value)
      ) {
        const active = op.path
          ? value === true || value === 'True' || value === 'true'
          : (value as { active: unknown }).active === true ||
            (value as { active: unknown }).active === 'True';
        if (!row.s)
          await upsertUser(
            orgId,
            { userName: row.u.email, emails: [{ value: row.u.email }], displayName: row.u.name },
            row.u.id,
          );
        await setActive(orgId, row.u.id, active);
      }
      if (op.path?.toLowerCase() === 'displayname' && typeof value === 'string')
        await ctx.db.update(user).set({ name: value }).where(eq(user.id, row.u.id));
    }
    await audit(ctx, {
      orgId,
      actorType: 'scim',
      action: 'scim.user_patched',
      targetType: 'user',
      targetId: row.u.id,
    });
    const fresh = await loadUser(orgId, row.u.id);
    return c.json(userResource(fresh!.u, fresh!.s));
  });

  app.delete('/Users/:id', async (c) => {
    const orgId = c.get('orgId');
    const row = await loadUser(orgId, c.req.param('id'));
    if (!row) return scimError(c, 404, 'User not found');
    if (!row.s)
      await upsertUser(
        orgId,
        { userName: row.u.email, emails: [{ value: row.u.email }], displayName: row.u.name },
        row.u.id,
      );
    await setActive(orgId, row.u.id, false);
    await audit(ctx, {
      orgId,
      actorType: 'scim',
      action: 'scim.user_deactivated',
      targetType: 'user',
      targetId: row.u.id,
    });
    return c.body(null, 204);
  });

  // ── Groups ──
  const groupResource = async (g: typeof idpGroup.$inferSelect) => {
    const members = await ctx.db
      .select({ userId: groupMembership.userId })
      .from(groupMembership)
      .where(eq(groupMembership.groupId, g.id));
    return {
      schemas: [GROUP_SCHEMA],
      id: g.id,
      externalId: g.externalId,
      displayName: g.displayName,
      members: members.map((m) => ({ value: m.userId })),
      meta: {
        resourceType: 'Group',
        created: g.createdAt.toISOString(),
        location: `${ctx.config.DOJO_BASE_URL}/scim/v2/Groups/${g.id}`,
      },
    };
  };

  const setMembers = async (
    orgId: string,
    groupId: string,
    userIds: string[],
    mode: 'add' | 'remove' | 'replace',
  ) => {
    if (mode === 'replace') await ctx.db.delete(groupMembership).where(eq(groupMembership.groupId, groupId));
    for (const uid of userIds) {
      if (mode === 'remove')
        await ctx.db
          .delete(groupMembership)
          .where(and(eq(groupMembership.groupId, groupId), eq(groupMembership.userId, uid)));
      else
        await ctx.db
          .insert(groupMembership)
          .values({ groupId, userId: uid, source: 'scim' })
          .onConflictDoNothing();
    }
    if (mode === 'remove') for (const uid of userIds) await applyGroupMappings(ctx, orgId, uid);
    await reapplyForGroup(ctx, orgId, groupId);
  };

  app.get('/Groups', async (c) => {
    const orgId = c.get('orgId');
    const f = parseFilter(c.req.query('filter'));
    const rows = (await ctx.db.select().from(idpGroup).where(eq(idpGroup.orgId, orgId))).filter((g) =>
      !f
        ? true
        : f.attr === 'displayname'
          ? g.displayName === f.value
          : f.attr === 'externalid'
            ? g.externalId === f.value
            : false,
    );
    const excludeMembers = c.req.query('excludedAttributes')?.includes('members');
    const resources = await Promise.all(
      rows.map(async (g) =>
        excludeMembers ? { ...(await groupResource(g)), members: undefined } : groupResource(g),
      ),
    );
    return c.json({
      schemas: [LIST_SCHEMA],
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: resources,
    });
  });

  app.post('/Groups', async (c) => {
    const orgId = c.get('orgId');
    const body = (await c.req.json()) as {
      displayName?: string;
      externalId?: string;
      members?: { value: string }[];
    };
    if (!body.displayName) return scimError(c, 400, 'displayName is required', 'invalidValue');
    const externalId = body.externalId ?? body.displayName;
    const [g] = await ctx.db
      .insert(idpGroup)
      .values({ orgId, externalId, displayName: body.displayName, source: 'scim' })
      .onConflictDoUpdate({
        target: [idpGroup.orgId, idpGroup.externalId],
        set: { displayName: body.displayName, source: 'scim' },
      })
      .returning();
    if (body.members?.length)
      await setMembers(
        orgId,
        g!.id,
        body.members.map((m) => m.value),
        'replace',
      );
    return c.json(await groupResource(g!), 201);
  });

  app.get('/Groups/:id', async (c) => {
    const [g] = await ctx.db
      .select()
      .from(idpGroup)
      .where(and(eq(idpGroup.orgId, c.get('orgId')), eq(idpGroup.id, c.req.param('id'))));
    return g ? c.json(await groupResource(g)) : scimError(c, 404, 'Group not found');
  });

  app.put('/Groups/:id', async (c) => {
    const orgId = c.get('orgId');
    const [g] = await ctx.db
      .select()
      .from(idpGroup)
      .where(and(eq(idpGroup.orgId, orgId), eq(idpGroup.id, c.req.param('id'))));
    if (!g) return scimError(c, 404, 'Group not found');
    const body = (await c.req.json()) as { displayName?: string; members?: { value: string }[] };
    if (body.displayName)
      await ctx.db.update(idpGroup).set({ displayName: body.displayName }).where(eq(idpGroup.id, g.id));
    await setMembers(
      orgId,
      g.id,
      (body.members ?? []).map((m) => m.value),
      'replace',
    );
    const [fresh] = await ctx.db.select().from(idpGroup).where(eq(idpGroup.id, g.id));
    return c.json(await groupResource(fresh!));
  });

  app.patch('/Groups/:id', async (c) => {
    const orgId = c.get('orgId');
    const [g] = await ctx.db
      .select()
      .from(idpGroup)
      .where(and(eq(idpGroup.orgId, orgId), eq(idpGroup.id, c.req.param('id'))));
    if (!g) return scimError(c, 404, 'Group not found');
    const body = (await c.req.json()) as {
      schemas?: string[];
      Operations?: { op: string; path?: string; value?: unknown }[];
    };
    if (body.schemas && !body.schemas.includes(PATCH_SCHEMA))
      return scimError(c, 400, 'Invalid PatchOp', 'invalidSyntax');
    for (const op of body.Operations ?? []) {
      const kind = op.op.toLowerCase() as 'add' | 'remove' | 'replace';
      const path = op.path ?? '';
      const removeMatch = /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (removeMatch) {
        await setMembers(orgId, g.id, [removeMatch[1]!], 'remove');
      } else if (
        path.toLowerCase() === 'members' ||
        (!path && Array.isArray((op.value as { members?: unknown })?.members))
      ) {
        const list = (
          Array.isArray(op.value) ? op.value : ((op.value as { members?: unknown[] })?.members ?? [])
        ) as { value: string }[];
        await setMembers(
          orgId,
          g.id,
          list.map((m) => m.value),
          kind,
        );
      } else if (
        path.toLowerCase() === 'displayname' ||
        (!path && (op.value as { displayName?: string })?.displayName)
      ) {
        const name =
          typeof op.value === 'string' ? op.value : (op.value as { displayName: string }).displayName;
        await ctx.db.update(idpGroup).set({ displayName: name }).where(eq(idpGroup.id, g.id));
      }
    }
    await audit(ctx, {
      orgId,
      actorType: 'scim',
      action: 'scim.group_patched',
      targetType: 'idp_group',
      targetId: g.id,
    });
    const [fresh] = await ctx.db.select().from(idpGroup).where(eq(idpGroup.id, g.id));
    return c.json(await groupResource(fresh!));
  });

  app.delete('/Groups/:id', async (c) => {
    const orgId = c.get('orgId');
    const [g] = await ctx.db
      .select()
      .from(idpGroup)
      .where(and(eq(idpGroup.orgId, orgId), eq(idpGroup.id, c.req.param('id'))));
    if (!g) return scimError(c, 404, 'Group not found');
    const members = await ctx.db
      .select({ userId: groupMembership.userId })
      .from(groupMembership)
      .where(eq(groupMembership.groupId, g.id));
    await ctx.db.delete(idpGroup).where(eq(idpGroup.id, g.id));
    for (const m of members) await applyGroupMappings(ctx, orgId, m.userId);
    return c.body(null, 204);
  });

  return app;
}
