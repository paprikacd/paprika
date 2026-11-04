export type GeoSeverity = 'low' | 'medium' | 'high' | 'unknown';
export type GeoLocation = {
  /** Stable entity identity. Never use its array index. */
  id: string;
  label: string;
  longitude: number;
  latitude: number;
  value: number | null;
  severity: GeoSeverity;
};

export type GeoGeometry = {
  width: number;
  height: number;
  description: string;
  countries: readonly { name: string; path: string }[];
  project: (longitude: number, latitude: number) => readonly [number, number];
};

/** Concept artwork only: these are decorative pixels, never aggregate observations. */
export type GeoDecorationPoint = {
  x: number; y: number; radius: number; color: string; opacity: number;
  severity?: GeoSeverity;
};

export function normalizeGeoLocations(input: readonly GeoLocation[], maxPoints = 500) {
  const locations: GeoLocation[] = [], ids = new Set<string>();
  let invalid = 0, duplicates = 0, omitted = 0;
  const limit = Math.min(500, Math.max(1, Number.isFinite(maxPoints) ? Math.floor(maxPoints) : 500));
  for (const point of input) {
    if (!point || typeof point.id !== 'string' || !point.id.trim() || typeof point.label !== 'string' ||
        !point.label.trim() || typeof point.longitude !== 'number' || !Number.isFinite(point.longitude) ||
        typeof point.latitude !== 'number' || !Number.isFinite(point.latitude) ||
        point.longitude < -180 || point.longitude > 180 || point.latitude < -90 || point.latitude > 90 ||
        (point.value !== null && (typeof point.value !== 'number' || !Number.isFinite(point.value)))) {
      invalid++;
      continue;
    }
    if (ids.has(point.id)) { duplicates++; continue; }
    ids.add(point.id);
    if (locations.length >= limit) { omitted++; continue; }
    locations.push({
      id: point.id, label: point.label, longitude: point.longitude, latitude: point.latitude,
      value: point.value,
      severity: ['low', 'medium', 'high', 'unknown'].includes(point.severity) ? point.severity : 'unknown',
    });
  }
  return { locations, invalid, duplicates, omitted };
}
