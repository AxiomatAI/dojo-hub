import { DEFAULT_POLICY, type PolicyDocument, policyDocumentSchema, RISK_LEVELS, type RiskLevel, riskRank } from '@dojohub/contract';
import { policy } from '@dojohub/db';
import { and, eq, isNull } from 'drizzle-orm';
import { compileExpression } from 'filtrex';
import type { AppContext } from '../context';

export async function loadPolicy(ctx: AppContext, orgId: string, namespaceId: string | null): Promise<PolicyDocument> {
  if (namespaceId) {
    const [ns] = await ctx.db
      .select()
      .from(policy)
      .where(and(eq(policy.orgId, orgId), eq(policy.namespaceId, namespaceId)));
    if (ns) return policyDocumentSchema.parse(ns.document);
  }
  const [org] = await ctx.db
    .select()
    .from(policy)
    .where(and(eq(policy.orgId, orgId), isNull(policy.namespaceId)));
  return org ? policyDocumentSchema.parse(org.document) : DEFAULT_POLICY;
}

export interface PolicyFacts {
  risk: RiskLevel;
  riskScore: number;
  claimsScore: number | null;
  kind: 'new' | 'update' | 'import' | 'unblock';
  major: boolean;
  assets: string[];
  findings: string[];
  files: number;
  namespace: string;
  source: string | null;
}

const LEVEL_LITERAL = new RegExp(`(["'])(${RISK_LEVELS.join('|')})\\1`, 'g');

/**
 * Evaluate a stage condition. Expressions use filtrex syntax, e.g.
 * `risk >= "medium" or has_asset("script")`, `kind == "update" and not major`.
 * Unknown/invalid expressions evaluate to true (fail closed: the stage applies).
 */
export function evaluateCondition(expr: string | undefined, facts: PolicyFacts): boolean {
  if (!expr?.trim()) return true;
  try {
    const normalised = expr.replace(LEVEL_LITERAL, (_m, _q, level: RiskLevel) => String(riskRank(level)));
    const fn = compileExpression(normalised, {
      extraFunctions: {
        has_asset: (flag: string) => facts.assets.includes(flag),
        has_finding: (rule: string) => facts.findings.some((f) => f === rule || f.startsWith(`${rule}.`)),
      },
    });
    const result = fn({
      risk: riskRank(facts.risk),
      score: facts.riskScore,
      claims_score: facts.claimsScore ?? 100,
      kind: facts.kind,
      major: facts.major,
      files: facts.files,
      namespace: facts.namespace,
      source: facts.source ?? '',
    });
    if (result instanceof Error) return true;
    return Boolean(result);
  } catch {
    return true;
  }
}

export function validateCondition(expr: string): string | null {
  try {
    compileExpression(expr.replace(LEVEL_LITERAL, '1'), { extraFunctions: { has_asset: () => true, has_finding: () => true } });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
