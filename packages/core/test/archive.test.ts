import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
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
