import type { Analyzer, Finding } from '../types';
import { lineOf, textFiles } from '../util';

const SECRET_PATTERNS: { id: string; re: RegExp; message: string }[] = [
  { id: 'aws_access_key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, message: 'AWS access key id' },
  { id: 'github_token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, message: 'GitHub token' },
  { id: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, message: 'GitLab token' },
  { id: 'slack_token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, message: 'Slack token' },
  { id: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, message: 'Slack webhook URL' },
  { id: 'openai_key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g, message: 'OpenAI API key' },
  { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g, message: 'Anthropic API key' },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, message: 'Google API key' },
  { id: 'stripe_key', re: /\b(sk|rk)_live_[0-9a-zA-Z]{24,}\b/g, message: 'Stripe live key' },
  { id: 'private_key', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g, message: 'Private key' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, message: 'JSON Web Token' },
  { id: 'azure_conn', re: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{40,}/g, message: 'Azure storage connection string' },
  { id: 'db_url_password', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s/]{6,}@/g, message: 'Database URL with password' },
];

const ASSIGN_RE = /\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'`]{12,})["']?/g;
const PLACEHOLDER = /^(x+|\*+|<.*>|\$\{?.*\}?|your[_-]|example|changeme|placeholder|dummy|test|xxx|\.\.\.|null|none|todo)/i;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function redact(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

export function secretsAnalyzer(): Analyzer {
  return {
    id: 'secrets',
    async run(ctx) {
      const findings: Finding[] = [];
      for (const [path, text] of textFiles(ctx.files)) {
        for (const p of SECRET_PATTERNS) {
          p.re.lastIndex = 0;
          for (const m of text.matchAll(p.re)) {
            findings.push({
              analyzer: 'secrets',
              rule: `secret.${p.id}`,
              severity: 'critical',
              message: `Possible ${p.message} committed in skill`,
              file: path,
              line: lineOf(text, m.index ?? 0),
              evidence: redact(m[0]),
            });
          }
        }
        ASSIGN_RE.lastIndex = 0;
        for (const m of text.matchAll(ASSIGN_RE)) {
          const value = m[3] ?? '';
          if (PLACEHOLDER.test(value) || entropy(value) < 3.5) continue;
          findings.push({
            analyzer: 'secrets',
            rule: 'secret.high_entropy_assignment',
            severity: 'high',
            message: `High-entropy value assigned to ${m[1]}`,
            file: path,
            line: lineOf(text, m.index ?? 0),
            evidence: `${m[1]}=${redact(value)}`,
          });
        }
      }
      return { analyzer: 'secrets', status: 'done', findings };
    },
  };
}
