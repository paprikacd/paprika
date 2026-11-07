import { issueText } from './input-issues.helper';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseRecordFrame } from '@insights/record-data';
import { widgetSchema, type RecordFrame } from '@insights/schema';
import { getWidgetDefinition } from '@insights/widget-registry';
import { applyBacklog, caughtUpToCommit, commitLag, majorityRequired, ownerAt, ownershipCounts, ownershipGeometry, ownershipPaths, ownershipTransfers, peerCells, peerLatencyConfig, quorumSummary, quorumTopologyConfig, replicaSamples, replicaSnapshots, replicationTracksConfig, shardMovementConfig, steppedPath, type ReplicaSnapshot } from '../src/charts/distributed/model';
import { distributedChartCatalog, isDistributedCatalogId, makeDistributedCatalogFixture } from '../src/charts/distributed/catalog';
import { registerDistributedCharts } from '../src/charts/distributed/register';
import { DISTRIBUTED_END, DISTRIBUTED_START, distributedEvents, distributedFixtures } from '../src/lenses/distributed/fixtures';
import { DistributedSystemsLens } from '../src/lenses/distributed/DistributedSystemsLens';

function set(frame: RecordFrame, row: number, key: string, value: string | number | boolean | null) { frame.rows[row][frame.columns.findIndex(column => column.key === key)] = value; }

describe('fixed-membership consensus evidence', () => {
  it('counts a strict voter majority and does not exclude reachable lagging replicas', () => {
    expect(majorityRequired(1)).toBe(1); expect(majorityRequired(4)).toBe(3); expect(majorityRequired(5)).toBe(3); expect(majorityRequired(6)).toBe(4);
    expect(() => majorityRequired(0)).toThrow(); expect(() => majorityRequired(3.5)).toThrow();
    const data = distributedFixtures(), q = quorumSummary(data.snapshot);
    expect(q).toMatchObject({ voters: 5, required: 3, reachable: 4, unavailable: 1, unknown: 0, status: 'reachable' });
    const slow = data.snapshot.find(p => p.replicaId === 'eu-2')!;
    expect(slow.reachable).toBe(true); expect(caughtUpToCommit(slow)).toBe(false);
    const learner: ReplicaSnapshot = { ...data.snapshot[4], replicaId: 'learner', voting: false, role: 'learner', reachable: true };
    expect(quorumSummary([...data.snapshot, learner]).voters).toBe(5);
  });

  it('distinguishes an impossible majority from incomplete reachability evidence', () => {
    const data = distributedFixtures();
    const unknown = data.snapshot.map((p, i) => ({ ...p, reachable: i < 2 ? true : null }));
    expect(quorumSummary(unknown).status).toBe('unknown');
    const down = data.snapshot.map((p, i) => ({ ...p, reachable: i < 2 }));
    expect(quorumSummary(down).status).toBe('unavailable');
    expect(quorumSummary([]).status).toBe('unknown');
  });

  it('keeps apply backlog, received lag and leader commit lag numerically distinct', () => {
    const data = distributedFixtures(), row = data.snapshot.find(p => p.replicaId === 'eu-2')!;
    expect(row.received).toBe(8441210); expect(row.commit).toBe(8441210); expect(row.applied).toBe(8441184);
    expect(row.leaderReceived - row.received!).toBe(26);
    expect(applyBacklog(row)).toBe(26); expect(commitLag(row)).toBe(34);
    expect(row.leaderCommit).toBe(8441218);
    for (const sample of data.samples.filter(p => p.received !== null)) { expect(sample.applied).toBeLessThanOrEqual(sample.commit!); expect(sample.commit).toBeLessThanOrEqual(sample.received!); expect(sample.commit).toBeLessThanOrEqual(sample.leaderCommit); }
  });

  it('retains last-known evidence without reporting a current unavailable lag', () => {
    const ap = distributedFixtures().snapshot.find(p => p.replicaId === 'ap-2')!;
    expect(ap.reachable).toBe(false); expect(ap.received).toBeNull(); expect(ap.applied).toBeNull(); expect(commitLag(ap)).toBeNull(); expect(applyBacklog(ap)).toBeNull();
    expect(ap.lastKnown?.timestamp).toBe(DISTRIBUTED_START + 41 * 15000); expect(ap.observedAt).toBe(ap.lastKnown?.timestamp);
    expect(ap.lastKnown?.applied).toBeGreaterThan(0); expect(ap.timestamp).toBe(DISTRIBUTED_END);
    const missing = distributedFixtures('042', 'gaps').snapshot.find(p => p.replicaId === 'eu-2')!;
    expect(missing.reachable).toBeNull(); expect(missing.lastKnown?.timestamp).toBe(DISTRIBUTED_START + 55 * 15000);
  });

  it('freezes committed progress when the fixture loses a majority while receipt continues', () => {
    const data = distributedFixtures('042', 'partition'); expect(data.quorum).toMatchObject({ reachable: 2, required: 3, status: 'unavailable' });
    const tail = data.samples.filter(p => p.role === 'leader' && p.timestamp >= DISTRIBUTED_START + 47 * 15000);
    expect(new Set(tail.map(p => p.commit)).size).toBe(1); expect(tail.at(-1)!.received).toBeGreaterThan(tail[0].received!);
    const healthy = distributedFixtures('043', 'partition'); expect(healthy.quorum.status).toBe('reachable'); expect(healthy.quorum.reachable).toBe(5);
  });

  it('accepts observed zero and rejects invalid index, identity and time contracts', () => {
    const frame = structuredClone(distributedFixtures().progress.result.records!); frame.rows = frame.rows.slice(0, 5);
    for (let i = 0; i < frame.rows.length; i++) for (const key of ['term', 'received', 'commit', 'applied', 'leaderReceived', 'leaderCommit']) set(frame, i, key, 0);
    const zeros = replicaSnapshots(replicaSamples(frame)); expect(zeros.every(caughtUpToCommit)).toBe(true); expect(zeros.every(p => applyBacklog(p) === 0)).toBe(true);
    const ahead = structuredClone(frame); set(ahead, 0, 'applied', 1); expect(() => replicaSamples(ahead)).toThrow(/Indices/);
    const negative = structuredClone(frame); set(negative, 0, 'received', -1); expect(() => replicaSamples(negative)).toThrow(/negative/);
    const future = structuredClone(frame); set(future, 0, 'observedAt', DISTRIBUTED_END + 1); expect(() => replicaSamples(future)).toThrow(/future/);
    const duplicate = structuredClone(frame); duplicate.rows.push([...duplicate.rows[0]]); expect(() => replicaSamples(duplicate)).toThrow(/Duplicate/);
    const partial = structuredClone(distributedFixtures().progress.result.records!); partial.rows.pop(); expect(() => replicaSamples(partial)).toThrow(/full declared membership/);
    const stale = structuredClone(frame); set(stale, 0, 'reachable', false); expect(() => replicaSamples(stale)).toThrow(/current log indices/);
    const badLeader = structuredClone(frame); set(badLeader, 0, 'leaderCommit', 1); expect(() => replicaSamples(badLeader)).toThrow(/Leader commit/);
  });
});

describe('directed peer data and missing observations', () => {
  it('keeps directional asymmetry and treats unavailable cells differently from zero', () => {
    const data = distributedFixtures();
    expect(data.peers.find(p => p.fromReplica === 'us-1' && p.toReplica === 'eu-2')?.rtt).toBe(84);
    expect(data.peers.find(p => p.fromReplica === 'eu-2' && p.toReplica === 'us-1')?.rtt).toBe(85);
    expect(data.peers.filter(p => p.fromReplica === 'ap-2' || p.toReplica === 'ap-2').every(p => p.rtt === null && p.status === 'unavailable')).toBe(true);
    const zero = structuredClone(data.latency.result.records!); set(zero, 0, 'rtt', 0); expect(peerCells(zero)[0].rtt).toBe(0);
    const gaps = distributedFixtures('042', 'gaps'); expect(gaps.peers.find(p => p.fromReplica === 'us-1' && p.toReplica === 'eu-2')?.status).toBe('unknown');
  });

  it('rejects self pairs, invented unavailable latency and duplicate directed measurements', () => {
    const data = distributedFixtures(), self = structuredClone(data.latency.result.records!); set(self, 0, 'toReplica', 'us-1'); expect(() => peerCells(self)).toThrow(/Self latency/);
    const unavailable = structuredClone(data.latency.result.records!); set(unavailable, 0, 'status', 'unavailable'); expect(() => peerCells(unavailable)).toThrow(/null/);
    const duplicate = structuredClone(data.latency.result.records!); duplicate.rows.push([...duplicate.rows[0]]); set(duplicate, duplicate.rows.length - 1, 'id', 'different-id'); expect(() => peerCells(duplicate)).toThrow(/pairs must be unique/);
    const mismatched = structuredClone(data.latency.result.records!); set(mismatched, 0, 'timestamp', DISTRIBUTED_START); expect(() => peerCells(mismatched)).toThrow(/exact snapshot time/);
  });

  it('renders step geometry without connecting missing samples', () => {
    const points = [{ timestamp: 0, value: 2 }, { timestamp: 10, value: 5 }, { timestamp: 20, value: null }, { timestamp: 30, value: 9 }];
    const path = steppedPath(points, t => t, v => v);
    expect(path).toBe('M0,2 H10V5  M30,9'); expect(path.match(/M/g)).toHaveLength(2); expect(path).not.toContain('20');
  });
});

describe('ownership conservation and transfer semantics', () => {
  it('conserves all 64 exclusive owners and derives only supplied transfer intervals', () => {
    const data = distributedFixtures(), paths = data.ownership;
    expect(Object.fromEntries(ownershipCounts(paths, 0))).toEqual({ 'us-east': 28, 'eu-west': 18, 'ap-southeast': 18 });
    expect(Object.fromEntries(ownershipCounts(paths, 1))).toEqual({ 'us-east': 26, 'eu-west': 20, 'ap-southeast': 18 });
    expect(Object.fromEntries(ownershipCounts(paths, 2))).toEqual({ 'us-east': 27, 'eu-west': 19, 'ap-southeast': 18 });
    expect(paths.flatMap(ownershipTransfers)).toHaveLength(3); expect(ownershipTransfers(paths.find(p => p.shardId === '042')!)).toHaveLength(0);
    for (const move of paths.flatMap(ownershipTransfers)) { expect(move.start).toBeLessThan(move.end); expect(move.start).toBeGreaterThanOrEqual(DISTRIBUTED_START); expect(move.end).toBeLessThanOrEqual(DISTRIBUTED_END); }
    const geometry = ownershipGeometry(paths, 230);
    for (const stage of geometry.stages) { expect(stage.reduce((sum, g) => sum + g.members.length, 0)).toBe(64); expect(stage.reduce((sum, g) => sum + g.height, 0)).toBeCloseTo(geometry.unit * 64); }
  });

  it('preserves unknown owners as cohort members without invented movements', () => {
    const paths = distributedFixtures('042', 'gaps').ownership;
    expect(ownershipCounts(paths, 1).get('Unknown')).toBe(2);
    for (const stage of [0, 1, 2] as const) expect([...ownershipCounts(paths, stage).values()].reduce((a, b) => a + b, 0)).toBe(64);
    const path = paths.find(p => p.shardId === '042')!; expect(ownerAt(path, 1)).toBe('Unknown'); expect(ownershipTransfers(path)).toHaveLength(0);
    expect(ownershipGeometry([...paths].reverse(), 230).stages).toEqual(ownershipGeometry(paths, 230).stages);
  });

  it('rejects unbounded transfers, mixed checkpoint times and invented stable transfers', () => {
    const frame = distributedFixtures().movement.result.records!;
    const outside = structuredClone(frame); set(outside, 26, 'move1Start', DISTRIBUTED_START - 1); expect(() => ownershipPaths(outside)).toThrow(/bounded increasing/);
    const invented = structuredClone(frame); set(invented, 0, 'move1Start', DISTRIBUTED_START + 1000); set(invented, 0, 'move1End', DISTRIBUTED_START + 2000); expect(() => ownershipPaths(invented)).toThrow(/invent/);
    const mixed = structuredClone(frame); set(mixed, 0, 't0', DISTRIBUTED_START - 1000); expect(() => ownershipPaths(mixed)).toThrow(/share exact/);
    expect(distributedFixtures('027').shardId).toBe('027'); expect(() => distributedFixtures('999')).toThrow(/Unknown/);
  });
});

describe('canonical distributed chart integration', () => {
  it('registers four strict intrinsic families with actual adapter validation', () => {
    registerDistributedCharts(); registerDistributedCharts();
    for (const feature of distributedChartCatalog) {
      expect(isDistributedCatalogId(feature.id)).toBe(true); const panel = makeDistributedCatalogFixture(feature.id), definition = getWidgetDefinition(panel.widget)!;
      expect(definition.sizing?.mode).toBe('intrinsic'); expect(definition.configFields?.length).toBeGreaterThan(0);
      definition.validateInput?.(panel.result, panel.widget.config);
      const wrong = structuredClone(panel.result); wrong.records!.columns[0].key = 'missing-id'; expect(issueText(definition.validateInput?.(wrong, panel.widget.config))).toMatch(/Missing distributed field/);
    }
    for (const schema of [quorumTopologyConfig, peerLatencyConfig, replicationTracksConfig, shardMovementConfig]) expect(() => schema.parse({ unsupported: true })).toThrow();
    expect(() => peerLatencyConfig.parse({ warnAboveMs: 0 })).toThrow();
  });

  it('passes every advertised fixture state through canonical transport and static rendering', () => {
    registerDistributedCharts();
    for (const feature of distributedChartCatalog) for (const preset of feature.presets) {
      const panel = makeDistributedCatalogFixture(feature.id, preset), widget = widgetSchema.parse(panel.widget), definition = getWidgetDefinition(widget)!;
      expect(parseRecordFrame(panel.result.records!)).toEqual(panel.result.records); expect(panel.result.records!.rows.length).toBeLessThanOrEqual(1000); expect(panel.result.records!.columns.length).toBeLessThanOrEqual(64);
      expect(new TextEncoder().encode(JSON.stringify(panel.result.records)).byteLength).toBeLessThan(4 * 1024 * 1024);
      definition.validateInput?.(panel.result, widget.config);
      const html = renderToStaticMarkup(createElement(definition.render, { widget, result: panel.result, embedded: true }));
      expect(html, `${feature.id}/${preset}`).not.toMatch(/NaN|Infinity|undefined|role="button"|<button|<input|<select/);
      if (preset === 'empty') expect(html).toContain('No distributed-system observations');
    }
  });

  it('supports independent replica identities and a different valid shard population', () => {
    const data = distributedFixtures('044'), frame = structuredClone(data.progress.result.records!);
    const mapping = new Map(['us-1', 'us-2', 'eu-1', 'eu-2', 'ap-2'].map((id, i) => [id, `node-${i + 1}`]));
    for (let row = 0; row < frame.rows.length; row++) { const id = frame.rows[row][frame.columns.findIndex(c => c.key === 'replicaId')] as string; set(frame, row, 'replicaId', mapping.get(id)!); set(frame, row, 'id', `independent-${row}`); set(frame, row, 'shardId', 'other-shard'); }
    frame.rows.reverse(); const samples = replicaSamples(frame), nodes = replicaSnapshots(samples);
    expect(nodes).toHaveLength(5); expect(nodes.find(p => p.role === 'leader')?.replicaId).toBe('node-2'); expect(quorumSummary(nodes).reachable).toBe(5);
    expect(distributedEvents(data).find(e => e.timestamp === DISTRIBUTED_START + 48 * 15000)?.message).toContain('has applied');
  });

  it('renders the canonical lens with concrete scoped navigation and coherent initial values', () => {
    const html = renderToStaticMarkup(createElement(DistributedSystemsLens));
    expect(html).toContain('Distributed investigation breadcrumb'); expect(html).toContain('Back to cluster'); expect(html).toContain('Open detail');
    expect(html).toContain('26 ent'); expect(html).toContain('34 ent'); expect(html).toContain('Majority reachable'); expect(html).not.toContain('NaN');
    const data = distributedFixtures(); expect(data.progress.result.records!.rows).toHaveLength(305); expect(data.latency.result.records!.rows).toHaveLength(20); expect(data.movement.result.records!.rows).toHaveLength(64);
  });
});
