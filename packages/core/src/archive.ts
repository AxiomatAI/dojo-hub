import { gunzipSync, gzipSync, unzipSync, zipSync } from 'fflate';
import { normalizePath } from './paths';
import type { FileMap } from './types';
import { utf8 } from './types';

export interface ArchiveLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxFiles: 1000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
};

export class ArchiveError extends Error {
  constructor(
    public code:
      | 'unsupported_format'
      | 'unsafe_path'
      | 'link_entry'
      | 'too_many_files'
      | 'too_large'
      | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Fixed timestamp so archives are byte-for-byte reproducible (2024-01-01T00:00:00Z). */
const FIXED_MTIME = 1704067200;

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = utf8.encode(value);
  buf.set(bytes.subarray(0, length), offset);
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length - 1, value.toString(8).padStart(length - 1, '0'));
  buf[offset + length - 1] = 0;
}

function splitUstarName(path: string): { name: string; prefix: string } {
  if (utf8.encode(path).length <= 100) return { name: path, prefix: '' };
  const idx = path.lastIndexOf('/', path.length - 1);
  for (let i = idx; i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (utf8.encode(prefix).length <= 155 && utf8.encode(name).length <= 100) return { name, prefix };
  }
  throw new ArchiveError('unsafe_path', `Path too long for tar: ${path}`);
}

function tarHeader(path: string, size: number, mode: number): Uint8Array {
  const h = new Uint8Array(512);
  const { name, prefix } = splitUstarName(path);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, FIXED_MTIME);
  h.fill(0x20, 148, 156);
  h[156] = 0x30; // '0' regular file
  writeString(h, 257, 6, 'ustar');
  h[262] = 0;
  writeString(h, 263, 2, '00');
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeOctal(h, 148, 7, sum);
  h[155] = 0x20;
  return h;
}

function isExecutable(path: string, bytes: Uint8Array): boolean {
  return (bytes[0] === 0x23 && bytes[1] === 0x21) || /\.(sh|bash|zsh)$/i.test(path);
}

/** Deterministic ustar archive (sorted entries, fixed mtime/uid/gid). */
export function createTar(files: FileMap): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    chunks.push(tarHeader(path, data.byteLength, isExecutable(path, data) ? 0o755 : 0o644));
    chunks.push(data);
    const pad = (512 - (data.byteLength % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Deterministic .tar.gz with SKILL.md at the archive root (agent-skills discovery RFC). */
export function createTarGz(files: FileMap): Uint8Array {
  return gzipSync(createTar(files), { level: 9, mtime: 0 });
}

export function createZip(files: FileMap): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of [...files.keys()].sort())
    entries[path] = [files.get(path)!, { mtime: new Date(FIXED_MTIME * 1000) }];
  return zipSync(entries, { level: 9 });
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const s = utf8
    .decode(buf.subarray(offset, offset + length))
    .replace(/\0.*$/, '')
    .trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function readCString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return utf8.decode(end === -1 ? slice : slice.subarray(0, end));
}

class Collector {
  files: FileMap = new Map();
  total = 0;
  constructor(private limits: ArchiveLimits) {}
  add(rawPath: string, data: Uint8Array) {
    const path = normalizePath(rawPath);
    if (path === null || path === '')
      throw new ArchiveError('unsafe_path', `Unsafe path in archive: ${rawPath}`);
    if (path.split('/').some((s) => s === '__MACOSX' || s === '.DS_Store')) return;
    if (data.byteLength > this.limits.maxFileBytes) {
      throw new ArchiveError('too_large', `${path} exceeds ${this.limits.maxFileBytes} bytes`);
    }
    this.total += data.byteLength;
    if (this.total > this.limits.maxTotalBytes)
      throw new ArchiveError('too_large', 'Archive exceeds size limit');
    this.files.set(path, data);
    if (this.files.size > this.limits.maxFiles)
      throw new ArchiveError('too_many_files', 'Too many files in archive');
  }
}

export function readTar(tar: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): FileMap {
  const c = new Collector(limits);
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readCString(header, 345, 155);
    let name = readCString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + 512;
    if (dataStart + size > tar.byteLength) throw new ArchiveError('corrupt', 'Truncated tar archive');
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = readCString(data, 0, data.byteLength);
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(utf8.decode(data));
      paxPath = m?.[1] ?? null;
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    if (type === '5') continue;
    if (type === '1' || type === '2') throw new ArchiveError('link_entry', `Links are not allowed: ${path}`);
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    c.add(path, data.slice());
  }
  return c.files;
}

export type ArchiveFormat = 'tar.gz' | 'tar' | 'zip' | 'skill-md';

export function detectFormat(bytes: Uint8Array): ArchiveFormat | null {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.byteLength > 262 && utf8.decode(bytes.subarray(257, 262)) === 'ustar') return 'tar';
  const head = utf8.decode(bytes.subarray(0, 8));
  if (head.startsWith('---') || head.startsWith('﻿---')) return 'skill-md';
  return null;
}

/** Strip a single top-level directory when every entry lives under it (common for GitHub archives/zips). */
export function stripSingleRoot(files: FileMap): FileMap {
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  if (tops.size !== 1 || files.has([...tops][0]!)) return files;
  const top = `${[...tops][0]}/`;
  const out: FileMap = new Map();
  for (const [p, v] of files) out.set(p.slice(top.length), v);
  return out;
}

/** Read an uploaded archive (zip, tar, tar.gz) or a bare SKILL.md into a FileMap. */
export function readArchive(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): FileMap {
  const format = detectFormat(bytes);
  switch (format) {
    case 'tar.gz': {
      let tar: Uint8Array;
      try {
        tar = gunzipSync(bytes);
      } catch {
        throw new ArchiveError('corrupt', 'Invalid gzip data');
      }
      if (tar.byteLength > limits.maxTotalBytes * 2)
        throw new ArchiveError('too_large', 'Archive exceeds size limit');
      return readTar(tar, limits);
    }
    case 'tar':
      return readTar(bytes, limits);
    case 'zip': {
      const c = new Collector(limits);
      let entries: Record<string, Uint8Array>;
      let count = 0;
      try {
        entries = unzipSync(bytes, {
          filter: (f) => {
            count++;
            if (count > limits.maxFiles * 2)
              throw new ArchiveError('too_many_files', 'Too many files in archive');
            if (f.originalSize > limits.maxFileBytes) {
              throw new ArchiveError('too_large', `${f.name} exceeds ${limits.maxFileBytes} bytes`);
            }
            return !f.name.endsWith('/');
          },
        });
      } catch (err) {
        if (err instanceof ArchiveError) throw err;
        throw new ArchiveError('corrupt', 'Invalid zip archive');
      }
      for (const [name, data] of Object.entries(entries)) c.add(name, data);
      return c.files;
    }
    case 'skill-md':
      return new Map([['SKILL.md', bytes]]);
    default:
      throw new ArchiveError(
        'unsupported_format',
        'Unsupported archive format (expected zip, tar, tar.gz or SKILL.md)',
      );
  }
}
