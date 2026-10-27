import { utf8 } from '@dojohub/core';
import type { Analyzer, Finding } from '../types';

interface Dep {
  ecosystem: 'npm' | 'PyPI';
  name: string;
  version?: string;
  file: string;
}

function parseDeps(path: string, text: string): Dep[] {
  const deps: Dep[] = [];
  const base = path.split('/').pop();
  if (base === 'package.json') {
    try {
      const pj = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(pj[key] ?? {})) {
          deps.push({
            ecosystem: 'npm',
            name,
            version: /^\d+\.\d+\.\d+$/.test(range) ? range : undefined,
            file: path,
          });
        }
      }
      const scripts = (pj.scripts ?? {}) as Record<string, string>;
      for (const hook of ['preinstall', 'install', 'postinstall']) {
        if (scripts[hook]) deps.push({ ecosystem: 'npm', name: `__lifecycle:${hook}`, file: path });
      }
    } catch {
      /* ignore invalid package.json; structure analyzer reports it */
    }
  } else if (base === 'requirements.txt') {
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*(==\s*([\w.]+))?/.exec(line);
      if (m && !line.trim().startsWith('#'))
        deps.push({ ecosystem: 'PyPI', name: m[1]!, version: m[3], file: path });
    }
  } else if (base === 'pyproject.toml') {
    const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
    for (const m of block.matchAll(/["']([A-Za-z0-9_.-]+)\s*(==\s*([\w.]+))?[^"']*["']/g)) {
      deps.push({ ecosystem: 'PyPI', name: m[1]!, version: m[3], file: path });
    }
  }
  return deps;
}

export interface DependencyOptions {
  /** Query OSV.dev for known vulnerabilities (requires outbound internet). */
  osv: boolean;
  fetchImpl?: typeof fetch;
}

export function dependenciesAnalyzer(opts: DependencyOptions = { osv: false }): Analyzer {
  return {
    id: 'dependencies',
    async run(ctx) {
      const deps: Dep[] = [];
      for (const [path, bytes] of ctx.files) deps.push(...parseDeps(path, utf8.decode(bytes)));
      const findings: Finding[] = [];
      for (const d of deps.filter((x) => x.name.startsWith('__lifecycle:'))) {
        findings.push({
          analyzer: 'dependencies',
          rule: 'deps.install_script',
          severity: 'high',
          message: `package.json defines a ${d.name.split(':')[1]} lifecycle script`,
          file: d.file,
        });
      }
      const real = deps.filter((d) => !d.name.startsWith('__'));
      if (real.length) {
        findings.push({
          analyzer: 'dependencies',
          rule: 'deps.declared',
          severity: 'info',
          message: `Declares ${real.length} third-party dependencies: ${real
            .slice(0, 10)
            .map((d) => d.name)
            .join(', ')}${real.length > 10 ? '…' : ''}`,
        });
      }
      if (opts.osv && real.some((d) => d.version)) {
        const f = opts.fetchImpl ?? fetch;
        try {
          const res = await f('https://api.osv.dev/v1/querybatch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              queries: real
                .filter((d) => d.version)
                .map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
          real
            .filter((d) => d.version)
            .forEach((d, i) => {
              const vulns = data.results[i]?.vulns ?? [];
              if (vulns.length) {
                findings.push({
                  analyzer: 'dependencies',
                  rule: 'deps.vulnerable',
                  severity: 'high',
                  message: `${d.name}@${d.version} has known vulnerabilities: ${vulns
                    .map((v) => v.id)
                    .slice(0, 5)
                    .join(', ')}`,
                  file: d.file,
                });
              }
            });
        } catch (err) {
          return {
            analyzer: 'dependencies',
            status: 'done',
            findings,
            error: `OSV lookup failed: ${(err as Error).message}`,
          };
        }
      }
      return { analyzer: 'dependencies', status: 'done', findings, report: { dependencies: real } };
    },
  };
}
