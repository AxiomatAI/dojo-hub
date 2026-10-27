import { z } from 'zod';
import { parseSkillMd } from './frontmatter';
import type { FileMap, ValidationIssue } from './types';
import { utf8 } from './types';

/** agentskills.io specification limits. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

export const skillNameSchema = z
  .string()
  .min(1)
  .max(SKILL_NAME_MAX)
  .regex(SKILL_NAME_RE, 'lowercase letters, digits and single hyphens only');

export const skillFrontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: z.string().min(1).max(DESCRIPTION_MAX),
    license: z.string().optional(),
    compatibility: z.string().max(COMPATIBILITY_MAX).optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export function isValidSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name);
}

/** Turn arbitrary text into a spec-compliant skill name. */
export function toSkillName(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SKILL_NAME_MAX)
      .replace(/-+$/g, '') || 'skill'
  );
}

export interface SkillValidation {
  ok: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  issues: ValidationIssue[];
}

/**
 * Validate a skill directory (files relative to the skill root).
 * `dirName` is the directory name the skill will be installed under, when known.
 */
export function validateSkill(files: FileMap, dirName?: string): SkillValidation {
  const issues: ValidationIssue[] = [];
  const raw = files.get('SKILL.md');
  if (!raw) {
    issues.push({ level: 'error', code: 'missing_skill_md', message: 'SKILL.md is missing at the skill root' });
    return { ok: false, frontmatter: {}, body: '', issues };
  }
  const parsed = parseSkillMd(utf8.decode(raw));
  if (parsed.error) issues.push({ level: 'error', code: 'frontmatter_invalid', message: parsed.error, path: 'SKILL.md' });
  if (!parsed.hasFrontmatter) {
    issues.push({ level: 'error', code: 'frontmatter_missing', message: 'SKILL.md has no YAML frontmatter', path: 'SKILL.md' });
  }
  const result = skillFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        level: 'error',
        code: `frontmatter_${issue.path.join('_') || 'root'}`,
        message: `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`,
        path: 'SKILL.md',
      });
    }
  }
  const name = parsed.frontmatter.name;
  if (typeof name === 'string' && dirName && name !== dirName) {
    issues.push({
      level: 'warning',
      code: 'name_dir_mismatch',
      message: `name "${name}" does not match directory "${dirName}"`,
      path: 'SKILL.md',
    });
  }
  if (parsed.body.trim().length === 0) {
    issues.push({ level: 'warning', code: 'empty_body', message: 'SKILL.md has no instructions body', path: 'SKILL.md' });
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    issues,
  };
}
