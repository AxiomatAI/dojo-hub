import { auditLog } from '@dojohub/db';
import type { AppContext } from '../context';

export interface AuditInput {
  orgId: string;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'token' | 'scim';
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(ctx: AppContext, input: AuditInput) {
  try {
    await ctx.db.insert(auditLog).values({
      orgId: input.orgId,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? (input.actorId ? 'user' : 'system'),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    });
  } catch (err) {
    ctx.logger.warn({ err, action: input.action }, 'failed to write audit log');
  }
}
