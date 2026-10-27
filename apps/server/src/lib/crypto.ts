import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM envelope for secrets at rest (BYOK keys, source credentials, webhook secrets). */
export class SecretBox {
  private key: Buffer;
  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'dojohub', 'secret-box-v1', 32));
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url')}`;
  }
  decrypt(payload: string): string {
    if (!payload.startsWith('v1.')) throw new Error('Unsupported secret format');
    const raw = Buffer.from(payload.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  decryptOrNull(payload: string | null | undefined): string | null {
    if (!payload) return null;
    try {
      return this.decrypt(payload);
    } catch {
      return null;
    }
  }
}

export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Human-friendly code without ambiguous characters, e.g. "KQ7M-X4PD". */
export function userCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const PAT_PREFIX = 'dojo_pat_';
export const SCIM_PREFIX = 'dojo_scim_';
