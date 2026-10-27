import type { InstallChannel } from '@dojohub/contract';
import { dailyStat, installEvent, skill, skillVersion, suite } from '@dojohub/db';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { sha256 } from '../lib/crypto';
import { emit } from './events';

export interface InstallInput {
  orgId: string;
  channel: InstallChannel;
  skillId?: string | null;
  skillVersionId?: string | null;
  suiteId?: string | null;
  namespaceId?: string | null;
  actorId?: string | null;
  isUpdate?: boolean;
  userAgent?: string | null;
  clientIp?: string | null;
}

/** Record an install/download and bump counters + daily rollups. */
export async function recordInstall(ctx: AppContext, input: InstallInput) {
  try {
    await ctx.db.insert(installEvent).values({
      orgId: input.orgId,
      channel: input.channel,
      skillId: input.skillId ?? null,
      skillVersionId: input.skillVersionId ?? null,
      suiteId: input.suiteId ?? null,
      namespaceId: input.namespaceId ?? null,
      actorId: input.actorId ?? null,
      isUpdate: !!input.isUpdate,
      userAgent: input.userAgent?.slice(0, 200) ?? null,
      clientHash: input.clientIp
        ? sha256(`${input.clientIp}:${new Date().toISOString().slice(0, 10)}`).slice(0, 16)
        : null,
    });
    const day = new Date().toISOString().slice(0, 10);
    const subjects: ['skill' | 'suite', string][] = [];
    if (input.skillId) subjects.push(['skill', input.skillId]);
    if (input.suiteId) subjects.push(['suite', input.suiteId]);
    for (const [subjectType, subjectId] of subjects) {
      await ctx.db
        .insert(dailyStat)
        .values({
          orgId: input.orgId,
          day,
          subjectType,
          subjectId,
          channel: input.channel,
          installs: input.isUpdate ? 0 : 1,
          updates: input.isUpdate ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [
            dailyStat.orgId,
            dailyStat.day,
            dailyStat.subjectType,
            dailyStat.subjectId,
            dailyStat.channel,
          ],
          set: input.isUpdate
            ? { updates: sql`${dailyStat.updates} + 1` }
            : { installs: sql`${dailyStat.installs} + 1` },
        });
    }
    if (input.skillId && !input.isUpdate) {
      await ctx.db
        .update(skill)
        .set({ installCount: sql`${skill.installCount} + 1` })
        .where(eq(skill.id, input.skillId));
    }
    if (input.skillVersionId && !input.isUpdate) {
      await ctx.db
        .update(skillVersion)
        .set({ installCount: sql`${skillVersion.installCount} + 1` })
        .where(eq(skillVersion.id, input.skillVersionId));
    }
    if (input.suiteId && !input.isUpdate) {
      await ctx.db
        .update(suite)
        .set({ installCount: sql`${suite.installCount} + 1` })
        .where(eq(suite.id, input.suiteId));
    }
    await emit(ctx, input.orgId, 'install.recorded', {
      channel: input.channel,
      skillId: input.skillId,
      versionId: input.skillVersionId,
      suiteId: input.suiteId,
      isUpdate: !!input.isUpdate,
    });
  } catch (err) {
    ctx.logger.warn({ err }, 'failed to record install');
  }
}
