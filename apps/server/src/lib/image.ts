import { AppError } from './errors';

/** Organisation icon constraints (shared with the web UI copy in `admin.orgIconHelp`). */
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MIN_ICON_SIDE = 32;
export const MIN_ICON_RATIO = 0.5;
export const MAX_ICON_RATIO = 2;

export type IconFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface ImageInfo {
  format: IconFormat;
  mime: string;
  /** Nominal pixel dimensions; 0 × 0 for SVGs without width/height/viewBox. */
  width: number;
  height: number;
}

const MIME: Record<IconFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then an IHDR chunk: length(4) 'IHDR'(4) width(4) height(4) …
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;
  if (String.fromCharCode(...b.slice(12, 16)) !== 'IHDR') return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: be16(b, i + 5), width: be16(b, i + 7) };
    i += 2 + be16(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  if (String.fromCharCode(...b.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...b.slice(8, 12)) !== 'WEBP')
    return null;
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (le24(b, 21) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

function svgSize(b: Uint8Array): { width: number; height: number } | null {
  const text = new TextDecoder('utf-8').decode(b);
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim();
  const root = /^<svg\b[^>]*>/i.exec(cleaned);
  if (!root) return null;
  const tag = root[0];
  const attr = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
    return m?.[1]?.trim();
  };
  const length = (v: string | undefined) => {
    const m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(v ?? '');
    return m ? Number.parseFloat(m[1]!) : NaN;
  };
  const w = length(attr('width'));
  const h = length(attr('height'));
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  const vb = (attr('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2]! > 0 && vb[3]! > 0)
    return { width: Math.round(Math.abs(vb[2]!)), height: Math.round(Math.abs(vb[3]!)) };
  // SVG scales; without width/height/viewBox the ratio is unknowable — accept without dimensions.
  return { width: 0, height: 0 };
}

/** Detect the image format from its content (the client-declared MIME is not trusted). */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const png = pngSize(bytes);
  if (png) return { format: 'png', mime: MIME.png, ...png };
  const jpeg = jpegSize(bytes);
  if (jpeg) return { format: 'jpeg', mime: MIME.jpeg, ...jpeg };
  const webp = webpSize(bytes);
  if (webp) return { format: 'webp', mime: MIME.webp, ...webp };
  const svg = svgSize(bytes);
  if (svg) return { format: 'svg', mime: MIME.svg, ...svg };
  return null;
}

/** Validate an organisation icon upload; throws an AppError with a user-readable message. */
export function validateOrgIcon(bytes: Uint8Array): ImageInfo {
  if (bytes.length === 0) throw new AppError(400, 'bad_request', 'The file is empty');
  if (bytes.length > MAX_ICON_BYTES)
    throw new AppError(413, 'bad_request', 'The icon must be 2 MB or smaller');
  const info = sniffImage(bytes);
  if (!info) throw new AppError(400, 'bad_request', 'Unsupported image format — use PNG, JPEG, WebP or SVG');
  const { width, height, format } = info;
  if (width > 0 && height > 0) {
    if (format !== 'svg' && Math.min(width, height) < MIN_ICON_SIDE)
      throw new AppError(400, 'bad_request', `The image must be at least ${MIN_ICON_SIDE} px on each side`);
    const ratio = width / height;
    if (ratio < MIN_ICON_RATIO || ratio > MAX_ICON_RATIO)
      throw new AppError(400, 'bad_request', 'Use a roughly square image (aspect ratio between 1:2 and 2:1)');
  }
  return info;
}
