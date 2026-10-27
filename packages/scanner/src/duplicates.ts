import { type FileMap, utf8 } from '@dojohub/core';
import { isProbablyText } from './util';

const NUM_HASHES = 64;
const SHINGLE = 5;
const SEEDS = Array.from({ length: NUM_HASHES }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) ^ 0x5bd1e995);

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function normalizeForSimilarity(files: FileMap): string {
  const parts: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    if (!isProbablyText(path, bytes)) continue;
    let text = utf8.decode(bytes);
    if (path === 'SKILL.md') text = text.replace(/^---[\s\S]*?\n---/, (fm) => fm.replace(/^name:.*$/m, ''));
    parts.push(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    );
  }
  return parts.join(' ');
}

/** MinHash signature over word 5-shingles; stable across processes. */
export function minhash(files: FileMap): number[] {
  const words = normalizeForSimilarity(files).split(' ').filter(Boolean);
  const shingles = new Set<string>();
  if (words.length < SHINGLE) shingles.add(words.join(' '));
  for (let i = 0; i + SHINGLE <= words.length; i++) shingles.add(words.slice(i, i + SHINGLE).join(' '));
  const sig = new Array<number>(NUM_HASHES).fill(0xffffffff);
  for (const sh of shingles) {
    for (let k = 0; k < NUM_HASHES; k++) {
      const h = fnv1a(sh, SEEDS[k]!);
      if (h < sig[k]!) sig[k] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity (0..1) between two signatures. */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const NEAR_DUPLICATE_THRESHOLD = 0.7;
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.92;
