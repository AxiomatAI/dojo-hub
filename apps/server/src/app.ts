import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { namespace, skill } from '@dojohub/db';
import { Scalar } from '@scalar/hono-api-reference';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { actorMiddleware, type Env } from './auth/actor';
import type { AppContext } from './context';
import { gitRoutes } from './distribution/git';
import { anonymousAllowed } from './distribution/resolve';
import { wellKnownRoutes } from './distribution/wellknown';
import { Api } from './lib/api';
import { errorHandler } from './lib/errors';
import { mcpHandler } from './mcp/server';
import { accountRoutes, VERSION } from './routes/account';
import { adminRoutes } from './routes/admin';
import { dashboardRoutes } from './routes/dashboard';
import { namespaceRoutes } from './routes/namespaces';
import { reviewRoutes, suiteRoutes } from './routes/reviews';
import { canSeeSkill, skillRoutes } from './routes/skills';
import { sourceRoutes } from './routes/sources';
import { scimRoutes } from './scim/routes';
import { getOrgId } from './services/org';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function createApp(ctx: AppContext) {
  const app = new Hono<Env>();
  app.onError(errorHandler(ctx.logger));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await ctx.sql`select 1`;
      return c.json({ ok: true, version: VERSION });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // Prometheus metrics (no labels with user data).
  const started = Date.now();
  let requests = 0;
  app.use('*', async (_c, next) => {
    requests++;
    await next();
  });
  app.get('/metrics', async (c) => {
    if (!ctx.config.DOJO_METRICS) return c.text('metrics disabled', 404);
    const rows = await ctx.sql<{ k: string; n: number }[]>`
      select 'skills' as k, count(*)::int as n from skill where archived_at is null
      union all select 'versions_pending_review', count(*)::int from skill_version where status = 'in_review'
      union all select 'versions_blocked', count(*)::int from skill_version where status = 'blocked'
      union all select 'installs_total', count(*)::int from install_event
      union all select 'webhook_deliveries_failed', count(*)::int from webhook_delivery where status = 'failed'`;
    const lines = [
      '# TYPE dojohub_up gauge',
      'dojohub_up 1',
      '# TYPE dojohub_uptime_seconds gauge',
      `dojohub_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`,
      '# TYPE dojohub_http_requests_total counter',
      `dojohub_http_requests_total ${requests}`,
      ...rows.flatMap((r) => [`# TYPE dojohub_${r.k} gauge`, `dojohub_${r.k} ${r.n}`]),
    ];
    return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

  // Better Auth (sessions, email/password, SSO OIDC + SAML callbacks).
  app.on(['GET', 'POST'], '/api/auth/*', (c) => ctx.auth.handler(c.req.raw));

  // SCIM uses its own bearer tokens.
  app.route('/scim/v2', scimRoutes(ctx));

  app.use('*', actorMiddleware(ctx));
  app.use('/api/*', secureHeaders());
  app.use('/api/v1/skills/upload', bodyLimit({ maxSize: 60 * 1024 * 1024 }));
  app.use('/api/v1/sources/*', bodyLimit({ maxSize: 210 * 1024 * 1024 }));

  const v1 = new Api();
  for (const r of [
    accountRoutes(),
    namespaceRoutes(),
    skillRoutes(),
    suiteRoutes(),
    reviewRoutes(),
    sourceRoutes(),
    dashboardRoutes(),
    adminRoutes(),
  ])
    v1.mount('', r);
  const root = new Api();
  root.mount('/api/v1', v1);
  app.route('/', root.app);

  app.get('/api/openapi.json', (c) =>
    c.json(root.openapi({ title: 'DojoHub API', version: VERSION, serverUrl: ctx.config.DOJO_BASE_URL })),
  );
  app.get('/api/docs', Scalar({ url: '/api/openapi.json', pageTitle: 'DojoHub API' }));

  // `npx skills find` compatibility (SKILLS_API_URL=<base>).
  app.get('/api/search', async (c) => {
    const orgId = await getOrgId(ctx);
    const q = c.req.query('q') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);
    const like = `%${q}%`;
    const rows = await ctx.db
      .select({ skill, namespace })
      .from(skill)
      .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
      .where(
        and(
          eq(skill.orgId, orgId),
          isNull(skill.archivedAt),
          or(ilike(skill.name, like), ilike(skill.displayName, like), ilike(skill.summary, like)),
        ),
      )
      .orderBy(desc(skill.installCount))
      .limit(200);
    const actor = c.get('actor');
    const out = [];
    for (const r of rows) {
      if (!r.skill.publishedVersionId) continue;
      if (actor ? !canSeeSkill(actor, r) : !(await anonymousAllowed(ctx, r.namespace))) continue;
      const anon = await anonymousAllowed(ctx, r.namespace);
      out.push({
        id: `${r.namespace.slug}/${r.skill.name}`,
        name: r.skill.name,
        source: anon
          ? `${ctx.config.DOJO_BASE_URL}/s/${r.namespace.slug}/${r.skill.name}`
          : `${ctx.config.DOJO_BASE_URL}/git/s/${r.namespace.slug}/${r.skill.name}.git`,
        installs: r.skill.installCount,
        description: r.skill.summary,
      });
      if (out.length >= limit) break;
    }
    return c.json({ query: q, searchType: 'fuzzy', skills: out, count: out.length });
  });

  const mcp = mcpHandler(ctx, app);
  app.all('/mcp', (c) => mcp(c.req.raw));

  app.route('/', wellKnownRoutes(ctx));
  app.route('/', gitRoutes(ctx));

  // Web SPA (production build). In development Vite serves the UI and proxies to this server.
  const webDist = ctx.config.DOJO_WEB_DIST;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');
    app.get('*', async (c) => {
      const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, '');
      if (path.startsWith('/api/'))
        return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      if (path !== '/' && extname(path)) {
        try {
          const file = await readFile(join(webDist, path));
          const immutable = path.startsWith('/assets/');
          return new Response(file, {
            headers: {
              'content-type': MIME[extname(path)] ?? 'application/octet-stream',
              'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
            },
          });
        } catch {
          return c.text('Not found', 404);
        }
      }
      return c.html(indexHtml, 200, { 'cache-control': 'no-cache' });
    });
  }
  return app;
}
