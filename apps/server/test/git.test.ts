import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileMapFromRecord } from '@dojohub/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { materialize, type Snapshot } from '../src/distribution/git';
import { ingestVersion } from '../src/services/skills';

const exec = promisify(execFile);
const SKILL = '---\nname: demo\ndescription: Demo skill\n---\nbody\n';
let dir: string;
let marker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dojo-git-'));
  marker = join(dir, 'pwned');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const ctxFor = (cacheDir: string) => ({ config: { DOJO_GIT_CACHE_DIR: cacheDir } }) as unknown as AppContext;
const snapshot = (files: Record<string, string>): Snapshot => ({
  commits: [
    { tag: 'v1.0.0', message: '1.0.0', date: new Date(0), files: async () => fileMapFromRecord(files) },
  ],
});
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const hook = () => `#!/bin/sh\ntouch '${marker}'\n`;

describe('git materialisation', () => {
  it('installs nested scripts, references and assets', async () => {
    const repo = await materialize(
      ctxFor(join(dir, 'cache')),
      'ok',
      snapshot({
        'SKILL.md': SKILL,
        'scripts/run.sh': '#!/bin/sh\necho ok\n',
        'references/api/guide.md': '# Guide\n',
        'assets/logo.svg': '<svg/>',
      }),
    );
    const { stdout } = await exec('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'v1.0.0']);
    expect(stdout.trim().split('\n').sort()).toEqual([
      'SKILL.md',
      'assets/logo.svg',
      'references/api/guide.md',
      'scripts/run.sh',
    ]);
    expect((await stat(join(repo, 'scripts/run.sh'))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(repo, 'references/api/guide.md'), 'utf8')).toBe('# Guide\n');
  });

  it.each([
    '.git/hooks/pre-commit',
    '.GIT/hooks/post-commit',
    '.git./hooks/pre-commit',
    '../../escape.sh',
    '/abs/pre-commit',
    'a\\..\\..\\x',
  ])('refuses %s before writing anything', async (path) => {
    const cache = join(dir, 'cache');
    await expect(
      materialize(ctxFor(cache), 'bad', snapshot({ 'SKILL.md': SKILL, [path]: hook() })),
    ).rejects.toThrow(/unsafe/i);
    expect(await exists(marker)).toBe(false);
    expect(await exists(join(cache, 'bad'))).toBe(false);
    expect(await exists(join(dir, 'escape.sh'))).toBe(false);
  });

  it('never reads work-tree config or runs hooks and fsmonitor commands', async () => {
    const repo = await materialize(
      ctxFor(join(dir, 'cache')),
      'cfg',
      snapshot({
        'SKILL.md': SKILL,
        '.gitconfig': `[core]\n\tfsmonitor = touch '${marker}'\n\thooksPath = hooks\n`,
        'hooks/pre-commit': hook(),
        'hooks/post-commit': hook(),
      }),
    );
    expect(await exists(marker)).toBe(false);
    expect(await exists(join(repo, '.git', 'hooks'))).toBe(false);
  });
});

describe('ingestion path validation', () => {
  // Any DB or blob access means the request got past validation.
  const poisoned = new Proxy(
    {},
    {
      get: (_, k) => {
        throw new Error(`touched ctx.${String(k)}`);
      },
    },
  ) as AppContext;

  it.each(['.git/hooks/pre-commit', '/etc/cron.d/x', '../x', 'scripts\\run.sh', 'a\u0000b', 'SKILL.MD'])(
    'rejects %s before any storage write',
    async (path) => {
      await expect(
        ingestVersion(poisoned, {
          orgId: 'o',
          ns: {} as never,
          files: fileMapFromRecord({ 'SKILL.md': SKILL, [path]: hook() }),
          actorId: 'u',
          submit: true,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'unsafe_path' });
    },
  );
});
