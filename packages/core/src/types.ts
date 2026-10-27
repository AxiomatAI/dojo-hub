/** In-memory file tree keyed by POSIX relative path (no leading slash). */
export type FileMap = Map<string, Uint8Array>;

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export const utf8 = {
  encode: (s: string): Uint8Array => encoder.encode(s),
  decode: (b: Uint8Array): string => decoder.decode(b),
};

export function fileMapFromRecord(record: Record<string, string | Uint8Array>): FileMap {
  const map: FileMap = new Map();
  for (const [k, v] of Object.entries(record)) map.set(k, typeof v === 'string' ? utf8.encode(v) : v);
  return map;
}

/** Return a new FileMap containing entries below `dir`, with paths made relative to it. */
export function subTree(files: FileMap, dir: string): FileMap {
  if (!dir) return new Map(files);
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const out: FileMap = new Map();
  for (const [p, v] of files) if (p.startsWith(prefix)) out.set(p.slice(prefix.length), v);
  return out;
}

export function totalSize(files: FileMap): number {
  let n = 0;
  for (const v of files.values()) n += v.byteLength;
  return n;
}
