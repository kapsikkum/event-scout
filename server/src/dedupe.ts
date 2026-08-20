import crypto from 'node:crypto';

export interface DedupeInput {
  id: number;
  title: string;
  startTime: string;
  lat: number | null;
  lng: number | null;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'at', 'of', 'in', 'on', 'and', '&', 'with', 'presents', 'live', 'tour', 'show']);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Assigns a dedupe group id to each event. Events match when their normalized
 * title and calendar date agree, and their venues are within 300m (events
 * missing coordinates match on title+date alone).
 */
export function assignDedupeGroups(events: DedupeInput[]): Map<number, string> {
  const result = new Map<number, string>();
  const byKey = new Map<string, DedupeInput[][]>(); // key -> clusters

  for (const ev of events) {
    const date = ev.startTime.slice(0, 10);
    const key = `${normalizeTitle(ev.title)}|${date}`;
    let clusters = byKey.get(key);
    if (!clusters) {
      clusters = [];
      byKey.set(key, clusters);
    }
    let placed = false;
    for (const cluster of clusters) {
      const compatible = cluster.every((other) => {
        if (ev.lat == null || ev.lng == null || other.lat == null || other.lng == null) return true;
        return haversineKm(ev.lat, ev.lng, other.lat, other.lng) <= 0.3;
      });
      if (compatible) {
        cluster.push(ev);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([ev]);
  }

  for (const [key, clusters] of byKey) {
    clusters.forEach((cluster, i) => {
      const group = crypto.createHash('sha1').update(`${key}#${i}`).digest('hex').slice(0, 16);
      for (const ev of cluster) result.set(ev.id, group);
    });
  }
  return result;
}
