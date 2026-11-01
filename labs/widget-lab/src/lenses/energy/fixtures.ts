import type { CatalogFeature, CatalogPreset } from '../../catalog/chart-fixtures';
import type { QueryResult, RecordFrame, Widget } from '../../renderer-extensions/schema';
import { powerFlowConfig, contingencyConfig, flexibilityConfig, meritConfig, powerNodes } from '../../charts/energy/model';
import { reserveEnvelopeConfig } from '../../charts/energy/reserve-model';

export type GridScenario = 'evening' | 'low-wind' | 'peak';
export const GRID_TIME = Date.UTC(2026, 9, 31, 18, 10);
const start = Date.UTC(2026, 9, 31, 16), step = 300000;
const col = (key: string, type: 'string' | 'number' | 'boolean' | 'timestamp' = 'number', unit?: string) => ({ key, label: key, type, ...(unit ? { unit } : {}) });
export const energyFrame = (columns: RecordFrame['columns'], rows: RecordFrame['rows']): QueryResult => ({ records: { columns, rows } });
function widget(id: string, title: string, pluginId: string, config: Widget['config'] = {}, unit = ''): Widget {
  return { id, title, type: 'plugin', pluginId, dataKind: 'records', providerId: 'synthetic-grid', query: `fixture.grid.${id}`, unit, config, options: { showTooltip: true, showLegend: true, decimals: 1 }, layout: { x: 0, y: 0, w: 6, h: 5 } };
}
export function buildGridBalance(scenario: GridScenario = 'evening', gaps = false) {
  const values = scenario === 'low-wind' ? [420, 310, 350, 270, 150] : scenario === 'peak' ? [620, 300, 350, 260, 150] : [620, 310, 240, 180, 150];
  const reserves = scenario === 'evening' ? [0, 0, 110, 70, 0] : [0, 0, 40, 30, 0];
  const ids = ['wind', 'solar', 'gas', 'imports', 'battery'], names = ['Wind', 'Solar', 'Gas', 'Imports', 'Battery discharge'];
  const total = values.reduce((a, b) => a + b, 0), losses = total * 40 / 1500, demand = total - losses;
  const rows: RecordFrame['rows'] = values.map((power, i) => [ids[i], names[i], 'source', power, power + reserves[i], [15, 20, 210, 120, 85][i], i === 4 ? 272 : null, i === 4 ? 400 : null]);
  rows.push(...[580, 520, 360, 40].map((n, i) => [['industrial', 'residential', 'transport', 'losses'][i], ['Industrial', 'Residential', 'Transport', 'Losses'][i], 'load', n / 1500 * total, 0, 0, null, null] as RecordFrame['rows'][number]));
  const powerResult = energyFrame([col('id', 'string'), col('label', 'string'), col('side', 'string'), col('power', 'number', 'MW'), col('available', 'number', 'MW'), col('price', 'number', '$/MWh'), col('energy', 'number', 'MWh'), col('capacity', 'number', 'MWh')], rows);
  const accounting = powerNodes(powerResult.records!);
  const forecastRows = Array.from({ length: 73 }, (_, i) => {
    const timestamp = start + i * step, hours = (timestamp - GRID_TIME) / 3600000;
    const gross = timestamp <= GRID_TIME ? total - 130 * -hours + 18 * Math.sin(i * .68) * Math.min(1, Math.abs(hours)) : total + 190 * Math.sin(Math.min(1, hours / 3.2) * Math.PI) - 24 * hours;
    const observed = timestamp <= GRID_TIME, future = timestamp >= GRID_TIME;
    const spread = future ? 18 + Math.max(0, hours) * 42 : 0;
    const missing = gaps && i >= 17 && i <= 19;
    return [timestamp, observed && !missing ? gross : null, future ? gross : null, future ? gross - spread * .55 : null, future ? gross + spread * .55 : null, future ? gross - spread : null, future ? gross + spread : null, accounting.available - Math.max(0, hours) * 12];
  });
  const forecast = { widget: widget('balance-forecast', 'Demand forecast & available supply', 'forecast-bands', { show68: true, show95: true, showGrid: true, showCapacity: true }, 'MW'), result: energyFrame([col('timestamp', 'number', 'ms'), col('observed', 'number', 'MW'), col('median', 'number', 'MW'), col('low68', 'number', 'MW'), col('high68', 'number', 'MW'), col('low95', 'number', 'MW'), col('high95', 'number', 'MW'), col('capacity', 'number', 'MW')], forecastRows) };
  const reserve = { widget: widget('balance-reserve', 'Available reserve & forecast uncertainty', 'reserve-envelope', reserveEnvelopeConfig.parse({ selectedTime: GRID_TIME }), 'MW'), result: forecast.result };
  const powers = Array.from({ length: 73 }, (_, i) => i < 13 ? -70 + 15 * Math.sin(i * .7) : i <= 44 ? Math.min(150, 30 + (i - 13) * 12) : -65 + 18 * Math.sin(i * .55));
  let energy = 272 + powers.slice(0, 26).reduce((a, p) => a + p / 12, 0);
  const dispatchRows = powers.map((power, i) => { const row = [start + i * step, gaps && i === 18 ? null : power, gaps && i === 18 ? null : energy, 400, i > 26]; energy -= power / 12; return row; });
  const flex = { widget: widget('balance-flexibility', 'Flexibility dispatch · BESS-01', 'dispatch-flexibility', flexibilityConfig.parse({ selectedTime: GRID_TIME }), 'MW'), result: energyFrame([col('timestamp', 'number', 'ms'), col('power', 'number', 'MW'), col('energy', 'number', 'MWh'), col('capacity', 'number', 'MWh'), col('predicted', 'boolean')], dispatchRows) };
  const scenarios = ['Base', 'N-1 A', 'N-1 B', 'Low wind', 'Peak load', 'Island'];
  const assetIds = ['north-link', 'east-link', 'battery', 'gas', 'wind', 'solar'];
  const assetNames = ['North link', 'East link', 'BESS-01', 'Gas-02', 'Wind-04', 'Solar-03'];
  const matrix = [[72, 88, 94, 65, 78, 96], [58, 76, 62, 60, 71, 89], [40, 52, 68, 94, 86, 58], [62, 74, 81, 68, 93, 85], [28, 46, 54, 88, 61, null], [35, 42, 39, 56, 82, 49]];
  const contingency = { widget: widget('balance-contingencies', 'Contingency exposure · simulated', 'contingency-matrix', contingencyConfig.parse({})), result: energyFrame([col('asset', 'string'), col('label', 'string'), col('scenario', 'string'), col('loading', 'number', '%')], assetIds.flatMap((id, i) => scenarios.map((s, j) => [id, assetNames[i], s, matrix[i][j] === null ? null : Math.min(120, matrix[i][j]! + (scenario === 'low-wind' && j === 3 ? 6 : scenario === 'peak' && j === 4 ? 8 : 0))]))) };
  const flow = { widget: widget('balance-power', 'Power dispatch · 18:10 UTC', 'power-flow', powerFlowConfig.parse({}), 'MW'), result: powerResult };
  const merit = { widget: widget('balance-merit', 'Dispatch merit order', 'dispatch-merit', meritConfig.parse({}), '$/MWh'), result: powerResult };
  return { flow, forecast, reserve, flex, contingency, merit, accounting, summary: { demand, losses, total, reserve: accounting.reserve, energy: 272, stateOfCharge: 68 }, scenario };
}

export type EnergyCatalogId = 'power-flow' | 'dispatch-flexibility' | 'contingency-matrix' | 'dispatch-merit' | 'reserve-envelope';
export const energyChartCatalog: readonly (Omit<CatalogFeature, 'id'> & { id: EnergyCatalogId })[] = [
  { id: 'power-flow', label: 'Conserved power flow', group: 'Grid Balance', lensHref: '#grid-balance', question: 'Which sources supply each load at a declared snapshot?', contract: 'Power in MW reconciles through the bus including losses. Storage MWh and available MW remain distinct.', inspect: 'Select a source or load to inspect exact power, whole-grid share and capacity.', presets: ['ready', 'empty', 'error'], owner: 'PowerFlow / powerNodes' },
  { id: 'reserve-envelope', label: 'Available reserve envelope', group: 'Grid Balance', lensHref: '#grid-balance', question: 'How much supply headroom remains as demand changes and its forecast widens?', contract: 'Reserve equals available capacity minus required supply, including losses. Subtraction reverses each demand interval: lower reserve = capacity − upper demand. Unknown capacity or demand remains unknown; observed and predicted values remain distinct.', inspect: 'Inspect an exact UTC timestamp or move with arrow keys, then pin its demand, capacity and reserve bounds. Configure field mappings, reference MW and 68%/95% intervals through the editor.', presets: ['ready', 'gaps', 'empty', 'error'], owner: 'ReserveEnvelope / reserveEnvelopePoints' },
  { id: 'dispatch-flexibility', label: 'Storage dispatch and energy', group: 'Grid Balance', lensHref: '#grid-balance', question: 'How does charge/discharge affect remaining energy?', contract: 'Positive MW is discharge, negative MW is charge; MWh integrates the same interval power with a declared ideal-storage assumption.', inspect: 'Inspect a timestamp or drag to zoom; use exact window controls, Undo and Reset.', presets: ['ready', 'gaps', 'empty', 'error'], owner: 'FlexibilityDispatch / flexibilityPoints' },
  { id: 'contingency-matrix', label: 'Contingency loading matrix', group: 'Grid Balance', lensHref: '#grid-balance', question: 'Which asset/scenario pairs approach their loading limit?', contract: 'Simulated loading uses percent of declared capacity. Null is not simulated and remains different from zero.', inspect: 'Select a cell for its asset, scenario and exact loading; change warning threshold in the editor.', presets: ['ready', 'empty', 'error'], owner: 'ContingencyMatrix / contingencyCells' },
  { id: 'dispatch-merit', label: 'Dispatch merit-order curve', group: 'Grid Balance', lensHref: '#grid-balance', question: 'Which available resources cover the required supply?', contract: 'Cumulative available MW is ordered by supplied marginal $/MWh; the demand rule includes losses.', inspect: 'Select a resource to inspect its available capacity, dispatched amount and marginal price.', presets: ['ready', 'empty', 'error'], owner: 'DispatchMerit / meritOrder' },
];
export const isEnergyCatalogId = (id: string): id is EnergyCatalogId => energyChartCatalog.some(c => c.id === id);
export function makeEnergyCatalogFixture(id: EnergyCatalogId, preset: CatalogPreset = 'ready') {
  const definition = energyChartCatalog.find(entry => entry.id === id);
  if (!definition?.presets.includes(preset)) throw new Error(`Unsupported ${id} preset: ${preset}`);
  const d = buildGridBalance('evening', preset === 'gaps');
  const source = id === 'power-flow' ? d.flow : id === 'reserve-envelope' ? d.reserve : id === 'dispatch-flexibility' ? d.flex : id === 'contingency-matrix' ? d.contingency : d.merit;
  const copy = structuredClone(source); copy.widget.id = `catalog-${id}`;
  if (preset === 'empty') copy.result.records!.rows = [];
  return copy;
}
