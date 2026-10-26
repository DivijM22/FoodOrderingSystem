import { ServiceUnavailableError } from '../errors.js';

export interface ServiceResponse<T> {
  status: number;
  body: T;
}

/**
 * Minimal JSON client for synchronous service-to-service calls.
 * Enforces a timeout so a slow dependency cannot hang the caller (fault isolation).
 */
export async function callService<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number; requestId?: string } = {},
): Promise<ServiceResponse<T>> {
  const { timeoutMs = 3000, requestId, headers, ...rest } = init;
  try {
    const res = await fetch(url, {
      ...rest,
      headers: {
        accept: 'application/json',
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : null) as T;
    return { status: res.status, body };
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw new ServiceUnavailableError(`Upstream service ${reason}: ${new URL(url).host}`);
  }
}
