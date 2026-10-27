import { createDb, type Database } from '@dojohub/db';
import type { Config } from './config';
import { createAuth, type Auth } from './auth/auth';
import { SecretBox } from './lib/crypto';
import type { Jobs } from './lib/jobs';
import type { Logger } from './lib/logger';
import { type BlobStore, createBlobStore } from './lib/storage';
import type postgres from 'postgres';

export interface AppContext {
  config: Config;
  db: Database;
  sql: postgres.Sql;
  blobs: BlobStore;
  secrets: SecretBox;
  logger: Logger;
  jobs: Jobs;
  auth: Auth;
  close: () => Promise<void>;
}

export async function createContext(
  config: Config,
  logger: Logger,
  makeJobs: (url: string) => Promise<Jobs>,
  overrides: Partial<Pick<AppContext, 'blobs'>> = {},
): Promise<AppContext> {
  const handle = createDb(config.DATABASE_URL, { max: config.DATABASE_POOL });
  const ctx = {
    config,
    db: handle.db,
    sql: handle.sql,
    blobs: overrides.blobs ?? createBlobStore(config),
    secrets: new SecretBox(config.DOJO_SECRET_KEY),
    logger,
  } as AppContext;
  ctx.jobs = await makeJobs(config.DATABASE_URL);
  ctx.auth = createAuth(ctx);
  ctx.close = async () => {
    await ctx.jobs.boss?.stop({ graceful: true, timeout: 5000 }).catch(() => {});
    await handle.close();
  };
  return ctx;
}
