import { getSettings } from './db.js';

/**
 * Photographer's conditions: light, sky and moon.
 *
 * Sun events are computed here rather than fetched, because the interesting
 * ones — golden hour, blue hour — aren't published by any free API, and
 * deriving them all from one solar model keeps them mutually consistent.
 * Weather comes from Open-Meteo, which needs no key or registration.
 */

const RAD = Math.PI / 180;
const J2000 = 2451545.0;

/** Solar elevation, in degrees, defining each event. */
const ELEVATION = {
  // Standard refraction-corrected horizon.
  sunrise: -0.833,
  // Golden hour runs from this elevation down through sunrise.
  goldenEnd: 6,
  // Civil twilight; blue hour sits between here and the horizon.
  blueStart: -6,
};

function toJulian(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function fromJulian(j: number): Date {
  return new Date((j - 2440587.5) * 86400000);
}

/**
 * Times at which the sun crosses a given elevation, using the standard
 * sunrise equation. Returns null when the sun never reaches it that day.
 */
function sunTimes(date: Date, lat: number, lon: number, elevationDeg: number): {
  rise: Date; set: Date; transit: Date;
} | null {
  const n = Math.round(toJulian(date) - J2000 - 0.0009 + lon / 360);
  const meanSolarNoon = n + 0.0009 - lon / 360;

  const M = (357.5291 + 0.98560028 * meanSolarNoon) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + meanSolarNoon + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const declination = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.44 * RAD));

  const cosOmega =
    (Math.sin(elevationDeg * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) /
    (Math.cos(lat * RAD) * Math.cos(declination));
  // Outside [-1, 1] the sun stays above or below that elevation all day.
  if (cosOmega < -1 || cosOmega > 1) return null;

  const omega = Math.acos(cosOmega) / RAD;
  return {
    rise: fromJulian(transit - omega / 360),
    set: fromJulian(transit + omega / 360),
    transit: fromJulian(transit),
  };
}

export interface SunDay {
  date: string;
  sunrise: string | null;
  sunset: string | null;
  solarNoon: string | null;
  dayLength: string | null;
  goldenMorning: { start: string; end: string } | null;
  goldenEvening: { start: string; end: string } | null;
  blueMorning: { start: string; end: string } | null;
  blueEvening: { start: string; end: string } | null;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function sunForDay(date: Date, lat: number, lon: number): SunDay {
  const horizon = sunTimes(date, lat, lon, ELEVATION.sunrise);
  const golden = sunTimes(date, lat, lon, ELEVATION.goldenEnd);
  const blue = sunTimes(date, lat, lon, ELEVATION.blueStart);

  let dayLength: string | null = null;
  if (horizon) {
    const mins = Math.round((horizon.set.getTime() - horizon.rise.getTime()) / 60000);
    dayLength = `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }

  return {
    date: date.toISOString().slice(0, 10),
    sunrise: iso(horizon?.rise),
    sunset: iso(horizon?.set),
    solarNoon: iso(horizon?.transit),
    dayLength,
    // Golden hour: from the horizon up to 6 degrees, and back down again.
    goldenMorning: horizon && golden ? { start: horizon.rise.toISOString(), end: golden.rise.toISOString() } : null,
    goldenEvening: horizon && golden ? { start: golden.set.toISOString(), end: horizon.set.toISOString() } : null,
    // Blue hour: civil twilight up to the horizon.
    blueMorning: horizon && blue ? { start: blue.rise.toISOString(), end: horizon.rise.toISOString() } : null,
    blueEvening: horizon && blue ? { start: horizon.set.toISOString(), end: blue.set.toISOString() } : null,
  };
}

/** Moon phase and illuminated fraction, from the mean synodic month. */
export function moonForDay(date: Date): { phase: string; illumination: number; age: number } {
  const SYNODIC = 29.530588853;
  // Reference new moon: 2000-01-06 18:14 UTC.
  const age = (((toJulian(date) - 2451550.26) % SYNODIC) + SYNODIC) % SYNODIC;
  const fraction = age / SYNODIC;
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * fraction)) / 2) * 100);

  // New/full/quarter name near-instants, so they get narrow windows; the
  // crescent and gibbous names cover the long stretches between. Splitting the
  // cycle into eight equal bands instead would call a 37%-lit crescent a
  // "first quarter", which is not what anyone means by it.
  const phase =
    fraction < 0.02 || fraction > 0.98 ? 'New moon'
      : fraction < 0.23 ? 'Waxing crescent'
      : fraction < 0.27 ? 'First quarter'
      : fraction < 0.48 ? 'Waxing gibbous'
      : fraction < 0.52 ? 'Full moon'
      : fraction < 0.73 ? 'Waning gibbous'
      : fraction < 0.77 ? 'Last quarter'
      : 'Waning crescent';

  return { phase, illumination, age: Math.round(age * 10) / 10 };
}

// --- weather ----------------------------------------------------------------

/** WMO weather codes, condensed to something readable. */
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

export interface WeatherDay {
  date: string;
  summary: string;
  tempMax: number | null;
  tempMin: number | null;
  cloudCover: number | null;
  rainChance: number | null;
  uvMax: number | null;
  windMax: number | null;
}

export interface PhotoConditions {
  location: { city: string; lat: number; lon: number } | null;
  today: { sun: SunDay; moon: ReturnType<typeof moonForDay>; weather: WeatherDay | null };
  tomorrow: { sun: SunDay; moon: ReturnType<typeof moonForDay>; weather: WeatherDay | null };
  now: { temp: number | null; cloudCover: number | null; summary: string; wind: number | null } | null;
  fetchedAt: string;
}

interface OpenMeteo {
  current?: { temperature_2m: number; cloud_cover: number; weather_code: number; wind_speed_10m: number };
  daily?: {
    time: string[]; weather_code: number[];
    temperature_2m_max: number[]; temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    uv_index_max: (number | null)[]; wind_speed_10m_max: (number | null)[];
    cloud_cover_mean?: (number | null)[];
  };
}

let cache: { at: number; data: PhotoConditions } | null = null;
const CACHE_MS = 20 * 60 * 1000;

async function fetchWeather(lat: number, lon: number): Promise<OpenMeteo | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
    'uv_index_max,wind_speed_10m_max,cloud_cover_mean' +
    '&current=temperature_2m,cloud_cover,weather_code,wind_speed_10m' +
    '&timezone=auto&forecast_days=2';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as OpenMeteo;
  } catch {
    return null;
  }
}

function weatherDay(data: OpenMeteo | null, i: number): WeatherDay | null {
  const d = data?.daily;
  if (!d || !d.time?.[i]) return null;
  return {
    date: d.time[i],
    summary: WEATHER_CODES[d.weather_code[i]] ?? 'Unknown',
    tempMax: d.temperature_2m_max?.[i] ?? null,
    tempMin: d.temperature_2m_min?.[i] ?? null,
    cloudCover: d.cloud_cover_mean?.[i] ?? null,
    rainChance: d.precipitation_probability_max?.[i] ?? null,
    uvMax: d.uv_index_max?.[i] ?? null,
    windMax: d.wind_speed_10m_max?.[i] ?? null,
  };
}

/** Everything the front page needs, cached so a reload doesn't re-fetch. */
export async function getPhotoConditions(force = false): Promise<PhotoConditions> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const settings = getSettings();
  const lat = settings.lat;
  const lon = settings.lng;
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);

  if (lat == null || lon == null) {
    const data: PhotoConditions = {
      location: null,
      today: { sun: sunForDay(now, 0, 0), moon: moonForDay(now), weather: null },
      tomorrow: { sun: sunForDay(tomorrow, 0, 0), moon: moonForDay(tomorrow), weather: null },
      now: null,
      fetchedAt: new Date().toISOString(),
    };
    return data;
  }

  const weather = await fetchWeather(lat, lon);
  const data: PhotoConditions = {
    location: { city: settings.city || 'Here', lat, lon },
    today: { sun: sunForDay(now, lat, lon), moon: moonForDay(now), weather: weatherDay(weather, 0) },
    tomorrow: {
      sun: sunForDay(tomorrow, lat, lon), moon: moonForDay(tomorrow), weather: weatherDay(weather, 1),
    },
    now: weather?.current
      ? {
          temp: weather.current.temperature_2m,
          cloudCover: weather.current.cloud_cover,
          summary: WEATHER_CODES[weather.current.weather_code] ?? 'Unknown',
          wind: weather.current.wind_speed_10m,
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}
