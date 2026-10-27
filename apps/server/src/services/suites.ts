import { INSTALLABLE_STATUSES, type RiskLevel, RISK_LEVELS, riskRank } from '@dojohub/contract';
import { isGreater, isValidVersion } from '@dojohub/core';
import { type Provenance, skillVersion, suite, suiteMember, suiteVersion } from '@dojohub/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import semver from 'semver';
import type { AppContext } from '../context';
import { badRequest, conflict } from '../lib/errors';
import { createApprovalRequest } from './approvals';
import { audit } from './audit';
import { emit } from './events';
import type { NamespaceRow } from './namespaces';
import { loadPolicy } from './policy';

export interface CreateSuiteInput {
  orgId: string;
  ns: NamespaceRow;
  actorId: string | null;
  name: string;
  displayName: string;
  description: string;
  version: string;
  members: { skillVersionId: string; isEntry?: boolean }[];
  submit: boolean;
  provenance?: Provenance;
  assets?: { path: string; sha256: string; size: number }[];
  sourceId?: string | null;
  author?: string | null;
  license?: string | null;
  homepage?: string | null;
  tags?: string[];
}

export async function createSuiteVersion(ctx: AppContext, input: CreateSuiteInput) {
  if (!isValidVersion(input.version)) throw badRequest(`"${input.version}" is not a valid semantic version`);
  if (!input.members.length) throw badRequest('A suite needs at least one skill');
  const memberIds = input.members.map((m) => m.skillVersionId);
  const rows = await ctx.db
    .select({ id: skillVersion.id })
    .from(skillVersion)
    .where(and(eq(skillVersion.orgId, input.orgId), inArray(skillVersion.id, memberIds)));
  if (rows.length !== new Set(memberIds).size) throw badRequest('Unknown skill version in suite members');

  let [s] = await ctx.db
    .select()
    .from(suite)
    .where(and(eq(suite.orgId, input.orgId), eq(suite.namespaceId, input.ns.id), eq(suite.name, input.name)));
  if (s) {
    const versions = await ctx.db.select({ v: suiteVersion.version }).from(suiteVersion).where(eq(suiteVersion.suiteId, s.id));
    const latest = versions.map((x) => x.v).sort(semver.rcompare)[0];
    if (latest && !isGreater(input.version, latest)) throw conflict(`Suite version must be greater than ${latest}`);
  } else {
    [s] = await ctx.db
      .insert(suite)
      .values({
        orgId: input.orgId,
        namespaceId: input.ns.id,
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        sourceId: input.sourceId ?? null,
        author: input.author ?? null,
        license: input.license ?? null,
        homepage: input.homepage ?? null,
        tags: input.tags ?? [],
        ownerId: input.actorId,
      })
      .returning();
  }
  const hasEntry = input.members.some((m) => m.isEntry);
  const [sv] = await ctx.db
    .insert(suiteVersion)
    .values({
      orgId: input.orgId,
      suiteId: s!.id,
      version: input.version,
      status: input.submit ? 'submitted' : 'draft',
      provenance: input.provenance ?? {},
      assets: input.assets ?? [],
      submittedBy: input.actorId,
      submittedAt: input.submit ? new Date() : null,
    })
    .returning();
  await ctx.db.insert(suiteMember).values(
    input.members.map((m, i) => ({
      suiteVersionId: sv!.id,
      skillVersionId: m.skillVersionId,
      position: i,
      isEntry: hasEntry ? !!m.isEntry : false,
    })),
  );
  await ctx.db
    .update(suite)
    .set({ latestVersionId: sv!.id, description: input.description || s!.description, updatedAt: new Date() })
    .where(eq(suite.id, s!.id));
  await audit(ctx, { orgId: input.orgId, actorId: input.actorId, action: 'suite.version_created', targetType: 'suite_version', targetId: sv!.id, metadata: { name: input.name, version: input.version } });
  await recomputeSuite(ctx, s!.id);
  if (input.submit) await ctx.jobs.send('suite.evaluate', { suiteVersionId: sv!.id });
  return { suite: s!, version: sv! };
}

/**
 * A suite version is reviewed once all its pinned skill versions are decided:
 * any rejected/blocked member rejects it, otherwise the namespace policy applies using the
 * highest member risk.
 */
export async function evaluateSuiteVersion(ctx: AppContext, suiteVersionId: string) {
  const [sv] = await ctx.db.select().from(suiteVersion).where(eq(suiteVersion.id, suiteVersionId));
  if (!sv || sv.status !== 'submitted') return;
  const [s] = await ctx.db.select().from(suite).where(eq(suite.id, sv.suiteId));
  const members = await ctx.db
    .select({ status: skillVersion.status, risk: skillVersion.riskLevel, version: skillVersion.version, id: skillVersion.id })
    .from(suiteMember)
    .innerJoin(skillVersion, eq(skillVersion.id, suiteMember.skillVersionId))
    .where(eq(suiteMember.suiteVersionId, sv.id));
  const bad = members.filter((m) => m.status === 'rejected' || m.status === 'blocked');
  if (bad.length) {
    return closeSuiteVersion(ctx, sv.id, 'rejected', `${bad.length} member skill version(s) were rejected or blocked`);
  }
  if (!members.every((m) => INSTALLABLE_STATUSES.includes(m.status))) return; // wait for members
  const risk = members.reduce<RiskLevel>((acc, m) => (m.risk && riskRank(m.risk) > riskRank(acc) ? m.risk : acc), RISK_LEVELS[0]);
  await ctx.db.update(suiteVersion).set({ riskLevel: risk }).where(eq(suiteVersion.id, sv.id));
  const policyDoc = await loadPolicy(ctx, sv.orgId, s!.namespaceId);
  // Members were already reviewed individually; the suite review only covers composition.
  const suitePolicy = { ...policyDoc, stages: policyDoc.stages.filter((st) => !st.when || /namespace|kind/.test(st.when)) };
  const opened = await createApprovalRequest(ctx, {
    suiteVersionId: sv.id,
    namespaceId: s!.namespaceId,
    policyDoc: suitePolicy,
    facts: {
      risk,
      riskScore: 0,
      claimsScore: null,
      kind: sv.provenance.sourceId ? 'import' : 'new',
      major: false,
      assets: [],
      findings: [],
      files: members.length,
      namespace: '',
      source: sv.provenance.url ?? null,
    },
    needsHuman: false,
  });
  if (opened) {
    await ctx.db.update(suiteVersion).set({ status: 'in_review' }).where(eq(suiteVersion.id, sv.id));
    await recomputeSuite(ctx, s!.id);
  } else {
    await closeSuiteVersion(ctx, sv.id, 'approved', 'All member skills approved');
  }
}

export async function closeSuiteVersion(ctx: AppContext, suiteVersionId: string, to: 'approved' | 'rejected', reason: string | null) {
  const [sv] = await ctx.db
    .update(suiteVersion)
    .set({ status: to, statusReason: reason, publishedAt: to === 'approved' ? new Date() : null })
    .where(eq(suiteVersion.id, suiteVersionId))
    .returning();
  if (!sv) return;
  const [s] = await ctx.db.select().from(suite).where(eq(suite.id, sv.suiteId));
  await recomputeSuite(ctx, sv.suiteId);
  await emit(
    ctx,
    sv.orgId,
    to === 'approved' ? 'version.published' : 'version.rejected',
    { suite: s?.name, version: sv.version, suiteVersionId: sv.id, reason },
    { namespaceId: s?.namespaceId },
  );
}

/** Worker job entry: re-evaluate suites that pin a newly decided skill version. */
export async function processSuiteEvaluate(ctx: AppContext, data: { suiteVersionId?: string; skillVersionId?: string }) {
  if (data.suiteVersionId) return evaluateSuiteVersion(ctx, data.suiteVersionId);
  if (!data.skillVersionId) return;
  const rows = await ctx.db
    .select({ id: suiteVersion.id })
    .from(suiteMember)
    .innerJoin(suiteVersion, eq(suiteVersion.id, suiteMember.suiteVersionId))
    .where(and(eq(suiteMember.skillVersionId, data.skillVersionId), eq(suiteVersion.status, 'submitted')));
  for (const r of rows) await evaluateSuiteVersion(ctx, r.id);
}

export async function recomputeSuite(ctx: AppContext, suiteId: string) {
  const versions = await ctx.db.select().from(suiteVersion).where(eq(suiteVersion.suiteId, suiteId)).orderBy(desc(suiteVersion.createdAt));
  if (!versions.length) return;
  const published = versions
    .filter((v) => INSTALLABLE_STATUSES.includes(v.status))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
  const latest = versions[0]!;
  await ctx.db
    .update(suite)
    .set({
      latestVersionId: latest.id,
      publishedVersionId: published?.id ?? null,
      status: latest.status === 'blocked' ? 'blocked' : (published?.status ?? latest.status),
      updatedAt: new Date(),
    })
    .where(eq(suite.id, suiteId));
}

export async function installableSuiteVersion(ctx: AppContext, suiteId: string, selector?: string | null) {
  const rows = await ctx.db
    .select()
    .from(suiteVersion)
    .where(and(eq(suiteVersion.suiteId, suiteId), inArray(suiteVersion.status, [...INSTALLABLE_STATUSES])));
  if (!rows.length) return null;
  if (selector && selector !== 'latest') {
    const match = semver.valid(selector) ? selector : semver.maxSatisfying(rows.map((r) => r.version), selector);
    return rows.find((r) => r.version === match) ?? null;
  }
  return rows.sort((a, b) => semver.rcompare(a.version, b.version))[0]!;
}

export async function suiteMembers(ctx: AppContext, suiteVersionId: string) {
  return ctx.db
    .select({ skillVersionId: suiteMember.skillVersionId, position: suiteMember.position, isEntry: suiteMember.isEntry })
    .from(suiteMember)
    .where(eq(suiteMember.suiteVersionId, suiteVersionId))
    .orderBy(suiteMember.position);
}
