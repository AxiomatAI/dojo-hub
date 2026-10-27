import { PgBoss } from 'pg-boss';
import type { Logger } from './logger';

export const QUEUES = {
  scan: 'version.scan',
  suiteEvaluate: 'suite.evaluate',
  webhook: 'webhook.deliver',
  sourceSync: 'source.sync',
  sourceSyncAll: 'source.sync-all',
  statsRollup: 'stats.rollup',
  directorySync: 'directory.sync',
  email: 'email.send',
  embed: 'version.embed',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface Jobs {
  send(
    queue: QueueName,
    data: object,
    opts?: { singletonKey?: string; startAfter?: number; retryLimit?: number },
  ): Promise<void>;
  boss: PgBoss | null;
}

export async function createJobs(url: string, logger: Logger): Promise<Jobs> {
  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q).catch(() => {});
  return {
    boss,
    async send(queue, data, opts) {
      await boss.send(queue, data, {
        retryLimit: opts?.retryLimit ?? 3,
        retryDelay: 10,
        retryBackoff: true,
        singletonKey: opts?.singletonKey,
        startAfter: opts?.startAfter,
      });
    },
  };
}

/** Inline job runner for tests: executes handlers synchronously. */
export function createInlineJobs(handlers: Partial<Record<QueueName, (data: never) => Promise<void>>>): Jobs {
  return {
    boss: null,
    async send(queue, data) {
      const h = handlers[queue] as ((d: object) => Promise<void>) | undefined;
      if (h) await h(data);
    },
  };
}
