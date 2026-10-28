import { type PolicyDocument, type RiskLevel, riskRank } from '@dojohub/contract';
import { bumpKindBetween } from '@dojohub/core';
import {
  approvalDecision,
  approvalRequest,
  approvalStage,
  decisionModel,
  duplicateMatch,
  llmConfig,
  namespace,
  scanRun,
  skill,
  skillEmbedding,
  skillVersion,
  source,
  versionFile,
} from '@dojohub/db';
import {
  type AnalyzerResult,
  aggregate,
  cosine,
  createEmbeddingModel,
  createLanguageModel,
  loadRulePack,
  minhash,
  NEAR_DUPLICATE_THRESHOLD,
  runLlmOnly,
  runScan,
  type ScanConfig,
  SEMANTIC_DUPLICATE_THRESHOLD,
  similarity,
} from '@dojohub/scanner';
import { embed } from 'ai';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../context';
import { createApprovalRequest } from './approvals';
import { emit } from './events';
import { getSetting } from './org';
import { loadPolicy, type PolicyFacts } from './policy';
import { loadVersionFiles, previousApprovedVersion, transition, type VersionRow } from './skills';

export async function buildScanConfig(ctx: AppContext, orgId: string): Promise<ScanConfig> {
  const config: ScanConfig = { osv: ctx.config.DOJO_OSV };
  const rulesYaml = await getSetting<string>(ctx, orgId, 'security.rules', '');
  if (rulesYaml.trim()) {
    try {
      config.extraRules = loadRulePack(rulesYaml);
    } catch (err) {
      ctx.logger.warn({ err }, 'invalid custom rule pack ignored');
    }
  }
  const [judge] = await ctx.db
    .select()
    .from(llmConfig)
    .where(and(eq(llmConfig.orgId, orgId), eq(llmConfig.purpose, 'judge'), eq(llmConfig.enabled, true)));
  if (judge) {
    const model = await createLanguageModel({
      provider: judge.provider,
      model: judge.model,
      apiKey: ctx.secrets.decryptOrNull(judge.apiKeyEnc),
      baseUrl: judge.baseUrl,
      options: judge.options,
    });
    config.judge = {
      model,
      modelName: `${judge.provider}/${judge.model}`,
      consensus: Number(judge.options.consensus ?? 1),
    };
  }
  const [dm] = await ctx.db
    .select()
    .from(decisionModel)
    .where(and(eq(decisionModel.orgId, orgId), eq(decisionModel.enabled, true)));
  if (dm) {
    config.decisionModel = {
      url: dm.url,
      secret: ctx.secrets.decryptOrNull(dm.secretEnc),
      timeoutMs: dm.timeoutMs,
      onError: dm.onError,
    };
  }
  return config;
}

/** How long an inline "run LLM verification" request may hold a provider connection. */
const LLM_CHECK_TIMEOUT_MS = 120_000;

/** True when an enabled "judge" model is configured for the org (LLM verification). */
export async function hasJudgeConfig(ctx: AppContext, orgId: string): Promise<boolean> {
  const [judge] = await ctx.db
    .select({ id: llmConfig.id })
    .from(llmConfig)
    .where(and(eq(llmConfig.orgId, orgId), eq(llmConfig.purpose, 'judge'), eq(llmConfig.enabled, true)));
  return !!judge;
}

/** Build the scan subject (skill content + previous approved version) for a version. */
async function scanSubjectFor(ctx: AppContext, v: VersionRow) {
  const [s] = await ctx.db.select().from(skill).where(eq(skill.id, v.skillId));
  if (!s) throw new Error(`skill ${v.skillId} not found`);
  const name = s.name;
  const files = await loadVersionFiles(ctx, v.id);
  const prev = await previousApprovedVersion(ctx, v);
  return {
    files,
    prev,
    input: {
      name,
      description: v.description,
      frontmatter: v.frontmatter,
      files,
      version: v.version,
      externalRefs: v.externalRefs,
      previous: prev
        ? {
            name,
            description: prev.description,
            frontmatter: prev.frontmatter,
            files: await loadVersionFiles(ctx, prev.id),
            version: prev.version,
          }
        : undefined,
    },
  };
}

/**
 * Run (or re-run) only the LLM judge for a version and store it as its `llm` scan row, then
 * re-aggregate the version risk score. Leaves the version status and approvals untouched, so it
 * works for approved versions scanned before the judge was configured.
 */
export async function runLlmCheck(ctx: AppContext, v: VersionRow): Promise<AnalyzerResult> {
  const orgId = v.orgId;
  const cfg = await buildScanConfig(ctx, orgId);
  const { input } = await scanSubjectFor(ctx, v);
  const startedAt = new Date();
  // Bound the inline judge call so a stalled provider connection cannot hang the request.
  const result = await runLlmOnly({ ...input, signal: AbortSignal.timeout(LLM_CHECK_TIMEOUT_MS) }, cfg);
  await ctx.db.delete(scanRun).where(and(eq(scanRun.skillVersionId, v.id), eq(scanRun.analyzer, 'llm')));
  await ctx.db.insert(scanRun).values({
    orgId,
    skillVersionId: v.id,
    analyzer: 'llm',
    status: result.status,
    verdict:
      result.verdict ??
      (result.status === 'done'
        ? result.findings.some((f) => ['high', 'critical'].includes(f.severity))
          ? 'warn'
          : 'pass'
        : null),
    riskScore: result.riskScore ?? null,
    findings: result.findings,
    report: result.report ?? null,
    model: result.model ?? null,
    tokens: result.tokens ?? null,
    error: result.error ?? null,
    startedAt,
    finishedAt: new Date(),
  });
  // Re-aggregate the risk score from every stored analyzer result (the judge may add findings).
  const rows = await ctx.db.select().from(scanRun).where(eq(scanRun.skillVersionId, v.id));
  const verdict = aggregate(
    rows.map((r) => ({
      analyzer: r.analyzer,
      status: r.status as AnalyzerResult['status'],
      verdict: r.verdict as AnalyzerResult['verdict'],
      riskScore: r.riskScore ?? undefined,
      findings: r.findings,
      report: r.report ?? undefined,
      model: r.model ?? undefined,
      error: r.error ?? undefined,
    })),
  );
  await ctx.db
    .update(skillVersion)
    .set({ riskScore: verdict.riskScore, riskLevel: verdict.riskLevel })
    .where(eq(skillVersion.id, v.id));
  return result;
}

/** Worker job: scan a submitted version, detect duplicates, then apply the namespace policy. */
export async function processScan(
  ctx: AppContext,
  versionId: string,
  kindHint?: 'new' | 'update' | 'import' | null,
) {
  const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, versionId));
  if (!v || (v.status !== 'submitted' && v.status !== 'scanning')) return;
  const orgId = v.orgId;
  await transition(ctx, v, 'scanning', null);
  const [s] = await ctx.db.select().from(skill).where(eq(skill.id, v.skillId));
  const [ns] = await ctx.db.select().from(namespace).where(eq(namespace.id, s!.namespaceId));
  const { input, files, prev } = await scanSubjectFor(ctx, v);
  const policyDoc = await loadPolicy(ctx, orgId, ns!.id);

  let results: AnalyzerResult[];
  try {
    const cfg = await buildScanConfig(ctx, orgId);
    results = await runScan(input, cfg);
  } catch (err) {
    ctx.logger.error({ err, versionId }, 'scan failed');
    results = [{ analyzer: 'pipeline', status: 'error', findings: [], error: (err as Error).message }];
  }

  // Duplicate detection (exact content hash, MinHash near-duplicates, optional embeddings).
  const fingerprint = minhash(files);
  const dupResult = await detectDuplicates(ctx, v, fingerprint, files);
  results.push(dupResult);

  const verdict = aggregate(results, policyDoc.gates.blockOn);
  await ctx.db.delete(scanRun).where(eq(scanRun.skillVersionId, v.id));
  await ctx.db.insert(scanRun).values(
    results.map((r) => ({
      orgId,
      skillVersionId: v.id,
      analyzer: r.analyzer,
      status: r.status,
      verdict:
        r.verdict ??
        (r.status === 'done'
          ? r.findings.some((f) => ['high', 'critical'].includes(f.severity))
            ? 'warn'
            : 'pass'
          : null),
      riskScore: r.riskScore ?? null,
      findings: r.findings,
      report: r.report ?? null,
      model: r.model ?? null,
      tokens: r.tokens ?? null,
      error: r.error ?? null,
      startedAt: new Date(),
      finishedAt: new Date(),
    })),
  );
  const fileFlags = results.find((r) => r.analyzer === 'assets')?.fileFlags ?? {};
  for (const [path, flags] of Object.entries(fileFlags)) {
    await ctx.db
      .update(versionFile)
      .set({ riskFlags: flags })
      .where(and(eq(versionFile.versionId, v.id), eq(versionFile.path, path)));
  }
  await ctx.db
    .update(skillVersion)
    .set({ riskScore: verdict.riskScore, riskLevel: verdict.riskLevel, fingerprint })
    .where(eq(skillVersion.id, v.id));
  v.riskScore = verdict.riskScore;
  v.riskLevel = verdict.riskLevel;

  const llm = results.find((r) => r.analyzer === 'llm' && r.status === 'done');
  const llmReport = llm?.report as
    | { category?: string; tags?: string[]; update?: { risk: string } }
    | undefined;
  if (llmReport?.category && !s!.category) {
    await ctx.db
      .update(skill)
      .set({
        category: llmReport.category,
        tags: s!.tags.length ? s!.tags : (llmReport.tags ?? []).slice(0, 8),
      })
      .where(eq(skill.id, s!.id));
  }

  await emit(
    ctx,
    orgId,
    'version.scanned',
    {
      skill: s!.name,
      version: v.version,
      versionId: v.id,
      riskLevel: verdict.riskLevel,
      riskScore: verdict.riskScore,
      verdict: verdict.verdict,
    },
    { namespaceId: ns!.id },
  );

  const allFindings = results.flatMap((r) => r.findings);
  let srcUrl: string | null = null;
  if (v.provenance.sourceId) {
    const [src] = await ctx.db
      .select({ url: source.url })
      .from(source)
      .where(eq(source.id, v.provenance.sourceId));
    srcUrl = src?.url ?? null;
  }
  const kind = kindHint ?? (prev ? 'update' : v.provenance.sourceId ? 'import' : 'new');
  const facts: PolicyFacts = {
    risk: verdict.riskLevel,
    riskScore: verdict.riskScore,
    claimsScore: verdict.claimsScore,
    kind: prev && kind === 'import' ? 'update' : kind,
    major: prev ? bumpKindBetween(prev.version, v.version) === 'major' : false,
    assets: [...new Set(Object.values(fileFlags).flat())],
    findings: allFindings.map((f) => f.rule),
    files: files.size,
    namespace: ns!.slug,
    source: srcUrl,
  };
  await decide(ctx, v, ns!.id, policyDoc, facts, {
    blockedBy: verdict.blockedBy,
    llmVerified: verdict.llmVerified,
    decisionModel: verdict.decisionModel,
    llmUpdateRisk: (llmReport?.update?.risk as RiskLevel | undefined) ?? null,
    exactDuplicate: dupResult.findings.some((f) => f.rule === 'duplicate.exact'),
  });
}

interface GateSignals {
  blockedBy: string[];
  llmVerified: boolean;
  decisionModel: 'allow' | 'review' | 'deny' | null;
  llmUpdateRisk: RiskLevel | null;
  exactDuplicate: boolean;
}

/** Apply policy gates and auto-approval rules; otherwise open a multi-stage approval request. */
export async function decide(
  ctx: AppContext,
  v: VersionRow,
  namespaceId: string,
  policyDoc: PolicyDocument,
  facts: PolicyFacts,
  signals: GateSignals,
) {
  const reject = async (reason: string) => {
    const [req] = await ctx.db
      .insert(approvalRequest)
      .values({
        orgId: v.orgId,
        skillVersionId: v.id,
        namespaceId,
        kind: facts.kind,
        status: 'rejected',
        policySnapshot: policyDoc,
        requestedBy: v.submittedBy,
        closedAt: new Date(),
      })
      .returning();
    await ctx.db
      .insert(approvalDecision)
      .values({ requestId: req!.id, actorType: 'system', decision: 'reject', comment: reason });
    await transition(ctx, v, 'rejected', reason);
    await afterDecision(ctx, v, 'rejected', reason);
  };
  const autoApprove = async (reason: string) => {
    const [req] = await ctx.db
      .insert(approvalRequest)
      .values({
        orgId: v.orgId,
        skillVersionId: v.id,
        namespaceId,
        kind: facts.kind,
        status: 'approved',
        policySnapshot: policyDoc,
        requestedBy: v.submittedBy,
        closedAt: new Date(),
      })
      .returning();
    await ctx.db
      .insert(approvalDecision)
      .values({ requestId: req!.id, actorType: 'system', decision: 'approve', comment: reason });
    await transition(ctx, v, 'approved', reason);
    await afterDecision(ctx, v, 'approved', reason);
  };

  const g = policyDoc.gates;
  if (signals.blockedBy.length)
    return reject(`Blocked by security rules: ${signals.blockedBy.slice(0, 5).join(', ')}`);
  if (riskRank(facts.risk) > riskRank(g.maxRisk))
    return reject(`Risk level ${facts.risk} exceeds the policy maximum (${g.maxRisk})`);
  if (signals.decisionModel === 'deny') return reject('Rejected by the decision model');
  if (g.minClaimsScore > 0 && facts.claimsScore !== null && facts.claimsScore < g.minClaimsScore) {
    return reject(
      `Content does not match its description (score ${facts.claimsScore} < ${g.minClaimsScore})`,
    );
  }
  if (g.rejectExactDuplicates && signals.exactDuplicate)
    return reject('Exact duplicate of an existing skill');

  const needsHuman = (g.requireLlmVerification && !signals.llmVerified) || signals.decisionModel === 'review';
  if (!needsHuman) {
    if (facts.kind === 'update') {
      const u = policyDoc.updates;
      const majorBlocked = u.majorRequiresManual && facts.major;
      const llmOk =
        !u.llmDiffReview ||
        !signals.llmVerified ||
        riskRank(signals.llmUpdateRisk ?? 'none') <= riskRank(u.maxRisk);
      if (u.mode === 'auto' && !majorBlocked) return autoApprove('Automatic update approval (policy: auto)');
      if (
        u.mode === 'auto_if_low_risk' &&
        !majorBlocked &&
        riskRank(facts.risk) <= riskRank(u.maxRisk) &&
        llmOk
      ) {
        return autoApprove(`Low-risk update approved automatically (risk ${facts.risk})`);
      }
    }
    if (facts.kind === 'import' && policyDoc.imports.mode === 'auto_if_trusted' && facts.source) {
      const trusted = policyDoc.imports.trustedSources.some(
        (t) => facts.source!.startsWith(t) || facts.source!.includes(t),
      );
      if (trusted && riskRank(facts.risk) <= riskRank('low'))
        return autoApprove('Trusted source import approved automatically');
    }
  }
  const opened = await createApprovalRequest(ctx, { version: v, namespaceId, policyDoc, facts, needsHuman });
  if (!opened) return autoApprove('No approval stages apply under the namespace policy');
  await transition(ctx, v, 'in_review', null);
}

/** Side effects after a final decision: events and suite re-evaluation. */
export async function afterDecision(
  ctx: AppContext,
  v: VersionRow,
  status: 'approved' | 'rejected',
  reason: string | null,
) {
  const [s] = await ctx.db.select().from(skill).where(eq(skill.id, v.skillId));
  await emit(
    ctx,
    v.orgId,
    status === 'approved' ? 'version.published' : 'version.rejected',
    { skill: s?.name, version: v.version, versionId: v.id, reason },
    { namespaceId: s?.namespaceId },
  );
  if (status === 'approved') {
    await ctx.jobs.send('suite.evaluate', { skillVersionId: v.id });
    await ctx.jobs.send('version.embed', { versionId: v.id });
  }
  const { notify } = await import('./notifications');
  if (v.submittedBy) {
    await notify(ctx, v.orgId, [v.submittedBy], {
      kind: `version.${status}`,
      title: `${s?.name}@${v.version} was ${status}`,
      body: reason ?? undefined,
      link: `/skills/${s?.name}`,
    });
  }
}

async function detectDuplicates(
  ctx: AppContext,
  v: VersionRow,
  fingerprint: number[],
  _files: Map<string, Uint8Array>,
): Promise<AnalyzerResult> {
  const findings: AnalyzerResult['findings'] = [];
  await ctx.db.delete(duplicateMatch).where(eq(duplicateMatch.versionId, v.id));
  const candidates = await ctx.db
    .select({
      id: skillVersion.id,
      skillId: skillVersion.skillId,
      version: skillVersion.version,
      contentHash: skillVersion.contentHash,
      fingerprint: skillVersion.fingerprint,
      name: skill.name,
    })
    .from(skillVersion)
    .innerJoin(skill, eq(skill.id, skillVersion.skillId))
    .where(
      and(
        eq(skillVersion.orgId, v.orgId),
        ne(skillVersion.skillId, v.skillId),
        inArray(skillVersion.status, ['approved', 'deprecated', 'in_review', 'blocked']),
      ),
    );
  // Keep only the best match per other skill.
  const best = new Map<
    string,
    { id: string; kind: 'exact' | 'near'; score: number; name: string; version: string }
  >();
  for (const c of candidates) {
    let kind: 'exact' | 'near' | null = null;
    let score = 0;
    if (c.contentHash === v.contentHash) {
      kind = 'exact';
      score = 1;
    } else if (c.fingerprint) {
      score = similarity(fingerprint, c.fingerprint);
      if (score >= NEAR_DUPLICATE_THRESHOLD) kind = 'near';
    }
    if (!kind) continue;
    const prev = best.get(c.skillId);
    if (!prev || score > prev.score)
      best.set(c.skillId, { id: c.id, kind, score, name: c.name, version: c.version });
  }
  for (const m of best.values()) {
    await ctx.db
      .insert(duplicateMatch)
      .values({ orgId: v.orgId, versionId: v.id, otherVersionId: m.id, kind: m.kind, score: m.score });
    findings.push({
      analyzer: 'duplicates',
      rule: `duplicate.${m.kind}`,
      severity: m.kind === 'exact' ? 'medium' : 'low',
      message: `${Math.round(m.score * 100)}% similar to ${m.name}@${m.version}`,
    });
  }
  return { analyzer: 'duplicates', status: 'done', findings };
}

/** Worker job: compute an embedding for semantic duplicate detection (when configured). */
export async function processEmbedding(ctx: AppContext, versionId: string) {
  const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, versionId));
  if (!v) return;
  const [cfg] = await ctx.db
    .select()
    .from(llmConfig)
    .where(
      and(eq(llmConfig.orgId, v.orgId), eq(llmConfig.purpose, 'embedding'), eq(llmConfig.enabled, true)),
    );
  if (!cfg) return;
  const files = await loadVersionFiles(ctx, v.id);
  const text = new TextDecoder().decode(files.get('SKILL.md') ?? new Uint8Array()).slice(0, 8000);
  const model = await createEmbeddingModel({
    provider: cfg.provider,
    model: cfg.model,
    apiKey: ctx.secrets.decryptOrNull(cfg.apiKeyEnc),
    baseUrl: cfg.baseUrl,
    options: cfg.options,
  });
  const { embedding } = await embed({ model, value: text });
  await ctx.db
    .insert(skillEmbedding)
    .values({ versionId: v.id, orgId: v.orgId, model: cfg.model, embedding })
    .onConflictDoUpdate({ target: skillEmbedding.versionId, set: { embedding, model: cfg.model } });
  const others = await ctx.db
    .select({
      versionId: skillEmbedding.versionId,
      embedding: skillEmbedding.embedding,
      skillId: skillVersion.skillId,
    })
    .from(skillEmbedding)
    .innerJoin(skillVersion, eq(skillVersion.id, skillEmbedding.versionId))
    .where(
      and(
        eq(skillEmbedding.orgId, v.orgId),
        eq(skillEmbedding.model, cfg.model),
        ne(skillVersion.skillId, v.skillId),
      ),
    );
  for (const o of others) {
    const score = cosine(embedding, o.embedding);
    if (score >= SEMANTIC_DUPLICATE_THRESHOLD) {
      await ctx.db
        .insert(duplicateMatch)
        .values({ orgId: v.orgId, versionId: v.id, otherVersionId: o.versionId, kind: 'semantic', score });
    }
  }
}

export { approvalStage };
