import type { Decision, PolicyDocument } from '@dojohub/contract';
import {
  type Approvers,
  approvalDecision,
  approvalRequest,
  approvalStage,
  groupMembership,
  idpGroup,
  namespaceMember,
  orgMember,
  skill,
  skillVersion,
  suite,
  suiteVersion,
} from '@dojohub/db';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { type Actor, actorHasRole, isOrgAdmin } from '../auth/permissions';
import type { AppContext } from '../context';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit } from './audit';
import { emit } from './events';
import { notify } from './notifications';
import { evaluateCondition, type PolicyFacts } from './policy';
import { transition, type VersionRow } from './skills';

export async function createApprovalRequest(
  ctx: AppContext,
  input: {
    version?: VersionRow;
    suiteVersionId?: string;
    namespaceId: string;
    policyDoc: PolicyDocument;
    facts: PolicyFacts;
    needsHuman: boolean;
  },
): Promise<boolean> {
  const applicable = input.policyDoc.stages.filter((s) => evaluateCondition(s.when, input.facts));
  const stages = applicable.length
    ? applicable
    : input.needsHuman
      ? [{ name: 'Manual review', approvers: { roles: ['maintainer', 'admin'] }, min: 1 }]
      : [];
  if (!stages.length) return false;
  const orgId = input.version?.orgId ?? (await suiteOrg(ctx, input.suiteVersionId!));
  const [req] = await ctx.db
    .insert(approvalRequest)
    .values({
      orgId,
      skillVersionId: input.version?.id ?? null,
      suiteVersionId: input.suiteVersionId ?? null,
      namespaceId: input.namespaceId,
      kind: input.facts.kind,
      policySnapshot: input.policyDoc,
      requestedBy: input.version?.submittedBy ?? null,
    })
    .returning();
  await ctx.db.insert(approvalStage).values(
    stages.map((s, i) => ({
      requestId: req!.id,
      position: i,
      name: s.name,
      approvers: s.approvers,
      minApprovals: s.min ?? 1,
      status: (i === 0 ? 'active' : 'waiting') as 'active' | 'waiting',
    })),
  );
  await notifyStage(ctx, req!.id);
  return true;
}

async function suiteOrg(ctx: AppContext, suiteVersionId: string) {
  const [sv] = await ctx.db
    .select({ orgId: suiteVersion.orgId })
    .from(suiteVersion)
    .where(eq(suiteVersion.id, suiteVersionId));
  return sv!.orgId;
}

/** Users who may decide on a stage (for notifications). */
export async function stageApproverIds(
  ctx: AppContext,
  orgId: string,
  namespaceId: string,
  approvers: Approvers,
): Promise<string[]> {
  const ids = new Set(approvers.users ?? []);
  if (approvers.groups?.length) {
    const rows = await ctx.db
      .select({ userId: groupMembership.userId })
      .from(groupMembership)
      .innerJoin(idpGroup, eq(idpGroup.id, groupMembership.groupId))
      .where(
        and(
          eq(idpGroup.orgId, orgId),
          or(inArray(idpGroup.externalId, approvers.groups), inArray(idpGroup.id, approvers.groups)),
        ),
      );
    for (const r of rows) ids.add(r.userId);
  }
  for (const role of approvers.roles ?? []) {
    const orgRows = await ctx.db
      .select({ userId: orgMember.userId })
      .from(orgMember)
      .where(and(eq(orgMember.orgId, orgId), eq(orgMember.role, role as never)));
    for (const r of orgRows) ids.add(r.userId);
    const nsRoles =
      role === 'reviewer'
        ? ['reviewer', 'maintainer', 'owner']
        : role === 'maintainer'
          ? ['maintainer', 'owner']
          : [role];
    const nsRows = await ctx.db
      .select({ userId: namespaceMember.userId })
      .from(namespaceMember)
      .where(
        and(eq(namespaceMember.namespaceId, namespaceId), inArray(namespaceMember.role, nsRoles as never[])),
      );
    for (const r of nsRows) ids.add(r.userId);
  }
  return [...ids];
}

async function notifyStage(ctx: AppContext, requestId: string) {
  const [req] = await ctx.db.select().from(approvalRequest).where(eq(approvalRequest.id, requestId));
  const [stage] = await ctx.db
    .select()
    .from(approvalStage)
    .where(and(eq(approvalStage.requestId, requestId), eq(approvalStage.status, 'active')));
  if (!req || !stage) return;
  const subject = await describeSubject(ctx, req);
  const users = (await stageApproverIds(ctx, req.orgId, req.namespaceId, stage.approvers)).filter(
    (u) => u !== req.requestedBy,
  );
  await notify(ctx, req.orgId, users, {
    kind: 'review.requested',
    title: `Review requested: ${subject.label}`,
    body: `Stage "${stage.name}" needs ${stage.minApprovals} approval(s).`,
    link: `/reviews/${req.id}`,
  });
  await emit(
    ctx,
    req.orgId,
    'review.requested',
    {
      requestId: req.id,
      stage: stage.name,
      subject: subject.label,
      link: `${ctx.config.DOJO_BASE_URL}/reviews/${req.id}`,
    },
    { namespaceId: req.namespaceId },
  );
}

async function describeSubject(ctx: AppContext, req: typeof approvalRequest.$inferSelect) {
  if (req.skillVersionId) {
    const [row] = await ctx.db
      .select({ name: skill.name, version: skillVersion.version })
      .from(skillVersion)
      .innerJoin(skill, eq(skill.id, skillVersion.skillId))
      .where(eq(skillVersion.id, req.skillVersionId));
    return { type: 'skill' as const, label: `${row?.name}@${row?.version}` };
  }
  const [row] = await ctx.db
    .select({ name: suite.name, version: suiteVersion.version })
    .from(suiteVersion)
    .innerJoin(suite, eq(suite.id, suiteVersion.suiteId))
    .where(eq(suiteVersion.id, req.suiteVersionId!));
  return { type: 'suite' as const, label: `${row?.name}@${row?.version} (suite)` };
}

export async function actorGroupKeys(ctx: AppContext, actor: Actor): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: idpGroup.id, externalId: idpGroup.externalId, displayName: idpGroup.displayName })
    .from(groupMembership)
    .innerJoin(idpGroup, eq(idpGroup.id, groupMembership.groupId))
    .where(and(eq(groupMembership.userId, actor.userId), eq(idpGroup.orgId, actor.orgId)));
  return rows.flatMap((r) => [r.id, r.externalId, r.displayName]);
}

export function canDecideStage(
  actor: Actor,
  stage: { approvers: Approvers; status: string },
  namespaceId: string,
  groupKeys: string[],
  requestedBy: string | null,
): boolean {
  if (stage.status !== 'active') return false;
  if (actor.scopes && !actor.scopes.includes('review') && !actor.scopes.includes('admin')) return false;
  // Separation of duties: submitters cannot approve their own work (org owners/admins excepted).
  if (requestedBy === actor.userId && !isOrgAdmin(actor)) return false;
  if (isOrgAdmin(actor)) return true;
  const a = stage.approvers;
  if (a.users?.includes(actor.userId)) return true;
  if (a.groups?.some((g) => groupKeys.includes(g))) return true;
  return (a.roles ?? []).some((r) => actorHasRole(actor, r, namespaceId));
}

export async function decideRequest(
  ctx: AppContext,
  actor: Actor,
  requestId: string,
  decision: Decision,
  comment?: string,
) {
  const [req] = await ctx.db
    .select()
    .from(approvalRequest)
    .where(and(eq(approvalRequest.orgId, actor.orgId), eq(approvalRequest.id, requestId)));
  if (!req) throw notFound('Review');
  if (req.status !== 'pending') throw conflict('This review is already closed');
  const stages = await ctx.db
    .select()
    .from(approvalStage)
    .where(eq(approvalStage.requestId, req.id))
    .orderBy(asc(approvalStage.position));
  const stage = stages.find((s) => s.status === 'active');
  if (!stage) throw conflict('No active stage');
  const keys = await actorGroupKeys(ctx, actor);
  if (!canDecideStage(actor, stage, req.namespaceId, keys, req.requestedBy)) {
    throw forbidden('You are not an approver for the current stage');
  }
  if ((decision === 'reject' || decision === 'request_changes') && !comment?.trim()) {
    throw badRequest('Please add a comment explaining the decision');
  }
  const prior = await ctx.db
    .select()
    .from(approvalDecision)
    .where(and(eq(approvalDecision.stageId, stage.id), eq(approvalDecision.actorId, actor.userId)));
  if (prior.length) throw conflict('You already decided on this stage');
  await ctx.db.insert(approvalDecision).values({
    requestId: req.id,
    stageId: stage.id,
    actorId: actor.userId,
    decision,
    comment: comment ?? null,
  });
  await audit(ctx, {
    orgId: actor.orgId,
    actorId: actor.userId,
    action: `review.${decision}`,
    targetType: 'approval_request',
    targetId: req.id,
    metadata: { stage: stage.name },
  });

  if (decision !== 'approve') {
    await ctx.db
      .update(approvalStage)
      .set({ status: 'rejected', completedAt: new Date() })
      .where(eq(approvalStage.id, stage.id));
    await ctx.db
      .update(approvalRequest)
      .set({ status: decision === 'reject' ? 'rejected' : 'cancelled', closedAt: new Date() })
      .where(eq(approvalRequest.id, req.id));
    await closeSubject(ctx, req, decision === 'reject' ? 'rejected' : 'draft', comment ?? null);
    await emit(
      ctx,
      req.orgId,
      'review.decided',
      { requestId: req.id, decision, stage: stage.name, by: actor.email },
      { namespaceId: req.namespaceId },
    );
    return;
  }
  const approvals = await ctx.db
    .select()
    .from(approvalDecision)
    .where(and(eq(approvalDecision.stageId, stage.id), eq(approvalDecision.decision, 'approve')));
  if (approvals.length < stage.minApprovals) {
    await emit(
      ctx,
      req.orgId,
      'review.decided',
      { requestId: req.id, decision, stage: stage.name, by: actor.email, pending: true },
      { namespaceId: req.namespaceId },
    );
    return;
  }
  await ctx.db
    .update(approvalStage)
    .set({ status: 'approved', completedAt: new Date() })
    .where(eq(approvalStage.id, stage.id));
  const next = stages.find((s) => s.position > stage.position && s.status === 'waiting');
  if (next) {
    await ctx.db.update(approvalStage).set({ status: 'active' }).where(eq(approvalStage.id, next.id));
    await ctx.db
      .update(approvalRequest)
      .set({ currentStage: next.position })
      .where(eq(approvalRequest.id, req.id));
    await notifyStage(ctx, req.id);
  } else {
    await ctx.db
      .update(approvalRequest)
      .set({ status: 'approved', closedAt: new Date() })
      .where(eq(approvalRequest.id, req.id));
    await closeSubject(ctx, req, 'approved', comment ?? null);
  }
  await emit(
    ctx,
    req.orgId,
    'review.decided',
    { requestId: req.id, decision, stage: stage.name, by: actor.email },
    { namespaceId: req.namespaceId },
  );
}

async function closeSubject(
  ctx: AppContext,
  req: typeof approvalRequest.$inferSelect,
  to: 'approved' | 'rejected' | 'draft',
  reason: string | null,
) {
  if (req.skillVersionId) {
    const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, req.skillVersionId));
    if (!v) return;
    await transition(ctx, v, to, reason);
    if (to !== 'draft') {
      const { afterDecision } = await import('./pipeline');
      await afterDecision(ctx, v, to, reason);
    }
  } else if (req.suiteVersionId) {
    const { closeSuiteVersion } = await import('./suites');
    await closeSuiteVersion(ctx, req.suiteVersionId, to === 'draft' ? 'rejected' : to, reason);
  }
}

/** Cancel open reviews for a version (e.g. when withdrawn). */
export async function cancelOpenRequests(ctx: AppContext, versionId: string) {
  await ctx.db
    .update(approvalRequest)
    .set({ status: 'cancelled', closedAt: new Date() })
    .where(and(eq(approvalRequest.skillVersionId, versionId), eq(approvalRequest.status, 'pending')));
}
