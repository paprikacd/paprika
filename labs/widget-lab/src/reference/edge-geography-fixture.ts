import type { GeoDecorationPoint, GeoGeometry, GeoLocation, GeoSeverity } from '../charts/geo/geo-data';
import { projectCity, worldCountries, worldSpeckles, WORLD_HEIGHT, WORLD_WIDTH } from './world-geometry';

// Explicit concept artwork, kept outside the reusable map renderer and analytical records.
const cities = [
  { name: 'San Francisco', lon: -122.4, lat: 37.8, level: 1, count: 42, connections: 3120 },
  { name: 'Los Angeles', lon: -118.2, lat: 34.1, level: 0, count: 24, connections: 1490 },
  { name: 'Seattle', lon: -122.3, lat: 47.6, level: 0, count: 15, connections: 820 },
  { name: 'Chicago', lon: -87.6, lat: 41.9, level: 0, count: 17, connections: 781 },
  { name: 'New York', lon: -74, lat: 40.7, level: 0, count: 24, connections: 1124 },
  { name: 'Toronto', lon: -79.4, lat: 43.7, level: 0, count: 14, connections: 409 },
  { name: 'Mexico City', lon: -99.1, lat: 19.4, level: 2, count: 6, connections: 92 },
  { name: 'Bogotá', lon: -74.1, lat: 4.7, level: 0, count: 5, connections: 87 },
  { name: 'São Paulo', lon: -46.6, lat: -23.6, level: 0, count: 10, connections: 214 },
  { name: 'Santiago', lon: -70.7, lat: -33.4, level: 0, count: 5, connections: 68 },
  { name: 'London', lon: -.1, lat: 51.5, level: 1, count: 39, connections: 1942 },
  { name: 'Paris', lon: 2.4, lat: 48.9, level: 0, count: 20, connections: 896 },
  { name: 'Frankfurt', lon: 8.7, lat: 50.1, level: 0, count: 38, connections: 1645 },
  { name: 'Madrid', lon: -3.7, lat: 40.4, level: 0, count: 11, connections: 378 },
  { name: 'Stockholm', lon: 18.1, lat: 59.3, level: 0, count: 10, connections: 241 },
  { name: 'Istanbul', lon: 29, lat: 41, level: 2, count: 8, connections: 169 },
  { name: 'Lagos', lon: 3.4, lat: 6.5, level: 1, count: 10, connections: 189 },
  { name: 'Johannesburg', lon: 28, lat: -26.2, level: 2, count: 6, connections: 112 },
  { name: 'Dubai', lon: 55.3, lat: 25.2, level: 2, count: 8, connections: 155 },
  { name: 'Mumbai', lon: 72.9, lat: 19.1, level: 0, count: 14, connections: 680 },
  { name: 'Singapore', lon: 103.8, lat: 1.4, level: 0, count: 19, connections: 1328 },
  { name: 'Hong Kong', lon: 114.2, lat: 22.3, level: 1, count: 28, connections: 1174 },
  { name: 'Tokyo', lon: 139.7, lat: 35.7, level: 0, count: 28, connections: 1654 },
  { name: 'Seoul', lon: 127, lat: 37.6, level: 0, count: 16, connections: 542 },
  { name: 'Sydney', lon: 151.2, lat: -33.9, level: 2, count: 8, connections: 701 },
  { name: 'Perth', lon: 115.9, lat: -31.9, level: 0, count: 7, connections: 216 },
];

const severities: GeoSeverity[] = ['low', 'medium', 'high'];
const noise = (seed: number) => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453123; return value - Math.floor(value); };
export const edgeGeoLocations: GeoLocation[] = cities.map(city => ({
  id: city.name.toLowerCase().replaceAll(' ', '-'), label: city.name,
  longitude: city.lon, latitude: city.lat, value: city.connections, severity: severities[city.level],
}));
export const edgeGeoGeometry: GeoGeometry = {
  width: WORLD_WIDTH, height: WORLD_HEIGHT, countries: worldCountries, project: projectCity,
  description: 'Reference concept projection with Natural Earth outlines; the polar caps lie outside the authored map crop',
};
export const edgeGeoDecoration: GeoDecorationPoint[] = [
  ...worldSpeckles.map(([longitude, latitude, radius, opacity], index) => {
    const [x, y] = projectCity(longitude, latitude);
    return { x, y, radius, opacity, color: index % 31 === 0 ? '#e4d875' : index % 53 === 0 ? '#f45737' : '#08c4dd', severity: 'low' as const };
  }),
  ...cities.flatMap((city, index) => {
    const [x, y] = projectCity(city.lon, city.lat);
    return Array.from({ length: Math.round(city.count * 1.8) }, (_, point) => {
      const angle = noise(index * 200 + point * 3) * Math.PI * 2;
      const distance = Math.pow(noise(index * 100 + point * 11), .6) * (city.count > 20 ? 21 : 10);
      return { x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance * .62,
        radius: .35 + noise(point * 7 + index) * .75, color: point % 11 === 0 ? '#ffbd30' : point % 17 === 0 ? '#fb4e43' : '#04d8ed',
        opacity: .35 + noise(point * 8 + index) * .6, severity: severities[city.level] };
    });
  }),
];
