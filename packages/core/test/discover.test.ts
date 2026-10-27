import { describe, expect, it } from 'vitest';
import { discover, fileMapFromRecord } from '../src';

const skill = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name} things\n---\n# ${name}\n${extra}`;

describe('discover', () => {
  it('treats a root SKILL.md as a single skill', () => {
    const r = discover(
      fileMapFromRecord({ 'SKILL.md': skill('solo'), 'scripts/run.sh': '#!/bin/sh\necho hi' }),
    );
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]!.path).toBe('');
    expect([...r.skills[0]!.files.keys()].sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });

  it('finds flat skills/ layout without manifests (open-mercato style)', () => {
    const r = discover(
      fileMapFromRecord({
        'skills/om-a/SKILL.md': skill('om-a'),
        'skills/om-a/references/x.md': 'ref',
        'skills/om-b/SKILL.md': skill('om-b'),
        'docs/skills/om-a.md': 'card',
        'package.json': '{}',
      }),
    );
    expect(r.skills.map((s) => s.name)).toEqual(['om-a', 'om-b']);
    expect(r.skills[0]!.files.has('references/x.md')).toBe(true);
    expect(r.suites).toHaveLength(0);
  });

  it('reads categorised layout with plugin.json skills array (mattpocock style)', () => {
    const r = discover(
      fileMapFromRecord({
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'mattpocock-skills',
          version: '1.3.1',
          skills: ['./skills/engineering/tdd', './skills/productivity/grill'],
        }),
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'mattpocock',
          owner: { name: 'Matt' },
          plugins: [{ name: 'mattpocock-skills', source: './' }],
        }),
        'skills/engineering/tdd/SKILL.md': skill('tdd'),
        'skills/engineering/tdd/mocking.md': 'x',
        'skills/productivity/grill/SKILL.md': skill('grill'),
        'skills/in-progress/wip/SKILL.md': skill('wip'),
      }),
      { exclude: ['skills/in-progress/**'] },
    );
    expect(r.skills.map((s) => s.name).sort()).toEqual(['grill', 'tdd']);
    expect(r.suites).toHaveLength(1);
    expect(r.suites[0]!.name).toBe('mattpocock-skills');
    expect(r.suites[0]!.version).toBe('1.3.1');
    expect(r.suites[0]!.skillPaths.sort()).toEqual(['skills/engineering/tdd', 'skills/productivity/grill']);
  });

  it('groups skills into multiple plugins from one marketplace (anthropics style)', () => {
    const r = discover(
      fileMapFromRecord({
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'anthropic-agent-skills',
          metadata: { version: '1.0.0' },
          plugins: [
            {
              name: 'document-skills',
              source: './',
              strict: false,
              skills: ['./skills/pdf', './skills/xlsx'],
            },
            { name: 'example-skills', source: './', strict: false, skills: ['./skills/art'] },
          ],
        }),
        'skills/pdf/SKILL.md': skill('pdf'),
        'skills/xlsx/SKILL.md': skill('xlsx'),
        'skills/art/SKILL.md': skill('art'),
      }),
    );
    expect(r.suites.map((s) => s.name)).toEqual(['document-skills', 'example-skills']);
    expect(r.skills.find((s) => s.name === 'pdf')!.pluginNames).toEqual(['document-skills']);
  });

  it('follows plugin sub-directories with directory-string skills (pstack style)', () => {
    const r = discover(
      fileMapFromRecord({
        '.claude-plugin/marketplace.json': JSON.stringify({
          plugins: [{ name: 'pstack', source: './harness/pstack/claude-code' }],
        }),
        'harness/pstack/claude-code/.claude-plugin/plugin.json': JSON.stringify({
          name: 'pstack',
          version: '0.15.35',
        }),
        'harness/pstack/claude-code/skills/architect/SKILL.md': skill('architect'),
        'harness/pstack/claude-code/agents/reviewer.md': 'agent',
      }),
    );
    expect(r.skills.map((s) => s.name)).toEqual(['architect']);
    expect(r.suites[0]!.version).toBe('0.15.35');
    expect(r.suites[0]!.assetPaths).toEqual(['harness/pstack/claude-code/agents/reviewer.md']);
  });

  it('flags references that escape the skill directory', () => {
    const r = discover(
      fileMapFromRecord({
        'skills/a/SKILL.md': skill('a', 'See [shared](../../shared/guide.md) and [local](references/x.md)'),
        'skills/a/references/x.md': 'x',
        'shared/guide.md': 'g',
      }),
    );
    expect(r.skills[0]!.externalRefs).toEqual(['shared/guide.md']);
  });

  it('reports validation issues and duplicate names', () => {
    const r = discover(
      fileMapFromRecord({
        'skills/a/SKILL.md': '---\nname: Bad_Name\n---\n',
        'skills/b/SKILL.md': skill('dup'),
        'skills/c/SKILL.md': skill('dup'),
      }),
    );
    expect(r.skills.find((s) => s.path === 'skills/a')!.issues.some((i) => i.level === 'error')).toBe(true);
    expect(r.warnings.some((w) => w.includes('dup'))).toBe(true);
  });
});
