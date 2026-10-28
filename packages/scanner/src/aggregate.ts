import type { RiskLevel } from '@dojohub/contract';
import type { AnalyzerResult, Finding, Verdict } from './types';

const WEIGHT: Record<Finding['severity'], number> = { info: 0, low: 2, medium: 8, high: 20, critical: 40 };

export function levelForScore(score: number): RiskLevel {
  if (score <= 0) return 'none';
  if (score < 15) return 'low';
  if (score < 40) return 'medium';
  if (score < 70) return 'high';
  return 'critical';
}

/** Map a judge level (1–5) onto the 0–100 claims score used by policy gates. */
export function levelToScore(level: number): number {
  return Math.min(100, Math.max(0, Math.round(level * 20)));
}

/** Combine analyzer results into a single risk score/level. Policy gates are applied by the server. */
export function aggregate(results: AnalyzerResult[], blockOn: string[] = []): Verdict {
  const findings = results.flatMap((r) => r.findings);
  let score = 0;
  // Repeated hits of the same rule add diminishing weight.
  const perRule = new Map<string, number>();
  for (const f of findings) {
    const n = perRule.get(f.rule) ?? 0;
    perRule.set(f.rule, n + 1);
    score += WEIGHT[f.severity] / (n + 1);
  }
  const llm = results.find((r) => r.analyzer === 'llm' && r.status === 'done');
  const llmVerdict = (llm?.report as { security?: { verdict?: string } } | undefined)?.security?.verdict;
  if (llmVerdict === 'malicious') score += 60;
  else if (llmVerdict === 'suspicious') score += 20;
  const dm = results.find((r) => r.analyzer === 'decision_model');
  const dmDecision = (dm?.report as { decision?: 'allow' | 'review' | 'deny' } | undefined)?.decision ?? null;
  if (dmDecision === 'deny') score += 50;
  if (typeof dm?.riskScore === 'number') score = Math.max(score, dm.riskScore);
  score = Math.min(100, Math.round(score));
  let riskLevel = levelForScore(score);
  if (findings.some((f) => f.severity === 'critical')) riskLevel = 'critical';
  else if (findings.some((f) => f.severity === 'high') && (riskLevel === 'none' || riskLevel === 'low'))
    riskLevel = 'medium';

  const blockedBy = findings
    .filter((f) =>
      blockOn.some((b) => f.rule === b || f.rule.startsWith(`${b}.`) || f.rule.split('.')[0] === b),
    )
    .map((f) => f.rule);
  const claims = (llm?.report as { claimsMatch?: { level?: number; score?: number } } | undefined)
    ?.claimsMatch;
  // Judge levels are 1–5 (mapped to 20–100); older reports stored 0–100 scores directly.
  const claimsScore = claims
    ? typeof claims.level === 'number'
      ? levelToScore(claims.level)
      : (claims.score ?? null)
    : null;
  const verdict =
    blockedBy.length || riskLevel === 'critical' || llmVerdict === 'malicious' || dmDecision === 'deny'
      ? 'fail'
      : riskLevel === 'high' || riskLevel === 'medium' || dmDecision === 'review'
        ? 'warn'
        : 'pass';
  return {
    riskScore: score,
    riskLevel,
    verdict,
    blockedBy: [...new Set(blockedBy)],
    claimsScore,
    llmVerified: !!llm,
    decisionModel: dmDecision,
  };
}
