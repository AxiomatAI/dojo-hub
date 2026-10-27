import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Verify every locale has the same keys as en-US (plural suffixes normalised). */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const PLURAL = /_(zero|one|two|few|many|other)$/;
function keys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = `${prefix}${k.replace(PLURAL, '')}`;
    if (v && typeof v === 'object') for (const kk of keys(v as Record<string, unknown>, `${key}.`)) out.add(kk);
    else out.add(key);
  }
  return out;
}
const load = (l: string) => JSON.parse(readFileSync(join(root, l, 'common.json'), 'utf8')) as Record<string, unknown>;
const base = keys(load('en-US'));
let failed = false;
for (const locale of ['en-GB', 'pl']) {
  const k = keys(load(locale));
  const missing = [...base].filter((x) => !k.has(x));
  const extra = [...k].filter((x) => !base.has(x));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${locale}: missing ${missing.length} [${missing.slice(0, 20).join(', ')}], extra ${extra.length} [${extra.slice(0, 20).join(', ')}]`);
  } else console.log(`${locale}: ${k.size} keys OK`);
}
process.exit(failed ? 1 : 0);
