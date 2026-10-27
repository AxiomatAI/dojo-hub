import { createHmac } from 'node:crypto';
import { webhook, webhookDelivery } from '@dojohub/db';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { EventEnvelope } from './events';

const TITLES: Record<string, string> = {
  'skill.submitted': 'Skill submitted',
  'version.scanned': 'Security scan finished',
  'review.requested': 'Review requested',
  'review.decided': 'Review decision',
  'version.published': 'Version published',
  'version.rejected': 'Version rejected',
  'version.deprecated': 'Version deprecated',
  'version.blocked': 'Version BLOCKED',
  'source.synced': 'Source synced',
  'source.update_available': 'Upstream updates available',
  'install.recorded': 'Install recorded',
};

function summarize(e: EventEnvelope): string {
  const d = e.data as Record<string, unknown>;
  const subject = d.skill ? `${d.skill}@${d.version ?? ''}` : d.suite ? `suite ${d.suite}@${d.version ?? ''}` : (d.subject ?? d.source ?? '');
  const extra = d.reason ? ` — ${d.reason}` : d.riskLevel ? ` — risk ${d.riskLevel}` : d.decision ? ` — ${d.decision}` : '';
  return `${TITLES[e.type] ?? e.type}: ${subject}${extra}`;
}

/** Render the payload for the webhook's format (raw JSON, Slack incoming webhook, Teams). */
export function renderPayload(format: 'json' | 'slack' | 'teams', e: EventEnvelope, baseUrl: string): unknown {
  if (format === 'slack') {
    return { text: summarize(e), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${summarize(e)}*\n<${baseUrl}|Open DojoHub>` } }] };
  }
  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [{ type: 'TextBlock', text: summarize(e), wrap: true, weight: 'Bolder' }],
            actions: [{ type: 'Action.OpenUrl', title: 'Open DojoHub', url: baseUrl }],
          },
        },
      ],
    };
  }
  return e;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Deliver one webhook attempt. Throws on failure so the job queue retries with backoff. */
export async function deliverWebhook(ctx: AppContext, deliveryId: string) {
  const [d] = await ctx.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId));
  if (!d || d.status === 'success') return;
  const [hook] = await ctx.db.select().from(webhook).where(eq(webhook.id, d.webhookId));
  if (!hook || !hook.active) return;
  const envelope = d.payload as EventEnvelope;
  const body = JSON.stringify(renderPayload(hook.format, envelope, ctx.config.DOJO_BASE_URL));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = ctx.secrets.decrypt(hook.secretEnc);
  const started = Date.now();
  let status: number | null = null;
  let text = '';
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DojoHub-Webhooks/1',
        'x-dojo-event': envelope.type,
        'x-dojo-event-id': envelope.id,
        'x-dojo-timestamp': timestamp,
        'x-dojo-signature': `sha256=${signPayload(secret, timestamp, body)}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    status = res.status;
    text = (await res.text()).slice(0, 2000);
  } catch (err) {
    text = (err as Error).message;
  }
  const ok = status !== null && status >= 200 && status < 300;
  await ctx.db
    .update(webhookDelivery)
    .set({
      status: ok ? 'success' : 'failed',
      attempts: sql`${webhookDelivery.attempts} + 1`,
      responseStatus: status,
      responseBody: text,
      durationMs: Date.now() - started,
      deliveredAt: ok ? new Date() : null,
    })
    .where(eq(webhookDelivery.id, d.id));
  if (!ok) throw new Error(`Webhook delivery failed (${status ?? 'network error'})`);
}
