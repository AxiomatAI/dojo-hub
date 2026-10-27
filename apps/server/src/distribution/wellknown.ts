import { Hono } from 'hono';
import type { Env } from '../auth/actor';
import type { AppContext } from '../context';
import { getOrgId } from '../services/org';
import { recordInstall } from '../services/stats';
import { getNamespace } from '../services/namespaces';
import { loadArchive } from '../services/skills';
import { namespace, skill, skillVersion } from '@dojohub/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type Bundle, canDownload, findSkill, findSuite, suiteBundle, teamBundle } from './resolve';
import { installableVersion } from '../services/skills';

export const WELL_KNOWN_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

function indexFor(base: string, bundles: Bundle[]) {
  return {
    $schema: WELL_KNOWN_SCHEMA,
    skills: bundles.map((b) => ({
      name: b.skill.name,
      type: 'archive' as const,
      description: b.version.description.slice(0, 1024) || b.skill.summary || b.skill.name,
      url: `${base}/dl/${b.version.id}.tar.gz`,
      digest: `sha256:${b.version.archiveDigest}`,
    })),
  };
}

const INDEX_PATHS = ['/.well-known/agent-skills/index.json', '/.well-known/skills/index.json'];

/**
 * Agent Skills discovery (RFC v0.2.0) endpoints consumed by the stock `npx skills` CLI:
 *   /t/<team>        team catalog          /s/<ns>/<skill>   single skill
 *   /suites/<ns>/<suite>                    /                 org-wide public catalog
 */
export function wellKnownRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const base = () => ctx.config.DOJO_BASE_URL;
  const json = (c: { json: (b: unknown, s?: number, h?: Record<string, string>) => Response }, body: unknown) =>
    c.json(body, 200, { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });

  for (const suffix of INDEX_PATHS) {
    app.get(`/t/:team${suffix}`, async (c) => {
      const orgId = await getOrgId(ctx);
      const ns = await getNamespace(ctx, orgId, c.req.param('team')).catch(() => null);
      if (!ns || !(await canDownload(ctx, c.get('actor'), ns))) return c.json({ error: 'not found' }, 404);
      return json(c, indexFor(base(), await teamBundle(ctx, ns)));
    });
    app.get(`/s/:ns/:skill${suffix}`, async (c) => {
      const orgId = await getOrgId(ctx);
      const found = await findSkill(ctx, orgId, c.req.param('ns'), c.req.param('skill'));
      if (!found || !(await canDownload(ctx, c.get('actor'), found.namespace))) return c.json({ error: 'not found' }, 404);
      const v = await installableVersion(ctx, found.skill.id);
      return json(c, indexFor(base(), v ? [{ skill: found.skill, version: v, namespace: found.namespace }] : []));
    });
    app.get(`/suites/:ns/:suite${suffix}`, async (c) => {
      const orgId = await getOrgId(ctx);
      const found = await findSuite(ctx, orgId, c.req.param('ns'), c.req.param('suite'));
      if (!found || !(await canDownload(ctx, c.get('actor'), found.namespace))) return c.json({ error: 'not found' }, 404);
      return json(c, indexFor(base(), await suiteBundle(ctx, found.suite.id)));
    });
    app.get(suffix, async (c) => {
      const orgId = await getOrgId(ctx);
      const nsRows = await ctx.db
        .select()
        .from(namespace)
        .where(and(eq(namespace.orgId, orgId), eq(namespace.visibility, 'public'), isNull(namespace.archivedAt)));
      const bundles: Bundle[] = [];
      if (nsRows.length) {
        const skills = await ctx.db
          .select()
          .from(skill)
          .where(and(inArray(skill.namespaceId, nsRows.map((n) => n.id)), isNull(skill.archivedAt)));
        for (const s of skills) {
          const v = await installableVersion(ctx, s.id);
          if (v) bundles.push({ skill: s, version: v, namespace: nsRows.find((n) => n.id === s.namespaceId)! });
        }
      }
      return json(c, indexFor(base(), bundles));
    });
  }

  app.get('/dl/:file', async (c) => {
    const id = c.req.param('file').replace(/\.tar\.gz$/, '');
    const [row] = await ctx.db
      .select({ v: skillVersion, s: skill, ns: namespace })
      .from(skillVersion)
      .innerJoin(skill, eq(skill.id, skillVersion.skillId))
      .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
      .where(eq(skillVersion.id, id));
    if (!row || !['approved', 'deprecated'].includes(row.v.status)) return c.json({ error: 'not found' }, 404);
    if (!(await canDownload(ctx, c.get('actor'), row.ns))) return c.json({ error: 'not found' }, 404);
    const archive = await loadArchive(ctx, row.v);
    await recordInstall(ctx, {
      orgId: row.v.orgId,
      channel: c.get('actor') ? 'api' : 'wellknown',
      skillId: row.s.id,
      skillVersionId: row.v.id,
      namespaceId: row.ns.id,
      actorId: c.get('actor')?.userId,
      userAgent: c.req.header('user-agent'),
      clientIp: c.req.header('x-forwarded-for') ?? null,
    });
    return new Response(archive as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(archive.byteLength),
        'content-disposition': `attachment; filename="${row.s.name}-${row.v.version}.tar.gz"`,
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      },
    });
  });
  return app;
}
