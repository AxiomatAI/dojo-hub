import { serve } from '@hono/node-server';
import { runMigrations, user } from '@dojohub/db';
import { count } from 'drizzle-orm';
import { createApp } from './app';
import { loadConfig } from './config';
import { type AppContext, createContext } from './context';
import { randomToken } from './lib/crypto';
import { createInlineJobs, createJobs } from './lib/jobs';
import { createLogger } from './lib/logger';
import { getOrgId } from './services/org';
import { jobHandlers, startWorker } from './worker';

const command = process.argv[2] ?? 'server';
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production' && process.stdout.isTTY);

async function migrate() {
  logger.info('applying database migrations');
  await runMigrations(config.DATABASE_URL);
}

async function announceSetup(ctx: AppContext) {
  const [{ n }] = (await ctx.db.select({ n: count() }).from(user)) as [{ n: number }];
  if (n > 0) return;
  if (!config.DOJO_SETUP_TOKEN) config.DOJO_SETUP_TOKEN = randomToken(18);
  logger.info(`\n\n  DojoHub is not set up yet. Open this one-time link to create the first administrator:\n\n    ${config.DOJO_BASE_URL}/setup?token=${config.DOJO_SETUP_TOKEN}\n`);
}

async function main() {
  if (command === 'migrate') {
    await migrate();
    return;
  }
  if (process.env.DOJO_SKIP_MIGRATIONS !== 'true' && command !== 'worker') await migrate();

  if (command === 'seed') {
    const ctx = await createContext(config, logger, async () => createInlineJobs({}));
    ctx.jobs = createInlineJobs(jobHandlers(ctx) as never);
    const { seed } = await import('./seed');
    await seed(ctx);
    await ctx.close();
    return;
  }

  const ctx = await createContext(config, logger, (url) => createJobs(url, logger));
  await getOrgId(ctx);
  const shutdown = async () => {
    logger.info('shutting down');
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (command === 'server' || command === 'all') {
    const app = createApp(ctx);
    serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
      logger.info(`DojoHub listening on http://${info.address}:${info.port} (public URL ${config.DOJO_BASE_URL})`);
    });
    await announceSetup(ctx);
  }
  if (command === 'worker' || command === 'all' || (command === 'server' && config.DOJO_EMBEDDED_WORKER)) {
    await startWorker(ctx);
  }
  if (!['server', 'worker', 'all'].includes(command)) {
    logger.error(`unknown command "${command}" (expected server | worker | all | migrate | seed)`);
    process.exit(2);
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error');
  process.exit(1);
});
