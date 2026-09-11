import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MergedEvent } from '../src/events.js';
import { matchesFilters } from '../src/notify/filters.js';
import { discordPayloads, matrixContent, matrixList } from '../src/notify/format.js';
import { digestSlot, inQuietHours, planTarget } from '../src/notify/run.js';
import type { NotifyStore, Snapshot } from '../src/notify/store.js';
import { DEFAULT_FILTERS, normalizeTarget } from '../src/notify/targets.js';
import { parseCommand, runCommand } from '../src/notify/commands.js';
import { isDiscordWebhook } from '../src/notify/discord.js';
import { mergeSecrets, redactSettings } from '../src/secrets.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';
import { useZone } from './zone.js';

let nextId = 1;
function ev(over: Partial<MergedEvent> = {}): MergedEvent {
  const id = nextId++;
  return {
    group: `g${id}`, title: `Event ${id}`, description: '', startTime: '2026-09-20T09:00:00.000Z', endTime: null,
    venueName: 'Mount Panorama', address: '', locality: 'Bathurst', place: 'Bathurst', lat: null, lng: null,
    imageUrl: '', category: 'Motorsport', priceText: '', isOnline: false, dateOnly: false, photoScore: 50,
    starred: false, hidden: false, firstSeenAt: '2026-09-10T00:00:00.000Z', unknownLocation: false, culled: null,
    sources: [{ source: 'crawler', url: `https://example.com/${id}` }], images: [],
    members: [{ id, source: 'crawler', title: '', url: '', imageUrl: '', startTime: '', venueName: '' }],
    manual: false, series: `s${id}`, note: '', enriched: {}, edited: [], rawDescription: '',
    ...over,
  };
}

function memoryStore(): NotifyStore {
  const kv = new Map<string, string>();
  const sent = new Set<string>();
  const snaps = new Map<string, Snapshot>();
  return {
    get: (k) => kv.get(k) ?? null,
    set: (k, v) => void kv.set(k, v),
    wasSent: (t, k, r) => sent.has(`${t}|${k}|${r}`),
    markSent: (t, k, r) => void sent.add(`${t}|${k}|${r}`),
    snapshot: (t, r) => snaps.get(`${t}|${r}`) ?? null,
    setSnapshot: (t, r, s) => void snaps.set(`${t}|${r}`, s),
  };
}

test('filters narrow, and an empty one lets everything through', () => {
  const e = ev({ title: 'Cars & Coffee', place: 'Penrith', category: 'Cars & bikes', photoScore: 40 });
  assert.ok(matchesFilters(e, DEFAULT_FILTERS));
  assert.ok(matchesFilters(e, { ...DEFAULT_FILTERS, places: ['Penrith NSW'] }), 'the region does not matter');
  assert.ok(!matchesFilters(e, { ...DEFAULT_FILTERS, places: ['Bathurst'] }));
  assert.ok(!matchesFilters(e, { ...DEFAULT_FILTERS, minPhotoScore: 60 }));
  assert.ok(matchesFilters(e, { ...DEFAULT_FILTERS, keywords: ['coffee'] }));
  assert.ok(!matchesFilters(e, { ...DEFAULT_FILTERS, excludeCategories: ['cars & bikes'] }));
  assert.ok(!matchesFilters(e, { ...DEFAULT_FILTERS, starredOnly: true }));
  assert.ok(matchesFilters(ev({ unknownLocation: true, place: '' }), { ...DEFAULT_FILTERS, places: ['unknown'] }));
});

test('a long run of new events is split within Discord’s limits, the ping on the first only', () => {
  const target = normalizeTarget({ kind: 'discord', mention: '123456789012345678' });
  const items = Array.from({ length: 25 }, () => ({ ev: ev({ description: 'x'.repeat(400) }) }));
  const payloads = discordPayloads({ kind: 'new', heading: 'new ones', items }, target, '');
  assert.ok(payloads.length >= 3);
  for (const p of payloads) assert.ok((p.embeds as unknown[]).length <= 10);
  assert.match(String(payloads[0].content), /^<@&123456789012345678> new ones/);
  assert.equal(payloads[1].content, undefined);
  assert.deepEqual((payloads[0].allowed_mentions as { roles: string[] }).roles, ['123456789012345678']);
});

test('entities in a title come out as the characters they stand for', () => {
  const e = ev({ title: 'Father&#8217;s Day Out', venueName: 'Volunteers&#8217; Pavillion' });
  const [payload] = discordPayloads({ kind: 'new', heading: 'h', items: [{ ev: e }] }, normalizeTarget({}), '');
  const embed = (payload.embeds as { title: string; description: string }[])[0];
  assert.equal(embed.title, 'Father’s Day Out');
  assert.match(embed.description, /Volunteers’ Pavillion/);
  assert.match(matrixList('h', [{ ev: e }], '').body, /Father’s Day Out/);
});

test('a Matrix room can have the full look, a ping, and ordinary messages', () => {
  const e = ev({ description: 'Bring the car.', priceText: 'Free', imageUrl: 'https://x.example/y.jpg' });
  const notice = { kind: 'new' as const, heading: 'new', items: [{ ev: e }] };
  const pics = { 'https://x.example/y.jpg': 'mxc://hs/abc' };
  const loud = matrixContent(notice, normalizeTarget({ kind: 'matrix', style: 'full', mention: '@room', matrixLoud: true }), '', pics);
  assert.equal(loud.msgtype, 'm.text');
  assert.deepEqual(loud['m.mentions'], { room: true });
  assert.match(loud.body, /^@room new/);
  assert.match(loud.formatted_body!, /Bring the car\./);
  assert.match(loud.formatted_body!, /Motorsport · Free · 📷 50/);
  assert.match(loud.formatted_body!, /<img src="mxc:\/\/hs\/abc"/);
  const quiet = matrixContent(notice, normalizeTarget({ kind: 'matrix', style: 'compact' }), '', pics);
  assert.equal(quiet.msgtype, 'm.notice');
  assert.deepEqual(quiet['m.mentions'], {}, 'nobody pinged by accident');
  assert.ok(!quiet.formatted_body!.includes('<img'));
  assert.ok(!quiet.formatted_body!.includes('Bring the car'));
});

test('commands in a room with a target list only what its filters let through', () => {
  const soon = new Date(Date.now() + 86400_000).toISOString();
  const list = [
    ev({ title: 'Hillclimb', category: 'Motorsport', startTime: soon }),
    ev({ title: 'Farmers market', category: 'Markets', startTime: soon }),
  ];
  const deps = {
    events: () => list, setFlag: () => undefined, status: () => '', allowed: () => false, appUrl: '', prefix: '!',
    filters: { ...DEFAULT_FILTERS, categories: ['Motorsport'] },
  };
  const body = runCommand({ name: 'events', args: ['week'] }, { roomId: '!cars', sender: '@a:x' }, deps)!.body;
  assert.match(body, /Hillclimb/);
  assert.doesNotMatch(body, /Farmers market/);
});

test('Matrix HTML is escaped', () => {
  const content = matrixList('<b>heading</b>', [{ ev: ev({ title: 'Cars < Coffee & "Co"' }) }], '');
  assert.ok(content.formatted_body!.includes('&lt;b&gt;heading&lt;/b&gt;'));
  assert.ok(content.formatted_body!.includes('Cars &lt; Coffee &amp; &quot;Co&quot;'));
  // Markup in a title is dropped before it gets that far.
  const tagged = matrixList('h', [{ ev: ev({ title: '<script>x</script>Swap meet' }) }], '');
  assert.ok(!tagged.formatted_body!.includes('<script'));
});

test('new events: the first run only sets the watermark, then settled finds are sent once', () => {
  const store = memoryStore();
  const target = normalizeTarget({ id: 't1', kind: 'discord' });
  const now = new Date('2026-09-11T10:00:00.000Z');
  const old = ev({ firstSeenAt: '2026-09-11T08:00:00.000Z' });
  assert.equal(planTarget(target, [old], store, now).length, 0, 'backlog not posted');

  const later = new Date('2026-09-11T11:00:00.000Z');
  const fresh = ev({ firstSeenAt: '2026-09-11T10:10:00.000Z' });
  const tooRecent = ev({ firstSeenAt: '2026-09-11T10:50:00.000Z' });
  const culled = ev({ firstSeenAt: '2026-09-11T10:15:00.000Z', culled: '900 km away' });
  const [notice] = planTarget(target, [old, fresh, tooRecent, culled], store, later);
  assert.equal(notice.kind, 'new');
  assert.deepEqual(notice.items.map((i) => i.ev.group), [fresh.group]);

  const again = new Date('2026-09-11T11:30:00.000Z');
  const [next] = planTarget(target, [old, fresh, tooRecent, culled], store, again);
  assert.deepEqual(next.items.map((i) => i.ev.group), [tooRecent.group], 'the settled one arrives, the sent one does not repeat');
});

test('the dates of a series come as one item', () => {
  const store = memoryStore();
  const target = normalizeTarget({ id: 't2' });
  planTarget(target, [], store, new Date('2026-09-11T00:00:00.000Z'));
  const dates = [1, 2, 3].map((d) => ev({ series: 'dance', firstSeenAt: '2026-09-11T00:10:00.000Z', startTime: `2026-09-2${d}T09:00:00.000Z` }));
  const [notice] = planTarget(target, dates, store, new Date('2026-09-11T02:00:00.000Z'));
  assert.equal(notice.items.length, 1);
  assert.equal(notice.items[0].moreDates, 2);
});

test('a reminder comes once, however many offsets have passed', () => {
  const store = memoryStore();
  const target = normalizeTarget({ id: 't3', triggers: { newEvents: { enabled: false }, reminders: { enabled: true, hoursBefore: [24, 2] } } });
  const star = ev({ starred: true, startTime: '2026-09-11T12:00:00.000Z' });
  const now = new Date('2026-09-11T10:30:00.000Z');
  const notices = planTarget(target, [star], store, now);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'reminder');
  assert.equal(planTarget(target, [star], store, new Date('2026-09-11T11:00:00.000Z')).length, 0);
});

test('a starred event that moves is reported with what changed', () => {
  const store = memoryStore();
  const target = normalizeTarget({ id: 't4', triggers: { newEvents: { enabled: false }, starredChanges: { enabled: true } } });
  const before = ev({ starred: true, venueName: 'Old Hall' });
  const now = new Date('2026-09-11T00:00:00.000Z');
  assert.equal(planTarget(target, [before], store, now).length, 0, 'first sight is a snapshot, not a change');
  const moved = { ...before, venueName: 'New Hall' };
  const [notice] = planTarget(target, [moved], store, now);
  assert.equal(notice.kind, 'change');
  assert.deepEqual(notice.items[0].changes, [{ field: 'venue', before: 'Old Hall', after: 'New Hall' }]);
});

test('digest slots and quiet hours', (t) => {
  useZone(t, 'Australia/Sydney');
  const thu6pm = { enabled: true, cadence: 'weekly' as const, weekday: 4, hour: 18, daysAhead: 7 };
  // Friday 11 Sept 2026, 9am: the last slot was Thursday the 10th at 6pm.
  assert.equal(digestSlot(thu6pm, new Date(2026, 8, 11, 9)).getTime(), new Date(2026, 8, 10, 18).getTime());
  assert.equal(digestSlot({ ...thu6pm, cadence: 'daily' }, new Date(2026, 8, 11, 9)).getTime(), new Date(2026, 8, 10, 18).getTime());
  const night = { enabled: true, from: 22, to: 7 };
  assert.ok(inQuietHours(night, new Date(2026, 8, 11, 23)));
  assert.ok(inQuietHours(night, new Date(2026, 8, 11, 3)));
  assert.ok(!inQuietHours(night, new Date(2026, 8, 11, 12)));
});

test('commands: parsed by prefix, and changes kept to the allowed list', () => {
  assert.deepEqual(parseCommand('!events weekend cars', '!'), { name: 'events', args: ['weekend', 'cars'] });
  assert.equal(parseCommand('hello there', '!'), null);
  const list = [ev({ title: 'Swap meet', startTime: new Date(Date.now() + 86400_000).toISOString() })];
  const flags: string[] = [];
  const deps = {
    events: () => list, setFlag: (g: string, f: string, v: boolean) => void flags.push(`${g}:${f}:${v}`),
    status: () => 'ok', allowed: (s: string) => s === '@me:x', appUrl: '', prefix: '!',
  };
  const shown = runCommand({ name: 'events', args: ['week'] }, { roomId: '!r', sender: '@you:x' }, deps)!;
  assert.match(shown.body, /1\. Swap meet/);
  assert.match(runCommand({ name: 'star', args: ['1'] }, { roomId: '!r', sender: '@you:x' }, deps)!.body, /allowed list/);
  runCommand({ name: 'star', args: ['1'] }, { roomId: '!r', sender: '@me:x' }, deps);
  assert.deepEqual(flags, [`${list[0].group}:starred:true`]);
});

test('webhooks: only Discord’s, kept like any other credential', () => {
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123/abc-DEF_9'));
  assert.ok(!isDiscordWebhook('https://example.com/api/webhooks/123/abc'));
  assert.ok(!isDiscordWebhook('http://192.168.1.1/'));
  const stored = { ...DEFAULT_SETTINGS, notifyTargets: [normalizeTarget({ id: 'a', webhookUrl: 'https://discord.com/api/webhooks/1/x' })] };
  const shown = redactSettings(stored);
  assert.equal(shown.notifyTargets[0].webhookUrl, '');
  assert.equal(shown.notifyTargets[0].webhookSet, true);
  const kept = mergeSecrets(stored, { notifyTargets: [{ ...shown.notifyTargets[0], name: 'renamed' }] });
  assert.equal(kept.notifyTargets![0].webhookUrl, 'https://discord.com/api/webhooks/1/x');
  assert.equal(kept.notifyTargets![0].name, 'renamed');
  const cleared = mergeSecrets(stored, { notifyTargets: [{ ...shown.notifyTargets[0], webhookUrl: null }] });
  assert.equal(cleared.notifyTargets![0].webhookUrl, '');
});
