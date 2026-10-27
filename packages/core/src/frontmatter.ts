import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  error?: string;
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMd(content: string): ParsedSkillMd {
  if (/^﻿?---js\b/.test(content)) {
    return { frontmatter: {}, body: content, hasFrontmatter: false, error: 'JavaScript frontmatter is not allowed' };
  }
  const m = FM_RE.exec(content);
  if (!m) return { frontmatter: {}, body: content, hasFrontmatter: false };
  const body = content.slice(m[0].length);
  try {
    const data = parseYaml(m[1] ?? '', { maxAliasCount: 50 }) as unknown;
    if (data === null || data === undefined) return { frontmatter: {}, body, hasFrontmatter: true };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { frontmatter: {}, body, hasFrontmatter: true, error: 'Frontmatter must be a YAML mapping' };
    }
    return { frontmatter: data as Record<string, unknown>, body, hasFrontmatter: true };
  } catch (err) {
    return { frontmatter: {}, body, hasFrontmatter: true, error: `Invalid YAML: ${(err as Error).message}` };
  }
}

export function serializeSkillMd(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/** Rewrite selected frontmatter keys while preserving the body. */
export function patchFrontmatter(content: string, patch: Record<string, unknown>): string {
  const parsed = parseSkillMd(content);
  return serializeSkillMd({ ...parsed.frontmatter, ...patch }, parsed.hasFrontmatter ? parsed.body : content);
}
