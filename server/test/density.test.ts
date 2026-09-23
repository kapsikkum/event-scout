import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { parseDensityParams, parseHistoryDays, renderArea, venueHistory } from '../src/density/pipeline.js';
import { selectObservations } from '../src/density/store.js';
import { pickAreas } from '../src/density/areas.js';
import type { Area } from '../src/density/areas.js';
import { getSettings, saveSettings } from '../src/db.js';

const sampleArea: Area = {
  name: 'Bathurst',
  slug: 'bathurst',
  bbox: { south: -33.46, north: -33.37, west: 149.52, east: 149.64 },
  cellMeters: 150,
  kernelMeters: 300,
};

test('parseDensityParams: hours is strictly positive and finite', () => {
  assert.equal(parseDensityParams({ hours: '12' }).hours, 12);
  assert.equal(parseDensityParams({ hours: '0.5' }).hours, 0.5);
  assert.equal(parseDensityParams({ hours: 24 }).hours, 24);

  // Non-numeric or invalid values fall back to undefined
  assert.equal(parseDensityParams({ hours: 'abc' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: 'NaN' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: NaN }).hours, undefined);
  assert.equal(parseDensityParams({ hours: '0' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: 0 }).hours, undefined);
  assert.equal(parseDensityParams({ hours: '-5' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: -5 }).hours, undefined);
  assert.equal(parseDensityParams({ hours: 'Infinity' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: Infinity }).hours, undefined);
  assert.equal(parseDensityParams({ hours: '' }).hours, undefined);
  assert.equal(parseDensityParams({ hours: '   ' }).hours, undefined);
  assert.equal(parseDensityParams({}).hours, undefined);
});

test('parseDensityParams: hour is an integer between 0 and 23', () => {
  assert.equal(parseDensityParams({ hour: '0' }).hourOfDay, 0);
  assert.equal(parseDensityParams({ hour: 0 }).hourOfDay, 0);
  assert.equal(parseDensityParams({ hour: '12' }).hourOfDay, 12);
  assert.equal(parseDensityParams({ hour: '23' }).hourOfDay, 23);
  assert.equal(parseDensityParams({ hour: 23 }).hourOfDay, 23);

  // Non-numeric, out of range, or non-integer values fall back to undefined
  assert.equal(parseDensityParams({ hour: 'bar' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: 'NaN' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: NaN }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '-1' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: -1 }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '24' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: 24 }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '99' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '12.5' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: 12.5 }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({ hour: '   ' }).hourOfDay, undefined);
  assert.equal(parseDensityParams({}).hourOfDay, undefined);
});

test('parseDensityParams: days filters to valid integers in 0..6', () => {
  assert.deepEqual(parseDensityParams({ days: '0,1,6' }).daysOfWeek, [0, 1, 6]);
  assert.deepEqual(parseDensityParams({ days: '0, 3, 5' }).daysOfWeek, [0, 3, 5]);
  assert.deepEqual(parseDensityParams({ days: '0,bad,3,99,-1,5,2.5' }).daysOfWeek, [0, 3, 5]);

  // If no valid days remain, undefined is returned
  assert.equal(parseDensityParams({ days: 'bad,foo,99,-2' }).daysOfWeek, undefined);
  assert.equal(parseDensityParams({ days: '' }).daysOfWeek, undefined);
  assert.equal(parseDensityParams({ days: '   ' }).daysOfWeek, undefined);
  assert.equal(parseDensityParams({}).daysOfWeek, undefined);
});

test('parseDensityParams: all flag parses correctly', () => {
  assert.equal(parseDensityParams({ all: '1' }).all, true);
  assert.equal(parseDensityParams({ all: 'true' }).all, false);
  assert.equal(parseDensityParams({ all: '0' }).all, false);
  assert.equal(parseDensityParams({}).all, false);
});

test('parseHistoryDays: strictly validates positive finite number with 14 default', () => {
  assert.equal(parseHistoryDays('7'), 7);
  assert.equal(parseHistoryDays('30'), 30);
  assert.equal(parseHistoryDays(7), 7);
  assert.equal(parseHistoryDays('1.5'), 1.5);

  // Invalid or out-of-range values fall back to 14 (or given default)
  assert.equal(parseHistoryDays('invalid'), 14);
  assert.equal(parseHistoryDays('abc'), 14);
  assert.equal(parseHistoryDays('NaN'), 14);
  assert.equal(parseHistoryDays(NaN), 14);
  assert.equal(parseHistoryDays('0'), 14);
  assert.equal(parseHistoryDays(0), 14);
  assert.equal(parseHistoryDays('-5'), 14);
  assert.equal(parseHistoryDays(-5), 14);
  assert.equal(parseHistoryDays('Infinity'), 14);
  assert.equal(parseHistoryDays(Infinity), 14);
  assert.equal(parseHistoryDays(''), 14);
  assert.equal(parseHistoryDays('   '), 14);
  assert.equal(parseHistoryDays(undefined), 14);
  assert.equal(parseHistoryDays(null), 14);
});

test('selectObservations ignores NaN and non-finite sinceTs without throwing', () => {
  // If sinceTs is NaN or non-finite, it should not be included in the SQL query
  assert.doesNotThrow(() => {
    const res = selectObservations({ sinceTs: NaN });
    assert.ok(Array.isArray(res));
  });

  assert.doesNotThrow(() => {
    const res = selectObservations({ sinceTs: Infinity });
    assert.ok(Array.isArray(res));
  });

  assert.doesNotThrow(() => {
    const res = selectObservations({ sinceTs: -Infinity });
    assert.ok(Array.isArray(res));
  });

  assert.doesNotThrow(() => {
    const res = selectObservations({ sinceTs: 1000 });
    assert.ok(Array.isArray(res));
  });
});

test('renderArea safely handles NaN and out-of-range options without throwing', () => {
  assert.doesNotThrow(() => {
    renderArea(sampleArea, {
      hours: NaN as any,
      hourOfDay: 99,
      daysOfWeek: [NaN as any, 99],
    });
  });

  assert.doesNotThrow(() => {
    renderArea(sampleArea, {
      hours: -5,
      hourOfDay: -1,
    });
  });
});

test('venueHistory safely handles NaN days without throwing', () => {
  assert.doesNotThrow(() => {
    const res = venueHistory(sampleArea, 'NonExistentVenue', NaN);
    assert.equal(res, null);
  });

  assert.doesNotThrow(() => {
    const res = venueHistory(sampleArea, 'NonExistentVenue', -10);
    assert.equal(res, null);
  });
});

test('density endpoints handle malformed query parameters cleanly over HTTP', async () => {
  const prevSettings = getSettings();
  saveSettings({
    ...prevSettings,
    city: 'Bathurst',
    lat: -33.4167,
    lng: 149.5806,
  });

  const app = express();

  app.get('/api/density/:area', (req, res) => {
    const [area] = pickAreas([req.params.area]);
    if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });

    const rawHours = req.query.hours != null && String(req.query.hours).trim() !== ''
      ? Number(req.query.hours)
      : NaN;
    const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : undefined;

    const rawHour = req.query.hour != null && String(req.query.hour).trim() !== ''
      ? Number(req.query.hour)
      : NaN;
    const hourOfDay = Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : undefined;

    const parsedDays = req.query.days != null
      ? String(req.query.days)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .map(Number)
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : undefined;
    const daysOfWeek = parsedDays && parsedDays.length > 0 ? parsedDays : undefined;

    const geojson = renderArea(area, {
      hours,
      all: req.query.all === '1',
      hourOfDay,
      daysOfWeek,
    });
    if (!geojson) return res.status(404).json({ error: 'No observations for that area yet.' });
    res.json(geojson);
  });

  app.get('/api/density/:area/history', (req, res) => {
    const [area] = pickAreas([req.params.area]);
    if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });
    const name = String(req.query.venue ?? '');
    if (!name) return res.status(400).json({ error: 'venue is required' });

    const rawDays = req.query.days != null && String(req.query.days).trim() !== ''
      ? Number(req.query.days)
      : NaN;
    const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 14;

    const history = venueHistory(area, name, days);
    if (!history) return res.status(404).json({ error: `Unknown venue: ${name}` });
    res.json(history);
  });

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Passing invalid hours, hour, and days to /api/density/:area does not crash (never 500)
    const resDensity = await fetch(`${base}/api/density/bathurst?hours=abc&hour=99&days=bad`);
    // Should return either 200 (if data exists) or 404 (if no observations), not 500
    assert.ok(resDensity.status === 200 || resDensity.status === 404);

    // 2. Passing invalid area returns 404
    const resBadArea = await fetch(`${base}/api/density/nonexistent-area?hours=abc`);
    assert.equal(resBadArea.status, 404);

    // 3. Missing venue returns 400
    const resNoVenue = await fetch(`${base}/api/density/bathurst/history?days=invalid`);
    assert.equal(resNoVenue.status, 400);

    // 4. Passing invalid days with a venue does not crash
    const resHistory = await fetch(`${base}/api/density/bathurst/history?venue=The+George&days=invalid`);
    assert.ok(resHistory.status === 200 || resHistory.status === 404);
  } finally {
    server.close();
    saveSettings(prevSettings);
  }
});
