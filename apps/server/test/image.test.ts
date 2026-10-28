import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { sniffImage, validateOrgIcon } from '../src/lib/image';

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

const jpeg = (w: number, h: number) => {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  new DataView(b.buffer).setUint16(7, h);
  new DataView(b.buffer).setUint16(9, w);
  return b;
};

const webpLossy = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([...'RIFF'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0], 0);
  b.set([...'WEBP'.split('').map((c) => c.charCodeAt(0))], 8);
  b.set([...'VP8 '.split('').map((c) => c.charCodeAt(0))], 12);
  b.set([0x9d, 0x01, 0x2a], 23);
  new DataView(b.buffer).setUint16(26, w, true);
  new DataView(b.buffer).setUint16(28, h, true);
  return b;
};

const webpLossless = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([...'RIFF'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0], 0);
  b.set([...'WEBP'.split('').map((c) => c.charCodeAt(0))], 8);
  b.set([...'VP8L'.split('').map((c) => c.charCodeAt(0))], 12);
  b[20] = 0x2f;
  const bits = (w - 1) | ((h - 1) << 14);
  new DataView(b.buffer).setUint32(21, bits, true);
  return b;
};

const webpExtended = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([...'RIFF'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0], 0);
  b.set([...'WEBP'.split('').map((c) => c.charCodeAt(0))], 8);
  b.set([...'VP8X'.split('').map((c) => c.charCodeAt(0))], 12);
  const dv = new DataView(b.buffer);
  dv.setUint16(24, w - 1, true);
  dv.setUint16(27, h - 1, true);
  return b;
};

const svg = (text: string) => new TextEncoder().encode(text);
const enc = (s: string) => new TextEncoder().encode(s);

describe('image sniffing', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(sniffImage(png(256, 128))).toMatchObject({
      format: 'png',
      mime: 'image/png',
      width: 256,
      height: 128,
    });
  });
  it('reads JPEG dimensions from the SOF segment', () => {
    expect(sniffImage(jpeg(120, 60))).toMatchObject({
      format: 'jpeg',
      mime: 'image/jpeg',
      width: 120,
      height: 60,
    });
  });
  it('reads WebP dimensions for lossy, lossless and extended variants', () => {
    expect(sniffImage(webpLossy(200, 100))).toMatchObject({ format: 'webp', width: 200, height: 100 });
    expect(sniffImage(webpLossless(200, 100))).toMatchObject({ format: 'webp', width: 200, height: 100 });
    expect(sniffImage(webpExtended(200, 100))).toMatchObject({ format: 'webp', width: 200, height: 100 });
  });
  it('reads SVG dimensions from width/height or viewBox', () => {
    expect(
      sniffImage(svg('<svg xmlns="http://www.w3.org/2000/svg" width="512px" height="256"></svg>')),
    ).toMatchObject({ format: 'svg', width: 512, height: 256 });
    expect(
      sniffImage(svg('<?xml version="1.0"?><!-- logo --><svg viewBox="0 0 64 32"></svg>')),
    ).toMatchObject({ format: 'svg', width: 64, height: 32 });
    expect(sniffImage(svg('<svg></svg>'))).toMatchObject({ format: 'svg', width: 0, height: 0 });
  });
  it('rejects non-image content', () => {
    expect(sniffImage(enc('just some text'))).toBeNull();
    expect(sniffImage(enc('<html><body><svg viewBox="0 0 1 1"/></body></html>'))).toBeNull();
  });
});

describe('organisation icon validation', () => {
  it('accepts a reasonable icon', () => {
    expect(validateOrgIcon(png(256, 256))).toMatchObject({ format: 'png' });
    expect(validateOrgIcon(png(512, 256))).toMatchObject({ format: 'png' }); // 2:1 is fine
  });
  it('rejects empty and oversized files', () => {
    expect(() => validateOrgIcon(new Uint8Array(0))).toThrow(AppError);
    expect(() => validateOrgIcon(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow(/2 MB/);
  });
  it('rejects unsupported formats', () => {
    expect(() => validateOrgIcon(enc('GIF89a not really'))).toThrow(/PNG, JPEG, WebP or SVG/);
  });
  it('rejects tiny images and extreme aspect ratios', () => {
    expect(() => validateOrgIcon(png(16, 16))).toThrow(/at least 32 px/);
    expect(() => validateOrgIcon(png(600, 100))).toThrow(/roughly square/);
    expect(() => validateOrgIcon(svg('<svg viewBox="0 0 100 10"></svg>'))).toThrow(/roughly square/);
  });
});
