import { describe, expect, it } from 'vitest';
import {
  fileMapFromRecord,
  nextVersion,
  patchFrontmatter,
  resolveVersion,
  suggestBump,
  unifiedDiff,
  validateSkill,
} from '../src';

describe('versions', () => {
  it('bumps and resolves', () => {
    expect(nextVersion(null)).toBe('1.0.0');
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(resolveVersion(['1.0.0', '1.2.0', '2.0.0'], '^1')).toBe('1.2.0');
    expect(resolveVersion(['1.0.0', '1.2.0'], 'latest')).toBe('1.2.0');
    expect(suggestBump({ name: 'a', description: 'x' }, { name: 'a', description: 'y' }, 0)).toBe('minor');
  });

  it('produces a unified diff', () => {
    const d = unifiedDiff('SKILL.md', 'a\nb\nc', 'a\nB\nc');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
  });

  it('validates and patches frontmatter', () => {
    const files = fileMapFromRecord({ 'SKILL.md': '---\nname: pdf\ndescription: PDFs\n---\nUse it.' });
    expect(validateSkill(files, 'pdf').ok).toBe(true);
    expect(validateSkill(files, 'other').issues.map((i) => i.code)).toContain('name_dir_mismatch');
    expect(
      patchFrontmatter('---\nname: pdf\ndescription: PDFs\n---\nUse it.', { name: 'acme-pdf' }),
    ).toContain('name: acme-pdf');
  });
});
