import type { QueryResult, RecordColumn, RecordFrame, Widget } from '../../renderer-extensions/schema';
import { summarizePasses, skyPoints, wrapLongitude } from '../../charts/orbital/model';

export type OrbitalPanel = { widget: Widget; result: QueryResult; caption: string };
export const ORBITAL_START = Date.UTC(2026, 9, 31, 11);
export const ORBITAL_END = ORBITAL_START + 3 * 3600000;
export const ORBITAL_NOW = ORBITAL_START + 30 * 60000;
export const ORBITAL_STATIONS = {
  Hobart: { longitude: 147.33, latitude: -42.88 },
  Perth: { longitude: 115.86, latitude: -31.95 },
  Svalbard: { longitude: 15.4, latitude: 78.2 },
  Alaska: { longitude: -147.72, latitude: 64.84 },
} as const;
const definitions = [
  ['pass-01', 'AST-07', 'Hobart', 42 + 10 / 60, 576, 68, 3.8],
  ['pass-02', 'AST-03', 'Hobart', 78 + 27 / 60, 614, 32, -1.1],
  ['pass-03', 'AST-11', 'Perth', 115 + 3 / 60, 501, 54, 5.6],
  ['pass-04', 'AST-07', 'Svalbard', 132 + 49 / 60, 482, 23, 2.1],
  ['pass-05', 'AST-08', 'Alaska', 168 + 17 / 60, 609, 48, 6.3],
  ['pass-06', 'AST-05', 'Perth', 38, 542, 45, 4.2],
  ['pass-07', 'AST-12', 'Alaska', 91, 656, 62, 7.1],
  ['pass-08', 'AST-03', 'Svalbard', 151, 430, 19, 1.2],
] as const;
const round = (n: number, places = 4) => Number(n.toFixed(places));
function result(columns: [string, RecordColumn['type'], string?][], rows: RecordFrame['rows']): QueryResult { return { records: { columns: columns.map(([key, type, unit]) => ({ key, type, ...(unit ? { unit } : {}) })), rows } }; }
function panel(id: string, title: string, data: QueryResult, config: Widget['config'], caption: string): OrbitalPanel {
  return { widget: { id: `orbital-${id}`, title, type: 'plugin', pluginId: id, dataKind: 'records', providerId: 'synthetic-orbital', query: `fixture.${id}`, unit: '', layout: { x: 0, y: 0, w: 6, h: 6 }, options: { showTooltip: true, showLegend: true, showGrid: true, decimals: 1 }, config }, result: data, caption };
}

/** Authored deterministic scenario geometry, not propagated ephemerides or measured contacts. */
export function orbitalFixtures(selectedPass = 'pass-01', gaps = false) {
  const ground: RecordFrame['rows'] = [], sky: RecordFrame['rows'] = [], budget: RecordFrame['rows'] = [];
  definitions.forEach(([id, satellite, station, offset, durationSeconds, peak, margin], j) => {
    const location = ORBITAL_STATIONS[station], acquisition = Math.round(ORBITAL_START + offset * 60000), loss = acquisition + durationSeconds * 1000, midpoint = (acquisition + loss) / 2;
    for (let i = 0; i <= 60; i++) {
      const u = i / 60, timestamp = midpoint + (u - .5) * 90 * 60000;
      const longitude = wrapLongitude(location.longitude + (u - .5) * 420), latitude = location.latitude * Math.cos((u - .5) * Math.PI) + 19 * Math.sin((u - .5) * 2 * Math.PI);
      ground.push([`${id}-track-${i}`, id, satellite, station, timestamp, round(longitude), round(latitude), round(550 + 16 * Math.cos(u * Math.PI * 2 + j)), timestamp < ORBITAL_NOW ? 'past' : 'predicted', (i + j * 7) % 60 >= 42, location.longitude, location.latitude, acquisition, loss]);
    }
    for (let i = 0; i <= 30; i++) {
      const u = i / 30, timestamp = acquisition + durationSeconds * 1000 * u;
      const elevation = peak * Math.sin(Math.PI * u), azimuth = ((j % 3 === 0 ? 210 : j % 3 === 1 ? 100 : 280) + u * 180) % 360;
      const link = margin + 8.2 * Math.sin(Math.PI * u), throughput = Math.max(0, 12 + link * 2.4) * Math.pow(Math.sin(Math.PI * u), .3);
      const missing = gaps && id === 'pass-01' && i >= 12 && i <= 15;
      sky.push([`${id}-sky-${i}`, id, satellite, station, timestamp, round(azimuth), round(elevation), missing ? null : round(link), missing ? null : round(throughput), round(.55 + .65 * Math.abs(u - .5))]);
    }
    const values = [round(margin + 2.2, 1), 4, -2.4, -1.3, -2.5];
    ['Reference', 'Antenna gain', 'Weather', 'Pointing', 'Interference'].forEach((label, i) => budget.push([`${id}-term-${i}`, id, label, i, values[i]]));
  });
  const trackResult = result([['id', 'string'], ['passId', 'string'], ['satellite', 'string'], ['station', 'string'], ['timestamp', 'number', 'ms'], ['longitude', 'number', '°'], ['latitude', 'number', '°'], ['altitude', 'number', 'km'], ['phase', 'string'], ['eclipse', 'boolean'], ['stationLon', 'number', '°'], ['stationLat', 'number', '°'], ['acquisition', 'number', 'ms'], ['loss', 'number', 'ms']], ground);
  const skyResult = result([['id', 'string'], ['passId', 'string'], ['satellite', 'string'], ['station', 'string'], ['timestamp', 'number', 'ms'], ['azimuth', 'number', '°'], ['elevation', 'number', '°'], ['margin', 'number', 'dB'], ['throughput', 'number', 'Mbps'], ['uncertainty', 'number', 'dB']], sky);
  const budgetResult = result([['id', 'string'], ['passId', 'string'], ['label', 'string'], ['order', 'number'], ['value', 'number', 'dB']], budget);
  const passes = summarizePasses(skyPoints(skyResult.records));
  return {
    passes,
    map: panel('orbital-ground-track', 'Ground tracks & access', trackResult, { selectedPass, showLabels: true, showEclipse: true, showGraticule: true }, 'Synthetic time-tagged tracks · geographic coordinates · predicted access'),
    skyplot: panel('orbital-skyplot', 'Station skyplot', skyResult, { selectedPass, showMask: true, showTimeLabels: true }, 'Azimuth clockwise from north · 90° elevation at the centre'),
    timeline: panel('orbital-contact-timeline', 'Predicted contact windows', skyResult, { selectedPass, showSignals: true, showUncertainty: true }, 'UTC intervals · select a pass · drag to change only this chart window'),
    profile: panel('orbital-pass-profile', 'Contact qualification profile', skyResult, { selectedPass, minimumElevation: 10, minimumMargin: 3, maxGapSeconds: 60 }, 'Predicted elevation, margin and Mbps · configurable planning thresholds · exact timing and gap-aware capacity'),
    budget: panel('orbital-link-budget', 'Relative link margin budget', budgetResult, { selectedPass, showValues: true }, 'Additive relative dB contributions · not absolute transmitter powers'),
  };
}
