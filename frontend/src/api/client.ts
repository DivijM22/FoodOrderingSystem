import { API_URL } from '../config';

/** Error envelope returned by every service: { success: false, error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { path?: string; message: string }[] = [],
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation messages keyed by the last path segment (e.g. "body.email" → "email"). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details) {
      const key = d.path?.split('.').slice(1).join('.') || d.path || '';
      if (key && !out[key]) out[key] = d.message;
    }
    return out;
  }
}

export interface Page {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type TokenSource = () => string | null;
type UnauthorizedHandler = (code: string) => void;

let getToken: TokenSource = () => null;
let onUnauthorized: UnauthorizedHandler = () => undefined;

/** Wired by the AuthProvider: where the JWT comes from, and what to do when the gateway rejects it. */
export function configureClient(tokenSource: TokenSource, unauthorized: UnauthorizedHandler) {
  getToken = tokenSource;
  onUnauthorized = unauthorized;
}

const SESSION_ERRORS = new Set(['TOKEN_EXPIRED', 'INVALID_TOKEN', 'MISSING_TOKEN', 'UNAUTHORIZED']);

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Send no Authorization header (public registration/login). */
  anonymous?: boolean;
  /** Extra request headers, e.g. Idempotency-Key. */
  headers?: Record<string, string>;
}

export function buildUrl(path: string, query?: RequestOptions['query']) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${API_URL}${path}${s ? `?${s}` : ''}`;
}

/** One call through the API gateway. Resolves with `{ data, meta }`; rejects with ApiError. */
export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: Page; status: number }> {
  const token = opts.anonymous ? null : getToken();
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_URL}. Is the platform running?`);
  }

  if (res.status === 204) return { data: undefined as T, status: 204 };
  const text = await res.text();
  let json: { success?: boolean; data?: T; meta?: Page; error?: { code?: string; message?: string; details?: { path?: string; message: string }[] } } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. a proxy error page) */
  }

  if (!res.ok || json?.success === false) {
    const e = json?.error ?? {};
    const code = e.code ?? `HTTP_${res.status}`;
    // A rejected session (expired / invalid token) ends the session; wrong credentials at login do not.
    if (res.status === 401 && token && SESSION_ERRORS.has(code)) onUnauthorized(code);
    const retryAfter = Number(res.headers.get('retry-after')) || undefined;
    throw new ApiError(res.status, code, e.message ?? `Request failed (${res.status})`, e.details ?? [], retryAfter);
  }
  return { data: json?.data as T, meta: json?.meta, status: res.status };
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  put: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const extra = err.details.length && !Object.keys(err.fieldErrors()).length ? ` (${err.details.map((d) => d.message).join('; ')})` : '';
    return `${err.message}${extra}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const currentToken = () => getToken();
