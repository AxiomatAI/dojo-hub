import { source } from '@dojohub/db';
import { isNotNull } from 'drizzle-orm';
import type { AppContext } from './context';
import { QUEUES, type QueueName } from './lib/jobs';
import { runDirectorySync } from './services/directory';
import { processEmbedding, processScan } from './services/pipeline';
import { syncSource } from './services/sources';
import { processSuiteEvaluate } from './services/suites';
import { deliverWebhook } from './services/webhooks';
import { directorySync } from '@dojohub/db';

type Handler = (data: Record<string, unknown>) => Promise<void>;

export function jobHandlers(ctx: AppContext): Partial<Record<QueueName, Handler>> {
  return {
    [QUEUES.scan]: (d) => processScan(ctx, String(d.versionId), (d.kind as never) ?? null),
    [QUEUES.suiteEvaluate]: (d) => processSuiteEvaluate(ctx, d as never),
    [QUEUES.webhook]: (d) => deliverWebhook(ctx, String(d.deliveryId)),
    [QUEUES.embed]: (d) => processEmbedding(ctx, String(d.versionId)),
    [QUEUES.directorySync]: async (d) => {
      if (d.id) return runDirectorySync(ctx, String(d.id));
      const rows = await ctx.db.select({ id: directorySync.id }).from(directorySync);
      for (const r of rows) await ctx.jobs.send(QUEUES.directorySync, { id: r.id });
    },
    [QUEUES.sourceSync]: async (d) => {
      await syncSource(ctx, String(d.sourceId));
    },
    [QUEUES.sourceSyncAll]: async () => {
      // Sources with a schedule are synced by their own cron; this hourly sweep covers sources without one.
      const rows = await ctx.db.select({ id: source.id, syncCron: source.syncCron, kind: source.kind }).from(source).where(isNotNull(source.id));
      for (const r of rows) if (!r.syncCron && r.kind !== 'upload') await ctx.jobs.send(QUEUES.sourceSync, { sourceId: r.id }, { singletonKey: `sync:${r.id}` });
    },
    [QUEUES.email]: async (d) => {
      ctx.logger.info({ to: d.userIds, subject: d.subject }, 'email notification (SMTP delivery not configured in this build)');
    },
  };
}

export async function startWorker(ctx: AppContext) {
  const boss = ctx.jobs.boss;
  if (!boss) throw new Error('Worker requires pg-boss');
  const handlers = jobHandlers(ctx);
  for (const [queue, handler] of Object.entries(handlers)) {
    const concurrency = queue === QUEUES.scan ? 4 : queue === QUEUES.webhook ? 8 : 2;
    for (let i = 0; i < concurrency; i++) {
      await boss.work(queue, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler!(job.data as Record<string, unknown>);
          } catch (err) {
            ctx.logger.warn({ err, queue, jobId: job.id }, 'job failed');
            throw err;
          }
        }
      });
    }
  }
  await boss.schedule(QUEUES.sourceSyncAll, '0 */6 * * *');
  await boss.schedule(QUEUES.directorySync, '15 * * * *');
  // Per-source cron schedules.
  const scheduled = await ctx.db.select({ id: source.id, syncCron: source.syncCron }).from(source).where(isNotNull(source.syncCron));
  for (const s of scheduled) {
    const name = `${QUEUES.sourceSync}.${s.id}`;
    await boss.createQueue(name).catch(() => {});
    await boss.schedule(name, s.syncCron!, { sourceId: s.id }).catch((err: Error) => ctx.logger.warn({ err, source: s.id }, 'invalid cron'));
    await boss.work(name, async (jobs) => {
      for (const j of jobs) await syncSource(ctx, String((j.data as { sourceId: string }).sourceId));
    });
  }
  ctx.logger.info('worker started');
}
