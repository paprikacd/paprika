import type { QueryResult } from '../vendor/paprika/ui/src/features/insights/schema';

export type EdgeScenario = 'steady' | 'incident' | 'gaps';
export type EdgeGateway = 'all' | 'edge-01' | 'edge-02';
export type EdgeMinutes = 15 | 30 | 60;
export type EdgeResolution = '10s' | '1m';
export type EdgeRule = 'rate-limit' | 'request-signature' | 'connection-limit';
export const EDGE_INTERVAL_MS = 60_000;
export const EDGE_DETAIL_INTERVAL_MS = 10_000;
export const EDGE_BASE_END_MS = Date.parse('2026-10-30T05:00:00Z');
// Scenario episodes belong to fixed observation times, so advancing the window
// adds a new interval without rewriting telemetry that was already observed.
const INCIDENT_START_MS = EDGE_BASE_END_MS - 24 * EDGE_INTERVAL_MS;
const INCIDENT_END_MS = EDGE_BASE_END_MS - 10 * EDGE_INTERVAL_MS;
const MISSING_WINDOWS = [
  [EDGE_BASE_END_MS - 30 * EDGE_INTERVAL_MS, EDGE_BASE_END_MS - 27 * EDGE_INTERVAL_MS],
  [EDGE_BASE_END_MS - EDGE_INTERVAL_MS, EDGE_BASE_END_MS],
] as const;
export const EDGE_GATEWAYS = [
  { id: 'edge-01' as const, name: 'Sydney', region: 'ap-southeast-2', share: 0.69 },
  { id: 'edge-02' as const, name: 'Singapore', region: 'ap-southeast-1', share: 0.31 },
];
export const EDGE_DESTINATIONS = [
  { address: '203.0.113.10', name: 'Object storage', weight: 0.26 },
  { address: '203.0.113.21', name: 'API ingress', weight: 0.21 },
  { address: '198.51.100.8', name: 'Telemetry', weight: 0.16 },
  { address: '203.0.113.54', name: 'Package registry', weight: 0.13 },
  { address: '198.51.100.31', name: 'Event stream', weight: 0.10 },
  { address: '192.0.2.17', name: 'Identity', weight: 0.08 },
  { address: '192.0.2.80', name: 'Control plane', weight: 0.06 },
];
const protocols = [{ name: 'HTTP/2', weight: 0.46 }, { name: 'HTTP/3', weight: 0.31 }, { name: 'TLS / TCP', weight: 0.18 }, { name: 'Other', weight: 0.05 }];

export interface EdgeTrafficPoint {
  timestampMs: number;
  ingressMbps: number | null;
  egressMbps: number | null;
  requests: number | null;
  allowed: number | null;
  challenged: number | null;
  blocked: number | null;
  ingressBytes: number | null;
  egressBytes: number | null;
}
export interface EdgePoint extends EdgeTrafficPoint {
  activeConnections: number | null;
  destinationBytes: number[] | null;
  protocolRequests: number[] | null;
}
interface GatewayPoint extends EdgePoint { gateway: Exclude<EdgeGateway, 'all'> }
export interface EdgeEvent { id: string; timestampMs: number; gateway: string; source: string; destination: string; rule: EdgeRule; count: number }
export interface EdgeDataset {
  startMs: number;
  endMs: number;
  scenario: EdgeScenario;
  gateway: EdgeGateway;
  minutes: EdgeMinutes;
  revision: number;
  points: EdgePoint[];
  samples10s: EdgeTrafficPoint[];
  coverage: number;
  lastObservedMs: number | null;
  summary: { ingressMbps: number | null; egressMbps: number | null; requests: number; allowed: number; challenged: number; blocked: number; blockedRatio: number | null; activeConnections: number | null; ingressChange: number | null; egressChange: number | null };
  destinations: Array<{ address: string; name: string; bytes: number; meanMbps: number; share: number }>;
  protocols: Array<{ name: string; requests: number; share: number }>;
  gateways: Array<{ id: string; name: string; region: string; meanMbps: number | null; requests: number; blockedRatio: number | null; coverage: number; trend: Array<number | null> }>;
  events: EdgeEvent[];
}

function partition(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let remaining = total;
  return weights.map((weight, index) => {
    const value = index === weights.length - 1 ? remaining : Math.floor(total * weight / sum);
    remaining -= value;
    return value;
  });
}
const mean = (values: Array<number | null>) => {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
};
const relative = (before: number | null, after: number | null) => before !== null && before !== 0 && after !== null ? (after - before) / before : null;
const add = (values: Array<number | null>) => values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
const missingTrafficPoint = (timestampMs: number): EdgeTrafficPoint => ({ timestampMs, ingressMbps: null, egressMbps: null, requests: null, allowed: null, challenged: null, blocked: null, ingressBytes: null, egressBytes: null });
const missingPoint = (timestampMs: number): EdgePoint => ({ ...missingTrafficPoint(timestampMs), activeConnections: null, destinationBytes: null, protocolRequests: null });

// These are synthetic fixture observations, not interpolation of measured data.
// Absolute timestamps and gateway identity seed the shape so a range change or
// new snapshot cannot rewrite an overlapping observation. Integer partitions
// make every six-bin rollup exactly equal to its existing minute source.
function fixtureNoise(seed: number) {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function generateDetailSamples(point: GatewayPoint): EdgeTrafficPoint[] {
  const timestamps = Array.from({ length: 6 }, (_, index) => point.timestampMs - EDGE_INTERVAL_MS + (index + 1) * EDGE_DETAIL_INTERVAL_MS);
  if (point.requests === null) return timestamps.map(missingTrafficPoint);
  const gatewaySeed = point.gateway === 'edge-01' ? 0x1a237 : 0x78b91;
  const weights = (channel: number) => timestamps.map(timestamp => 0.64 + 0.72 * fixtureNoise((timestamp / EDGE_DETAIL_INTERVAL_MS) ^ gatewaySeed ^ channel));
  const ingressBytes = partition(point.ingressBytes!, weights(0x2cb17));
  const egressBytes = partition(point.egressBytes!, weights(0x6a4d3));
  const allowed = partition(point.allowed!, weights(0x71f29));
  const challenged = partition(point.challenged!, weights(0x543a1));
  const blocked = partition(point.blocked!, weights(0x3bf95));
  return timestamps.map((timestampMs, index) => ({
    timestampMs,
    ingressBytes: ingressBytes[index], egressBytes: egressBytes[index],
    ingressMbps: ingressBytes[index] * 8 / 10 / 1_000_000,
    egressMbps: egressBytes[index] * 8 / 10 / 1_000_000,
    allowed: allowed[index], challenged: challenged[index], blocked: blocked[index],
    requests: allowed[index] + challenged[index] + blocked[index],
  }));
}

function generateGateway(gateway: typeof EDGE_GATEWAYS[number], scenario: EdgeScenario, revision: number): GatewayPoint[] {
  const endMs = EDGE_BASE_END_MS + revision * EDGE_INTERVAL_MS;
  return Array.from({ length: 60 }, (_, index) => {
    const timestampMs = endMs - (59 - index) * EDGE_INTERVAL_MS;
    if (scenario === 'gaps' && MISSING_WINDOWS.some(([start, end]) => timestampMs >= start && timestampMs <= end)) return { ...missingPoint(timestampMs), gateway: gateway.id };
    const phase = (timestampMs - EDGE_BASE_END_MS) / EDGE_INTERVAL_MS + 59;
    const gatewayPhase = gateway.id === 'edge-01' ? 0 : 1.6;
    const disturbance = scenario === 'incident' && timestampMs >= INCIDENT_START_MS && timestampMs <= INCIDENT_END_MS ? Math.sin(((timestampMs - INCIDENT_START_MS) / EDGE_INTERVAL_MS + 1) / 16 * Math.PI) : 0;
    const wave = 1 + 0.09 * Math.sin(phase * 0.63 + gatewayPhase) + 0.055 * Math.sin(phase * 2.4 + gatewayPhase) + 0.04 * Math.cos(phase * 1.27);
    const ingressBytes = Math.round((770 * wave + 330 * disturbance * (gateway.id === 'edge-01' ? 1.4 : 0.2)) * gateway.share * 1_000_000 / 8 * 60);
    const egressBytes = Math.round((205 * (1 + 0.13 * Math.sin(phase * 0.45 + 1)) + 90 * disturbance) * gateway.share * 1_000_000 / 8 * 60);
    const requests = Math.round((30_800 * wave + disturbance * 12_000) * gateway.share);
    const blocked = Math.round(requests * (0.014 + 0.006 * (Math.sin(phase * 0.7) + 1) / 2 + disturbance * (gateway.id === 'edge-01' ? 0.092 : 0.012)));
    const challenged = Math.round(requests * (0.054 + 0.012 * (Math.cos(phase * 0.43) + 1) / 2 + disturbance * 0.10));
    const destinationWeights = EDGE_DESTINATIONS.map((destination, destinationIndex) => destination.weight * (1 + 0.12 * Math.sin(phase * 0.27 + destinationIndex + gatewayPhase)));
    return {
      timestampMs, gateway: gateway.id,
      ingressBytes, egressBytes, ingressMbps: ingressBytes * 8 / 60 / 1_000_000, egressMbps: egressBytes * 8 / 60 / 1_000_000,
      requests, blocked, challenged, allowed: requests - blocked - challenged,
      activeConnections: Math.round((17_500 * (1 + 0.07 * Math.sin(phase * 0.24)) + disturbance * 3_200) * gateway.share),
      destinationBytes: partition(ingressBytes, destinationWeights),
      protocolRequests: partition(requests, protocols.map(protocol => protocol.weight)),
    };
  });
}

export function buildEdgeTelemetry({ scenario = 'incident', gateway = 'all', minutes = 30, revision = 0 }: { scenario?: EdgeScenario; gateway?: EdgeGateway; minutes?: EdgeMinutes; revision?: number } = {}): EdgeDataset {
  const endMs = EDGE_BASE_END_MS + revision * EDGE_INTERVAL_MS;
  const startMs = endMs - minutes * EDGE_INTERVAL_MS;
  const selectedGateways = EDGE_GATEWAYS.filter(item => gateway === 'all' || item.id === gateway);
  const grouped = selectedGateways.map(item => {
    const gatewayPoints = generateGateway(item, scenario, revision).slice(-minutes);
    return { gateway: item, points: gatewayPoints, samples10s: gatewayPoints.flatMap(generateDetailSamples) };
  });
  const points: EdgePoint[] = Array.from({ length: minutes }, (_, index) => {
    const contributors = grouped.map(group => group.points[index]);
    if (contributors.some(point => point.requests === null)) return missingPoint(contributors[0].timestampMs);
    const sumField = (key: 'ingressMbps' | 'egressMbps' | 'requests' | 'allowed' | 'challenged' | 'blocked' | 'activeConnections' | 'ingressBytes' | 'egressBytes') => add(contributors.map(point => point[key]));
    return { timestampMs: contributors[0].timestampMs, ingressMbps: sumField('ingressMbps'), egressMbps: sumField('egressMbps'), requests: sumField('requests'), allowed: sumField('allowed'), challenged: sumField('challenged'), blocked: sumField('blocked'), activeConnections: sumField('activeConnections'), ingressBytes: sumField('ingressBytes'), egressBytes: sumField('egressBytes'), destinationBytes: EDGE_DESTINATIONS.map((_, i) => contributors.reduce((sum, point) => sum + (point.destinationBytes?.[i] ?? 0), 0)), protocolRequests: protocols.map((_, i) => contributors.reduce((sum, point) => sum + (point.protocolRequests?.[i] ?? 0), 0)) };
  });
  const valid = points.filter(point => point.requests !== null);
  const samples10s: EdgeTrafficPoint[] = Array.from({ length: minutes * 6 }, (_, index) => {
    const contributors = grouped.map(group => group.samples10s[index]);
    if (contributors.some(point => point.requests === null)) return missingTrafficPoint(contributors[0].timestampMs);
    const sumField = (key: 'requests' | 'allowed' | 'challenged' | 'blocked' | 'ingressBytes' | 'egressBytes') => add(contributors.map(point => point[key]));
    const ingressBytes = sumField('ingressBytes');
    const egressBytes = sumField('egressBytes');
    return {
      timestampMs: contributors[0].timestampMs,
      ingressBytes, egressBytes,
      ingressMbps: ingressBytes * 8 / 10 / 1_000_000,
      egressMbps: egressBytes * 8 / 10 / 1_000_000,
      requests: sumField('requests'), allowed: sumField('allowed'),
      challenged: sumField('challenged'), blocked: sumField('blocked'),
    };
  });
  const requests = add(points.map(point => point.requests));
  const blocked = add(points.map(point => point.blocked));
  const totalInbound = add(points.map(point => point.ingressBytes));
  const half = Math.floor(points.length / 2);
  const before = points.slice(points.length - 2 * half, points.length - half);
  const after = points.slice(-half);
  const last = valid.at(-1);
  return {
    startMs, endMs, scenario, gateway, minutes, revision, points, samples10s,
    coverage: valid.length / points.length,
    lastObservedMs: last?.timestampMs ?? null,
    summary: { ingressMbps: mean(points.map(point => point.ingressMbps)), egressMbps: mean(points.map(point => point.egressMbps)), requests, allowed: add(points.map(point => point.allowed)), challenged: add(points.map(point => point.challenged)), blocked, blockedRatio: requests ? blocked / requests : null, activeConnections: last?.activeConnections ?? null, ingressChange: relative(mean(before.map(point => point.ingressMbps)), mean(after.map(point => point.ingressMbps))), egressChange: relative(mean(before.map(point => point.egressMbps)), mean(after.map(point => point.egressMbps))) },
    destinations: EDGE_DESTINATIONS.map((destination, index) => { const bytes = points.reduce((sum, point) => sum + (point.destinationBytes?.[index] ?? 0), 0); return { address: destination.address, name: destination.name, bytes, meanMbps: valid.length ? bytes * 8 / (valid.length * 60) / 1_000_000 : 0, share: totalInbound ? bytes / totalInbound : 0 }; }).sort((a, b) => b.bytes - a.bytes),
    protocols: protocols.map((protocol, index) => { const count = points.reduce((sum, point) => sum + (point.protocolRequests?.[index] ?? 0), 0); return { name: protocol.name, requests: count, share: requests ? count / requests : 0 }; }),
    gateways: grouped.map(group => { const count = add(group.points.map(point => point.requests)); return { id: group.gateway.id, name: group.gateway.name, region: group.gateway.region, meanMbps: mean(group.points.map(point => point.ingressMbps)), requests: count, blockedRatio: count ? add(group.points.map(point => point.blocked)) / count : null, coverage: group.points.filter(point => point.requests !== null).length / group.points.length, trend: group.points.map(point => point.ingressMbps) }; }),
    events: grouped.flatMap(group => group.points.filter(point => (point.blocked ?? 0) > 0).map(point => {
      const identity = Math.round(point.timestampMs / EDGE_INTERVAL_MS);
      return { id: `${group.gateway.id}-${point.timestampMs}`, timestampMs: point.timestampMs, gateway: group.gateway.id, source: `192.0.2.${24 + (identity * 7) % 200}`, destination: EDGE_DESTINATIONS[(identity + (group.gateway.id === 'edge-01' ? 0 : 2)) % EDGE_DESTINATIONS.length].address, rule: (['rate-limit', 'request-signature', 'connection-limit'] as EdgeRule[])[identity % 3], count: point.blocked! };
    })).sort((a, b) => b.timestampMs - a.timestampMs || a.gateway.localeCompare(b.gateway)),
  };
}

export function makeEdgeChartResult(data: EdgeDataset, resolution: EdgeResolution = '1m'): QueryResult & { series: NonNullable<QueryResult['series']> } {
  const points = resolution === '10s' ? data.samples10s : data.points;
  const labels = { gateway: data.gateway === 'all' ? 'edge-01, edge-02' : data.gateway, source: resolution === '10s' ? 'Synthetic 10s fixture' : 'Synthetic telemetry', interval: resolution === '10s' ? '10 seconds' : '1 minute' };
  return { series: [
    { name: 'Ingress', labels, points: points.map(point => ({ timestamp: point.timestampMs, value: point.ingressMbps })) },
    { name: 'Egress · mirrored', labels, points: points.map(point => ({ timestamp: point.timestampMs, value: point.egressMbps === null ? null : -point.egressMbps })) },
  ] };
}
