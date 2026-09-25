import { test } from 'node:test';
import assert from 'node:assert/strict';

import { download } from '../src/flyerStore.js';
import { feedUrl, readFeed } from '../src/sources/ical.js';
import { fetchText } from '../src/sources/websearch.js';
import { assertPublicUrl, BlockedHostError, publicLookup, readCapped, TooLargeError } from '../src/nethost.js';

test('ical preview feedUrl validation rejects private address', async () => {
  for (const url of [
    'webcal://127.0.0.1/test.ics',
    'webcals://192.168.1.1/events.ics',
    'http://169.254.169.254/latest/meta-data',
    'https://localhost:8080/cal.ics',
  ]) {
    await assert.rejects(() => assertPublicUrl(feedUrl(url)), BlockedHostError, url);
  }
});

test('flyerStore download refuses private address', async () => {
  await assert.rejects(() => download('http://127.0.0.1/flyer.jpg'), BlockedHostError);
  await assert.rejects(() => download('http://169.254.169.254/flyer.jpg'), BlockedHostError);
});

test('flyerStore download refuses redirect to private address', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/metadata.jpg' },
      })) as typeof fetch;
    await assert.rejects(() => download('https://example.com/flyer.jpg'), BlockedHostError);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('flyerStore download refuses too many redirects', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next.jpg' },
      })) as typeof fetch;
    await assert.rejects(() => download('https://example.com/flyer.jpg'), /too many redirects/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ical readFeed refuses private address', async () => {
  await assert.rejects(() => readFeed('http://127.0.0.1/cal.ics', 'Council'), BlockedHostError);
  await assert.rejects(() => readFeed('webcal://192.168.1.1/cal.ics', 'Council'), BlockedHostError);
});

test('ical readFeed refuses redirect to private address', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/private.ics' },
      })) as typeof fetch;
    await assert.rejects(() => readFeed('https://example.com/cal.ics', 'Council'), BlockedHostError);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ical readFeed refuses too many redirects', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next.ics' },
      })) as typeof fetch;
    await assert.rejects(() => readFeed('https://example.com/cal.ics', 'Council'), /too many redirects/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('websearch fetchText refuses private address', async () => {
  await assert.rejects(() => fetchText('http://127.0.0.1/events', 2000), BlockedHostError);
});

test('websearch fetchText refuses redirect to private address', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/secret' },
      })) as typeof fetch;
    await assert.rejects(() => fetchText('https://example.com/events', 2000), BlockedHostError);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('websearch fetchText refuses too many redirects', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next' },
      })) as typeof fetch;
    await assert.rejects(() => fetchText('https://example.com/events', 2000), /too many redirects/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('the connection lookup refuses a name answering with a private address', async () => {
  // What a rebinding server does on the second lookup: the name that passed
  // assertPublicUrl now resolves somewhere private, and the socket is refused.
  const err = await new Promise<Error | null>((resolve) => publicLookup('localhost', {}, (e) => resolve(e)));
  assert.ok(err instanceof BlockedHostError);
});

test('readCapped stops reading once a body passes the cap', async () => {
  const big = new Response(new ReadableStream({
    pull(ctrl) {
      ctrl.enqueue(new Uint8Array(64 * 1024));
    },
  }));
  await assert.rejects(() => readCapped(big, 256 * 1024), TooLargeError);
  const declared = new Response('x', { headers: { 'content-length': String(10 ** 9) } });
  await assert.rejects(() => readCapped(declared, 1024), TooLargeError);
  assert.equal((await readCapped(new Response('hello'), 1024)).toString(), 'hello');
});
