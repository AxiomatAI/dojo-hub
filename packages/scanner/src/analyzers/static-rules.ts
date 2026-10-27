import { DEFAULT_RULES, type Rule } from '../rules';
import type { Analyzer, Finding } from '../types';
import { lineOf, snippet, textFiles } from '../util';

export function staticRulesAnalyzer(extraRules: Rule[] = []): Analyzer {
  const rules = [...DEFAULT_RULES, ...extraRules].map((r) => ({
    ...r,
    re: new RegExp(r.pattern, r.flags.includes('g') ? r.flags : `${r.flags}g`),
    fileRe: r.files ? new RegExp(r.files, 'i') : null,
  }));
  return {
    id: 'static',
    async run(ctx) {
      const findings: Finding[] = [];
      for (const [path, text] of textFiles(ctx.files)) {
        for (const rule of rules) {
          if (rule.fileRe && !rule.fileRe.test(path)) continue;
          rule.re.lastIndex = 0;
          let hits = 0;
          for (const m of text.matchAll(rule.re)) {
            findings.push({
              analyzer: 'static',
              rule: rule.id,
              severity: rule.severity,
              message: rule.message,
              file: path,
              line: lineOf(text, m.index ?? 0),
              evidence: snippet(text, m.index ?? 0),
            });
            if (++hits >= 5) break;
          }
        }
      }
      return { analyzer: 'static', status: 'done', findings };
    },
  };
}
