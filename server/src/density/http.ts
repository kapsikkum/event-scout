import { readCappedText } from '../nethost.js';

const MAX_JSON_BYTES = 20 * 1024 * 1024;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A URL with its query values blanked, so keys and tokens never reach a log line. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '…');
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} for ${redactUrl(url)}`);
  }
}

interface FetchOpts extends RequestInit {
  retries?: number;
  timeoutMs?: number;
}

/**
 * fetch with timeout and backoff. Retries on network errors, 429 and 5xx;
 * a 4xx other than 429 is a real answer, so it throws immediately.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { retries = 3, timeoutMs = 20000, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const text = await readCappedText(res, MAX_JSON_BYTES);
      if (!res.ok) {
        const err = new HttpError(res.status, text.slice(0, 500), url);
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
      } else {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Non-JSON response from ${redactUrl(url)}: ${text.slice(0, 200)}`);
        }
      }
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
  throw lastErr;
}

/** Run tasks with a fixed concurrency cap, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
