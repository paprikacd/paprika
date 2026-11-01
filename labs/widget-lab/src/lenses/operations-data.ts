import type { QueryResult, RecordFrame, Widget } from '../renderer-extensions/schema';

export const OPERATIONS_AS_OF = Date.UTC(2026, 9, 30, 10);
export type OperationsKind = 'website' | 'infrastructure';
export type OperationsPanel = { widget: Widget; result: QueryResult; caption: string; accent?: string };
const round = (value: number, places = 2) => Number(value.toFixed(places));
const wave = (index: number, phase = 0) => Math.sin(index * .37 + phase) * .58 + Math.sin(index * 1.71 + phase) * .24 + Math.cos(index * .083 + phase) * .18;
const options: Widget['options'] = { showLegend: true, showTooltip: true, showGrid: true, gridX: true, curve: 'linear', lineWidth: 1.25, decimals: 1, display: 'area', fillStyle: 'gradient', fillOpacity: .18, min: 0, inspectorDensity: 'compact' };
function widget(id: string, title: string, unit: string, patch: Partial<Widget> = {}): Widget {
  return { id, title, unit, type: 'timeseries', providerId: 'operations-fixture', query: `synthetic.${id}`, layout: { x: 0, y: 0, w: 6, h: 4 }, options: { ...options }, ...patch };
}
function metrics(id: string, title: string, unit: string, caption: string, times: number[], entries: Array<{ name: string; values: Array<number | null>; labels?: Record<string, string> }>, patch: Partial<Widget> = {}): OperationsPanel {
  return { widget: widget(id, title, unit, patch), caption, result: { series: entries.map(entry => ({ name: entry.name, labels: { fixture: 'synthetic', interval: times.length > 1 ? `${(times[1] - times[0]) / 60000} minutes` : 'snapshot', ...entry.labels }, points: entry.values.map((value, index) => ({ timestamp: times[index], value })) })) } };
}
/** Integer observations with an exact requested population, allocated by largest remainder. */
export function allocateEventCounts(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(weight => total * weight / sum), counts = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, remainder: value - counts[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remainder = total - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) counts[order[i].index]++;
  return counts;
}
export function buildWebsiteLens(minutes: 60 | 180 = 180) {
  const allTimes = Array.from({ length: 180 }, (_, i) => OPERATIONS_AS_OF - (179 - i) * 60000);
  const counts = [190, 269, 273].map((total, s) => allocateEventCounts(total, allTimes.map((_, i) => 1.2 + wave(i, s))));
  const from = 180 - minutes, times = allTimes.slice(from);
  const eventCounts = counts.map(series => series.slice(from));
  const eventNames = ['Successful sign-ins', 'New accounts', 'Sign-outs'];
  const accents = ['#11cde5', '#f7bd54', '#27d8b0'];
  const summaries = eventCounts.map((values, s) => {
    let cumulative = 0;
    return { ...metrics(`website-events-${s}`, eventNames[s], 'events', `Total in selected ${minutes / 60}h · cumulative history`, times, [{ name: eventNames[s], values: values.map(value => cumulative += value) }], { type: 'stat', color: accents[s], options: { ...options, showSparkline: true, showLegend: false, decimals: 0 } }), accent: accents[s] };
  });
  const index = times.map((_, i) => i + from);
  const cpu = index.map(i => round(24 + i * .12 + wave(i, 4) * 8 + 20 * Math.exp(-(((i - 102) / 8) ** 2))));
  const memory = index.map(i => round(19 + i * .033 + wave(i, 2) * 2.8 + (i === 46 ? 17 : 0)));
  const sessions = index.map(i => Math.round(123 + i * .42 + wave(i, 3) * 19));
  const servers = Array.from({ length: 4 }, (_, s) => index.map(i => Math.round(25 + s * 6 + i * .025 + wave(i, s) * (8 + s * 2))));
  const requests = index.map((_, i) => servers.reduce((sum, server) => sum + server[i], 0));
  const buckets = Array.from({ length: 5 }, () => [] as number[]);
  requests.forEach((total, i) => {
    const slow = .04 + .12 * Math.exp(-(((index[i] - 102) / 12) ** 2));
    const parts = allocateEventCounts(total, [.43, .28, .18, .11 - slow / 2, slow / 2]);
    parts.forEach((count, s) => buckets[s].push(count));
  });
  return { minutes, times, eventCounts, requests, buckets, summaries, panels: {
    memory: metrics('website-memory', 'Memory / application fleet', 'GiB', 'Resident memory · 4 application nodes', times, [{ name: 'Resident memory', values: memory }], { color: '#11cde5', options: { ...options, max: 64 } }),
    sessions: metrics('website-sessions', 'Session activity', 'sessions', 'Concurrent sessions · latest observed gauge', times, [{ name: 'Active', values: sessions }, { name: 'Returning', values: sessions.map((value, i) => Math.round(value * (.42 + Math.sin(index[i] * .04) * .04))) }]),
    cpu: metrics('website-cpu', 'CPU / application fleet', '%', 'Mean observed CPU utilization · 0–100% scale', times, [{ name: 'CPU', values: cpu }], { color: '#f7bd54', options: { ...options, max: 100 } }),
    requests: metrics('website-requests', 'Server requests', 'req/min', 'Exclusive server contributions · one-minute counts', times, servers.map((values, s) => ({ name: `web-${String(s + 1).padStart(2, '0')}`, values })), { type: 'plugin', pluginId: 'stacked-timeseries', dataKind: 'metrics', config: { display: 'area', maxSeries: 4, maxPoints: 240, legendDisplay: 'compact', legendPosition: 'bottom' } }),
    latency: metrics('website-page-load', 'Full page load / duration buckets', 'req/min', 'Exclusive durations; all buckets reconcile to request count', times, buckets.map((values, s) => ({ name: ['< 250ms', '250–500ms', '500ms–1s', '1–2s', '≥ 2s'][s], values })), { type: 'plugin', pluginId: 'stacked-timeseries', dataKind: 'metrics', config: { display: 'bar', maxSeries: 5, maxPoints: 60, legendDisplay: 'compact', legendPosition: 'bottom' } }),
    transfer: metrics('website-transfer', 'Application throughput', 'Mb/s', 'Observed ingress and egress · source values remain positive', times, [
      { name: 'Ingress', labels: { direction: 'inbound' }, values: requests.map((value, i) => round(value * .31 + Math.sin(index[i] * .12) * 3)) },
      { name: 'Egress', labels: { direction: 'outbound' }, values: requests.map((value, i) => round(value * .14 + Math.cos(index[i] * .1) * 2)) },
    ], { type: 'plugin', pluginId: 'directional-traffic', dataKind: 'metrics', config: { directionLabel: 'direction', outboundValue: 'outbound', maxSeries: 2, maxPoints: 240, legendDisplay: 'compact', legendPosition: 'bottom' } }),
  } };
}

const cities = [
  ['syd', 'Sydney', -33.8688, 151.2093, 26, 62], ['mel', 'Melbourne', -37.8136, 144.9631, 19, 33],
  ['sin', 'Singapore', 1.3521, 103.8198, 48, 91], ['tok', 'Tokyo', 35.6762, 139.6503, 67, 18],
  ['lon', 'London', 51.5072, -.1276, 181, 247], ['fra', 'Frankfurt', 50.1109, 8.6821, 166, 78],
  ['sfo', 'San Francisco', 37.7749, -122.4194, 149, 113], ['nyc', 'New York', 40.7128, -74.006, 208, 44],
  ['sao', 'São Paulo', -23.5505, -46.6333, 279, 29], ['cpt', 'Cape Town', -33.9249, 18.4241, 254, 57],
] as const;
function locationPanel(kind: 'latency' | 'blocked'): OperationsPanel {
  const isLatency = kind === 'latency';
  const columns: RecordFrame['columns'] = [{ key: 'id', type: 'string' }, { key: 'city', label: 'Probe location', type: 'string' }, { key: 'latitude', type: 'number' }, { key: 'longitude', type: 'number' }, { key: 'value', label: isLatency ? 'RTT' : 'Blocked requests', type: 'number', unit: isLatency ? 'ms' : 'requests' }, { key: 'classification', type: 'string' }];
  const rows: RecordFrame['rows'] = cities.map(([id, city, latitude, longitude, latency, blocked]) => [id, city, latitude, longitude, isLatency ? latency : blocked, isLatency ? latency < 50 ? 'low' : latency < 180 ? 'medium' : 'high' : blocked < 60 ? 'low' : blocked < 150 ? 'medium' : 'high']);
  return { widget: widget(`infrastructure-map-${kind}`, isLatency ? 'World ping times' : 'Blocked request origins', isLatency ? 'ms' : 'requests', { type: 'plugin', pluginId: 'connection-map', dataKind: 'records', config: { latitude: 'latitude', longitude: 'longitude', label: 'city', value: 'value', status: 'classification', showLocations: false, maxPoints: 60 } }), result: { records: { columns, rows } }, caption: isLatency ? 'Latency risk: <50 / 50–179 / ≥180ms · latest RTT' : 'Source risk by blocked count: <60 / 60–149 / ≥150 · last 12h' };
}
/** Equal-weight mean of every plotted host at each sample. The fixture declares no host capacities, so each host counts once. */
function equalWeightMean(hosts: number[][]) {
  return hosts[0].map((_, i) => hosts.reduce((sum, host) => sum + host[i], 0) / hosts.length);
}
export function buildInfrastructureLens() {
  const times = Array.from({ length: 144 }, (_, i) => OPERATIONS_AS_OF - (143 - i) * 300000);
  const cpu = times.map((_, i) => round(29 + wave(i, 1) * 13 + 25 * Math.exp(-(((i - 72) / 11) ** 2))));
  const cpuSecond = cpu.map((value, i) => round(value * .72 + Math.sin(i * .2) * 4));
  const memory = times.map((_, i) => round(57 + i * .055 + wave(i, 2) * 3));
  const memorySecond = memory.map((value, i) => round(value * .7 + Math.sin(i * .13) * 2));
  const down = times.map((_, i) => round(318 + wave(i) * 92));
  const up = times.map((_, i) => round(71 + wave(i, 4) * 22));
  const storageRows: RecordFrame['rows'] = [
    ['data / primary', 8000, 4928, 61.6], ['backups / vault', 16000, 11232, 70.2], ['media / archive', 4000, 1884, 47.1], ['system / nvme', 1000, 116, 11.6],
  ];
  const stat = (id: string, title: string, unit: string, values: number[], accent: string, caption: string) => ({ ...metrics(id, title, unit, caption, times, [{ name: title, values }], { type: 'stat', color: accent, options: { ...options, showSparkline: true, showLegend: false, decimals: unit === '%' ? 1 : 0 } }), accent });
  return { times, storageRows, health: [
    { name: 'Edge gateway', detail: 'edge-01 · responding', state: 'Healthy' },
    { name: 'Application nodes', detail: '12 / 12 reachable', state: 'Healthy' },
    { name: 'Storage replication', detail: 'All replicas current', state: 'Healthy' },
    { name: 'Backup vault', detail: '70.2% capacity used', state: 'Watch' },
    { name: 'Remote probes', detail: `${cities.filter(city => city[4] >= 180).length} / ${cities.length} ≥ 180ms`, state: 'Watch' },
  ], summaries: [
    stat('infrastructure-nodes', 'Nodes online', 'nodes', times.map(() => 12), '#27d8b0', '12 expected · latest snapshot'),
    stat('infrastructure-containers', 'Containers running', 'containers', times.map(() => 8), '#7db8ed', '8 desired · latest snapshot'),
    stat('infrastructure-cpu-stat', 'CPU utilization', '%', equalWeightMean([cpu, cpuSecond]), '#f7bd54', 'Mean of 2 hosts · equal weight, capacity not declared · latest sample'),
    stat('infrastructure-memory-stat', 'Memory utilized', '%', equalWeightMean([memory, memorySecond]), '#a289f5', 'Allocated RAM · mean of 2 hosts, equal weight · latest sample'),
    stat('infrastructure-download-stat', 'WAN download', 'Mb/s', down, '#11cde5', 'Measured rate · latest sample'),
    stat('infrastructure-uptime', 'Gateway uptime', 'days', times.map((_, i) => 22 + i / 288), '#27d8b0', 'Elapsed duration · no resets'),
  ], panels: {
    blocked: locationPanel('blocked'), latency: locationPanel('latency'),
    cpu: metrics('infrastructure-cpu', 'Hypervisor CPU', '%', 'Five-minute samples · host utilization', times, [{ name: 'compute-01', values: cpu }, { name: 'compute-02', values: cpuSecond }], { options: { ...options, max: 100 } }),
    memory: metrics('infrastructure-memory', 'Host memory', '%', 'Allocated physical RAM · per-host percentage', times, [{ name: 'compute-01', values: memory }, { name: 'compute-02', values: memorySecond }], { options: { ...options, max: 100 }, color: '#a289f5' }),
    storage: { widget: widget('infrastructure-storage', 'Disk space usage', '', { type: 'plugin', pluginId: 'record-table', dataKind: 'records', config: { columns: ['mount', 'size', 'used', 'percent'], density: 'compact', showSearch: false, pageSize: 10, cellStyles: [{ column: 'percent', display: 'bar', min: 0, max: 100 }] } }), caption: 'Decimal GB · used / capacity · exact records', result: { records: { columns: [{ key: 'mount', label: 'Mounted on', type: 'string' }, { key: 'size', label: 'Size', type: 'number', unit: 'GB' }, { key: 'used', label: 'Used', type: 'number', unit: 'GB' }, { key: 'percent', label: 'Used', type: 'number', unit: '%' }], rows: storageRows } } } as OperationsPanel,
    network: metrics('infrastructure-network', 'WAN throughput / 12 hours', 'Mb/s', 'Independent download and upload rates · five-minute observations', times, [{ name: 'Download', values: down }, { name: 'Upload', values: up }], { options: { ...options, decimals: 2 }, color: '#11cde5' }),
  } };
}
