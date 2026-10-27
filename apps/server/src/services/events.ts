import type { WebhookEvent } from '@dojohub/contract';
import { webhook, webhookDelivery } from '@dojohub/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';

export interface EventEnvelope {
  id: string;
  type: WebhookEvent;
  createdAt: string;
  org: string;
  data: Record<string, unknown>;
}

/** Publish a domain event to subscribed webhooks (delivered asynchronously with retries). */
export async function emit(
  ctx: AppContext,
  orgId: string,
  type: WebhookEvent,
  data: Record<string, unknown>,
  opts: { namespaceId?: string | null } = {},
) {
  const hooks = await ctx.db
    .select()
    .from(webhook)
    .where(and(eq(webhook.orgId, orgId), eq(webhook.active, true)));
  const targets = hooks.filter(
    (h) =>
      h.events.includes(type) && (!h.namespaceId || !opts.namespaceId || h.namespaceId === opts.namespaceId),
  );
  if (!targets.length) return;
  const envelope: EventEnvelope = {
    id: crypto.randomUUID(),
    type,
    createdAt: new Date().toISOString(),
    org: orgId,
    data,
  };
  for (const h of targets) {
    const [d] = await ctx.db
      .insert(webhookDelivery)
      .values({ webhookId: h.id, eventId: envelope.id, event: type, payload: envelope })
      .returning({ id: webhookDelivery.id });
    await ctx.jobs.send('webhook.deliver', { deliveryId: d!.id }, { retryLimit: 8 });
  }
}
