import { validateSkill } from '@dojohub/core';
import type { Analyzer, Finding } from '../types';
import { textFiles } from '../util';

const ALLOWED_EXT =
  /\.(md|mdx|txt|json|jsonc|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|sql|html?|css|svg|png|jpe?g|gif|webp|csv|xml|pdf|ini|cfg|lock|rb|go|rs|java|kt|php|lua|r|swift|c|h|cpp|hpp|cs|ttf|otf|woff2?|ico|xsd|dtd|j2|jinja|tmpl|tpl|mustache|hbs)$/i;
const NO_EXT_OK = /(^|\/)(LICENSE|NOTICE|README|Makefile|Dockerfile|\.gitignore|\.editorconfig|\.env\.example)[^/]*$/i;

/** Hidden or deceptive Unicode: bidi controls, zero-width, tag characters. */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional detection of invisible characters
const HIDDEN_UNICODE = /[‪-‮⁦-⁩​-‏⁠﻿]|\uDB40[\uDC00-\uDC7F]/g;

export interface StructureLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_STRUCTURE_LIMITS: StructureLimits = {
  maxFiles: 500,
  maxTotalBytes: 20 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
};

export function structureAnalyzer(limits: StructureLimits = DEFAULT_STRUCTURE_LIMITS): Analyzer {
  return {
    id: 'structure',
    async run(ctx) {
      const findings: Finding[] = [];
      const add = (f: Omit<Finding, 'analyzer'>) => findings.push({ analyzer: 'structure', ...f });
      const v = validateSkill(ctx.files, ctx.name);
      for (const issue of v.issues) {
        add({
          rule: `spec.${issue.code}`,
          severity: issue.level === 'error' ? 'high' : 'low',
          message: issue.message,
          file: issue.path,
        });
      }
      if (ctx.files.size > limits.maxFiles) {
        add({ rule: 'limits.file_count', severity: 'medium', message: `${ctx.files.size} files exceeds ${limits.maxFiles}` });
      }
      let total = 0;
      for (const [path, bytes] of ctx.files) {
        total += bytes.byteLength;
        if (bytes.byteLength > limits.maxFileBytes) {
          add({ rule: 'limits.file_size', severity: 'medium', message: `File is ${bytes.byteLength} bytes`, file: path });
        }
        const base = path.split('/').pop() ?? path;
        if (!ALLOWED_EXT.test(path) && !NO_EXT_OK.test(path) && base.includes('.')) {
          add({ rule: 'files.unusual_extension', severity: 'low', message: `Unusual file type: ${base}`, file: path });
        }
        if (base.startsWith('.') && !NO_EXT_OK.test(path)) {
          add({ rule: 'files.hidden_file', severity: 'low', message: `Hidden file ${base}`, file: path });
        }
      }
      if (total > limits.maxTotalBytes) {
        add({ rule: 'limits.total_size', severity: 'medium', message: `Total size ${total} bytes exceeds limit` });
      }
      for (const [path, text] of textFiles(ctx.files)) {
        HIDDEN_UNICODE.lastIndex = 0;
        const m = HIDDEN_UNICODE.exec(text);
        if (m) {
          add({
            rule: 'unicode.hidden',
            severity: path.endsWith('.md') ? 'high' : 'medium',
            message: `Invisible/bidirectional Unicode U+${m[0].codePointAt(0)!.toString(16).toUpperCase()} can hide instructions`,
            file: path,
          });
        }
      }
      for (const ref of ctx.externalRefs ?? []) {
        add({ rule: 'files.external_reference', severity: 'low', message: `References file outside the skill: ${ref}` });
      }
      const desc = String(ctx.frontmatter.description ?? '');
      if (desc && desc.length < 20) {
        add({ rule: 'quality.short_description', severity: 'info', message: 'Description is very short; agents use it to decide when to load the skill' });
      }
      return { analyzer: 'structure', status: 'done', findings };
    },
  };
}
