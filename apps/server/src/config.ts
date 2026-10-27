import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://dojohub:dojohub@localhost:5432/dojohub'),
  DATABASE_POOL: z.coerce.number().default(10),
  /** Public URL users reach DojoHub at (used for install commands, SSO callbacks, git URLs). */
  DOJO_BASE_URL: z.string().default('http://localhost:3000'),
  /** Secret for sessions and at-rest encryption of BYOK keys/credentials (min 32 chars). */
  DOJO_SECRET_KEY: z.string().min(32).default('dev-insecure-secret-change-me-0123456789abcdef'),
  DOJO_AUTH_LOCAL: bool.default(true),
  DOJO_ALLOW_SIGNUP: bool.default(false),
  DOJO_BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  DOJO_SETUP_TOKEN: z.string().optional(),
  DOJO_ORG_NAME: z.string().default('My Organization'),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_PATH: z.string().default('./.data/blobs'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  DOJO_GIT_CACHE_DIR: z.string().default('./.data/git'),
  DOJO_WORK_DIR: z.string().default('./.data/work'),
  DOJO_WEB_DIST: z.string().optional(),
  DOJO_OSV: bool.default(false),
  DOJO_TRUST_PROXY: bool.default(false),
  /** Run background workers inside the server process (single-container mode). */
  DOJO_EMBEDDED_WORKER: bool.default(false),
  DOJO_METRICS: bool.default(true),
  GITHUB_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('DojoHub <dojohub@localhost>'),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (common with docker-compose `${VAR:-}` defaults) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const cfg = schema.parse(cleaned);
  cfg.DOJO_BASE_URL = cfg.DOJO_BASE_URL.replace(/\/+$/, '');
  if (cfg.NODE_ENV === 'production' && cfg.DOJO_SECRET_KEY.startsWith('dev-insecure')) {
    throw new Error('DOJO_SECRET_KEY must be set to a random value (>= 32 chars) in production');
  }
  return cfg;
}
