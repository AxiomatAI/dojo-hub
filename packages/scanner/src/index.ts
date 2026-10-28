import { assetsAnalyzer } from './analyzers/assets';
import { type DecisionModelOptions, decisionModelAnalyzer } from './analyzers/decision-model';
import { dependenciesAnalyzer } from './analyzers/dependencies';
import { type JudgeOptions, llmJudgeAnalyzer } from './analyzers/llm-judge';
import { secretsAnalyzer } from './analyzers/secrets';
import { staticRulesAnalyzer } from './analyzers/static-rules';
import { structureAnalyzer } from './analyzers/structure';
import type { Rule } from './rules';
import type { Analyzer, AnalyzerResult, ScanContext } from './types';

export * from './aggregate';
export { classifyFile } from './analyzers/assets';
export { decisionResponseSchema } from './analyzers/decision-model';
export { type JudgeReport, judgeReportSchema } from './analyzers/llm-judge';
export * from './duplicates';
export * from './llm';
export * from './rules';
export * from './types';
export { isProbablyText, mimeOf } from './util';

export interface ScanConfig {
  extraRules?: Rule[];
  osv?: boolean;
  judge?: JudgeOptions;
  decisionModel?: Omit<DecisionModelOptions, 'priorFindings'>;
}

export function buildAnalyzers(config: ScanConfig = {}): Analyzer[] {
  return [
    structureAnalyzer(),
    staticRulesAnalyzer(config.extraRules),
    secretsAnalyzer(),
    assetsAnalyzer(),
    dependenciesAnalyzer({ osv: !!config.osv }),
  ];
}

/**
 * Run all analyzers. Deterministic analyzers run first so their findings can be passed to the
 * external decision model. Skill content is never executed.
 */
/**
 * Run only the LLM judge — used to (re-)run the verification for a version that was scanned
 * before a judge model was configured. Returns `skipped` when no judge is configured.
 */
export async function runLlmOnly(ctx: ScanContext, config: ScanConfig = {}): Promise<AnalyzerResult> {
  if (!config.judge) return { analyzer: 'llm', status: 'skipped', findings: [] };
  try {
    return await llmJudgeAnalyzer(config.judge).run(ctx);
  } catch (err) {
    return { analyzer: 'llm', status: 'error', findings: [], error: (err as Error).message };
  }
}

export async function runScan(ctx: ScanContext, config: ScanConfig = {}): Promise<AnalyzerResult[]> {
  const results: AnalyzerResult[] = [];
  const safeRun = async (a: Analyzer): Promise<AnalyzerResult> => {
    try {
      return await a.run(ctx);
    } catch (err) {
      return { analyzer: a.id, status: 'error', findings: [], error: (err as Error).message };
    }
  };
  results.push(...(await Promise.all(buildAnalyzers(config).map(safeRun))));
  if (config.judge) results.push(await safeRun(llmJudgeAnalyzer(config.judge)));
  else results.push({ analyzer: 'llm', status: 'skipped', findings: [] });
  if (config.decisionModel) {
    results.push(
      await safeRun(
        decisionModelAnalyzer({
          ...config.decisionModel,
          priorFindings: () => results.flatMap((r) => r.findings),
        }),
      ),
    );
  }
  return results;
}
