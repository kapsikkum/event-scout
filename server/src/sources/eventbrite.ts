import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

interface EbEvent {
  id: string;
  name?: { text?: string };
  summary?: string;
  description?: { text?: string };
  url?: string;
  start?: { utc?: string };
  end?: { utc?: string };
  logo?: { original?: { url?: string }; url?: string };
  online_event?: boolean;
  is_free?: boolean;
  venue?: {
    name?: string;
    address?: { localized_address_display?: string };
    latitude?: string;
    longitude?: string;
  };
}

export const eventbrite: EventSourceAdapter = {
  name: 'eventbrite',
  label: 'Eventbrite',

  async fetchEvents(_loc: Location, settings: Settings): Promise<RawEvent[]> {
    if (!settings.eventbriteToken) {
      throw new MissingConfigError('Add an Eventbrite private token in Settings (eventbrite.com/platform/api-keys).');
    }
    if (settings.eventbriteOrganizerIds.length === 0) {
      throw new MissingConfigError('Eventbrite has no public search API — add organizer IDs to follow in Settings.');
    }
    const events: RawEvent[] = [];
    for (const orgId of settings.eventbriteOrganizerIds) {
      const url = new URL(`https://www.eventbriteapi.com/v3/organizers/${encodeURIComponent(orgId.trim())}/events/`);
      url.searchParams.set('status', 'live');
      url.searchParams.set('order_by', 'start_asc');
      url.searchParams.set('expand', 'venue');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${settings.eventbriteToken}` } });
      if (res.status === 401) throw new MissingConfigError('Eventbrite rejected the token.');
      if (res.status === 404) continue; // bad organizer id — skip, don't fail the whole source
      if (!res.ok) throw new Error(`Eventbrite returned HTTP ${res.status} for organizer ${orgId}`);
      const data = (await res.json()) as { events?: EbEvent[] };
      for (const ev of data.events ?? []) {
        if (!ev.start?.utc) continue;
        events.push({
          sourceId: ev.id,
          title: ev.name?.text ?? 'Untitled event',
          description: ev.summary ?? ev.description?.text ?? '',
          startTime: ev.start.utc,
          endTime: ev.end?.utc,
          venueName: ev.venue?.name ?? '',
          address: ev.venue?.address?.localized_address_display ?? '',
          lat: ev.venue?.latitude ? parseFloat(ev.venue.latitude) : undefined,
          lng: ev.venue?.longitude ? parseFloat(ev.venue.longitude) : undefined,
          url: ev.url,
          imageUrl: ev.logo?.original?.url ?? ev.logo?.url,
          category: 'Community',
          priceText: ev.is_free ? 'Free' : '',
          isOnline: ev.online_event ?? false,
        });
      }
    }
    return events;
  },
};
