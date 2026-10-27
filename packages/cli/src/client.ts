import { currentRegistry, getToken } from './config';

export class DojoError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface Client {
  url: string;
  registry: string;
  request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  raw(path: string, init?: RequestInit): Promise<Response>;
}

export async function createClient(opts: { registry?: string; requireAuth?: boolean } = {}): Promise<Client> {
  const reg = await currentRegistry(opts.registry);
  const token = await getToken(reg.name);
  if (opts.requireAuth !== false && !token) throw new Error(`Not logged in to ${reg.name}. Run \`dojo login ${reg.url}\`.`);
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${reg.url}${path}`, { ...init, headers: { 'user-agent': 'dojo-cli/0.1', ...auth, ...(init.headers as Record<string, string>) } });
  return {
    url: reg.url,
    registry: reg.name,
    raw,
    async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const isBinary = body instanceof Uint8Array;
      const res = await raw(`/api/v1${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': isBinary ? 'application/octet-stream' : 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : isBinary ? (body as BodyInit) : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message: string; details?: unknown } };
      if (!res.ok) throw new DojoError(res.status, data.error?.message ?? `HTTP ${res.status}`, data.error?.details);
      return data as T;
    },
  };
}
