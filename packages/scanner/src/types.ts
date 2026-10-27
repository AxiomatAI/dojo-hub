import type { AssetFlag, RiskLevel } from '@dojohub/contract';
import type { FileMap } from '@dojohub/core';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  analyzer: string;
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface ScanSubject {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  files: FileMap;
}

export interface ScanContext extends ScanSubject {
  /** Previously approved version, when scanning an update. */
  previous?: ScanSubject & { version: string };
  version: string;
  externalRefs?: string[];
  signal?: AbortSignal;
}

export interface AnalyzerResult {
  analyzer: string;
  status: 'done' | 'error' | 'skipped';
  verdict?: 'pass' | 'warn' | 'fail';
  riskScore?: number;
  findings: Finding[];
  report?: Record<string, unknown>;
  model?: string;
  tokens?: number;
  error?: string;
  /** Per-file risk flags (asset analyzer). */
  fileFlags?: Record<string, AssetFlag[]>;
}

export interface Analyzer {
  id: string;
  run(ctx: ScanContext): Promise<AnalyzerResult>;
}

export interface Verdict {
  riskScore: number;
  riskLevel: RiskLevel;
  verdict: 'pass' | 'warn' | 'fail';
  blockedBy: string[];
  claimsScore: number | null;
  llmVerified: boolean;
  decisionModel: 'allow' | 'review' | 'deny' | null;
}
