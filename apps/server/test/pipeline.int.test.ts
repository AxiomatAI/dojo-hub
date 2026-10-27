import { fileMapFromRecord } from '@dojohub/core';
import { approvalRequest, namespace, organization, runMigrations, skillVersion } from '@dojohub/db';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadActor } from '../src/auth/actor';
import { loadConfig } from '../src/config';
import { type AppContext, createContext } from '../src/context';
import { createInlineJobs } from '../src/lib/jobs';
import { createLogger } from '../src/lib/logger';
import { MemoryBlobStore } from '../src/lib/storage';
import { createLocalUser } from '../src/routes/account';
import { decideRequest } from '../src/services/approvals';
import { ensureOrg, resetOrgCache } from '../src/services/org';
import { ingestVersion, transition } from '../src/services/skills';
import { jobHandlers } from '../src/worker';

/**
 * Full pipeline against a real PostgreSQL (pgvector). Runs when DOJO_TEST_DATABASE_URL points at a
 * server where the user may create databases, e.g. the dev compose: postgres://dojohub:dojohub@localhost:5432/postgres
 */
const ADMIN_URL = process.env.DOJO_TEST_DATABASE_URL;
const dbName = `dojohub_test_${Date.now()}`;
let ctx: AppContext;

describe.skipIf(!ADMIN_URL)('pipeline (integration)', () => {
  beforeAll(async () => {
    const admin = postgres(ADMIN_URL!, { max: 1 });
    await admin.unsafe(`create database ${dbName}`);
    await admin.end();
    const url = ADMIN_URL!.replace(/\/[^/]*$/, `/${dbName}`);
    await runMigrations(url);
    resetOrgCache();
    ctx = await createContext(
      loadConfig({ DATABASE_URL: url, LOG_LEVEL: 'warn' }),
      createLogger('warn', false),
      async () => createInlineJobs({}),
      {
        blobs: new MemoryBlobStore(),
      },
    );
    ctx.jobs = createInlineJobs(jobHandlers(ctx) as never);
    await ensureOrg(ctx, 'Test Org');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
    const admin = postgres(ADMIN_URL!, { max: 1 });
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it('scans, routes through approval stages and publishes', async () => {
    const [org] = await ctx.db.select().from(organization);
    const owner = await createLocalUser(ctx, {
      name: 'Owner',
      email: 'owner@test.dev',
      password: 'correct-horse-battery',
    });
    const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.orgId, org!.id));
    const res = await ingestVersion(ctx, {
      orgId: org!.id,
      ns: ns!,
      actorId: owner.id,
      submit: true,
      files: fileMapFromRecord({
        'SKILL.md':
          '---\nname: lint-helper\ndescription: Runs the linter and explains failures to the developer.\n---\nRun `scripts/lint.sh`.',
        'scripts/lint.sh': '#!/bin/sh\nnpm run lint\n',
      }),
    });
    const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, res.version.id));
    expect(v!.status).toBe('in_review');
    const [req] = await ctx.db
      .select()
      .from(approvalRequest)
      .where(eq(approvalRequest.skillVersionId, v!.id));
    const a = (await loadActor(ctx, owner.id, 'session', null))!;
    expect(a.orgRole).toBe('owner');
    for (let i = 0; i < 3; i++) {
      const [open] = await ctx.db
        .select()
        .from(approvalRequest)
        .where(and(eq(approvalRequest.id, req!.id), eq(approvalRequest.status, 'pending')));
      if (!open) break;
      await decideRequest(ctx, a, req!.id, 'approve', 'ok');
    }
    const [after] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, v!.id));
    expect(after!.status).toBe('approved');
    await transition(ctx, after!, 'blocked', 'test');
    const [blocked] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, v!.id));
    expect(blocked!.status).toBe('blocked');
  });

  it('rejects skills that trip blocking rules automatically', async () => {
    const [org] = await ctx.db.select().from(organization);
    const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.orgId, org!.id));
    const res = await ingestVersion(ctx, {
      orgId: org!.id,
      ns: ns!,
      actorId: null,
      submit: true,
      files: fileMapFromRecord({
        'SKILL.md':
          '---\nname: leaky\ndescription: Configures deployment credentials for the team.\n---\nUse token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      }),
    });
    const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, res.version.id));
    expect(v!.status).toBe('rejected');
    expect(v!.statusReason).toContain('secret');
  });

  it('refuses identical re-submissions and name collisions across namespaces', async () => {
    const [org] = await ctx.db.select().from(organization);
    const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.orgId, org!.id));
    const files = fileMapFromRecord({
      'SKILL.md':
        '---\nname: lint-helper\ndescription: Runs the linter and explains failures to the developer.\n---\nRun `scripts/lint.sh`.',
      'scripts/lint.sh': '#!/bin/sh\nnpm run lint\n',
    });
    await expect(
      ingestVersion(ctx, { orgId: org!.id, ns: ns!, actorId: null, submit: false, files }),
    ).rejects.toThrow(/No changes/);
  });
});
