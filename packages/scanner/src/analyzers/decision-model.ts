import { utf8 } from '@dojohub/core';
import { z } from 'zod';
import type { Analyzer, Finding } from '../types';
import { isProbablyText } from '../util';

export const decisionResponseSchema = z.object({
  decision: z.enum(['allow', 'review', 'deny']),
  score: z.number().min(0).max(100).optional(),
  reasons: z.array(z.string()).default([]),
  labels: z.array(z.string()).optional(),
});
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

export interface DecisionModelOptions {
  url: string;
  secret?: string | null;
  timeoutMs?: number;
  onError?: 'review' | 'ignore';
  /** Findings from earlier analyzers, forwarded as features. */
  priorFindings?: () => Finding[];
  fetchImpl?: typeof fetch;
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8.encode(secret) as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8.encode(body) as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pluggable external decision model ("Jev-like"): DojoHub POSTs the skill and prior findings,
 * the model answers allow | review | deny. Contract documented in docs/decision-model.md.
 */
export function decisionModelAnalyzer(opts: DecisionModelOptions): Analyzer {
  return {
    id: 'decision_model',
    async run(ctx) {
      const files = [...ctx.files].map(([path, bytes]) => ({
        path,
        size: bytes.byteLength,
        content: isProbablyText(path, bytes) ? utf8.decode(bytes).slice(0, 100_000) : null,
      }));
      const body = JSON.stringify({
        schemaVersion: 1,
        skill: { name: ctx.name, description: ctx.description, frontmatter: ctx.frontmatter },
        version: ctx.version,
        previousVersion: ctx.previous?.version ?? null,
        files,
        findings: opts.priorFindings?.() ?? [],
      });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'DojoHub-DecisionModel/1',
      };
      if (opts.secret) headers['x-dojo-signature'] = `sha256=${await hmac(opts.secret, body)}`;
      try {
        const res = await (opts.fetchImpl ?? fetch)(opts.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = decisionResponseSchema.parse(await res.json());
        const findings: Finding[] = parsed.reasons.map((r) => ({
          analyzer: 'decision_model',
          rule: `decision.${parsed.decision}`,
          severity: parsed.decision === 'deny' ? 'high' : parsed.decision === 'review' ? 'medium' : 'info',
          message: r,
        }));
        return {
          analyzer: 'decision_model',
          status: 'done',
          verdict: parsed.decision === 'deny' ? 'fail' : parsed.decision === 'review' ? 'warn' : 'pass',
          riskScore: parsed.score,
          findings,
          report: parsed as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = `Decision model unavailable: ${(err as Error).message}`;
        if (opts.onError === 'ignore')
          return { analyzer: 'decision_model', status: 'error', findings: [], error: message };
        return {
          analyzer: 'decision_model',
          status: 'error',
          verdict: 'warn',
          findings: [
            { analyzer: 'decision_model', rule: 'decision.unavailable', severity: 'medium', message },
          ],
          error: message,
          report: { decision: 'review' },
        };
      }
    },
  };
}
