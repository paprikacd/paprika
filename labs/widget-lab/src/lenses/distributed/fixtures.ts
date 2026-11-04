import type { QueryResult, RecordColumn, RecordFrame, Widget } from '@insights/schema';
import { commitLag, ownershipPaths, peerCells, quorumSummary, replicaSamples, replicaSnapshots, type ReplicaRole, type ReplicaSample } from '../../charts/distributed/model';

export type DistributedScenario = 'degraded' | 'partition' | 'gaps';
export type DistributedPanel = { widget: Widget; result: QueryResult; caption: string };
export const DISTRIBUTED_START = Date.UTC(2026, 9, 31, 11, 49);
export const DISTRIBUTED_END = DISTRIBUTED_START + 15 * 60000;
export const DISTRIBUTED_SHARDS = ['042', '043', '044'] as const;
export const DISTRIBUTED_MEMBERS = [
  { id: 'us-1', region: 'us-east', address: '10.0.1.11' },
  { id: 'us-2', region: 'us-east', address: '10.0.1.12' },
  { id: 'eu-1', region: 'eu-west', address: '10.1.0.21' },
  { id: 'eu-2', region: 'eu-west', address: '10.1.0.22' },
  { id: 'ap-2', region: 'ap-southeast', address: '10.2.0.31' },
] as const;

function result(columns: [string, RecordColumn['type'], string?][], rows: RecordFrame['rows']): QueryResult {
  return { records: { columns: columns.map(([key, type, unit]) => ({ key, type, ...(unit ? { unit } : {}) })), rows } };
}
function panel(id: string, title: string, data: QueryResult, config: Widget['config'], caption: string): DistributedPanel {
  return { widget: { id: id, title, type: 'plugin', pluginId: id, dataKind: 'records', providerId: 'synthetic-distributed', query: `fixture.${id}`, unit: '', layout: { x: 0, y: 0, w: 6, h: 6 }, options: { showTooltip: true, showLegend: true, decimals: 0 }, config }, result: data, caption };
}

/** Deterministic telemetry-shaped observations, not a consensus simulator or live Raft cluster. */
export function distributedFixtures(shardId = '042', scenario: DistributedScenario = 'degraded') {
  if (!/^\d{3}$/.test(shardId) || Number(shardId) < 1 || Number(shardId) > 64) throw new Error('Unknown distributed fixture shard.');
  const shardOffset = Number(shardId) - 42, variant = ((shardOffset % 3) + 3) % 3;
  const leaderId = ['us-1', 'eu-1', 'us-2'][variant], affected = shardId === '042';
  const baseIndex = 8440000 + shardOffset * 93000;
  const leaderAt = (i: number) => baseIndex + Math.round(i / 60 * 1236);
  const rows: RecordFrame['rows'] = [], lastSeen = new Map<string, number>();
  for (let i = 0; i <= 60; i++) {
    const timestamp = DISTRIBUTED_START + i * 15000, leaderReceived = leaderAt(i);
    const leaderCommit = affected && scenario === 'partition' && i >= 48 ? leaderAt(47) - 18 : leaderReceived - 18;
    for (const [memberIndex, member] of DISTRIBUTED_MEMBERS.entries()) {
      const role: ReplicaRole = member.id === leaderId ? 'leader' : 'follower';
      const unavailable = affected && (member.id === 'ap-2' && i >= 42 || scenario === 'partition' && i >= 48 && ['eu-1', 'eu-2'].includes(member.id));
      const missing = affected && scenario === 'gaps' && member.id === 'eu-2' && i >= 56;
      const reachable = missing ? null : !unavailable;
      let received: number | null = leaderReceived, commit: number | null = leaderCommit, applied: number | null = leaderCommit;
      if (role !== 'leader') {
        const lag = member.id === 'us-2' ? 10 : member.id === 'eu-1' ? 18 : member.id === 'eu-2' && affected ? 26 + Math.round(8 * Math.abs(Math.sin(i * Math.PI / 15))) : member.id === 'ap-2' && affected ? 160 + i * 4 : 8 + memberIndex;
        received = leaderReceived - lag;
        commit = Math.min(received, leaderCommit);
        const backlog = member.id === 'eu-2' && affected ? 26 + Math.round(5 * Math.abs(Math.sin(i * Math.PI / 20))) : member.id === 'us-2' ? 3 : 0;
        applied = commit - backlog;
      }
      if (reachable === true) lastSeen.set(member.id, timestamp);
      else { received = null; commit = null; applied = null; }
      rows.push([`${shardId}/${member.id}/${i}`, shardId, member.id, member.region, member.address, role, true, timestamp, lastSeen.get(member.id) ?? null, reachable, reachable === true ? (i < 28 ? 217 : 218) + variant : null, received, commit, applied, leaderReceived, leaderCommit]);
    }
  }
  const history = result([['id', 'string'], ['shardId', 'string'], ['replicaId', 'string'], ['region', 'string'], ['address', 'string'], ['role', 'string'], ['voting', 'boolean'], ['timestamp', 'number', 'ms'], ['observedAt', 'number', 'ms'], ['reachable', 'boolean'], ['term', 'number'], ['received', 'number', 'entries'], ['commit', 'number', 'entries'], ['applied', 'number', 'entries'], ['leaderReceived', 'number', 'entries'], ['leaderCommit', 'number', 'entries']], rows);
  const samples = replicaSamples(history.records), snapshot = replicaSnapshots(samples), quorum = quorumSummary(snapshot);
  const rtt = [[0, 12, 71, 84, 241], [11, 0, 68, 81, 238], [73, 66, 0, 18, 243], [85, 80, 17, 0, 239], [241, 236, 247, 239, 0]];
  const peerRows: RecordFrame['rows'] = [];
  for (const [i, from] of snapshot.entries()) for (const [j, to] of snapshot.entries()) if (i !== j) {
    const status = from.reachable === false || to.reachable === false ? 'unavailable' : from.reachable === null || to.reachable === null ? 'unknown' : 'measured';
    peerRows.push([`${shardId}/${from.replicaId}→${to.replicaId}`, shardId, DISTRIBUTED_END, from.replicaId, to.replicaId, status === 'measured' ? rtt[i][j] + variant * 2 : null, status === 'measured' ? Number((2.2 + ((i * 3 + j * 7 + variant) % 12) / 2).toFixed(1)) : null, status]);
  }
  const peerResult = result([['id', 'string'], ['shardId', 'string'], ['timestamp', 'number', 'ms'], ['fromReplica', 'string'], ['toReplica', 'string'], ['rtt', 'number', 'ms'], ['throughput', 'number', 'MB/s'], ['status', 'string']], peerRows);
  const ownershipRows: RecordFrame['rows'] = [];
  // Exclusive ownership counts: 28/18/18 → 26/20/18 → 27/19/18.
  for (let i = 1; i <= 64; i++) {
    const id = String(i).padStart(3, '0'), initial = i <= 28 ? 'us-east' : i <= 46 ? 'eu-west' : 'ap-southeast';
    const middle = i === 27 || i === 28 ? 'eu-west' : initial, final = i === 29 ? 'us-east' : middle;
    const missing = scenario === 'gaps' && [8, 42].includes(i);
    ownershipRows.push([`ownership/${id}`, id, DISTRIBUTED_START, DISTRIBUTED_START + 7 * 60000, DISTRIBUTED_END, initial, missing ? null : middle, final,
      i === 27 || i === 28 ? DISTRIBUTED_START + (5 * 60 + (i - 27) * 20) * 1000 : null,
      i === 27 || i === 28 ? DISTRIBUTED_START + (6 * 60 + (i - 27) * 25) * 1000 : null,
      i === 29 ? DISTRIBUTED_START + 11 * 60000 : null, i === 29 ? DISTRIBUTED_START + 12 * 60000 : null]);
  }
  const ownershipResult = result([['id', 'string'], ['shardId', 'string'], ['t0', 'number', 'ms'], ['t1', 'number', 'ms'], ['t2', 'number', 'ms'], ['owner0', 'string'], ['owner1', 'string'], ['owner2', 'string'], ['move1Start', 'number', 'ms'], ['move1End', 'number', 'ms'], ['move2Start', 'number', 'ms'], ['move2End', 'number', 'ms']], ownershipRows);
  const selectedReplica = affected ? 'eu-2' : leaderId;
  return {
    shardId, scenario, leaderId, samples, snapshot, quorum, peers: peerCells(peerResult.records), ownership: ownershipPaths(ownershipResult.records),
    topology: panel('distributed-quorum-topology', 'Replica topology', history, { selectedReplica, showAddresses: true, showRegions: true, showIndices: true }, 'Leader → followers · fixed voting membership · current reachability and log evidence'),
    latency: panel('distributed-peer-latency', 'Peer round-trip latency', peerResult, { selectedReplica, showValues: true, metric: 'rtt', warnAboveMs: 75 }, 'Directed observations · rows are sources, columns are destinations · ms'),
    progress: panel('distributed-replication-tracks', 'Replication progress', history, { selectedReplica, showReceived: true, showCommitted: true, showLag: true }, 'Exact log indices · 15-second samples · chart zoom preserves source summaries'),
    movement: panel('distributed-shard-movement', 'Partition movement', ownershipResult, { selectedShard: shardId, showValues: true, showStable: true }, 'Exclusive shard ownership · fixed cohort of 64 · transfer times are supplied events'),
  };
}

export function distributedFleet(scenario: DistributedScenario = 'degraded') { return DISTRIBUTED_SHARDS.map(id => distributedFixtures(id, scenario)); }
export type DistributedFixture = ReturnType<typeof distributedFixtures>;
export type DistributedEvent = { id: string; timestamp: number; shardId: string; replicaId: string; index: number | null; message: string; state: string };
export function distributedEvents(data: DistributedFixture): DistributedEvent[] {
  const at = (replica: string, step: number): ReplicaSample => data.samples.find(p => p.replicaId === replica && p.timestamp === DISTRIBUTED_START + step * 15000)!;
  const records: [string, number, string, string][] = [
    [data.leaderId, 28, 'Leader term advanced; supplied commit remains monotone', 'Observed'],
    ['ap-2', 42, data.shardId === '042' ? 'Heartbeat timed out; current indices unavailable' : 'Heartbeat acknowledged', data.shardId === '042' ? 'Unavailable' : 'Observed'],
    ['eu-2', 48, data.scenario === 'partition' && data.shardId === '042' ? 'Peer partition; leader cannot reach a majority' : commitLag(at('eu-2', 48)) === 0 ? 'Follower has applied the supplied leader commit index' : 'Apply queue remains behind the leader commit index', data.scenario === 'partition' && data.shardId === '042' ? 'Unavailable' : commitLag(at('eu-2', 48)) === 0 ? 'Observed' : 'Applying'],
    ['eu-2', 56, data.scenario === 'gaps' && data.shardId === '042' ? 'Telemetry coverage ended; current state unknown' : 'Periodic follower state observed', data.scenario === 'gaps' && data.shardId === '042' ? 'Unknown' : 'Observed'],
    [data.leaderId, 60, data.quorum.status === 'reachable' ? 'Voting reachability confirmed; inspect commit evidence separately' : 'Insufficient known reachable voters for a majority', data.quorum.status === 'reachable' ? 'Observed' : 'Unavailable'],
  ];
  return records.map(([replicaId, step, message, state], i) => { const sample = at(replicaId, step); return { id: `${data.shardId}-event-${i}`, timestamp: sample.timestamp, shardId: data.shardId, replicaId, index: sample.applied, message, state }; }).reverse();
}
