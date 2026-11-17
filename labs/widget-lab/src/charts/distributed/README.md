# Distributed Systems chart contract

This family adapts the generated distributed-systems reference into an executable synthetic investigation. The source image supplies composition; validated records supply all numbers and geometry.

## Scope and questions

- Audience: an SRE investigating one replicated shard and its peers.
- Primary question: can the leader reach a voting majority, and which followers have applied the supplied committed log?
- Secondary questions: which directed peer observations and apply queues explain lag; where did exclusive shard ownership change?
- Time: 31 October 2026, 11:49–12:04 UTC, supplied 15-second replication observations. Network cells are an exact 12:04 snapshot. Ownership has three exact checkpoints and separately supplied transfer intervals.
- Synthetic scenarios: a reachable lagging follower with one unreachable replica; a partition with only two known reachable voters and frozen commit; a telemetry gap with unknown current indices. Scenario changes affect shard 042.

## Corrected reference semantics

The generated reference excluded a degraded but reachable voting follower from the reachable majority count. The implementation counts all reachable voting members, keeps learner membership separate, and reports floor(voters / 2) + 1 as the required majority.

Received, local committed, and applied log indices are distinct. The implementation validates applied ≤ local commit ≤ received and local commit ≤ supplied leader commit. It displays apply backlog as local commit minus applied, and lag behind leader commit as leader commit minus applied. In the initial eu-2 fixture these values are **26** and **34 entries**, respectively; neither is labelled milliseconds. A follower is caught up to the supplied committed log when its applied index equals that commit index, even if the leader has additional uncommitted entries.

Unavailable current samples have null current values and retain explicitly timestamped last-known evidence. Peer RTT is directed: reverse observations are separate; a missing or unavailable pair is never a zero. Ownership conserves one unit per shard at every checkpoint, including unknown owners. Alluvial checkpoint curves do not claim exact movement timing; inspectors expose supplied transfer bounds.

The Raft terminology and bounds were checked against [Ongaro and Ousterhout, In Search of an Understandable Consensus Algorithm, Figure 2 and §5.4.2](https://raft.github.io/raft.pdf). A leader’s committed index is supplied evidence. It is **not** inferred merely from reachability or by taking the middle received index without entry-term information.

## Integration and ownership

Four canonical plugin identities use strict configs, canonical scalar record frames, intrinsic sizing and `validateInput` adapters. Shared owners provide panel editing, inspection lifecycle, selected-state pin reconciliation, motion preferences, normal-flow pins, transient hover UI, and local UTC brush windows. No new renderer dependency or private network path is introduced.

The chart family exports `registerDistributedCharts`, `distributedChartCatalog`, `makeDistributedCatalogFixture`, `isDistributedCatalogId` and `DistributedCatalogId`. Every catalog family has ready, gaps, empty and error-host fixtures. Error fixtures retain valid underlying input because the catalog owns its source-error state.

`DistributedSystemsLens({onEdit})` provides cluster → shard → replica navigation with breadcrumb/back. Hover/focus is local inspection; click/Enter pins and updates the selected entity. Named Open actions navigate. The peer matrix maps local pair IDs to destination replica IDs when preserving pins. The replication plot maps observation IDs to replica IDs. The ownership chart maps path IDs to shard IDs. Camera-free local time zoom changes only the replication view; source snapshot and quorum accounting remain unchanged.

## Verification status

The targeted test suite covers majority arithmetic, distinct current/unknown/stale states, index ordering, partition commit behaviour, directional peers, step gaps, ownership conservation, bounded transfer intervals, strict registration/configuration, canonical transport, embedded SSR, independent identities and lens composition. Browser interactions, visual review, focus behaviour, narrow layouts and motion are separate root-agent verification gates. No browser or production-performance claim follows from these source and numerical checks.
