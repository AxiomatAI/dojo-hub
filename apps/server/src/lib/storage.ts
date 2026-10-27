import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config';
import { sha256 } from './crypto';

/** Content-addressed blob store: every file of every skill version is stored once by sha256. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(sha: string): Promise<Uint8Array | null>;
  has(sha: string): Promise<boolean>;
}

const keyFor = (sha: string) => `blobs/sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;

class FsBlobStore implements BlobStore {
  constructor(private root: string) {}
  async put(bytes: Uint8Array) {
    const sha = sha256(bytes);
    const path = join(this.root, keyFor(sha));
    if (await this.has(sha)) return sha;
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    return sha;
  }
  async get(sha: string) {
    try {
      return new Uint8Array(await readFile(join(this.root, keyFor(sha))));
    } catch {
      return null;
    }
  }
  async has(sha: string) {
    try {
      await stat(join(this.root, keyFor(sha)));
      return true;
    } catch {
      return false;
    }
  }
}

class S3BlobStore implements BlobStore {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}
  async put(bytes: Uint8Array) {
    const sha = sha256(bytes);
    if (await this.has(sha)) return sha;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: keyFor(sha), Body: bytes }));
    return sha;
  }
  async get(sha: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: keyFor(sha) }));
      return res.Body ? new Uint8Array(await res.Body.transformToByteArray()) : null;
    } catch {
      return null;
    }
  }
  async has(sha: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: keyFor(sha) }));
      return true;
    } catch {
      return false;
    }
  }
}

export function createBlobStore(cfg: Config): BlobStore {
  if (cfg.STORAGE_DRIVER === 's3') {
    if (!cfg.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    const client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials:
        cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
    return new S3BlobStore(client, cfg.S3_BUCKET);
  }
  return new FsBlobStore(cfg.STORAGE_PATH);
}

/** In-memory store for tests. */
export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    const sha = sha256(bytes);
    this.map.set(sha, bytes);
    return sha;
  }
  async get(sha: string) {
    return this.map.get(sha) ?? null;
  }
  async has(sha: string) {
    return this.map.has(sha);
  }
}
