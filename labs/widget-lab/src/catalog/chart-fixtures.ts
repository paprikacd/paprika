import { distributedChartCatalog, isDistributedCatalogId, makeDistributedCatalogFixture, type DistributedCatalogId } from '../charts/distributed/catalog';
import { kubernetesChartCatalog, isKubernetesCatalogId, makeKubernetesCatalogFixture, type KubernetesCatalogId } from '../charts/kubernetes/catalog';
import { performanceChartCatalog, isPerformanceCatalogId, makePerformanceCatalogFixture, type PerformanceCatalogId } from '../charts/performance/catalog';
import { energyChartCatalog, isEnergyCatalogId, makeEnergyCatalogFixture, type EnergyCatalogId } from '../lenses/energy/fixtures';
import { clinicalChartCatalog, isClinicalCatalogId, makeClinicalCatalogFixture, type ClinicalCatalogId } from '../charts/clinical/catalog';
import { waferChartCatalog, isWaferCatalogId, makeWaferCatalogFixture, type WaferCatalogId } from '../charts/wafer/catalog';
import { orbitalChartCatalog, isOrbitalCatalogId, makeOrbitalCatalogFixture, type OrbitalCatalogId } from '../charts/orbital/catalog';
import type { QueryResult, RecordFrame, Widget } from '@insights/schema';
import { buildEdgeTelemetry } from '../data/edge-telemetry';
import { buildTelemetry } from '../data/telemetry';
import { makeChartResults } from '../data/chart-adapter';
import { buildReliability, reliabilityBurnSeries, reliabilityIncidents, reliabilityTimeline, RELIABILITY_SERVICES, summarizeReliability } from '../data/reliability';
import { conceptChartCatalog, isConceptCatalogId, makeConceptCatalogFixture, type ConceptCatalogId } from './concept-fixtures';
import { analyticsChartCatalog, isAnalyticsCatalogId, makeAnalyticsCatalogFixture, type AnalyticsCatalogId } from './analytics-fixtures';
import { spatialChartCatalog, isSpatialCatalogId, makeSpatialCatalogFixture, type SpatialCatalogId } from './spatial-fixtures';
import { explorationChartCatalog, isExplorationCatalogId, makeExplorationCatalogFixture, type ExplorationCatalogId } from './exploration-fixtures';
import { profilingChartCatalog, isProfilingCatalogId, makeProfilingCatalogFixture, type ProfilingCatalogId } from './profiling-fixtures';

export type CatalogPreset = 'ready' | 'gaps' | 'empty' | 'error';
export type CatalogId = 'stat' | 'timeseries' | 'directional-traffic' | 'stacked-timeseries' | 'distribution-heatmap' | 'status-history' | 'record-table' | 'budget-meter' | 'segmented-meter' | 'incident-calendar' | 'connection-map' | ConceptCatalogId | AnalyticsCatalogId | SpatialCatalogId | ExplorationCatalogId | ProfilingCatalogId | EnergyCatalogId | ClinicalCatalogId | WaferCatalogId | OrbitalCatalogId | KubernetesCatalogId | PerformanceCatalogId | DistributedCatalogId;
export type CatalogFeature = {
  id: CatalogId; label: string; question: string; contract: string; inspect: string;
  presets: readonly CatalogPreset[]; owner: string; localExtension?: string; group?: string; lensHref?: string;
};
const standard = ['ready', 'gaps', 'empty', 'error'] as const;
export const chartCatalog: readonly CatalogFeature[] = [
  { id: 'stat', label: 'Metric + history', question: 'What is the latest observed ingress rate?', contract: 'The headline is the latest valid sample; the sparkline preserves missing observations. Unit conversion happens before rendering.', inspect: 'Open the exact observation to see its source labels and timestamp.', presets: standard, owner: 'Built-in stat · StatSparkline' },
  { id: 'timeseries', label: 'SLO burn rate', question: 'Is the error budget being consumed faster than its allowance?', contract: 'One-hour and six-hour burn rates are computed from pooled request counts. A missing window remains null; the 1× rule is reference context.', inspect: 'Drag over the plot to select a chart time window. Hover or pin an observation to compare exact same-time values, miniature histories and window statistics.', presets: standard, owner: 'Built-in timeseries', localExtension: 'Measured grid, gradient, reference-line and compact-inspector options.' },
  { id: 'directional-traffic', label: 'Mirrored traffic', question: 'How do inbound and outbound rates compare?', contract: 'Both source rates are nonnegative Mb/s. Outbound is mirrored below zero only by the renderer; exact values retain their source sign.', inspect: 'Select an outbound observation and compare its exact positive value with its plotted position.', presets: standard, owner: 'directional-traffic · DirectionalTraffic' },
  { id: 'stacked-timeseries', label: 'Stacked outcomes', question: 'Which exclusive outcomes make up each request bucket?', contract: 'Allowed + challenged + blocked equals the observed request count for each one-minute bucket. Missing populations remain gaps.', inspect: 'Select a stack segment to inspect its exact outcome and interval endpoint.', presets: standard, owner: 'stacked-timeseries · StackedTimeseries' },
  { id: 'distribution-heatmap', label: 'Distribution density', question: 'Where did the latency distribution shift?', contract: 'Input is cumulative histogram counts; the adapter differences adjacent buckets once. Density is requests per minute, while boundaries are milliseconds.', inspect: 'Inspect a bucket and time column; missing density is distinct from zero.', presets: standard, owner: 'distribution-heatmap · DistributionHeatmap' },
  { id: 'status-history', label: 'State history', question: 'Which service samples crossed the burn thresholds?', contract: 'Cells show observed worst-hour burn in equal twelve-hour bins. This renderer is a sampled history, not an elapsed-duration interval chart.', inspect: 'Select a state cell; null bins stay unknown. The exact series appears below.', presets: standard, owner: 'status-history · StatusHistory' },
  { id: 'record-table', label: 'Ranked evidence', question: 'Which destinations account for observed ingress bytes?', contract: 'Mb/s bars share an explicit 0–1,000 Mb/s domain. Share uses the complete observed ingress byte population; null values are not zero.', inspect: 'Sort, filter and select a row. Inspect the exact source record independently of its bar.', presets: standard, owner: 'record-table · RecordTable / StyledRecordCell' },
  { id: 'budget-meter', label: 'Budget meter', question: 'How much of the request-based SLO allowance remains?', contract: 'Remaining budget is 100 × (allowed failures − observed failures) / allowed failures. Negative values remain exact even when a painted track reaches its limit.', inspect: 'Inspect a service to see its exact remaining percentage and source scope.', presets: standard, owner: 'threshold-gauge · ThresholdGauge (linear)' },
  { id: 'segmented-meter', label: 'Segmented capacity', question: 'Which supplied service values approach the configured limits?', contract: 'Segments use an explicit 0–100% scale. Colors classify capacity thresholds, and exact numbers remain available when segment geometry rounds.', inspect: 'Select a capacity reading. At narrow sizes the owner may use its continuous fallback.', presets: standard, owner: 'threshold-gauge · ThresholdGauge (segmented)' },
  { id: 'incident-calendar', label: 'Incident calendar', question: 'On which UTC dates did recorded incidents start?', contract: 'Counts represent recorded incident starts, not outage duration or a claim of healthy coverage on empty dates. Calendar selection does not change an SLO denominator.', inspect: 'Select a date to see its aggregate and source labels.', presets: ['ready', 'empty', 'error'], owner: 'incident-calendar · IncidentCalendar / buildIncidentCalendar' },
  { id: 'connection-map', label: 'Connection geography', question: 'Where are the supplied connection observations located?', contract: 'WGS84 coordinates drive the same equirectangular projection as the land geometry. Values are exact observations; color comes from the supplied classification.', inspect: 'Scroll over the map to zoom; drag or use pan controls, select a location, then reset the world view. Ctrl/Command + scroll remains browser zoom.', presets: standard, owner: 'connection-map · buildConnectionMap + GeoMap', localExtension: 'Shared bounded viewport, stable location identity, fixed-size markers and accessible navigation.' },
];
export const allChartCatalog: readonly CatalogFeature[] = [...chartCatalog, ...conceptChartCatalog, ...profilingChartCatalog, ...analyticsChartCatalog, ...spatialChartCatalog, ...explorationChartCatalog, ...energyChartCatalog, ...clinicalChartCatalog, ...waferChartCatalog, ...orbitalChartCatalog,...kubernetesChartCatalog,...performanceChartCatalog,...distributedChartCatalog];

const base = { providerId: 'catalog-fixture', query: 'deterministic_catalog_fixture', layout: { x: 0, y: 0, w: 8, h: 5 } };
const options: Widget['options'] = { showLegend: true, showGrid: true, showTooltip: true, decimals: 2, curve: 'linear' };
const point = (timestamp: number, value: number | null) => ({ timestamp, value });
const thresholdColors = [{ value: 0, color: '#00a997', label: 'Within budget pace' }, { value: 1, color: '#e7a326', label: 'Elevated burn' }, { value: 2, color: '#ed594c', label: 'Breaching' }];

function recordFrame(columns: RecordFrame['columns'], rows: RecordFrame['rows']): QueryResult { return { records: { columns, rows } }; }

export function makeCatalogFixture(id: CatalogId, preset: CatalogPreset = 'ready'): { widget: Widget; result: QueryResult } {
  if (isDistributedCatalogId(id)) return makeDistributedCatalogFixture(id,preset);
  if (isKubernetesCatalogId(id)) return makeKubernetesCatalogFixture(id,preset);
  if (isPerformanceCatalogId(id)) return makePerformanceCatalogFixture(id,preset);
  if (isEnergyCatalogId(id)) return makeEnergyCatalogFixture(id,preset);
  if (isClinicalCatalogId(id)) return makeClinicalCatalogFixture(id,preset);
  if (isWaferCatalogId(id)) return makeWaferCatalogFixture(id,preset);
  if (isOrbitalCatalogId(id)) return makeOrbitalCatalogFixture(id,preset);
  if (isProfilingCatalogId(id)) return makeProfilingCatalogFixture(id,preset);
  if (isAnalyticsCatalogId(id)) return makeAnalyticsCatalogFixture(id,preset);
  if (isSpatialCatalogId(id)) return makeSpatialCatalogFixture(id,preset);
  if (isExplorationCatalogId(id)) return makeExplorationCatalogFixture(id,preset);
  if (isConceptCatalogId(id)) return makeConceptCatalogFixture(id, preset);
  const feature = chartCatalog.find(item => item.id === id);
  if (!feature) throw new Error(`Unknown catalogue chart: ${id}`);
  if (!feature.presets.includes(preset)) throw new Error(`The ${id} example does not define a ${preset} fixture.`);
  const missing = preset === 'gaps';
  const edge = buildEdgeTelemetry({ scenario: missing ? 'gaps' : 'incident', gateway: 'all', minutes: 30 });
  const reliability = buildReliability(30, missing ? 'gaps' : 'incident');
  let widget: Widget = { ...base, id: `catalog-${id}`, title: feature.label, type: 'plugin', pluginId: id, dataKind: 'metrics', unit: '', options: { ...options } };
  let result: QueryResult;
  if (id === 'stat') {
    widget = { ...widget, type: 'stat', pluginId: undefined, dataKind: undefined, unit: 'Mb/s', options: { ...options, showSparkline: true, decimals: 2 } };
    result = { series: [{ name: 'Ingress', labels: { gateway: 'all', fixture: 'synthetic', interval: '1 minute' }, points: edge.points.map(row => point(row.timestampMs, row.ingressMbps)) }] };
  } else if (id === 'timeseries') {
    const burns = reliabilityBurnSeries(reliability, 'uptime-api');
    widget = { ...widget, type: 'timeseries', pluginId: undefined, dataKind: undefined, title: 'Availability burn rate', unit: '×', options: { ...options, display: 'area', min: 0, lineWidth: 1.35, fillOpacity: .2, timeAxis: 'calendar', gridX: true, axisUnit: 'caption', tooltipMaxWidth: 292, referenceLines: [{ value: 1, label: 'Budget pace 1×' }] } };
    result = { series: ['1h burn rate', '6h burn rate'].map((name, index) => ({ name, labels: { service: 'uptime-api', fixture: 'synthetic', interval: '1 hour' }, points: burns.map(row => point(row.timestampMs, index ? row.sixHour : row.oneHour)) })) };
  } else if (id === 'directional-traffic') {
    widget = { ...widget, unit: 'Mb/s', config: { directionLabel: 'direction', outboundValue: 'outbound', maxSeries: 2, maxPoints: 120, legendDisplay: 'table', legendPosition: 'bottom' } };
    result = { series: ['Ingress', 'Egress'].map((name, index) => ({ name, labels: { direction: index ? 'outbound' : 'inbound', gateway: 'all', fixture: 'synthetic', interval: '1 minute' }, points: edge.points.map(row => point(row.timestampMs, index ? row.egressMbps : row.ingressMbps)) })) };
  } else if (id === 'stacked-timeseries') {
    widget = { ...widget, unit: 'requests/min', config: { display: 'bar', maxSeries: 3, maxPoints: 120, legendDisplay: 'compact', legendPosition: 'bottom' } };
    const outcomes = ['allowed', 'challenged', 'blocked'] as const;
    result = { series: outcomes.map(name => ({ name: name[0].toUpperCase() + name.slice(1), labels: { outcome: name, gateway: 'all', interval: '1 minute', fixture: 'synthetic' }, points: edge.points.map(row => point(row.timestampMs, row[name])) })) };
  } else if (id === 'distribution-heatmap') {
    widget = { ...widget, unit: 'ms', config: { bucketLabel: 'le', bucketUnit: 'ms', densityUnit: 'requests/min', aggregation: 'none', maxBuckets: 12, maxColumns: 60 } };
    result = makeChartResults(buildTelemetry(missing ? 'gaps' : 'regression')).distribution;
  } else if (id === 'status-history') {
    widget = { ...widget, unit: '×', config: { maxSeries: 6, maxPoints: 60 }, options: { ...options, thresholds: thresholdColors } };
    result = { series: RELIABILITY_SERVICES.map(service => ({ name: service.id, labels: { service: service.id, bucket: '12 hours', statistic: 'worst observed 1h burn', fixture: 'synthetic' }, points: reliabilityTimeline(reliability, service.id).map(interval => point(interval.endMs, interval.state === 'missing' ? null : interval.worstHourBurn)) })) };
  } else if (id === 'record-table') {
    widget = { ...widget, dataKind: 'records', config: { columns: ['destination', 'name', 'traffic', 'share'], density: 'compact', showSearch: true, pageSize: 10, cellStyles: [{ column: 'traffic', display: 'bar', min: 0, max: 1000 }] } };
    result = recordFrame([{ key: 'destination', label: 'Destination', type: 'string' }, { key: 'name', label: 'Service', type: 'string' }, { key: 'traffic', label: 'Traffic', type: 'number', unit: 'Mb/s' }, { key: 'share', label: 'Share', type: 'number', unit: 'percent' }], edge.destinations.map((row, index) => [row.address, row.name, missing && index === 1 ? null : row.meanMbps, missing && index === 1 ? null : row.share * 100]));
  } else if (id === 'budget-meter') {
    widget = { ...widget, pluginId: 'threshold-gauge', unit: '%', options: { ...options, min: 0, max: 100, thresholds: [{ value: 0, color: '#ed594c', label: 'At risk' }, { value: 20, color: '#e7a326', label: 'Watch' }, { value: 60, color: '#00a997', label: 'Available' }] }, config: { display: 'linear', seriesMode: 'all', maxSeries: 6, showThresholds: true } };
    result = { series: RELIABILITY_SERVICES.map((service, index) => { const summary = summarizeReliability(reliability, service.id); return { name: service.id, labels: { service: service.id, basis: 'request counts', fixture: 'synthetic' }, points: [point(reliability.endMs, missing && index === 1 ? null : summary.budgetRemaining === null ? null : summary.budgetRemaining * 100)] }; }) };
  } else if (id === 'segmented-meter') {
    widget = { ...widget, pluginId: 'threshold-gauge', unit: '%', options: { ...options, min: 0, max: 100, thresholds: [{ value: 0, color: '#00a997', label: 'Normal' }, { value: 70, color: '#e7a326', label: 'Elevated' }, { value: 90, color: '#ed594c', label: 'Critical' }] }, config: { display: 'segmented', orientation: 'horizontal', seriesMode: 'all', maxSeries: 6, segments: 24, showThresholds: true } };
    result = { series: [34, 62, 81, 96].map((value, index) => ({ name: `edge-${String(index + 1).padStart(2, '0')}`, labels: { metric: 'connection capacity used', fixture: 'synthetic' }, points: [point(edge.endMs, missing && index === 1 ? null : value)] })) };
  } else if (id === 'incident-calendar') {
    widget = { ...widget, dataKind: 'records', unit: 'incidents', config: { date: 'date', label: 'title', status: 'status', aggregation: 'count', months: 1, endDate: '2026-10-30' } };
    result = recordFrame([{ key: 'date', label: 'Started (UTC)', type: 'timestamp' }, { key: 'title', label: 'Incident', type: 'string' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'service', label: 'Service', type: 'string' }], reliabilityIncidents(reliability).map(incident => [new Date(incident.startMs).toISOString(), incident.title, incident.status, incident.serviceId]));
  } else {
    widget = { ...widget, dataKind: 'records', unit: 'connections', config: { latitude: 'latitude', longitude: 'longitude', label: 'city', value: 'connections', status: 'classification', showLocations: true, maxPoints: 120 } };
    const rows: RecordFrame['rows'] = [
      ['syd', 'Sydney', -33.8688, 151.2093, 1420, 'low'], ['mel', 'Melbourne', -37.8136, 144.9631, 864, 'low'],
      ['sin', 'Singapore', 1.3521, 103.8198, 1182, 'medium'], ['tok', 'Tokyo', 35.6762, 139.6503, 965, 'low'],
      ['lon', 'London', 51.5072, -.1276, 742, 'high'], ['fra', 'Frankfurt', 50.1109, 8.6821, 691, 'medium'],
      ['sfo', 'San Francisco', 37.7749, -122.4194, 1263, 'low'], ['nyc', 'New York', 40.7128, -74.006, 733, 'low'],
      ['sao', 'São Paulo', -23.5505, -46.6333, 240, 'unknown'], ['cpt', 'Cape Town', -33.9249, 18.4241, 182, 'low'],
    ];
    if (missing) { rows[2][4] = null; rows[5][4] = null; rows.push(['invalid', 'Unlocated source', null, 12, 42, 'unknown']); }
    result = recordFrame([{ key: 'id', type: 'string' }, { key: 'city', type: 'string' }, { key: 'latitude', type: 'number' }, { key: 'longitude', type: 'number' }, { key: 'connections', type: 'number', unit: 'connections' }, { key: 'classification', type: 'string' }], rows);
  }
  if (preset === 'empty') result = result.records ? { records: { ...result.records, rows: [] } } : { series: [] };
  return { widget, result };
}
