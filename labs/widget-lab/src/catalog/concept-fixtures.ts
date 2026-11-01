import type { QueryResult, Widget } from '../renderer-extensions/schema';
import { marketRiskPanels } from '../lenses/market-risk-data';
import { buildInferenceFleet } from '../lenses/inference-fleet-data';
import { incidentDependencyPanel, incidentTelemetryPanel, incidentTracePanel } from '../lenses/incident-room-data';
import { buildGridOperations } from '../lenses/grid-operations-data';
import type { CatalogFeature, CatalogPreset } from './chart-fixtures';

export type ConceptCatalogId = 'contribution-waterfall' | 'correlation-matrix' | 'liquidity-ladder' | 'rack-matrix' | 'request-flow' | 'log-scatter' | 'aligned-telemetry' | 'trace-waterfall' | 'service-dependency' | 'grid-network-map' | 'forecast-bands';
const standard = ['ready', 'gaps', 'empty', 'error'] as const;
const complete = ['ready', 'empty', 'error'] as const;
export const conceptChartCatalog: readonly CatalogFeature[] = [
  { id: 'contribution-waterfall', label: 'Contribution waterfall', group: 'Market Risk', lensHref: '#market-risk', question: 'Which sectors contributed to the portfolio’s return?', contract: 'Signed sector contributions share the same opening portfolio denominator. The cumulative steps and final total reconcile to the unchanged-position portfolio return. A missing contribution makes subsequent cumulative values and the total unknown.', inspect: 'Inspect or pin a contribution to see its exact value and cumulative before/after values. Missing observations demonstrate why an unknown contribution cannot become zero.', presets: standard, owner: 'contribution-waterfall · ContributionWaterfall / waterfallSteps' },
  { id: 'correlation-matrix', label: 'Correlation matrix', group: 'Market Risk', lensHref: '#market-risk', question: 'Which assets moved together in paired daily returns?', contract: 'Pearson correlations are computed from paired daily returns on a fixed −1 to +1 scale. Values are symmetric, known self-correlations equal one, and missing pairs remain unknown. Pair counts are retained in inspection.', inspect: 'Use pointer or arrow keys to choose an asset pair; Enter pins its value and paired sample count. Missing observations remove both directions of the same pair.', presets: standard, owner: 'correlation-matrix · CorrelationMatrix / correlationCells' },
  { id: 'liquidity-ladder', label: 'Liquidity horizon', group: 'Market Risk', lensHref: '#market-risk', question: 'How much market value belongs to each liquidity horizon?', contract: 'Each nonnegative market value belongs to one declared horizon and category. Bars use a common zero baseline; restricted assets have a pattern as well as a label. Unknown components invalidate their horizon total and portfolio share.', inspect: 'Select a category segment for its exact value and share. Switch to Missing observations to inspect an incomplete horizon.', presets: standard, owner: 'liquidity-ladder · LiquidityLadder / liquiditySegments' },
  { id: 'rack-matrix', label: 'Rack × device matrix', group: 'Inference Fleet', lensHref: '#inference-fleet', question: 'Which GPU devices are busy or missing telemetry?', contract: '128 devices occupy 16 racks × 8 slots. The utilization scale remains 0–100%; four source devices have unavailable telemetry. Historical values and capacity are source records, independent of cell size.', inspect: 'Select GPU-073 or use the device menu. Arrow keys navigate rack/slot cells; Enter pins; Escape dismisses. The rich detail includes exact capacity, temperature, queue and utilization history.', presets: standard, owner: 'rack-matrix · RackMatrix / buildRackMatrix' },
  { id: 'request-flow', label: 'Request routing flow', group: 'Inference Fleet', lensHref: '#inference-fleet', question: 'Where did original requests enter, execute and finish?', contract: 'One set of records supplies both link stages. 58,200 original requests/s reconcile across region, model and outcome; retry attempts are excluded. Missing flow counts are unsupported rather than implicitly replaced with zero.', inspect: 'Choose a ribbon by pointer or keyboard to inspect its exact rate and share of displayed original requests.', presets: complete, owner: 'request-flow · RequestFlow / buildRequestFlow' },
  { id: 'log-scatter', label: 'Paired log scatter', group: 'Inference Fleet', lensHref: '#inference-fleet', question: 'How do paired TTFT and throughput observations compare?', contract: 'Each point pairs the same model and five-minute timestamp. Both axes are logarithmic and retain only positive finite observations. Missing/nonpositive pairs are explicitly counted as omitted; stable colors identify models.', inspect: 'Filter a model with its legend, hover a point, or focus the chart and use arrows then Enter. Exact time, tokens/s and milliseconds remain available.', presets: standard, owner: 'log-scatter · LogScatter / buildLogScatter' },
  { id: 'aligned-telemetry', label: 'Aligned telemetry lanes', group: 'Incident Room', lensHref: '#incident-room', question: 'How did request rate, latency and errors change together?', contract: 'Separate units share one UTC time scale and common bounds. Request and error counts produce per-bucket rates and ratios; the synthetic per-bucket p95 is not averaged across instances. Deployment annotations are context, not causal claims.', inspect: 'Drag a lane to change every lane’s view. Use exact time inputs, Undo or Reset; hover or pin a timestamp to compare same-time values and histories. Hatched intervals remain unknown.', presets: standard, owner: 'aligned-telemetry · AlignedTelemetry / shared time-window owner' },
  { id: 'trace-waterfall', label: 'Nested trace waterfall', group: 'Incident Room', lensHref: '#incident-room', question: 'Which parallel spans contributed to this sampled request?', contract: 'One trace supplies real start offsets, durations, parentage and status. The root elapsed duration is 1,892ms; overlapping spans are not summed into request duration. Incomplete parentage is rejected instead of inventing missing spans.', inspect: 'Search operations, collapse a branch, select a span and inspect its exact timing. Use the selected interval action to focus the waterfall, then Reset.', presets: complete, owner: 'trace-waterfall · TraceWaterfall / buildTraceSpans' },
  { id: 'service-dependency', label: 'Service dependency graph', group: 'Incident Room', lensHref: '#incident-room', question: 'Which observed service calls had elevated error ratios?', contract: 'Directed edges retain supplied request/error counts and latency. Node error ratios use pooled counts from the declared incident fixture; layout does not invent edges or imply causal direction beyond the observed calls.', inspect: 'Select a service to inspect its incoming/outgoing calls and pooled error ratio. Missing observations retain request counts while marking an edge latency unknown.', presets: standard, owner: 'service-dependency · ServiceDependency / buildDependencyGraph' },
  { id: 'grid-network-map', label: 'Geographic network', group: 'Grid Operations', lensHref: '#grid-operations', question: 'Which supplied transmission corridors approach capacity?', contract: 'Approximate city coordinates anchor a synthetic network, not a utility map. Direction and MW flow are supplied independently from node readings; capacity ratios determine corridor classification. Camera movement never changes source values.', inspect: 'Scroll to zoom, drag to pan, or use the navigation controls. Select a station for exact MW, kV, reserve and history. Missing node telemetry remains unknown while independent corridor observations remain visible.', presets: standard, owner: 'grid-network-map · GridNetworkMap / shared geographic camera' },
  { id: 'forecast-bands', label: 'Forecast intervals', group: 'Grid Operations', lensHref: '#grid-operations', question: 'How does observed demand compare with the forecast range?', contract: 'Observed MW and the synthetic forecast median are distinct series. Supplied 68% and 95% central intervals remain nested; they are scenario uncertainty ranges, not guarantees. Missing predictions remove the median and all four bounds together.', inspect: 'Inspect a future timestamp for exact median and interval values. Drag to zoom or use exact time inputs, Undo and Reset. Missing observations preserve discontinuities.', presets: standard, owner: 'forecast-bands · ForecastBands / forecastRecords' },
];

export function isConceptCatalogId(id: string): id is ConceptCatalogId { return conceptChartCatalog.some(feature => feature.id === id); }

export function makeConceptCatalogFixture(id: ConceptCatalogId, preset: CatalogPreset = 'ready'): { widget: Widget; result: QueryResult } {
  const feature = conceptChartCatalog.find(item => item.id === id)!;
  if (!feature.presets.includes(preset)) throw new Error(`The ${id} example does not define a ${preset} fixture.`);
  let source: { widget: Widget; result: QueryResult };
  if (id === 'contribution-waterfall' || id === 'correlation-matrix' || id === 'liquidity-ladder') {
    const market = marketRiskPanels(30); source = id === 'contribution-waterfall' ? market.waterfall : id === 'correlation-matrix' ? market.correlation : market.liquidity;
  } else if (id === 'rack-matrix' || id === 'request-flow' || id === 'log-scatter') {
    const fleet = buildInferenceFleet(); source = id === 'rack-matrix' ? fleet.rack : id === 'request-flow' ? fleet.routing : fleet.scatter;
  } else if (id === 'aligned-telemetry') source = incidentTelemetryPanel('checkout-api');
  else if (id === 'trace-waterfall') source = incidentTracePanel();
  else if (id === 'service-dependency') source = incidentDependencyPanel();
  else { const grid = buildGridOperations(); source = id === 'grid-network-map' ? grid.panels.map : grid.panels.prediction; }
  const fixture = structuredClone({ widget: { ...source.widget, id: `catalog-${id}` }, result: source.result });
  const { result } = fixture;
  if (preset === 'empty') { fixture.result = result.records ? { records: { ...result.records, rows: [] } } : { series: [] }; return fixture; }
  if (preset !== 'gaps') return fixture;
  if (id === 'aligned-telemetry') {
    result.series!.forEach(series => series.points.forEach((point, index) => { if (index >= 66 && index <= 84) point.value = null; }));
    return fixture;
  }
  const frame = result.records!, index = (key: string) => frame.columns.findIndex(column => column.key === key);
  if (id === 'contribution-waterfall') frame.rows[1][index('value')] = null;
  else if (id === 'correlation-matrix') {
    const a = frame.rows[0][index('row')], b = frame.rows.find(row => row[index('row')] !== a)![index('row')];
    frame.rows.forEach(row => { if (row[index('row')] === a && row[index('column')] === b || row[index('row')] === b && row[index('column')] === a) { row[index('value')] = null; row[index('samples')] = 0; } });
  } else if (id === 'liquidity-ladder') frame.rows[1][index('value')] = null;
  else if (id === 'rack-matrix') frame.rows.slice(40, 48).forEach(row => frame.columns.forEach((column, i) => { if (['utilization', 'memory', 'temperature', 'queue'].includes(column.key) || column.key.startsWith('history_')) row[i] = null; }));
  else if (id === 'log-scatter') frame.rows.filter((_, i) => i % 7 === 0).forEach(row => row[index('ttft')] = null);
  else if (id === 'service-dependency') frame.rows[4][index('latencyMs')] = null;
  else if (id === 'grid-network-map') {
    const nodeIds = frame.rows.filter(row => row[index('kind')] === 'node').slice(2, 5).map(row => row[index('id')]);
    frame.rows.forEach(row => { if (nodeIds.includes(row[index('id')])) { row[index('value')] = null; if (row[index('kind')] === 'node') { row[index('voltage')] = null; row[index('reserve')] = null; row[index('status')] = 'Unknown'; } } });
  } else if (id === 'forecast-bands') frame.rows.forEach((row, i) => { if (i >= 100 && i <= 108 || i >= 222 && i <= 230) for (const key of ['observed', 'median', 'low68', 'high68', 'low95', 'high95']) row[index(key)] = null; });
  return fixture;
}
