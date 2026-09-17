/**
 * Distance, and how far out an area reaches. See README.md in this directory.
 */

/** Great-circle distance in kilometres. */
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
 * How far past its radius an area still counts. The radius is picked for
 * searching, not for relevance, and a venue just over the line is not what
 * anyone means by outside.
 */
export const AREA_SLACK = 1.5;

export interface Area {
  lat: number;
  lng: number;
  radiusKm: number;
}

/** Whether a point lies in an area, slack included. */
export function inArea(lat: number, lng: number, area: Area): boolean {
  return haversineKm(area.lat, area.lng, lat, lng) <= area.radiusKm * AREA_SLACK;
}
