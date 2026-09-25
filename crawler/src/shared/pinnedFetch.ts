import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * A `fetch` whose socket connects only where `lookup` allows.
 *
 * Node's own fetch resolves a name itself and offers no hook into it, so a
 * check made beforehand ("does this name resolve somewhere public?") and the
 * connection that follows each do their own lookup — and a DNS server that
 * answers publicly the first time and privately the second (rebinding) walks
 * straight past the check. `http.request` takes the lookup to use for the
 * connection, so the address that is judged is the address that is dialled.
 *
 * Only what the callers here need: GET-shaped requests, gzip/deflate/br
 * decoding, an AbortSignal, and a web `Response` back. No redirects are
 * followed; the caller walks those one hop at a time and checks each.
 *
 * A test that has replaced `globalThis.fetch` to script answers gets that
 * instead, so those tests keep working without a network.
 */
const nativeFetch = globalThis.fetch;

const NULL_BODY = new Set([204, 205, 304]);

export function pinnedFetch(url: string, init: RequestInit, lookup: LookupFunction): Promise<Response> {
  if (globalThis.fetch !== nativeFetch) return globalThis.fetch(url, { ...init, redirect: 'manual' });

  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = new Headers(init.headers);
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers),
        lookup,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) out.append(name, one);
        }

        const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
          : encoding === 'deflate' ? zlib.createInflate()
          : encoding === 'br' ? zlib.createBrotliDecompress()
          : null;
        let body: Readable = res;
        if (decoder) {
          body = pipeline(res, decoder, () => undefined);
          out.delete('content-encoding');
          out.delete('content-length');
        }

        if (status < 200 || status > 599) {
          res.destroy();
          return reject(new Error(`unexpected HTTP status ${status}`));
        }
        const empty = NULL_BODY.has(status) || init.method === 'HEAD';
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers: out,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(init.body == null ? undefined : (init.body as string | Uint8Array));
  });
}
