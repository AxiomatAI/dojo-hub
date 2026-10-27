import { type FileMap, utf8 } from '@dojohub/core';

const TEXT_EXT =
  /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql|html?|css|scss|xml|svg|csv|env|lock|gradle|php|pl|lua|r|swift|c|h|cpp|hpp|cs)$/i;

export function isProbablyText(path: string, bytes: Uint8Array): boolean {
  if (TEXT_EXT.test(path)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8000));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return sample.byteLength === 0 || control / sample.byteLength < 0.05;
}

export function* textFiles(files: FileMap): Generator<[string, string]> {
  for (const [path, bytes] of files) if (isProbablyText(path, bytes)) yield [path, utf8.decode(bytes)];
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function snippet(text: string, index: number, length = 120): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, length);
}

const MIME: Record<string, string> = {
  md: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  ps1: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  csv: 'text/csv',
  xml: 'application/xml',
  toml: 'application/toml',
};

export function mimeOf(path: string, bytes: Uint8Array): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? (isProbablyText(path, bytes) ? 'text/plain' : 'application/octet-stream');
}
