import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

interface SgEvent {
  id: number;
  title: string;
  url?: string;
  description?: string;
  datetime_utc?: string;
  datetime_local?: string;
  venue?: {
    name?: string;
    address?: string;
    extended_address?: string;
    location?: { lat?: number; lon?: number };
  };
  performers?: { image?: string }[];
  taxonomies?: { name?: string }[];
  stats?: { lowest_price?: number | null };
}

export const seatgeek: EventSourceAdapter = {
  name: 'seatgeek',
  label: 'SeatGeek',

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    if (!settings.seatgeekClientId) {
      throw new MissingConfigError('Add a free SeatGeek client ID in Settings (seatgeek.com/account/develop).');
    }
    const events: RawEvent[] = [];
    const maxPages = 5;
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL('https://api.seatgeek.com/2/events');
      url.searchParams.set('client_id', settings.seatgeekClientId);
      url.searchParams.set('lat', String(loc.lat));
      url.searchParams.set('lon', String(loc.lng));
      url.searchParams.set('range', `${Math.max(1, Math.round(loc.radiusKm))}km`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      url.searchParams.set('sort', 'datetime_utc.asc');

      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) throw new MissingConfigError('SeatGeek rejected the client ID.');
      if (!res.ok) throw new Error(`SeatGeek returned HTTP ${res.status}`);
      const data = (await res.json()) as { events?: SgEvent[]; meta?: { total?: number; page?: number; per_page?: number } };
      const batch = data.events ?? [];
      for (const ev of batch) {
        const start = ev.datetime_utc ? `${ev.datetime_utc}Z` : ev.datetime_local;
        if (!start) continue;
        events.push({
          sourceId: String(ev.id),
          title: ev.title,
          description: ev.description ?? '',
          startTime: start,
          venueName: ev.venue?.name ?? '',
          address: [ev.venue?.address, ev.venue?.extended_address].filter(Boolean).join(', '),
          lat: ev.venue?.location?.lat ?? undefined,
          lng: ev.venue?.location?.lon ?? undefined,
          url: ev.url,
          imageUrl: ev.performers?.find((p) => p.image)?.image,
          category: ev.taxonomies?.[0]?.name?.replace(/_/g, ' ') ?? '',
          priceText: ev.stats?.lowest_price != null ? `from $${ev.stats.lowest_price}` : '',
        });
      }
      const total = data.meta?.total ?? 0;
      if (batch.length === 0 || page * 100 >= total) break;
    }
    return events;
  },
};
