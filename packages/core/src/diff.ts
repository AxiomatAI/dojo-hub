import type { FileDigest } from './hash';

export interface FileChange {
  path: string;
  change: 'added' | 'removed' | 'modified';
  before?: string;
  after?: string;
}

export function diffManifests(before: FileDigest[], after: FileDigest[]): FileChange[] {
  const a = new Map(before.map((f) => [f.path, f.sha256]));
  const b = new Map(after.map((f) => [f.path, f.sha256]));
  const changes: FileChange[] = [];
  for (const [path, sha] of b) {
    const prev = a.get(path);
    if (prev === undefined) changes.push({ path, change: 'added', after: sha });
    else if (prev !== sha) changes.push({ path, change: 'modified', before: prev, after: sha });
  }
  for (const [path, sha] of a) if (!b.has(path)) changes.push({ path, change: 'removed', before: sha });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/** Simple line diff (Myers O(ND)) producing unified-diff-like hunks for review UIs and LLM prompts. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = myers(a, b);
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end]!.op !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.op === ' ') run++;
      if (run > context * 2 || end + run >= ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    lines.push('@@');
    for (const o of ops.slice(start, end)) lines.push(`${o.op}${o.line}`);
    i = end;
  }
  return lines.join('\n');
}

function myers(a: string[], b: string[]): { op: ' ' | '-' | '+'; line: string }[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  const out: { op: ' ' | '-' | '+'; line: string }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? 0) < (vv.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: ' ', line: a[--x]! });
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: '+', line: b[--y]! });
      else out.push({ op: '-', line: a[--x]! });
    }
  }
  return out.reverse();
}
