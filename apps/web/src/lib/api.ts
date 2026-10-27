export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[] | undefined;

async function request<T>(method: string, path: string, body?: Json | BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer;
  const res = await fetch(path.startsWith('/') ? path : `/api/v1/${path}`, {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

/** Thin client for DojoHub's REST API (`/api/v1`). Paths are relative to /api/v1 unless they start with "/". */
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: Json | BodyInit, headers?: Record<string, string>) => request<T>('POST', path, body ?? {}, headers),
  put: <T>(path: string, body?: Json) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: Json) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
