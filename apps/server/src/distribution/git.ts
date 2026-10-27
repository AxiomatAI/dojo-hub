import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { skillVersion } from '@dojohub/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import semver from 'semver';
import type { Env } from '../auth/actor';
import type { AppContext } from '../context';
import { sha256 } from '../lib/crypto';
import { getNamespace } from '../services/namespaces';
import { getOrgId } from '../services/org';
import { loadVersionFiles } from '../services/skills';
import { recordInstall } from '../services/stats';
import {
  type Bundle,
  canDownload,
  findSkill,
  findSuite,
  type NamespaceRow,
  suiteBundle,
  teamBundle,
} from './resolve';

const exec = promisify(execFile);

interface Snapshot {
  /** Commits in order; each one fully replaces the tree. */
  commits: { tag?: string; message: string; date: Date; files: () => Promise<Map<string, Uint8Array>> }[];
}

const AUTHOR = { name: 'DojoHub', email: 'dojohub@localhost' };

async function writeTree(dir: string, files: Map<string, Uint8Array>) {
  for (const entry of await readdir(dir))
    if (entry !== '.git') await rm(join(dir, entry), { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    const exec = bytes[0] === 0x23 && bytes[1] === 0x21;
    await chmod(full, exec ? 0o755 : 0o644);
  }
}

/**
 * Materialise a read-only git repository for a distribution target. Commits are deterministic
 * (fixed author and publish timestamps), so every replica builds byte-identical repositories
 * and no shared volume is needed.
 */
async function materialize(ctx: AppContext, key: string, snapshot: Snapshot): Promise<string> {
  const root = ctx.config.DOJO_GIT_CACHE_DIR;
  const target = join(root, key);
  try {
    await stat(join(target, '.git', 'HEAD'));
    const now = new Date();
    await utimes(target, now, now).catch(() => {});
    return target;
  } catch {
    /* build */
  }
  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(join(root, '.build-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
  const git = (args: string[], extra: Record<string, string> = {}) =>
    exec('git', ['-C', tmp, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true', ...args], {
      env: { ...env, ...extra },
    });
  try {
    await git(['init', '-q', '-b', 'main']);
    for (const commit of snapshot.commits) {
      await writeTree(tmp, await commit.files());
      await git(['add', '-A']);
      const date = commit.date.toISOString();
      await git(['commit', '-q', '--allow-empty', '-m', commit.message], {
        GIT_AUTHOR_NAME: AUTHOR.name,
        GIT_AUTHOR_EMAIL: AUTHOR.email,
        GIT_COMMITTER_NAME: AUTHOR.name,
        GIT_COMMITTER_EMAIL: AUTHOR.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      if (commit.tag) await git(['tag', commit.tag]);
    }
    await git(['update-server-info']);
    await rename(tmp, target).catch(async () => {
      // Another request built it concurrently.
      await rm(tmp, { recursive: true, force: true });
    });
    return target;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function singleSkillSnapshot(
  ctx: AppContext,
  skillId: string,
): Promise<{ key: string; snapshot: Snapshot; latest: string | null }> {
  const versions = (
    await ctx.db
      .select()
      .from(skillVersion)
      .where(and(eq(skillVersion.skillId, skillId), inArray(skillVersion.status, ['approved', 'deprecated'])))
  ).sort((a, b) => semver.compare(a.version, b.version));
  // Keep `main` on the newest approved version: deprecated versions are tagged but not the tip.
  const approved = versions.filter((v) => v.status === 'approved');
  const tip = approved[approved.length - 1] ?? versions[versions.length - 1];
  const ordered = tip ? [...versions.filter((v) => v.id !== tip.id), tip] : [];
  const key = `s-${sha256(ordered.map((v) => `${v.id}:${v.archiveDigest}`).join('|')).slice(0, 24)}`;
  return {
    key,
    latest: tip?.id ?? null,
    snapshot: {
      commits: ordered.map((v) => ({
        tag: `v${v.version}`,
        message: `${v.version}${v.changelog ? `\n\n${v.changelog}` : ''}`,
        date: v.publishedAt ?? v.createdAt,
        files: () => loadVersionFiles(ctx, v.id),
      })),
    },
  };
}

function bundleSnapshot(
  ctx: AppContext,
  label: string,
  bundles: Bundle[],
): { key: string; snapshot: Snapshot } {
  const key = `b-${sha256(`${label}|${bundles.map((b) => `${b.skill.name}:${b.version.id}`).join('|')}`).slice(0, 24)}`;
  const newest = bundles.reduce(
    (d, b) => Math.max(d, (b.version.publishedAt ?? b.version.createdAt).getTime()),
    0,
  );
  return {
    key,
    snapshot: {
      commits: [
        {
          message: `${label}\n\n${bundles.map((b) => `- ${b.skill.name}@${b.version.version}`).join('\n')}`,
          date: new Date(newest || 1704067200000),
          files: async () => {
            const out = new Map<string, Uint8Array>();
            for (const b of bundles) {
              for (const [p, bytes] of await loadVersionFiles(ctx, b.version.id))
                out.set(`skills/${b.skill.name}/${p}`, bytes);
            }
            out.set(
              'README.md',
              new TextEncoder().encode(
                `# ${label}\n\nServed by DojoHub. Install with \`npx skills add <this-url>\`.\n\n${bundles.map((b) => `- **${b.skill.name}** ${b.version.version}: ${b.version.description}`).join('\n')}\n`,
              ),
            );
            return out;
          },
        },
      ],
    },
  };
}

function pktLine(s: string) {
  return `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
}

function unauthorizedGit() {
  return new Response('Authentication required\n', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="DojoHub"', 'content-type': 'text/plain' },
  });
}

async function runUploadPack(repo: string, args: string[], input?: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['upload-pack', '--stateless-rpc', ...args, repo], {
      env: { ...process.env, GIT_PROTOCOL: 'version=1' },
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errs.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new Error(`git upload-pack exited ${code}: ${Buffer.concat(errs).toString()}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

interface Target {
  ns: NamespaceRow;
  build: () => Promise<{ key: string; snapshot: Snapshot }>;
  onFetch: () => Promise<void>;
}

/**
 * Read-only git smart-HTTP endpoints. Stock `npx skills` installs private skills through these,
 * authenticating with a DojoHub token via git credential helpers (`dojo login` configures one).
 */
export function gitRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  const resolveTarget = async (
    path: string,
    c: { get: (k: 'actor') => Env['Variables']['actor']; req: { header: (n: string) => string | undefined } },
  ): Promise<Target | null> => {
    const orgId = await getOrgId(ctx);
    const actor = c.get('actor');
    const m = /^(s|suites)\/([^/]+)\/([^/]+?)\.git$|^t\/([^/]+?)\.git$/.exec(path);
    if (!m) return null;
    if (m[4]) {
      const ns = await getNamespace(ctx, orgId, m[4]).catch(() => null);
      if (!ns) return null;
      return {
        ns,
        build: async () => bundleSnapshot(ctx, `Team ${ns.displayName}`, await teamBundle(ctx, ns)),
        onFetch: () =>
          recordInstall(ctx, {
            orgId,
            channel: 'git',
            namespaceId: ns.id,
            actorId: actor?.userId,
            userAgent: c.req.header('user-agent'),
          }),
      };
    }
    if (m[1] === 's') {
      const found = await findSkill(ctx, orgId, m[2]!, m[3]!);
      if (!found) return null;
      let latest: string | null = null;
      return {
        ns: found.namespace,
        build: async () => {
          const r = await singleSkillSnapshot(ctx, found.skill.id);
          latest = r.latest;
          return r;
        },
        onFetch: () =>
          recordInstall(ctx, {
            orgId,
            channel: 'git',
            skillId: found.skill.id,
            skillVersionId: latest,
            namespaceId: found.namespace.id,
            actorId: actor?.userId,
            userAgent: c.req.header('user-agent'),
          }),
      };
    }
    const found = await findSuite(ctx, orgId, m[2]!, m[3]!);
    if (!found) return null;
    return {
      ns: found.namespace,
      build: async () =>
        bundleSnapshot(ctx, `Suite ${found.suite.displayName}`, await suiteBundle(ctx, found.suite.id)),
      onFetch: () =>
        recordInstall(ctx, {
          orgId,
          channel: 'git',
          suiteId: found.suite.id,
          namespaceId: found.namespace.id,
          actorId: actor?.userId,
          userAgent: c.req.header('user-agent'),
        }),
    };
  };

  app.get('/git/*', async (c) => {
    const rest = c.req.path.replace(/^\/git\//, '');
    if (!rest.endsWith('/info/refs') || c.req.query('service') !== 'git-upload-pack') {
      return c.text('Only smart HTTP fetch (git-upload-pack) is supported', 403);
    }
    const target = await resolveTarget(rest.replace(/\/info\/refs$/, ''), c);
    if (!target) return c.get('actor') ? c.text('Not found', 404) : unauthorizedGit();
    if (!(await canDownload(ctx, c.get('actor'), target.ns)))
      return c.get('actor') ? c.text('Not found', 404) : unauthorizedGit();
    const { key, snapshot } = await target.build();
    if (!snapshot.commits.length) return c.text('Nothing has been published here yet', 404);
    const repo = await materialize(ctx, key, snapshot);
    const refs = await runUploadPack(repo, ['--advertise-refs']);
    const head = new TextEncoder().encode(`${pktLine('# service=git-upload-pack\n')}0000`);
    const body = new Uint8Array(head.byteLength + refs.byteLength);
    body.set(head);
    body.set(refs, head.byteLength);
    return new Response(body, {
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
    });
  });

  app.post('/git/*', async (c) => {
    const rest = c.req.path.replace(/^\/git\//, '');
    if (!rest.endsWith('/git-upload-pack')) return c.text('Push is not supported', 403);
    const target = await resolveTarget(rest.replace(/\/git-upload-pack$/, ''), c);
    if (!target) return c.get('actor') ? c.text('Not found', 404) : unauthorizedGit();
    if (!(await canDownload(ctx, c.get('actor'), target.ns)))
      return c.get('actor') ? c.text('Not found', 404) : unauthorizedGit();
    const { key, snapshot } = await target.build();
    const repo = await materialize(ctx, key, snapshot);
    let input = new Uint8Array(await c.req.arrayBuffer());
    if (c.req.header('content-encoding') === 'gzip') {
      const { gunzipSync } = await import('node:zlib');
      input = new Uint8Array(gunzipSync(input));
    }
    const out = await runUploadPack(repo, [], input);
    if (new TextDecoder().decode(input.subarray(0, 200)).includes('want ')) await target.onFetch();
    return new Response(out as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
    });
  });
  return app;
}
