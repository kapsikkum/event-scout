export const M_PER_DEG_LAT = 111320;

export interface Point { lat: number; lon: number }
export interface Bbox { south: number; west: number; north: number; east: number }

export function mPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bboxCentre(b: Bbox): Point {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

export function bboxSizeMeters(b: Bbox): { width: number; height: number } {
  const { lat } = bboxCentre(b);
  return {
    width: (b.east - b.west) * mPerDegLon(lat),
    height: (b.north - b.south) * M_PER_DEG_LAT,
  };
}

/** A radius in km around a point, as a lat/lon box. */
export function bboxFromRadius(lat: number, lon: number, radiusKm: number): Bbox {
  const dLat = (radiusKm * 1000) / M_PER_DEG_LAT;
  const dLon = (radiusKm * 1000) / mPerDegLon(lat);
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

/** Split a bbox into tiles no larger than maxSpanDeg on either axis. */
export function tileBbox(b: Bbox, maxSpanDeg: number): Bbox[] {
  const rows = Math.max(1, Math.ceil((b.north - b.south) / maxSpanDeg));
  const cols = Math.max(1, Math.ceil((b.east - b.west) / maxSpanDeg));
  const dLat = (b.north - b.south) / rows;
  const dLon = (b.east - b.west) / cols;
  const tiles: Bbox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        south: b.south + r * dLat,
        north: b.south + (r + 1) * dLat,
        west: b.west + c * dLon,
        east: b.west + (c + 1) * dLon,
      });
    }
  }
  return tiles;
}

export function inBbox(b: Bbox, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Google's encoded polyline algorithm, precision 5. */
export function decodePolyline(encoded: string): Point[] {
  const points: Point[] = [];
  let index = 0, lat = 0, lon = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return points;
}

/**
 * Resample a polyline so points sit roughly spacingMeters apart. Longer lines
 * therefore yield more samples, which is what gives them more weight.
 */
export function densifyLine(points: Point[], spacingMeters: number): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  const out: Point[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = haversine(a.lat, a.lon, b.lat, b.lon);
    if (seg === 0) continue;
    let d = spacingMeters - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      d += spacingMeters;
    }
    carry = (carry + seg) % spacingMeters;
  }
  return out;
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}
