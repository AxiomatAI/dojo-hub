import { notification } from '@dojohub/db';
import type { AppContext } from '../context';

export async function notify(
  ctx: AppContext,
  orgId: string,
  userIds: string[],
  n: { kind: string; title: string; body?: string; link?: string },
) {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return;
  await ctx.db.insert(notification).values(unique.map((userId) => ({ orgId, userId, ...n })));
  if (ctx.config.SMTP_URL) {
    await ctx.jobs.send('email.send', { orgId, userIds: unique, subject: n.title, body: n.body ?? '', link: n.link });
  }
}
