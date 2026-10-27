import type { AssetFlag } from '@dojohub/contract';
import { utf8 } from '@dojohub/core';
import type { Analyzer, Finding } from '../types';
import { isProbablyText } from '../util';

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|ps1|psm1|rb|pl|php|bat|cmd|lua)$/i;
const BINARY_EXEC = /\.(exe|dll|so|dylib|bin|elf|app|msi|deb|rpm|jar|class|wasm|pyc)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const NETWORK = /\b(curl|wget|fetch\(|requests\.(get|post|put)|urllib|http\.(get|request)|axios|net\.connect|socket\.|Invoke-WebRequest|httpx)\b/;
const FS_WRITE = /(\bwriteFile(Sync)?\b|open\([^)]*['"][wa]\+?['"]|\s>{1,2}\s*[~/$]|\brm\s+-|\bmv\s|\bcp\s|shutil\.(rmtree|move|copy)|fs\.(rm|unlink|rename))/;
const ENV_ACCESS = /(process\.env|os\.environ|getenv\(|\$\{?[A-Z_]{3,}\}?|\$env:)/;
const OBFUSCATED = /([A-Za-z0-9+/]{400,}={0,2}|(\\x[0-9a-f]{2}){24,}|eval\s*\(\s*(atob|unescape|Buffer\.from))/i;

export function classifyFile(path: string, bytes: Uint8Array): AssetFlag[] {
  const flags = new Set<AssetFlag>();
  const text = isProbablyText(path, bytes);
  if (BINARY_EXEC.test(path)) flags.add('executable');
  if (ARCHIVE.test(path)) flags.add('archive');
  if (!text && !/\.(png|jpe?g|gif|webp|ico|pdf|ttf|otf|woff2?)$/i.test(path)) flags.add('binary');
  if (bytes.byteLength > 1024 * 1024) flags.add('large');
  if (text) {
    const s = utf8.decode(bytes);
    const isScript = SCRIPT_EXT.test(path) || s.startsWith('#!');
    if (isScript) flags.add('script');
    if (s.startsWith('#!')) flags.add('executable');
    if (isScript || /\.(md|txt)$/i.test(path)) {
      if (NETWORK.test(s)) flags.add('network');
      if (isScript && FS_WRITE.test(s)) flags.add('fs-write');
      if (isScript && ENV_ACCESS.test(s)) flags.add('env-access');
    }
    if (OBFUSCATED.test(s)) flags.add('obfuscated');
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: detection of invisible characters
    if (/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060]/.test(s)) flags.add('hidden-unicode');
  }
  return [...flags].sort();
}

const FLAG_SEVERITY: Partial<Record<AssetFlag, Finding['severity']>> = {
  executable: 'medium',
  binary: 'high',
  archive: 'medium',
  obfuscated: 'high',
  'hidden-unicode': 'high',
};

export function assetsAnalyzer(): Analyzer {
  return {
    id: 'assets',
    async run(ctx) {
      const fileFlags: Record<string, AssetFlag[]> = {};
      const findings: Finding[] = [];
      for (const [path, bytes] of ctx.files) {
        const flags = classifyFile(path, bytes);
        fileFlags[path] = flags;
        for (const flag of flags) {
          const severity = FLAG_SEVERITY[flag];
          if (severity) {
            findings.push({ analyzer: 'assets', rule: `asset.${flag}`, severity, message: `Risky asset: ${flag}`, file: path });
          }
        }
      }
      const scripts = Object.values(fileFlags).filter((f) => f.includes('script')).length;
      if (scripts > 0) {
        findings.push({
          analyzer: 'assets',
          rule: 'asset.scripts_present',
          severity: 'info',
          message: `Skill bundles ${scripts} executable script(s) the agent may run`,
        });
      }
      return { analyzer: 'assets', status: 'done', findings, fileFlags };
    },
  };
}
