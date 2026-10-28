import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  checkSafePaths,
  contentHash,
  createTarGz,
  createZip,
  fileMapFromRecord,
  readArchive,
  sha256Hex,
  stripSingleRoot,
  utf8,
} from '../src';

const files = fileMapFromRecord({
  'SKILL.md': '---\nname: x\ndescription: y\n---\nbody',
  'scripts/run.sh': '#!/bin/sh\necho ok\n',
  [`references/${'deep/'.repeat(25)}file.md`]: 'long path',
});

describe('archives', () => {
  it('round-trips tar.gz deterministically', async () => {
    const a = createTarGz(files);
    const b = createTarGz(files);
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
    const back = readArchive(a);
    expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
    expect(utf8.decode(back.get('scripts/run.sh')!)).toContain('echo ok');
  });

  it('round-trips zip and strips a single root folder', () => {
    const zipped = zipSync({
      'my-skill/SKILL.md': files.get('SKILL.md')!,
      'my-skill/a.txt': utf8.encode('a'),
    });
    expect([...stripSingleRoot(readArchive(zipped)).keys()].sort()).toEqual(['SKILL.md', 'a.txt']);
    expect(readArchive(createZip(files)).size).toBe(3);
  });

  it('rejects zip-slip paths', () => {
    const evil = zipSync({ '../evil.sh': utf8.encode('x') });
    expect(() => readArchive(evil)).toThrow(ArchiveError);
  });

  it('accepts a bare SKILL.md', () => {
    expect(readArchive(files.get('SKILL.md')!).has('SKILL.md')).toBe(true);
  });

  it('content hash ignores line endings', async () => {
    const lf = fileMapFromRecord({ 'SKILL.md': 'a\nb\n' });
    const crlf = fileMapFromRecord({ 'SKILL.md': 'a\r\nb\r\n' });
    expect(await contentHash(lf)).toBe(await contentHash(crlf));
  });
});

describe('safe skill paths', () => {
  const codes = (paths: string[]) => checkSafePaths(paths).map((i) => i.path);

  it('accepts canonical nested skill layouts', () => {
    expect(
      checkSafePaths([
        'SKILL.md',
        'scripts/run.sh',
        'references/api/guide.md',
        'assets/logo.png',
        '.gitignore',
        '.github/workflows/ci.yml',
        'scripts/.env.example',
      ]),
    ).toEqual([]);
  });

  it.each([
    ['absolute', '/etc/passwd'],
    ['double leading slash', '//SKILL.md'],
    ['traversal', '../outside.sh'],
    ['inner traversal', 'scripts/../../x'],
    ['dot component', './SKILL.md'],
    ['empty component', 'scripts//run.sh'],
    ['trailing slash', 'scripts/'],
    ['backslash', 'scripts\\..\\..\\x'],
    ['drive letter', 'C:/Windows/x'],
    ['NTFS stream', 'SKILL.md:evil'],
    ['NUL', 'SKILL.md\u0000.png'],
    ['newline', 'a\nb'],
    ['git dir', '.git/hooks/pre-commit'],
    ['nested git dir', 'scripts/.git/config'],
    ['git case alias', '.GIT/hooks/post-commit'],
    ['git trailing dot', '.git./hooks/pre-commit'],
    ['git trailing space', '.git /config'],
    ['git 8.3 alias', 'GIT~1/config'],
    ['git HFS ignorable', '.g\u200cit/hooks/pre-commit'],
    ['gitmodules', '.gitmodules'],
    ['dots only', '...'],
    ['empty', ''],
  ])('rejects %s', (_, path) => {
    expect(codes(['SKILL.md', path])).toEqual([path]);
  });

  it('rejects names that collide once normalised', () => {
    expect(codes(['SKILL.md', 'skill.md'])).toEqual(['skill.md']);
    expect(codes(['a/b.md', 'A/B.md.'])).toEqual(['A/B.md.']);
    expect(codes(['caf\u00e9.md', 'cafe\u0301.md'])).toEqual(['cafe\u0301.md']);
  });

  it('rejects file/directory conflicts in either order', () => {
    expect(codes(['scripts', 'scripts/run.sh'])).toEqual(['scripts/run.sh']);
    expect(codes(['scripts/run.sh', 'scripts'])).toEqual(['scripts']);
    expect(codes(['Scripts/run.sh', 'scripts'])).toEqual(['scripts']);
  });
});
