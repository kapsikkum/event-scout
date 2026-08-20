import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

interface TmEvent {
  id: string;
  name: string;
  url?: string;
  info?: string;
  description?: string;
  images?: { url: string; width: number }[];
  dates?: { start?: { dateTime?: string; localDate?: string } };
  classifications?: { segment?: { name?: string }; genre?: { name?: string } }[];
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  _embedded?: {
    venues?: {
      name?: string;
      address?: { line1?: string };
      city?: { name?: string };
      state?: { stateCode?: string };
      location?: { latitude?: string; longitude?: string };
    }[];
  };
}

export const ticketmaster: EventSourceAdapter = {
  name: 'ticketmaster',
  label: 'Ticketmaster',

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    if (!settings.ticketmasterKey) {
      throw new MissingConfigError('Add a free Ticketmaster API key in Settings (developer.ticketmaster.com).');
    }
    const events: RawEvent[] = [];
    const maxPages = 5;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      url.searchParams.set('apikey', settings.ticketmasterKey);
      url.searchParams.set('latlong', `${loc.lat},${loc.lng}`);
      url.searchParams.set('radius', String(Math.max(1, Math.round(loc.radiusKm))));
      url.searchParams.set('unit', 'km');
      url.searchParams.set('size', '100');
      url.searchParams.set('sort', 'date,asc');
      url.searchParams.set('page', String(page));

      const res = await fetch(url);
      if (res.status === 401) throw new MissingConfigError('Ticketmaster rejected the API key.');
      if (!res.ok) throw new Error(`Ticketmaster returned HTTP ${res.status}`);
      const data = (await res.json()) as {
        _embedded?: { events?: TmEvent[] };
        page?: { totalPages?: number };
      };
      const batch = data._embedded?.events ?? [];
      for (const ev of batch) {
        const start = ev.dates?.start?.dateTime ?? (ev.dates?.start?.localDate ? `${ev.dates.start.localDate}T12:00:00` : null);
        if (!start) continue;
        const venue = ev._embedded?.venues?.[0];
        const image = (ev.images ?? []).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
        const cls = ev.classifications?.[0];
        const price = ev.priceRanges?.[0];
        events.push({
          sourceId: ev.id,
          title: ev.name,
          description: ev.info ?? ev.description ?? '',
          startTime: start,
          venueName: venue?.name ?? '',
          address: [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(Boolean).join(', '),
          lat: venue?.location?.latitude ? parseFloat(venue.location.latitude) : undefined,
          lng: venue?.location?.longitude ? parseFloat(venue.location.longitude) : undefined,
          url: ev.url,
          imageUrl: image?.url,
          category: [cls?.segment?.name, cls?.genre?.name].filter(Boolean).join(' / '),
          priceText: price ? `${price.currency ?? '$'} ${price.min ?? '?'}–${price.max ?? '?'}` : '',
        });
      }
      if (!data.page?.totalPages || page >= data.page.totalPages - 1 || batch.length === 0) break;
    }
    return events;
  },
};
