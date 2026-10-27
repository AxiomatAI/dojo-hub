import { directorySync, orgMember, user } from '@dojohub/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { syncUserGroups, upsertGroups } from './groups';

interface GraphConfig {
  kind: 'microsoft_graph';
  tenantId: string;
  clientId: string;
  clientSecret: string;
  groupFilter?: string;
}
interface GoogleConfig {
  kind: 'google_directory';
  serviceAccountJson: string;
  adminEmail: string;
  domain: string;
}

async function graphToken(cfg: GraphConfig): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Graph token request failed: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function graphAll<T>(token: string, url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const res: Response = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Graph request failed: HTTP ${res.status}`);
    const page = (await res.json()) as { value: T[]; '@odata.nextLink'?: string };
    out.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return out;
}

/** Microsoft Graph: groups + transitive members (also resolves Entra's >200 group overage). */
async function syncGraph(ctx: AppContext, orgId: string, cfg: GraphConfig) {
  const token = await graphToken(cfg);
  const filter = cfg.groupFilter ? `&$filter=${encodeURIComponent(cfg.groupFilter)}` : '';
  const groups = await graphAll<{ id: string; displayName: string }>(
    token,
    `https://graph.microsoft.com/v1.0/groups?$select=id,displayName&$top=999${filter}`,
  );
  await upsertGroups(
    ctx,
    orgId,
    groups.map((g) => ({ externalId: g.id, displayName: g.displayName })),
    'directory_sync',
    'microsoft_graph',
  );
  const byUser = new Map<string, { externalId: string; displayName: string }[]>();
  for (const g of groups) {
    const members = await graphAll<{ mail?: string; userPrincipalName?: string }>(
      token,
      `https://graph.microsoft.com/v1.0/groups/${g.id}/transitiveMembers/microsoft.graph.user?$select=mail,userPrincipalName&$top=999`,
    );
    for (const m of members) {
      const email = (m.mail ?? m.userPrincipalName ?? '').toLowerCase();
      if (!email) continue;
      byUser.set(email, [...(byUser.get(email) ?? []), { externalId: g.id, displayName: g.displayName }]);
    }
  }
  return applyMemberships(ctx, orgId, byUser);
}

async function googleToken(cfg: GoogleConfig): Promise<string> {
  const sa = JSON.parse(cfg.serviceAccountJson) as { client_email: string; private_key: string };
  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    sub: cfg.adminEmail,
    scope:
      'https://www.googleapis.com/auth/admin.directory.group.readonly https://www.googleapis.com/auth/admin.directory.group.member.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Google Workspace Admin SDK Directory API (service account with domain-wide delegation). */
async function syncGoogle(ctx: AppContext, orgId: string, cfg: GoogleConfig) {
  const token = await googleToken(cfg);
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Directory API failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const groups: { id: string; email: string; name: string }[] = [];
  let pageToken = '';
  do {
    const page = await get<{
      groups?: { id: string; email: string; name: string }[];
      nextPageToken?: string;
    }>(
      `https://admin.googleapis.com/admin/directory/v1/groups?domain=${encodeURIComponent(cfg.domain)}&maxResults=200${pageToken ? `&pageToken=${pageToken}` : ''}`,
    );
    groups.push(...(page.groups ?? []));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  await upsertGroups(
    ctx,
    orgId,
    groups.map((g) => ({ externalId: g.email, displayName: g.name })),
    'directory_sync',
    'google_directory',
  );
  const byUser = new Map<string, { externalId: string; displayName: string }[]>();
  for (const g of groups) {
    let token2 = '';
    do {
      const page = await get<{ members?: { email: string; type: string }[]; nextPageToken?: string }>(
        `https://admin.googleapis.com/admin/directory/v1/groups/${g.id}/members?includeDerivedMembership=true&maxResults=200${token2 ? `&pageToken=${token2}` : ''}`,
      );
      for (const m of page.members ?? []) {
        if (m.type !== 'USER') continue;
        const email = m.email.toLowerCase();
        byUser.set(email, [...(byUser.get(email) ?? []), { externalId: g.email, displayName: g.name }]);
      }
      token2 = page.nextPageToken ?? '';
    } while (token2);
  }
  return applyMemberships(ctx, orgId, byUser);
}

async function applyMemberships(
  ctx: AppContext,
  orgId: string,
  byUser: Map<string, { externalId: string; displayName: string }[]>,
) {
  const members = await ctx.db
    .select({ id: user.id, email: user.email })
    .from(orgMember)
    .innerJoin(user, eq(user.id, orgMember.userId))
    .where(eq(orgMember.orgId, orgId));
  let synced = 0;
  for (const m of members) {
    await syncUserGroups(ctx, orgId, m.id, byUser.get(m.email.toLowerCase()) ?? [], 'directory_sync');
    synced++;
  }
  return { groups: new Set([...byUser.values()].flat().map((g) => g.externalId)).size, users: synced };
}

export async function runDirectorySync(ctx: AppContext, id: string) {
  const [row] = await ctx.db.select().from(directorySync).where(eq(directorySync.id, id));
  if (!row || !row.enabled) return;
  const cfg = JSON.parse(ctx.secrets.decrypt(row.configEnc)) as GraphConfig | GoogleConfig;
  try {
    const res =
      cfg.kind === 'microsoft_graph'
        ? await syncGraph(ctx, row.orgId, cfg)
        : await syncGoogle(ctx, row.orgId, cfg);
    await ctx.db
      .update(directorySync)
      .set({ lastRunAt: new Date(), lastStatus: `ok: ${res.groups} groups, ${res.users} users` })
      .where(and(eq(directorySync.id, id)));
  } catch (err) {
    await ctx.db
      .update(directorySync)
      .set({ lastRunAt: new Date(), lastStatus: `error: ${(err as Error).message}` })
      .where(eq(directorySync.id, id));
    throw err;
  }
}
