import type { QueryResult, RecordColumn, RecordFrame, Widget } from '../../renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';
import { chamberBoxes, waferRows, type DieBin, type WaferDie } from '../../charts/wafer/model';

export const WAFER_IDS = ['W-11', 'W-12', 'W-13', 'W-14', 'W-15', 'W-16', 'W-17'] as const;
export type WaferId = typeof WAFER_IDS[number];
export type WaferPanel = { widget: Widget; result: QueryResult; caption: string };
const CHAMBERS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C1', 'C3'];
const columns: RecordColumn[] = [
  { key: 'id', type: 'string' }, { key: 'wafer', type: 'string' }, { key: 'lot', type: 'string' },
  { key: 'column', type: 'number' }, { key: 'row', type: 'number' },
  ...['xMm', 'yMm', 'pitchMm', 'dieSizeMm', 'diameterMm'].map(key => ({ key, type: 'number' as const, unit: 'mm' })),
  { key: 'bin', type: 'string' }, { key: 'leakageNA', type: 'number', unit: 'nA' }, { key: 'chamber', type: 'string' },
  ...['probeAt', 'processStart', 'lithographyAt', 'etchAt', 'cleanAt'].map(key => ({ key, type: 'number' as const, unit: 'ms' })),
  { key: 'depositionNm', type: 'number', unit: 'nm' }, { key: 'lithographyDose', type: 'number', unit: 'mJ/cm²' },
  { key: 'etchSeconds', type: 'number', unit: 's' }, { key: 'cleanPpm', type: 'number', unit: 'ppm' },
];
const round = (n: number, digits = 3) => Number(n.toFixed(digits));
function noise(column: number, row: number, seed: number) {
  let h = Math.imul(column + 37, 73856093) ^ Math.imul(row + 43, 19349663) ^ Math.imul(seed + 17, 83492791);
  h = Math.imul(h ^ h >>> 16, 2246822519); h = Math.imul(h ^ h >>> 13, 3266489917);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}

/** One bounded scalar frame per wafer. The full lot remains fixture data, never an oversized QueryResult. */
export function waferResult(wafer: WaferId = 'W-17', preset: 'ready' | 'gaps' = 'ready'): QueryResult {
  const index = WAFER_IDS.indexOf(wafer);
  if (index < 0) throw new Error('Unknown synthetic wafer.');
  const rows: RecordFrame['rows'] = [], chamber = CHAMBERS[index];
  const start = Date.UTC(2026, 9, 27, 6) + index * 6 * 3600000;
  for (let row = -15; row <= 15; row++) for (let column = -15; column <= 15; column++) {
    const x = column * 10, y = row * 10, radius = Math.hypot(x, y);
    if (radius > 150) continue;
    const outside = Math.hypot(Math.abs(x) + 4.5, Math.abs(y) + 4.5) > 147;
    const angular = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    const centre = [300, 40, 52, 170, 255, 210, 46][index], angleDistance = Math.min(Math.abs(angular - centre), 360 - Math.abs(angular - centre));
    const clustered = radius > (index === 6 ? 98 : 112) && angleDistance < (index === 6 ? 28 : 19) && noise(column, row, index + 5) > .17;
    let bin: DieBin = 'pass';
    let leakage: number | null = round(.12 + Math.exp(-.7 + noise(column, row, index) * 2.4) * (chamber === 'C3' ? 1.25 : 1));
    if (clustered) leakage = round(12 + noise(column, row, index + 11) * (chamber === 'C3' ? 120 : 43));
    if (outside) bin = 'excluded';
    else if (noise(column, row, index + 41) < (preset === 'gaps' ? .28 : .017)) bin = 'untested';
    else if (noise(column, row, index + 22) < .008) bin = 'open';
    else if (leakage > 10) bin = 'leakage';
    else if (noise(column, row, index + 33) < .014) bin = 'timing';
    if (['untested', 'excluded', 'open'].includes(bin)) leakage = null;
    const tested = bin !== 'untested' && bin !== 'excluded';
    const die: WaferDie = {
      id: `${wafer}:${column}:${row}`, wafer, lot: 'L26-1048', column, row, xMm: x, yMm: y, pitchMm: 10, dieSizeMm: 9, diameterMm: 300,
      bin, leakageNA: leakage, chamber, probeAt: tested ? start + 16 * 3600000 + (row + 15) * 62000 + (column + 15) * 1700 : null,
      processStart: start, lithographyAt: start + 4 * 3600000 + 7 * 60000, etchAt: start + 8 * 3600000 + 16 * 60000, cleanAt: start + 10 * 3600000 + 4 * 60000,
      depositionNm: round(410 + index * .7 + .9 * Math.cos(radius / 38), 2), lithographyDose: round(36.4 + .04 * index + noise(column, row, index + 80) * .6, 3),
      etchSeconds: round(61.5 + (chamber === 'C3' ? 2.7 : .3) + noise(column, row, index + 92) * .8, 3), cleanPpm: round(.18 + noise(column, row, index + 82) * .22, 3),
    };
    rows.push(columns.map(c => die[c.key as keyof WaferDie]));
  }
  return { records: parseRecordFrame({ columns, rows }) };
}

export function waferLot(preset: 'ready' | 'gaps' = 'ready') {
  return WAFER_IDS.map(id => { const result = waferResult(id, preset); return { id, result, dies: waferRows(result.records) }; });
}
export function chamberResult(dies: readonly WaferDie[]): QueryResult {
  const fields: RecordColumn[] = [{ key: 'id', type: 'string' }, ...['count', 'missing'].map(key => ({ key, type: 'number' as const })),
    ...['min', 'q1', 'median', 'q3', 'max', 'lowWhisker', 'highWhisker'].map(key => ({ key, type: 'number' as const, unit: 'nA' })),
    { key: 'outlierCount', type: 'number' }, ...Array.from({ length: 20 }, (_, i) => ({ key: `outlier${i + 1}`, type: 'number' as const, unit: 'nA' }))];
  const rows: RecordFrame['rows'] = chamberBoxes(dies).map(c => [c.id, c.count, c.missing, c.min, c.q1, c.median, c.q3, c.max, c.lowWhisker, c.highWhisker, c.outlierCount, ...Array.from({ length: 20 }, (_, i) => c.outliers[i] ?? null)]);
  return { records: parseRecordFrame({ columns: fields, rows }) };
}

export function waferPanel(id: string, title: string, result: QueryResult, config: Widget['config'] = {}, caption = ''): WaferPanel {
  return { widget: { id: `wafer-${id}`, type: 'plugin', pluginId: id, title, dataKind: 'records', providerId: 'synthetic-wafer', query: `fixture.${id}`, unit: '',
    layout: { x: 0, y: 0, w: 6, h: 6 }, options: { showTooltip: true, showLegend: true, showGrid: true, decimals: 3 }, config }, result, caption };
}

export function waferFixtures(wafer: WaferId = 'W-17', preset: 'ready' | 'gaps' = 'ready') {
  const lot = waferLot(preset), active = lot.find(item => item.id === wafer)!;
  if (!active) throw new Error('Unknown synthetic wafer.');
  const selected = active.dies.find(d => d.bin === 'leakage') ?? active.dies.find(d => d.bin === 'pass');
  const boxes = chamberResult(lot.flatMap(item => item.dies));
  return { lot, active, initialDie: selected?.id ?? '',
    map: waferPanel('wafer-die-map', `Die map · ${wafer}`, active.result, { colorMode: 'bin', showCoordinates: true, showGrid: true, cellGap: .12 }, 'Physical coordinates in millimetres · die row/column are separate identities'),
    transect: waferPanel('wafer-transect', 'Die cross-section', active.result, { axis: 'row', followSelection: true, index: 0, scale: 'log', showConnections: true, showGrid: true, showReference: true, referenceValue: 10, selectedDieId: selected?.id ?? '' }, 'Physical row or column through the selected die · unmeasured positions stay separate from numeric leakage'),
    signature: waferPanel('wafer-signature', 'Spatial defect signature', active.result, { metric: 'rate', angularBins: 12, defect: 'all', showValues: true }, 'Failure rate within each tested spatial bin · untested and edge exclusions remain separate'),
    yield: waferPanel('wafer-yield-waterfall', 'Yield accounting', active.result, { showValues: true }, 'Mutually exclusive final test bins · passing / tested denominator'),
    chambers: waferPanel('wafer-chamber-distribution', 'Leakage by chamber', boxes, { scale: 'log', showOutliers: true, specification: 10, selectedChamber: active.dies[0]?.chamber ?? '' }, 'Full seven-wafer lot · observed leakage · quartiles and 1.5×IQR whiskers'),
    lineage: waferPanel('wafer-process-lineage', 'Selected die · process history', active.result, { selectedDieId: selected?.id ?? '', showMeasurements: true }, 'Recorded fixture stages and measurements · association does not establish a cause'),
  };
}
