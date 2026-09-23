import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eventsFromMicrodata } from '../src/extract/microdata.js';
import { eventsFromLanguage } from '../src/extract/language.js';

// Fixed 'now' within 2026 for consistent date tests
const NOW = new Date('2026-09-15T00:00:00Z');

// ----------------------------------------------------------------------------
// 1. Microdata Extraction Tests
// ----------------------------------------------------------------------------

const MICRODATA_PAGE = `<!doctype html>
<html>
<head><title>Events</title></head>
<body>
  <div itemscope itemtype="http://schema.org/Event">
    <a itemprop="url" href="/events/spring-fair">
      <span itemprop="name">Bathurst Spring Fair</span>
    </a>
    <meta itemprop="startDate" content="2026-10-08T10:00:00+11:00">
    <meta itemprop="endDate" content="2026-10-08T16:00:00+11:00">
    <p itemprop="description">Rides, stalls &amp; live entertainment for all ages.</p>
    <img itemprop="image" src="https://example.com/fair.jpg" alt="Fair poster">
    
    <div itemprop="location" itemscope itemtype="http://schema.org/Place">
      <span itemprop="name">Bathurst Showground</span>
      <div itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
        <span itemprop="streetAddress">1 Main St</span>
        <span itemprop="addressLocality">Bathurst</span>
        <span itemprop="addressRegion">NSW</span>
        <span itemprop="postalCode">2795</span>
      </div>
      <div itemprop="geo" itemscope itemtype="http://schema.org/GeoCoordinates">
        <meta itemprop="latitude" content="-33.41">
        <meta itemprop="longitude" content="149.58">
      </div>
    </div>

    <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
      <meta itemprop="price" content="0">
      <meta itemprop="priceCurrency" content="AUD">
    </div>
  </div>
</body>
</html>`;

test('extracts schema.org/Event microdata with location, geo, price, and dates', () => {
  const events = eventsFromMicrodata(MICRODATA_PAGE, 'https://example.com/events', NOW);
  assert.equal(events.length, 1);

  const ev = events[0];
  assert.equal(ev.title, 'Bathurst Spring Fair');
  assert.equal(ev.startTime, '2026-10-07T23:00:00.000Z');
  assert.equal(ev.endTime, '2026-10-08T05:00:00.000Z');
  assert.equal(ev.description, 'Rides, stalls & live entertainment for all ages.');
  assert.equal(ev.venueName, 'Bathurst Showground');
  assert.equal(ev.address, '1 Main St, Bathurst, NSW, 2795');
  assert.equal(ev.lat, -33.41);
  assert.equal(ev.lng, 149.58);
  assert.equal(ev.imageUrl, 'https://example.com/fair.jpg');
  assert.equal(ev.url, 'https://example.com/events/spring-fair');
  assert.equal(ev.priceText, 'Free');
  assert.equal(ev.foundOn, 'https://example.com/events');
});

test('extracts microdata with schema.org event subtypes (Festival, CommunityEvent, MusicEvent)', () => {
  const html = `
    <div itemscope itemtype="https://schema.org/Festival">
      <h2 itemprop="name">Orange Blossom Festival</h2>
      <time itemprop="startDate" datetime="2026-10-15T09:00:00+11:00">Oct 15</time>
      <span itemprop="location">Orange Botanic Gardens</span>
    </div>
    <div itemscope itemtype="http://schema.org/CommunityEvent">
      <h2 itemprop="name">Penrith Community Market</h2>
      <meta itemprop="startDate" content="2026-10-18T08:00:00+11:00">
      <div itemprop="location" itemscope itemtype="http://schema.org/Place">
        <span itemprop="name">Penrith Park</span>
      </div>
    </div>
  `;

  const events = eventsFromMicrodata(html, 'https://example.com/festivals', NOW);
  assert.equal(events.length, 2);

  assert.equal(events[0].title, 'Orange Blossom Festival');
  assert.equal(events[0].venueName, 'Orange Botanic Gardens');

  assert.equal(events[1].title, 'Penrith Community Market');
  assert.equal(events[1].venueName, 'Penrith Park');
});

test('microdata ignores non-event items and deduplicates identical events', () => {
  const html = `
    <div itemscope itemtype="http://schema.org/Organization">
      <span itemprop="name">Not An Event Org</span>
    </div>
    <div itemscope itemtype="http://schema.org/Event">
      <span itemprop="name">Duplicate Meet</span>
      <meta itemprop="startDate" content="2026-10-10T12:00:00+11:00">
    </div>
    <div itemscope itemtype="http://schema.org/Event">
      <span itemprop="name">Duplicate Meet</span>
      <meta itemprop="startDate" content="2026-10-10T12:00:00+11:00">
    </div>
  `;

  const events = eventsFromMicrodata(html, 'https://example.com/org', NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Duplicate Meet');
});

// ----------------------------------------------------------------------------
// 2. Natural Language Extraction Tests
// ----------------------------------------------------------------------------

test('extracts event from natural language page with title, date in prose, and town in text', async () => {
  const html = `<!doctype html>
  <html>
  <head>
    <meta property="og:title" content="Annual Bathurst Car Meet" />
    <meta property="og:description" content="All makes and models welcome at our annual Bathurst gathering." />
    <meta property="og:image" content="/images/meet.jpg" />
  </head>
  <body>
    <h1>Annual Bathurst Car Meet</h1>
    <p>Come along to our annual show and car rally! Gates open on 18th October 2026 at 10:00am.</p>
    <p>We are meeting in Bathurst for a full day of displays and free admission.</p>
  </body>
  </html>`;

  const events = await eventsFromLanguage(
    html,
    'https://example.com/cars/meet',
    ['Bathurst NSW', 'Orange NSW'],
    NOW
  );

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.title, 'Annual Bathurst Car Meet');
  assert.equal(ev.address, 'Bathurst NSW');
  assert.equal(ev.imageUrl, 'https://example.com/images/meet.jpg');
  assert.equal(ev.dateOnly, false);
  assert.ok(ev.startTime.startsWith('2026-10-17T23:00') || ev.startTime.includes('2026-10-18'));
});

test('extracts event from natural language page with <time datetime="..."> tag', async () => {
  const html = `<!doctype html>
  <html>
  <head><title>Spring Music Festival 2026</title></head>
  <body>
    <h1>Spring Music Festival</h1>
    <p>Live concert featuring local rock and jazz bands.</p>
    <p>When: <time datetime="2026-10-25T18:00:00+11:00">Sunday 25 October 2026</time></p>
    <p>Location: Penrith Civic Centre. Book your tickets now.</p>
  </body>
  </html>`;

  const events = await eventsFromLanguage(
    html,
    'https://example.com/fest',
    ['Penrith NSW'],
    NOW
  );

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.title, 'Spring Music Festival');
  assert.equal(ev.startTime, '2026-10-25T07:00:00.000Z');
  assert.equal(ev.address, 'Penrith NSW');
});

// ----------------------------------------------------------------------------
// 3. Fast Pre-Check Tests (Non-event pages ignored)
// ----------------------------------------------------------------------------

test('fast pre-check ignores non-event pages like privacy policies', async () => {
  const privacyHtml = `<!doctype html>
  <html>
  <head><title>Privacy Policy - Example</title></head>
  <body>
    <h1>Privacy Policy</h1>
    <p>Last updated: 14 January 2026</p>
    <p>We respect your privacy and will not share your personal information or browsing history.</p>
    <p>For questions, contact privacy@example.com.</p>
  </body>
  </html>`;

  const result = await eventsFromLanguage(
    privacyHtml,
    'https://example.com/privacy',
    ['Bathurst NSW'],
    NOW
  );
  assert.deepEqual(result, [], 'Privacy policy should be ignored by fast pre-check');
});

test('fast pre-check ignores pages without dates or times', async () => {
  const aboutHtml = `<!doctype html>
  <html>
  <head><title>About Us</title></head>
  <body>
    <h1>About Our Community Club</h1>
    <p>We are a club that organizes concerts, shows, and festivals throughout the year.</p>
  </body>
  </html>`;

  const result = await eventsFromLanguage(
    aboutHtml,
    'https://example.com/about',
    ['Bathurst NSW'],
    NOW
  );
  assert.deepEqual(result, [], 'Page without dates or times should return []');
});

test('fast pre-check ignores pages without event vocabulary', async () => {
  const blogHtml = `<!doctype html>
  <html>
  <head><title>Cooking Tips</title></head>
  <body>
    <h1>How to bake sourdough bread</h1>
    <p>Posted on 12th October 2026. Here is a recipe with flour, water, and salt.</p>
  </body>
  </html>`;

  const result = await eventsFromLanguage(
    blogHtml,
    'https://example.com/recipes/bread',
    ['Bathurst NSW'],
    NOW
  );
  assert.deepEqual(result, [], 'Blog article without event vocabulary should return []');
});

// ----------------------------------------------------------------------------
// 4. LLM Fallback (Ollama) Tests
// ----------------------------------------------------------------------------

test('gracefully handles unreachable Ollama server without throwing', async () => {
  // Page with event vocab & date in text, but missing title
  const html = `<!doctype html>
  <html>
  <body>
    <p>Huge market festival with food and craft tickets on 20th October 2026 at 10am!</p>
  </body>
  </html>`;

  const result = await eventsFromLanguage(
    html,
    'https://example.com/market',
    ['Bathurst NSW'],
    NOW,
    { ollamaUrl: 'http://127.0.0.1:54321', model: 'llama3' }
  );

  // Since Ollama is unreachable and title was missing, it safely falls back and returns []
  assert.ok(Array.isArray(result));
});

test('invokes Ollama fallback when rule-based extraction misses title', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let chatPayload: any = null;

    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input?.url ?? '';
      if (urlStr.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'test-model', size: 1000 }] }), { status: 200 });
      }
      if (urlStr.endsWith('/api/chat')) {
        chatPayload = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                title: 'Spring Harvest Market',
                start: '2026-10-22T09:00',
                end: '2026-10-22T14:00',
                venue: 'Community Hall',
                address: 'Bathurst NSW',
                description: 'Local produce and crafts at the spring market.',
              }),
            },
          }),
          { status: 200 }
        );
      }
      return originalFetch(input, init);
    }) as any;

    // Page that has date and event vocab, but no <title>, <h1>, or og:title
    const html = `<div><p>Big festival market happening on 22nd October 2026!</p></div>`;

    const result = await eventsFromLanguage(
      html,
      'https://example.com/market-page',
      ['Bathurst NSW'],
      NOW,
      { ollamaUrl: 'http://localhost:11434', model: 'test-model' }
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Spring Harvest Market');
    assert.equal(result[0].venueName, 'Community Hall');
    assert.equal(result[0].address, 'Bathurst NSW');
    assert.ok(chatPayload !== null, 'Ollama /api/chat was called');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
