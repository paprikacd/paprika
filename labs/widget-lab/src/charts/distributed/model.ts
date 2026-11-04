import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';

const replicaSelection = { selectedReplica: z.string().max(80).optional() };
export const quorumTopologyConfig = z.strictObject({ ...replicaSelection, showAddresses: z.boolean().default(true), showRegions: z.boolean().default(true), showIndices: z.boolean().default(true) });
export const peerLatencyConfig = z.strictObject({ ...replicaSelection, showValues: z.boolean().default(true), metric: z.enum(['rtt', 'throughput']).default('rtt'), warnAboveMs: z.number().positive().max(10000).default(75) });
export const replicationTracksConfig = z.strictObject({ ...replicaSelection, selectedTimestamp: z.number().finite().optional(), showReceived: z.boolean().default(true), showCommitted: z.boolean().default(true), showLag: z.boolean().default(true) });
export const shardMovementConfig = z.strictObject({ selectedShard: z.string().max(80).optional(), showValues: z.boolean().default(true), showStable: z.boolean().default(true) });

function objects(frame: RecordFrame | undefined, required: string[]) {
  if (!frame) return [];
  if (frame.rows.length > 1000) throw new Error('Distributed charts accept at most 1,000 records.');
  const keys = new Set(frame.columns.map(c => c.key));
  if (keys.size !== frame.columns.length) throw new Error('Distributed columns require unique keys.');
  for (const key of required) if (!keys.has(key)) throw new Error(`Missing distributed field “${key}”.`);
  return frame.rows.map(row => {
    if (row.length !== frame.columns.length) throw new Error('Distributed rows must match the declared columns.');
    return Object.fromEntries(frame.columns.map((column, i) => [column.key, row[i]]));
  });
}
function text(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error(`${name} must be bounded nonempty text.`); return value; }
function finite(value: unknown, name: string) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite.`); return value; }
function nonnegative(value: unknown, name: string) { const n = finite(value, name); if (n < 0) throw new Error(`${name} cannot be negative.`); return n; }
function index(value: unknown, name: string) { const n = nonnegative(value, name); if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a safe integer.`); return n; }
function maybeIndex(value: unknown, name: string) { return value === null ? null : index(value, name); }
function bool(value: unknown, name: string) { if (typeof value !== 'boolean') throw new Error(`${name} must be an explicit boolean.`); return value; }
function unique<T extends { id: string }>(rows: T[]) { const ids = new Set<string>(); for (const row of rows) { if (ids.has(row.id)) throw new Error(`Duplicate distributed identity “${row.id}”.`); ids.add(row.id); } return rows; }

export type ReplicaRole = 'leader' | 'follower' | 'learner';
export type ReplicaSample = {
  id: string; shardId: string; replicaId: string; region: string; address: string; role: ReplicaRole; voting: boolean;
  timestamp: number; observedAt: number | null; reachable: boolean | null; term: number | null;
  received: number | null; commit: number | null; applied: number | null; leaderReceived: number; leaderCommit: number;
};
export type ReplicaSnapshot = ReplicaSample & { lastKnown: ReplicaSample | undefined };

/** One fixed-membership shard, supplied leader reference, and exact sample timestamps. */
export function replicaSamples(frame: RecordFrame | undefined): ReplicaSample[] {
  const rows = unique(objects(frame, ['id', 'shardId', 'replicaId', 'region', 'address', 'role', 'voting', 'timestamp', 'observedAt', 'reachable', 'term', 'received', 'commit', 'applied', 'leaderReceived', 'leaderCommit']).map<ReplicaSample>(r => {
    if (r.role !== 'leader' && r.role !== 'follower' && r.role !== 'learner') throw new Error('Replica role must be leader, follower or learner.');
    const row: ReplicaSample = {
      id: text(r.id, 'ID'), shardId: text(r.shardId, 'Shard'), replicaId: text(r.replicaId, 'Replica'), region: text(r.region, 'Region'), address: text(r.address, 'Address'), role: r.role,
      voting: bool(r.voting, 'Voting membership'), timestamp: finite(r.timestamp, 'Timestamp'), observedAt: r.observedAt === null ? null : finite(r.observedAt, 'Last observation'), reachable: r.reachable === null ? null : bool(r.reachable, 'Reachability'),
      term: maybeIndex(r.term, 'Term'), received: maybeIndex(r.received, 'Received index'), commit: maybeIndex(r.commit, 'Commit index'), applied: maybeIndex(r.applied, 'Applied index'), leaderReceived: index(r.leaderReceived, 'Leader received index'), leaderCommit: index(r.leaderCommit, 'Leader commit index'),
    };
    if (row.leaderCommit > row.leaderReceived) throw new Error('Leader commit cannot exceed the leader received index.');
    if (row.observedAt !== null && row.observedAt > row.timestamp) throw new Error('An observation cannot come from the future.');
    if (row.reachable !== true) {
      if ([row.term, row.received, row.commit, row.applied].some(v => v !== null)) throw new Error('Unavailable or unknown telemetry cannot carry current log indices.');
    } else {
      if ([row.term, row.received, row.commit, row.applied].some(v => v === null) || row.observedAt !== row.timestamp) throw new Error('A reachable sample requires same-timestamp index observations.');
      if (row.applied! > row.commit! || row.commit! > row.received! || row.commit! > row.leaderCommit || row.received! > row.leaderReceived) throw new Error('Indices must satisfy applied ≤ local commit ≤ received, bounded by the supplied leader reference.');
    }
    if (row.role === 'leader' && !row.voting || row.role === 'learner' && row.voting) throw new Error('Leaders vote; learners are excluded from voting membership.');
    return row;
  }));
  if (new Set(rows.map(r => r.shardId)).size > 1) throw new Error('A replica frame describes one shard.');
  const groups = replicaGroups(rows);
  if (groups.length > 12) throw new Error('A replica chart supports at most 12 members.');
  for (const group of groups) {
    const first = group.samples[0], times = new Set<number>();
    let previousCommit = -1, previousApplied = -1, previousTerm = -1;
    for (const sample of group.samples) {
      if (times.has(sample.timestamp)) throw new Error('A replica cannot have duplicate timestamps.');
      times.add(sample.timestamp);
      if (sample.region !== first.region || sample.address !== first.address || sample.voting !== first.voting) throw new Error('Replica identity and membership must stay stable within this frame.');
      if (sample.commit !== null) { if (sample.commit < previousCommit || sample.applied! < previousApplied || sample.term! < previousTerm) throw new Error('Commit, applied index and observed term cannot go backwards.'); previousCommit = sample.commit; previousApplied = sample.applied!; previousTerm = sample.term!; }
    }
  }
  const byTime = new Map<number, ReplicaSample[]>();
  for (const row of rows) byTime.set(row.timestamp, [...(byTime.get(row.timestamp) ?? []), row]);
  let previousLeaderCommit = -1;
  for (const [, samples] of [...byTime].sort(([a], [b]) => a - b)) {
    const first = samples[0];
    if (samples.length !== groups.length || samples.filter(p => p.role === 'leader').length !== 1) throw new Error('Each timestamp requires the full declared membership and one supplied leader.');
    if (samples.some(p => p.leaderCommit !== first.leaderCommit || p.leaderReceived !== first.leaderReceived)) throw new Error('Same-timestamp observations must agree on the leader reference.');
    const leader = samples.find(p => p.role === 'leader')!;
    if (leader.reachable === true && (leader.received !== first.leaderReceived || leader.commit !== first.leaderCommit)) throw new Error('Leader observations must match the supplied leader reference.');
    if (first.leaderCommit < previousLeaderCommit) throw new Error('Leader commit cannot go backwards.');
    previousLeaderCommit = first.leaderCommit;
  }
  return rows;
}

export function replicaGroups(rows: readonly ReplicaSample[]) {
  const groups = new Map<string, ReplicaSample[]>();
  for (const row of rows) groups.set(row.replicaId, [...(groups.get(row.replicaId) ?? []), row]);
  return [...groups].map(([id, samples]) => ({ id, samples: [...samples].sort((a, b) => a.timestamp - b.timestamp) }));
}
export function replicaSnapshots(rows: readonly ReplicaSample[]): ReplicaSnapshot[] {
  return replicaGroups(rows).map(group => ({ ...group.samples.at(-1)!, lastKnown: [...group.samples].reverse().find(p => p.received !== null) }));
}
export function majorityRequired(voters: number) { if (!Number.isSafeInteger(voters) || voters < 1) throw new Error('Quorum needs a positive integer voter count.'); return Math.floor(voters / 2) + 1; }
export function quorumSummary(rows: readonly ReplicaSnapshot[]) {
  const voters = rows.filter(r => r.voting), required = voters.length ? majorityRequired(voters.length) : 0;
  const reachable = voters.filter(r => r.reachable === true).length, unknown = voters.filter(r => r.reachable === null).length;
  const status = !voters.length ? 'unknown' : reachable >= required ? 'reachable' : reachable + unknown >= required ? 'unknown' : 'unavailable';
  return { voters: voters.length, required, reachable, unknown, unavailable: voters.length - reachable - unknown, status, caughtUp: rows.filter(caughtUpToCommit).length } as const;
}
export function commitLag(row: Pick<ReplicaSample, 'applied' | 'leaderCommit'>) { return row.applied === null ? null : row.leaderCommit - row.applied; }
export function applyBacklog(row: Pick<ReplicaSample, 'commit' | 'applied'>) { return row.commit === null || row.applied === null ? null : row.commit - row.applied; }
export function caughtUpToCommit(row: ReplicaSample) { return row.reachable === true && row.applied === row.leaderCommit; }
export function replicaState(row: ReplicaSample) { return row.reachable === null ? 'Unknown' : row.reachable === false ? 'Unavailable' : caughtUpToCommit(row) ? 'Caught up' : commitLag(row)! > 20 ? 'Lagging' : 'Applying'; }

export type PeerCell = { id: string; shardId: string; timestamp: number; fromReplica: string; toReplica: string; rtt: number | null; throughput: number | null; status: 'measured' | 'unavailable' | 'unknown' };
export function peerCells(frame: RecordFrame | undefined): PeerCell[] {
  const rows = unique(objects(frame, ['id', 'shardId', 'timestamp', 'fromReplica', 'toReplica', 'rtt', 'throughput', 'status']).map<PeerCell>(r => {
    if (r.status !== 'measured' && r.status !== 'unavailable' && r.status !== 'unknown') throw new Error('A peer observation requires measured, unavailable or unknown status.');
    const row: PeerCell = { id: text(r.id, 'ID'), shardId: text(r.shardId, 'Shard'), timestamp: finite(r.timestamp, 'Timestamp'), fromReplica: text(r.fromReplica, 'Source replica'), toReplica: text(r.toReplica, 'Destination replica'), rtt: r.rtt === null ? null : nonnegative(r.rtt, 'RTT'), throughput: r.throughput === null ? null : nonnegative(r.throughput, 'Throughput'), status: r.status };
    if (row.fromReplica === row.toReplica) throw new Error('Self latency is not a measured peer pair.');
    if (row.status === 'measured' ? row.rtt === null : row.rtt !== null || row.throughput !== null) throw new Error('Unavailable peer values must stay null; measured RTT must exist.');
    return row;
  }));
  if (new Set(rows.map(p => p.shardId)).size > 1 || new Set(rows.map(p => p.timestamp)).size > 1) throw new Error('Peer cells require one shard and one exact snapshot time.');
  if (new Set(rows.map(p => `${p.fromReplica}\0${p.toReplica}`)).size !== rows.length) throw new Error('Directed peer pairs must be unique.');
  if (new Set(rows.flatMap(p => [p.fromReplica, p.toReplica])).size > 12) throw new Error('Peer matrices support at most 12 replicas.');
  return rows;
}

export type OwnershipPath = {
  id: string; shardId: string; t0: number; t1: number; t2: number; owner0: string | null; owner1: string | null; owner2: string | null;
  move1Start: number | null; move1End: number | null; move2Start: number | null; move2End: number | null;
};
export function ownershipPaths(frame: RecordFrame | undefined): OwnershipPath[] {
  const rows = unique(objects(frame, ['id', 'shardId', 't0', 't1', 't2', 'owner0', 'owner1', 'owner2', 'move1Start', 'move1End', 'move2Start', 'move2End']).map<OwnershipPath>(r => {
    const row = { id: text(r.id, 'ID'), shardId: text(r.shardId, 'Shard'), t0: finite(r.t0, 'First checkpoint'), t1: finite(r.t1, 'Middle checkpoint'), t2: finite(r.t2, 'Final checkpoint'), owner0: r.owner0 === null ? null : text(r.owner0, 'Initial owner'), owner1: r.owner1 === null ? null : text(r.owner1, 'Middle owner'), owner2: r.owner2 === null ? null : text(r.owner2, 'Final owner'), move1Start: r.move1Start === null ? null : finite(r.move1Start, 'First transfer start'), move1End: r.move1End === null ? null : finite(r.move1End, 'First transfer end'), move2Start: r.move2Start === null ? null : finite(r.move2Start, 'Second transfer start'), move2End: r.move2End === null ? null : finite(r.move2End, 'Second transfer end') };
    if (!(row.t0 < row.t1 && row.t1 < row.t2)) throw new Error('Ownership checkpoint times must increase.');
    for (const stage of [1, 2] as const) {
      const from = stage === 1 ? row.owner0 : row.owner1, to = stage === 1 ? row.owner1 : row.owner2;
      const start = stage === 1 ? row.move1Start : row.move2Start, end = stage === 1 ? row.move1End : row.move2End;
      const lower = stage === 1 ? row.t0 : row.t1, upper = stage === 1 ? row.t1 : row.t2;
      if (from !== null && to !== null && from !== to) { if (start === null || end === null || start < lower || end > upper || end <= start) throw new Error('A confirmed ownership change requires a bounded increasing transfer interval.'); }
      else if (start !== null || end !== null) throw new Error('Stable or unknown ownership must not invent a transfer interval.');
    }
    return row;
  }));
  if (new Set(rows.map(p => p.shardId)).size !== rows.length) throw new Error('Each shard needs one complete ownership path.');
  if (rows.some(p => p.t0 !== rows[0].t0 || p.t1 !== rows[0].t1 || p.t2 !== rows[0].t2)) throw new Error('All ownership paths must share exact checkpoint times.');
  if (rows.length > 200 || new Set(rows.flatMap(p => [p.owner0, p.owner1, p.owner2])).size > 8) throw new Error('Ownership charts support at most 200 shards and eight owner states.');
  return rows;
}
export const UNKNOWN_OWNER = 'Unknown';
export function ownerAt(path: OwnershipPath, stage: 0 | 1 | 2) { return [path.owner0, path.owner1, path.owner2][stage] ?? UNKNOWN_OWNER; }
export function ownershipCounts(paths: readonly OwnershipPath[], stage: 0 | 1 | 2) { const counts = new Map<string, number>(); for (const path of paths) { const owner = ownerAt(path, stage); counts.set(owner, (counts.get(owner) ?? 0) + 1); } return counts; }
export function ownershipTransfers(path: OwnershipPath) {
  return ([1, 2] as const).flatMap(stage => { const start = stage === 1 ? path.move1Start : path.move2Start, end = stage === 1 ? path.move1End : path.move2End; return start === null || end === null ? [] : [{ id: `${path.id}-${stage}`, shardId: path.shardId, from: ownerAt(path, stage - 1 as 0 | 1), to: ownerAt(path, stage), start, end }]; });
}
/** A fixed cohort flows between exclusive owners; every shard retains exactly one unit at every checkpoint. */
export function ownershipGeometry(paths: readonly OwnershipPath[], height: number, gap = 13) {
  const owners = [...new Set(paths.flatMap(p => [ownerAt(p, 0), ownerAt(p, 1), ownerAt(p, 2)]))].sort((a, b) => a === UNKNOWN_OWNER ? 1 : b === UNKNOWN_OWNER ? -1 : a.localeCompare(b));
  const unit = paths.length ? Math.max(1, height - Math.max(0, owners.length - 1) * gap) / paths.length : 0;
  const stages = ([0, 1, 2] as const).map(stage => {
    let cursor = 0;
    return owners.map(owner => { const members = paths.filter(p => ownerAt(p, stage) === owner).sort((a, b) => a.shardId.localeCompare(b.shardId)), y = cursor; cursor += members.length * unit + gap; return { owner, y, height: members.length * unit, members: members.map((p, i) => ({ id: p.id, y: y + i * unit })) }; });
  });
  return { owners, unit, stages };
}

export function nearestSample<T extends { timestamp: number }>(samples: readonly T[], timestamp: number) { return samples.reduce<T | undefined>((best, row) => !best || Math.abs(row.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? row : best, undefined); }
export function steppedPath(points: readonly { timestamp: number; value: number | null }[], x: (t: number) => number, y: (v: number) => number) {
  let previous: { timestamp: number; value: number } | null = null;
  return points.map(point => {
    if (point.value === null) { previous = null; return ''; }
    const mark = previous ? `H${x(point.timestamp)}V${y(point.value)}` : `M${x(point.timestamp)},${y(point.value)}`;
    previous = { timestamp: point.timestamp, value: point.value };
    return mark;
  }).join(' ');
}
export const distributedUtc = (timestamp: number, seconds = false) => new Date(timestamp).toISOString().slice(11, seconds ? 19 : 16);
export const formatIndex = (value: number | null | undefined) => value === null || value === undefined ? 'Unknown' : value.toLocaleString('en-US');
