import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Docker-style multi-registry configuration (~/.config/dojo/config.json). */
export interface Registry {
  url: string;
  user?: { name: string; email: string };
}
export interface CliConfig {
  current?: string;
  registries: Record<string, Registry>;
}

export const CONFIG_DIR = process.env.DOJO_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dojo');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');
const SERVICE = 'dojohub';

export function normalizeUrl(url: string): string {
  const withProto = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProto.replace(/\/+$/, '');
}

export function registryName(url: string): string {
  return new URL(url).host;
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as CliConfig;
  } catch {
    return { registries: {} };
  }
}

export async function saveConfig(cfg: CliConfig) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Resolve the registry for a command: --registry flag, DOJO_REGISTRY env, or the current context. */
export async function currentRegistry(override?: string): Promise<Registry & { name: string }> {
  const cfg = await loadConfig();
  const wanted = override ?? process.env.DOJO_REGISTRY;
  if (wanted) {
    const url = normalizeUrl(wanted);
    const name = registryName(url);
    return { name, ...(cfg.registries[name] ?? { url }) };
  }
  if (!cfg.current || !cfg.registries[cfg.current]) {
    throw new Error('Not logged in. Run `dojo login <registry-url>` first.');
  }
  return { name: cfg.current, ...cfg.registries[cfg.current]! };
}

type Keyring = { Entry: new (service: string, account: string) => { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean } };
let keyring: Keyring | null | undefined;
async function loadKeyring(): Promise<Keyring | null> {
  if (keyring !== undefined) return keyring;
  if (process.env.DOJO_NO_KEYCHAIN) return (keyring = null);
  try {
    keyring = (await import('@napi-rs/keyring')) as unknown as Keyring;
  } catch {
    keyring = null;
  }
  return keyring;
}

async function readCredentialFile(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Tokens live in the OS keychain when available, otherwise in a 0600 file. */
export async function getToken(registry: string): Promise<string | null> {
  if (process.env.DOJO_TOKEN) return process.env.DOJO_TOKEN;
  const k = await loadKeyring();
  if (k) {
    try {
      const v = new k.Entry(SERVICE, registry).getPassword();
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  return (await readCredentialFile())[registry] ?? null;
}

export async function setToken(registry: string, token: string): Promise<'keychain' | 'file'> {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, registry).setPassword(token);
      return 'keychain';
    } catch {
      /* fall back */
    }
  }
  const creds = await readCredentialFile();
  creds[registry] = token;
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await chmod(CREDENTIALS_FILE, 0o600);
  return 'file';
}

export async function deleteToken(registry: string) {
  const k = await loadKeyring();
  if (k) {
    try {
      new k.Entry(SERVICE, registry).deletePassword();
    } catch {
      /* ignore */
    }
  }
  const creds = await readCredentialFile();
  if (creds[registry]) {
    delete creds[registry];
    await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
}
