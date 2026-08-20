import ical from 'node-ical';
import crypto from 'node:crypto';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

export const icalSource: EventSourceAdapter = {
  name: 'ical',
  label: 'Calendar feeds',

  async fetchEvents(_loc: Location, settings: Settings): Promise<RawEvent[]> {
    if (settings.icalFeeds.length === 0) {
      throw new MissingConfigError('Add iCal/ICS feed URLs in Settings (city calendars, parks departments, venues).');
    }
    const events: RawEvent[] = [];
    const horizon = new Date();
    horizon.setMonth(horizon.getMonth() + 6);

    for (const feed of settings.icalFeeds) {
      const data = await ical.async.fromURL(feed.url);
      for (const item of Object.values(data)) {
        if (!item || item.type !== 'VEVENT') continue;
        const ev = item as ical.VEvent;
        if (!ev.start) continue;
        const start = new Date(ev.start);
        if (start > horizon || start < new Date(Date.now() - 24 * 3600 * 1000)) continue;
        const uid = ev.uid ?? crypto.createHash('sha1').update(`${feed.url}|${ev.summary}|${start.toISOString()}`).digest('hex');
        const geo = (ev as unknown as { geo?: { lat?: number; lon?: number } }).geo;
        events.push({
          sourceId: `${crypto.createHash('sha1').update(feed.url).digest('hex').slice(0, 8)}:${uid}`,
          title: String(ev.summary ?? 'Untitled event'),
          description: String(ev.description ?? ''),
          startTime: start.toISOString(),
          endTime: ev.end ? new Date(ev.end).toISOString() : undefined,
          venueName: feed.name,
          address: String(ev.location ?? ''),
          lat: geo?.lat,
          lng: geo?.lon,
          url: typeof ev.url === 'string' ? ev.url : '',
          category: 'Community',
        });
      }
    }
    return events;
  },
};
