import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as p from '@clack/prompts';
import { createTarGz, isValidSkillName, toSkillName, validateSkill } from '@dojohub/core';
import { defineCommand, runMain } from 'citty';
import pc from 'picocolors';
import { AGENTS, resolveAgents } from './agents';
import { createClient, DojoError } from './client';
import { deleteToken, getToken, loadConfig, normalizeUrl, registryName, saveConfig, setToken } from './config';
import { dojoEntries, fetchSkill, installSkill, readLock, readSkillDir, removeSkill } from './install';

const exec = promisify(execFile);
const VERSION = '0.1.0';

const common = {
  registry: { type: 'string', description: 'Registry URL or host (defaults to the current context)' },
} as const;
const installArgs = {
  ...common,
  agent: { type: 'string', alias: 'a', description: `Agents to install for (comma separated, or "*"): ${AGENTS.map((a) => a.id).join(', ')}` },
  global: { type: 'boolean', alias: 'g', description: 'Install for the current user instead of the project' },
} as const;

const fail = (err: unknown): never => {
  const msg = err instanceof DojoError ? `${err.message}${err.status === 401 ? ' (try `dojo login`)' : ''}` : (err as Error).message;
  p.log.error(pc.red(msg));
  process.exit(1);
};

/** Parse `@ns/name@1.2.0` | `name@^1` | `name`. */
function parseRef(ref: string): { ns?: string; name: string; version?: string } {
  const m = /^(?:@([a-z0-9-]+)\/)?([a-z0-9-]+)(?:@(.+))?$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid skill reference "${ref}" (expected @team/skill[@version])`);
  return { ns: m[1], name: m[2]!, version: m[3] };
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* user can open manually */
  }
}

function pickVersion(versions: { version: string; status: string }[], wanted?: string): string | null {
  const installable = versions.filter((v) => v.status === 'approved' || v.status === 'deprecated');
  if (!wanted || wanted === 'latest') return (installable.find((v) => v.status === 'approved') ?? installable[0])?.version ?? null;
  if (installable.some((v) => v.version === wanted)) return wanted;
  // simple caret/tilde/major support without pulling semver into the CLI bundle
  const m = /^[\^~]?(\d+)(?:\.(\d+))?/.exec(wanted);
  if (!m) return null;
  const match = installable.find((v) => {
    const [maj, min] = v.version.split('.');
    return maj === m[1] && (wanted.startsWith('^') || !m[2] || min === m[2]);
  });
  return match?.version ?? null;
}

const login = defineCommand({
  meta: { name: 'login', description: 'Sign in to a DojoHub registry (OAuth device flow)' },
  args: {
    url: { type: 'positional', required: false, description: 'Registry URL, e.g. https://skills.acme.com' },
    token: { type: 'string', description: 'Use an existing access token instead of the browser flow' },
    'git-helper': { type: 'boolean', description: 'Configure git to authenticate `npx skills` installs from this registry', default: undefined },
  },
  async run({ args }) {
    p.intro(pc.bgMagenta(pc.white(' dojo login ')));
    const cfg = await loadConfig();
    let url = args.url as string | undefined;
    if (!url) {
      const v = await p.text({ message: 'Registry URL', placeholder: 'https://skills.example.com', initialValue: cfg.current ? cfg.registries[cfg.current]?.url : undefined });
      if (p.isCancel(v)) process.exit(1);
      url = v;
    }
    url = normalizeUrl(url);
    const name = registryName(url);
    let token = args.token as string | undefined;
    if (!token) {
      const start = await fetch(`${url}/api/v1/cli/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientName: `dojo CLI (${process.env.USER ?? 'user'}@${process.platform})` }) }).catch(fail);
      if (!start.ok) fail(new Error(`${url} does not look like a DojoHub registry (HTTP ${start.status})`));
      const d = (await start.json()) as { deviceCode: string; userCode: string; verificationUriComplete: string; interval: number; expiresIn: number };
      p.note(`${pc.bold(d.userCode)}\n\n${pc.dim('Confirm this code in your browser:')}\n${pc.cyan(d.verificationUriComplete)}`, 'Device login');
      openBrowser(d.verificationUriComplete);
      const s = p.spinner();
      s.start('Waiting for approval…');
      const deadline = Date.now() + d.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.max(2, d.interval) * 1000));
        const res = await fetch(`${url}/api/v1/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: d.deviceCode }) });
        const body = (await res.json()) as { accessToken?: string; error?: string };
        if (body.accessToken) {
          token = body.accessToken;
          break;
        }
        if (body.error && !['authorization_pending', 'slow_down'].includes(body.error)) {
          s.stop(pc.red(`Login failed: ${body.error}`));
          process.exit(1);
        }
      }
      if (!token) {
        s.stop(pc.red('Login timed out'));
        process.exit(1);
      }
      s.stop('Approved');
    }
    const me = await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!me.ok) fail(new Error('The token was rejected by the registry'));
    const user = (await me.json()) as { name: string; email: string; orgName: string };
    const where = await setToken(name, token);
    cfg.registries[name] = { url, user: { name: user.name, email: user.email } };
    cfg.current = name;
    await saveConfig(cfg);
    p.log.success(`Logged in to ${pc.bold(user.orgName)} as ${user.email} ${pc.dim(`(token stored in ${where})`)}`);
    let helper = args['git-helper'] as boolean | undefined;
    if (helper === undefined && process.stdin.isTTY) {
      const v = await p.confirm({ message: 'Let git (and `npx skills`) authenticate to this registry with your token?', initialValue: true });
      helper = !p.isCancel(v) && v;
    }
    if (helper) await configureGitHelper(url);
    p.outro(`Try ${pc.cyan('dojo search')} or ${pc.cyan('dojo sync --team <team>')}`);
  },
});

async function configureGitHelper(url: string) {
  const self = process.argv[1] && existsSync(process.argv[1]) ? `${process.execPath} ${resolve(process.argv[1])}` : 'dojo';
  try {
    await exec('git', ['config', '--global', `credential.${url}.helper`, `!${self} credential`]);
    p.log.info(`Configured git credential helper for ${url}`);
  } catch (err) {
    p.log.warn(`Could not configure git: ${(err as Error).message}`);
  }
}

const logout = defineCommand({
  meta: { name: 'logout', description: 'Remove stored credentials for a registry' },
  args: { ...common },
  async run({ args }) {
    const cfg = await loadConfig();
    const name = args.registry ? registryName(normalizeUrl(args.registry)) : cfg.current;
    if (!name) return fail(new Error('Not logged in'));
    await deleteToken(name);
    delete cfg.registries[name];
    if (cfg.current === name) cfg.current = Object.keys(cfg.registries)[0];
    await saveConfig(cfg);
    p.log.success(`Logged out of ${name}`);
  },
});

const whoami = defineCommand({
  meta: { name: 'whoami', description: 'Show the current user and registry' },
  args: { ...common },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const me = await c.request<{ name: string; email: string; role: string; orgName: string; namespaces: { slug: string; role: string }[] }>('GET', '/me').catch(fail);
    console.log(`${pc.bold(me.name)} <${me.email}> — ${me.role} @ ${me.orgName} (${c.url})`);
    if (me.namespaces.length) console.log(pc.dim(`teams: ${me.namespaces.map((n) => `@${n.slug} (${n.role})`).join(', ')}`));
  },
});

const context = defineCommand({
  meta: { name: 'context', description: 'List or switch registries (like `docker context`)' },
  subCommands: {
    ls: defineCommand({
      meta: { name: 'ls', description: 'List registries' },
      async run() {
        const cfg = await loadConfig();
        for (const [name, r] of Object.entries(cfg.registries)) console.log(`${name === cfg.current ? pc.green('*') : ' '} ${pc.bold(name)}  ${pc.dim(r.url)}  ${r.user?.email ?? ''}`);
      },
    }),
    use: defineCommand({
      meta: { name: 'use', description: 'Switch the current registry' },
      args: { name: { type: 'positional', required: true } },
      async run({ args }) {
        const cfg = await loadConfig();
        const name = cfg.registries[args.name] ? args.name : registryName(normalizeUrl(args.name));
        if (!cfg.registries[name]) return fail(new Error(`Unknown registry ${args.name}`));
        cfg.current = name;
        await saveConfig(cfg);
        p.log.success(`Using ${name}`);
      },
    }),
  },
});

const search = defineCommand({
  meta: { name: 'search', description: 'Search approved skills' },
  args: { ...common, query: { type: 'positional', required: false }, team: { type: 'string' } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const qs = new URLSearchParams({ status: 'approved,deprecated', pageSize: '30', sort: 'installs' });
    if (args.query) qs.set('q', args.query);
    if (args.team) qs.set('team', args.team);
    const res = await c.request<{ items: { name: string; namespace: string; summary: string; publishedVersion: string; installCount: number; riskLevel: string }[] }>('GET', `/skills?${qs}`).catch(fail);
    if (!res.items.length) return console.log(pc.dim('No skills found'));
    for (const s of res.items) {
      console.log(`${pc.bold(`@${s.namespace}/${s.name}`)} ${pc.dim(`v${s.publishedVersion} · ${s.installCount} installs · risk ${s.riskLevel ?? 'n/a'}`)}`);
      console.log(`  ${s.summary.slice(0, 110)}`);
    }
  },
});

const info = defineCommand({
  meta: { name: 'info', description: 'Show details of a skill' },
  args: { ...common, skill: { type: 'positional', required: true } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const ref = parseRef(args.skill);
    const s = await fetchSkill(c, ref.name).catch(fail);
    console.log(`${pc.bold(`@${s.namespace}/${s.name}`)}  ${s.status}`);
    console.log(s.summary);
    console.log(pc.dim(`git: ${s.install.gitUrl}`));
    for (const v of s.versions.slice(0, 10)) console.log(`  ${v.version.padEnd(10)} ${v.status}`);
  },
});

async function doInstall(refs: string[], args: { registry?: string; agent?: string; global?: boolean }, update = false) {
  const c = await createClient({ registry: args.registry }).catch(fail);
  const agents = resolveAgents(args.agent?.split(',').map((x) => x.trim()));
  for (const raw of refs) {
    const ref = parseRef(raw);
    const s = p.spinner();
    s.start(`Installing ${ref.name}`);
    try {
      const skill = await fetchSkill(c, ref.name);
      if (ref.ns && skill.namespace !== ref.ns) throw new Error(`${ref.name} belongs to @${skill.namespace}, not @${ref.ns}`);
      const version = pickVersion(skill.versions, ref.version);
      if (!version) throw new Error(`No installable version of ${ref.name}${ref.version ? ` matching ${ref.version}` : ''}`);
      const r = await installSkill(c, skill, version, { agents, global: !!args.global, cwd: process.cwd(), update });
      s.stop(`${pc.green('✓')} ${skill.name}@${r.version} → ${pc.dim(r.path)}`);
      for (const w of r.warnings) p.log.warn(w);
    } catch (err) {
      s.stop(pc.red(`✗ ${ref.name}: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  }
  p.log.info(pc.dim(`Agents: ${agents.map((a) => a.name).join(', ')}`));
}

const add = defineCommand({
  meta: { name: 'add', description: 'Install skills (@team/skill[@version]) or a suite (--suite @team/suite)' },
  args: { ...installArgs, refs: { type: 'positional', required: true, description: 'Skill references' }, suite: { type: 'boolean', description: 'Install a whole suite' } },
  async run({ args }) {
    const refs = [args.refs, ...((args._ as string[]) ?? []).slice(1)].filter(Boolean) as string[];
    if (args.suite) {
      const c = await createClient({ registry: args.registry }).catch(fail);
      for (const r of refs) {
        const m = /^@([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(r);
        if (!m) fail(new Error('Suites are referenced as @team/suite'));
        const suite = await c.request<{ members: { name: string; version: string }[] }>('GET', `/suites/${m![1]}/${m![2]}`).catch(fail);
        await doInstall(suite.members.map((x) => `${x.name}@${x.version}`), args);
      }
      return;
    }
    await doInstall(refs, args);
  },
});

const list = defineCommand({
  meta: { name: 'list', description: 'List skills installed by dojo in this project (or -g)' },
  args: { global: { type: 'boolean', alias: 'g' } },
  async run({ args }) {
    const lock = await readLock({ global: !!args.global, cwd: process.cwd() });
    const entries = dojoEntries(lock);
    if (!entries.length) return console.log(pc.dim('No dojo-managed skills installed'));
    for (const [name, e] of entries) console.log(`${pc.bold(name)} ${e.dojo.version} ${pc.dim(`@${e.dojo.namespace} · ${e.dojo.registry}`)}`);
  },
});

const update = defineCommand({
  meta: { name: 'update', description: 'Update installed skills to their latest approved versions' },
  args: { ...installArgs, skills: { type: 'positional', required: false } },
  async run({ args }) {
    const lock = await readLock({ global: !!args.global, cwd: process.cwd() });
    const c = await createClient({ registry: args.registry }).catch(fail);
    const only = args.skills ? [args.skills, ...((args._ as string[]) ?? []).slice(1)] : null;
    const todo: string[] = [];
    for (const [name, e] of dojoEntries(lock)) {
      if (only && !only.includes(name)) continue;
      const s = await fetchSkill(c, name).catch(() => null);
      const latest = s && pickVersion(s.versions);
      if (latest && latest !== e.dojo.version) todo.push(`${name}@${latest}`);
    }
    if (!todo.length) return p.log.success('Everything is up to date');
    await doInstall(todo, args, true);
  },
});

const remove = defineCommand({
  meta: { name: 'remove', description: 'Uninstall skills' },
  args: { ...installArgs, skills: { type: 'positional', required: true } },
  async run({ args }) {
    const names = [args.skills, ...((args._ as string[]) ?? []).slice(1)];
    const agents = args.agent ? resolveAgents(args.agent.split(',')) : AGENTS;
    for (const n of names) {
      await removeSkill(n, { agents, global: !!args.global, cwd: process.cwd() });
      p.log.success(`Removed ${n}`);
    }
  },
});

const sync = defineCommand({
  meta: { name: 'sync', description: "Install everything a team requires and recommends (use --level to filter)" },
  args: { ...installArgs, team: { type: 'string', required: true, description: 'Team slug' }, level: { type: 'string', description: 'required | recommended | optional (default: required,recommended)' } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const levels = (args.level ?? 'required,recommended').split(',');
    const team = await c
      .request<{ catalog: { level: string; pinnedVersion: string | null; skill: { name: string } | null; suite: { name: string; namespace: string } | null }[] }>('GET', `/namespaces/${args.team}`)
      .catch(fail);
    const refs: string[] = [];
    for (const e of team.catalog.filter((x) => levels.includes(x.level))) {
      if (e.skill) refs.push(`${e.skill.name}${e.pinnedVersion ? `@${e.pinnedVersion}` : ''}`);
      if (e.suite) {
        const suite = await c.request<{ members: { name: string; version: string }[] }>('GET', `/suites/${e.suite.namespace}/${e.suite.name}`).catch(fail);
        refs.push(...suite.members.map((m) => `${m.name}@${m.version}`));
      }
    }
    if (!refs.length) return p.log.info(`@${args.team} has no ${levels.join('/')} skills`);
    await doInstall([...new Set(refs)], args);
  },
});

const audit = defineCommand({
  meta: { name: 'audit', description: 'Check installed skills for blocked, deprecated or outdated versions' },
  args: { ...common, global: { type: 'boolean', alias: 'g' } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const lock = await readLock({ global: !!args.global, cwd: process.cwd() });
    let problems = 0;
    for (const [name, e] of dojoEntries(lock)) {
      const s = await fetchSkill(c, name).catch(() => null);
      const v = s?.versions.find((x) => x.version === e.dojo.version);
      const latest = s && pickVersion(s.versions);
      if (!s || !v) {
        console.log(`${pc.yellow('?')} ${name}@${e.dojo.version} not found in registry`);
        problems++;
      } else if (v.status === 'blocked') {
        console.log(`${pc.red('✗')} ${name}@${v.version} is ${pc.red('BLOCKED')} — remove it: dojo remove ${name}`);
        problems++;
      } else if (v.status === 'deprecated') {
        console.log(`${pc.yellow('!')} ${name}@${v.version} is deprecated${latest && latest !== v.version ? ` — update to ${latest}` : ''}`);
        problems++;
      } else if (latest && latest !== v.version) console.log(`${pc.cyan('↑')} ${name}@${v.version} → ${latest} available`);
      else console.log(`${pc.green('✓')} ${name}@${v.version}`);
    }
    if (problems) process.exitCode = 2;
  },
});

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: Describe what this skill does and when an agent should use it (max 1024 characters).
license: Apache-2.0
---

# ${name}

## When to use

- …

## Instructions

1. …
`;

const init = defineCommand({
  meta: { name: 'init', description: 'Scaffold a new skill directory' },
  args: { name: { type: 'positional', required: false } },
  async run({ args }) {
    let name = args.name as string | undefined;
    if (!name) {
      const v = await p.text({ message: 'Skill name', placeholder: 'my-skill', validate: (s) => (s && isValidSkillName(toSkillName(s)) ? undefined : 'Use lowercase letters, digits and hyphens') });
      if (p.isCancel(v)) process.exit(1);
      name = v;
    }
    name = toSkillName(name);
    const dir = resolve(name);
    if (existsSync(join(dir, 'SKILL.md'))) return fail(new Error(`${dir}/SKILL.md already exists`));
    await mkdir(join(dir, 'references'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), SKILL_TEMPLATE(name));
    p.log.success(`Created ${dir}/SKILL.md — edit it, then run ${pc.cyan(`dojo submit ${name} --namespace <team>`)}`);
  },
});

const submit = defineCommand({
  meta: { name: 'submit', description: 'Submit a skill directory (new skill or new version) for review' },
  args: {
    ...common,
    dir: { type: 'positional', required: false, default: '.' },
    namespace: { type: 'string', alias: 'n', required: true, description: 'Target team/namespace' },
    version: { type: 'string', description: 'Semantic version (default: automatic bump)' },
    changelog: { type: 'string', alias: 'm' },
    draft: { type: 'boolean', description: 'Save as draft without submitting' },
  },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const dir = resolve(args.dir as string);
    const files = await readSkillDir(dir);
    const v = validateSkill(files, dir.split(/[\\/]/).pop());
    for (const i of v.issues) (i.level === 'error' ? p.log.error : p.log.warn)(i.message);
    if (!v.ok) process.exit(1);
    const archive = createTarGz(files);
    const qs = new URLSearchParams({ namespace: args.namespace, submit: String(!args.draft) });
    if (args.version) qs.set('version', args.version);
    if (args.changelog) qs.set('changelog', args.changelog);
    const s = p.spinner();
    s.start(`Uploading ${files.size} files`);
    const res = await c.request<{ skill: string; version: string; status: string }>('POST', `/skills/upload?${qs}`, archive).catch((e) => {
      s.stop('Upload failed');
      return fail(e);
    });
    s.stop(`${pc.green('✓')} ${res.skill}@${res.version} ${res.status}`);
    p.log.info(`Track it: ${pc.cyan(`${c.url}/skills/${res.skill}/versions/${res.version}`)}  or  dojo status ${res.skill}@${res.version}`);
  },
});

const status = defineCommand({
  meta: { name: 'status', description: 'Show the trust status, scan result and review progress of a version' },
  args: { ...common, ref: { type: 'positional', required: true, description: 'skill@version' } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const ref = parseRef(args.ref);
    const s = await fetchSkill(c, ref.name).catch(fail);
    const version = ref.version ?? s.versions[0]?.version;
    const v = await c
      .request<{ version: string; status: string; statusReason: string | null; riskLevel: string | null; riskScore: number | null; scans: { analyzer: string; verdict: string | null; findings: unknown[] }[]; review: { id: string } | null }>(
        'GET',
        `/skills/${ref.name}/versions/${version}`,
      )
      .catch(fail);
    console.log(`${pc.bold(`${ref.name}@${v.version}`)}  ${v.status}  risk ${v.riskLevel ?? 'n/a'}${v.riskScore ? ` (${v.riskScore})` : ''}`);
    if (v.statusReason) console.log(pc.dim(v.statusReason));
    for (const sc of v.scans) console.log(`  ${sc.analyzer.padEnd(16)} ${sc.verdict ?? '-'}  ${sc.findings.length} findings`);
    if (v.review) console.log(pc.dim(`review: ${c.url}/reviews/${v.review.id}`));
  },
});

const importCmd = defineCommand({
  meta: { name: 'import', description: 'Add an upstream repository (GitHub, GitLab, git, well-known) as a source' },
  args: { ...common, url: { type: 'positional', required: true }, namespace: { type: 'string', alias: 'n', required: true }, ref: { type: 'string' }, prefix: { type: 'string', description: 'Name prefix for imported skills' } },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    const kind = /gitlab/.test(args.url) ? 'gitlab' : /^https?:\/\/(?!github\.com)/.test(args.url) && !args.url.endsWith('.git') ? 'well_known' : /github\.com|^[\w.-]+\/[\w.-]+$/.test(args.url) ? 'github' : 'git';
    const res = await c
      .request<{ id: string; itemCounts: Record<string, number> }>('POST', '/sources', { namespace: args.namespace, kind, name: args.url, url: args.url, ref: args.ref, namePrefix: args.prefix })
      .catch(fail);
    p.log.success(`Source added (${res.itemCounts.new ?? 0} new items). Pick what to import: ${c.url}/sources/${res.id}`);
  },
});

const credential = defineCommand({
  meta: { name: 'credential', description: 'git credential helper (configured by `dojo login`)' },
  args: { op: { type: 'positional', required: false, default: 'get' } },
  async run({ args }) {
    if (args.op !== 'get') return;
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const fields = Object.fromEntries(input.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const cfg = await loadConfig();
    const host = fields.host;
    const name = Object.keys(cfg.registries).find((n) => n === host || new URL(cfg.registries[n]!.url).host === host);
    if (!name) return;
    const token = await getToken(name);
    if (token) process.stdout.write(`username=dojo\npassword=${token}\n`);
  },
});

const setupSkills = defineCommand({
  meta: { name: 'setup-skills', description: 'Configure the standard `npx skills` CLI to work with this registry' },
  args: { ...common },
  async run({ args }) {
    const c = await createClient({ registry: args.registry }).catch(fail);
    await configureGitHelper(c.url);
    p.note(`export DISABLE_TELEMETRY=1\nexport SKILLS_API_URL=${c.url}\n\nnpx skills add ${c.url}/t/<team>\nnpx skills add ${c.url}/git/t/<private-team>.git`, 'Add to your shell profile');
  },
});

const main = defineCommand({
  meta: { name: 'dojo', version: VERSION, description: 'DojoHub CLI — governed AI agent skills for your organisation' },
  subCommands: {
    login,
    logout,
    whoami,
    context,
    search,
    info,
    add,
    install: add,
    list,
    ls: list,
    update,
    remove,
    rm: remove,
    sync,
    audit,
    init,
    submit,
    publish: submit,
    status,
    import: importCmd,
    credential,
    'setup-skills': setupSkills,
  },
});

void runMain(main);
