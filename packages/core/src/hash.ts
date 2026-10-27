import type { FileMap } from './types';
import { utf8 } from './types';

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalise text for content comparisons: LF line endings, no trailing whitespace at EOF. */
export function normalizeText(bytes: Uint8Array): Uint8Array {
  const s = utf8.decode(bytes);
  if (s.includes('\u0000')) return bytes;
  return utf8.encode(s.replace(/\r\n?/g, '\n').replace(/\s+$/, '\n'));
}

export interface FileDigest {
  path: string;
  sha256: string;
  size: number;
}

export async function digestFiles(files: FileMap): Promise<FileDigest[]> {
  const out: FileDigest[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    out.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength });
  }
  return out;
}

/**
 * Stable content hash of a skill: sha256 over sorted "path\0sha256(normalised)" lines.
 * Independent of archive format, mtimes and line endings, so it is suitable for
 * exact-duplicate detection and upstream change tracking.
 */
export async function contentHash(files: FileMap): Promise<string> {
  const lines: string[] = [];
  for (const path of [...files.keys()].sort()) {
    lines.push(`${path}\u0000${await sha256Hex(normalizeText(files.get(path)!))}`);
  }
  return sha256Hex(lines.join('\n'));
}
