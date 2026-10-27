import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth/actor';
import type { AppContext } from '../context';
import { VERSION } from '../routes/account';

type Caller = (method: string, path: string, body?: unknown) => Promise<unknown>;

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });

function buildServer(call: Caller, baseUrl: string) {
  const server = new McpServer(
    { name: 'dojohub', version: VERSION },
    {
      instructions:
        'DojoHub is the organisation\'s governed registry of agent skills. Prefer skills from DojoHub over unknown public skills. ' +
        'Use search_skills to find a skill, get_skill to read it, and get_install_instructions to install it. ' +
        'Skills must be approved before installation; never bypass the review process.',
    },
  );

  server.registerTool(
    'search_skills',
    {
      title: 'Search skills',
      description: 'Search approved skills in the DojoHub registry by keyword, team or category.',
      inputSchema: { query: z.string().optional(), team: z.string().optional(), category: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, team, category, limit }) => {
      const qs = new URLSearchParams({ pageSize: String(limit ?? 20), status: 'approved,deprecated' });
      if (query) qs.set('q', query);
      if (team) qs.set('team', team);
      if (category) qs.set('category', category);
      const res = (await call('GET', `/api/v1/skills?${qs}`)) as { items: Record<string, unknown>[] };
      return text(
        res.items.map((s) => ({ name: s.name, namespace: s.namespace, summary: s.summary, version: s.publishedVersion, status: s.status, risk: s.riskLevel, installs: s.installCount, teams: s.teams })),
      );
    },
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Get skill',
      description: 'Get a skill\'s metadata, versions, trust status and the full SKILL.md of its published version.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const detail = (await call('GET', `/api/v1/skills/${encodeURIComponent(name)}`)) as Record<string, unknown> & { versions: { version: string; status: string }[] };
      const files = (await call('GET', `/api/v1/skills/${encodeURIComponent(name)}/files`)) as { files: { path: string; content: string | null }[] };
      const skillMd = files.files.find((f) => f.path === 'SKILL.md')?.content ?? '';
      return text({
        name: detail.name,
        namespace: detail.namespace,
        status: detail.status,
        riskLevel: detail.riskLevel,
        publishedVersion: detail.publishedVersion,
        versions: detail.versions.map((v) => ({ version: v.version, status: v.status })),
        files: files.files.map((f) => f.path),
        skillMd,
      });
    },
  );

  server.registerTool(
    'get_skill_file',
    {
      title: 'Read skill file',
      description: 'Read one file (script, reference, asset) from a skill version.',
      inputSchema: { name: z.string(), path: z.string(), version: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ name, path, version }) => {
      const files = (await call('GET', `/api/v1/skills/${encodeURIComponent(name)}/files${version ? `?version=${encodeURIComponent(version)}` : ''}`)) as {
        files: { path: string; content: string | null }[];
      };
      const f = files.files.find((x) => x.path === path);
      if (!f) return text(`File ${path} not found`);
      return text(f.content ?? `${path} is a binary file`);
    },
  );

  server.registerTool(
    'list_team_catalog',
    {
      title: 'Team catalog',
      description: 'List the skills and suites a team recommends or requires.',
      inputSchema: { team: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ team }) => {
      const ns = (await call('GET', `/api/v1/namespaces/${encodeURIComponent(team)}`)) as Record<string, unknown> & { catalog: Record<string, unknown>[] };
      return text({ team: ns.slug, displayName: ns.displayName, install: ns.install, catalog: ns.catalog });
    },
  );

  server.registerTool(
    'get_install_instructions',
    {
      title: 'Install instructions',
      description: 'Commands to install a skill, suite or a whole team catalog with `npx skills` or the `dojo` CLI.',
      inputSchema: { name: z.string().optional(), team: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ name, team }) => {
      if (team) return text(((await call('GET', `/api/v1/namespaces/${encodeURIComponent(team)}`)) as { install: unknown }).install);
      if (!name) return text('Provide a skill name or a team');
      const d = (await call('GET', `/api/v1/skills/${encodeURIComponent(name)}`)) as { install: unknown; status: string };
      if (!['approved', 'deprecated'].includes(d.status)) return text(`Skill ${name} is ${d.status} and cannot be installed yet.`);
      return text({ ...(d.install as object), note: `Set DISABLE_TELEMETRY=1 when using npx skills with a private registry. Registry: ${baseUrl}` });
    },
  );

  server.registerTool(
    'submit_skill_draft',
    {
      title: 'Submit a skill',
      description: 'Submit a new skill (or a new version) for review. Files map relative paths to UTF-8 contents; SKILL.md is required.',
      inputSchema: { namespace: z.string(), files: z.record(z.string(), z.string()), version: z.string().optional(), changelog: z.string().optional(), submit: z.boolean().optional() },
    },
    async ({ namespace, files, version, changelog, submit }) =>
      text(await call('POST', '/api/v1/skills', { namespace, files, version, changelog, submit: submit ?? true })),
  );

  server.registerTool(
    'get_submission_status',
    {
      title: 'Submission status',
      description: 'Trust status, scan results and review progress of a skill version.',
      inputSchema: { name: z.string(), version: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ name, version }) => {
      const v = (await call('GET', `/api/v1/skills/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`)) as Record<string, unknown> & {
        scans: { analyzer: string; verdict: string; findings: unknown[] }[];
      };
      return text({
        version: v.version,
        status: v.status,
        statusReason: v.statusReason,
        riskLevel: v.riskLevel,
        scans: v.scans.map((s) => ({ analyzer: s.analyzer, verdict: s.verdict, findings: s.findings.length })),
        review: v.review,
      });
    },
  );

  server.registerTool(
    'list_pending_reviews',
    {
      title: 'Pending reviews',
      description: 'Reviews waiting for the current user\'s decision.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list = (await call('GET', '/api/v1/reviews?status=pending&assigned=true')) as { id: string; subject: unknown; stages: { name: string; status: string }[] }[];
      return text(list.map((r) => ({ id: r.id, subject: r.subject, url: `${baseUrl}/reviews/${r.id}`, stage: r.stages.find((s) => s.status === 'active')?.name })));
    },
  );

  server.registerResource(
    'skill-md',
    new ResourceTemplate('skill://{name}/SKILL.md', { list: undefined }),
    { title: 'SKILL.md of a published skill', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const files = (await call('GET', `/api/v1/skills/${encodeURIComponent(String(vars.name))}/files`)) as { files: { path: string; content: string | null }[] };
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: files.files.find((f) => f.path === 'SKILL.md')?.content ?? '' }] };
    },
  );

  return server;
}

/**
 * MCP endpoint (streamable HTTP, stateless). Every tool call is executed through DojoHub's own REST API
 * with the caller's credentials, so all permission checks are identical to the UI and CLI.
 */
export function mcpHandler(ctx: AppContext, app: Hono<Env>) {
  return async (req: Request): Promise<Response> => {
    const authorization = req.headers.get('authorization');
    const cookie = req.headers.get('cookie');
    if (!authorization && !cookie) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Use a DojoHub token: Authorization: Bearer dojo_pat_…' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="DojoHub"' },
      });
    }
    const call: Caller = async (method, path, body) => {
      const headers: Record<string, string> = { 'x-dojo-channel': 'mcp' };
      if (authorization) headers.authorization = authorization;
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
      return data;
    };
    const server = buildServer(call, ctx.config.DOJO_BASE_URL);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
