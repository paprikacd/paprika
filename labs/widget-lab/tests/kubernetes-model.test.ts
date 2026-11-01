import { describe, expect, it, vi } from 'vitest';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { fleetBack, fleetBreadcrumb, fleetRows, fleetScope, fleetSelectionAction, fleetSelectionId, nodeFor, placementConfig, resourceBarsConfig, resourceSummary, resourceTimepoints, resourceTrendConfig, selectExisting, throttleConfig, throttleRows, workloadSummary } from '../src/charts/kubernetes/model';
import { makeKubernetesCatalogFixture } from '../src/charts/kubernetes/catalog';
import { FLEET_NAMESPACES, FLEET_START, createFleet, fleetResult, fleetThrottling, fleetTrend, sampleContainer } from '../src/lenses/kubernetes/fixtures';

describe('Kubernetes canonical ownership and accounting', () => {
  const source = fleetResult(), entities = fleetRows(source.records);
  it('fits a coherent 48-node / pod / container hierarchy in one bounded canonical frame', () => {
    expect(parseRecordFrame(source.records)).toEqual(source.records);
    expect(entities).toHaveLength(924);
    expect(entities.filter(e => e.kind === 'node')).toHaveLength(48);
    expect(entities.filter(e => e.kind === 'pod')).toHaveLength(292);
    expect(entities.filter(e => e.kind === 'container')).toHaveLength(584);
    expect(entities.filter(e => e.status === 'Not ready')).toHaveLength(1);
    expect(entities.filter(e => e.kind === 'pod' && e.status === 'Pending')).toHaveLength(4);
    expect(fleetRows(fleetResult().records)).toEqual(entities);
  });
  it('aggregates resource leaves once and keeps pending requests out of scheduled node totals', () => {
    const all = resourceSummary(entities), containers = entities.filter(e => e.kind === 'container'), pending = containers.filter(e => e.nodeId === null);
    expect(all.cpuAllocatable).toBe(768); expect(all.memoryAllocatable).toBe(3072);
    expect(all.expected).toBe(576); expect(all.cpuUsed.count).toBe(564);
    expect(all.cpuRequested).toBeCloseTo(containers.reduce((s, c) => s + c.cpuRequest!, 0) - pending.reduce((s, c) => s + c.cpuRequest!, 0), 8);
    expect(pending.reduce((s, c) => s + c.cpuRequest!, 0)).toBeCloseTo(9.6, 9);
    expect(pending.reduce((s, c) => s + c.memoryRequest!, 0)).toBe(36);
    const node = resourceSummary(entities, 'node-au-17'), childPods = entities.filter(e => e.kind === 'pod' && e.nodeId === 'node-au-17');
    expect(node.cpuRequested).toBeCloseTo(childPods.reduce((s, p) => s + resourceSummary(entities, p.id).cpuRequested, 0), 9);
    expect(node.cpuLimit).toBeGreaterThan(node.cpuAllocatable!);
    expect(node.cpuRequested).toBeLessThanOrEqual(node.cpuAllocatable!);
  });
  it('distinguishes unavailable, pending and real zero observations', () => {
    const unavailable = resourceSummary(entities, 'node-au-36');
    expect(unavailable.cpuUsed.value).toBeNull(); expect(unavailable.cpuUsed.count).toBe(0); expect(unavailable.expected).toBe(12);
    expect(unavailable.cpuRequested).toBeGreaterThan(0);
    const pending = resourceSummary(entities, 'pending:0'); expect(pending.cpuUsed.value).toBeNull(); expect(pending.cpuAllocatable).toBeNull();
    const zero = structuredClone(source.records!); const c = zero.rows.find(row => row[1] === 'container' && row[7] === 'Running')!;
    for (const key of ['cpuUsed', 'memoryUsed', 'networkRx', 'networkTx']) c[zero.columns.findIndex(col => col.key === key)] = 0;
    const parsed = fleetRows(zero); expect(resourceSummary(parsed, String(c[0])).cpuUsed).toEqual({ value: 0, count: 1 });
  });
  it('filters workloads by namespace while retaining physical node allocatable capacity', () => {
    const scopes = FLEET_NAMESPACES.filter(n => n !== 'all').map(n => fleetRows(fleetResult(n).records));
    for (const scope of scopes) { expect(scope.filter(e => e.kind === 'node')).toHaveLength(48); expect(resourceSummary(scope).cpuAllocatable).toBe(768); }
    expect(scopes.reduce((n, rows) => n + resourceSummary(rows).cpuRequested, 0)).toBeCloseTo(resourceSummary(entities).cpuRequested, 8);
    expect(scopes.reduce((n, rows) => n + rows.filter(e => e.kind === 'pod').length, 0)).toBe(292);
    for (const w of workloadSummary(entities)) expect(w.running + w.pending + w.unknown).toBe(w.desired);
  });
  it('rejects duplicate identities, false ancestry, missing fields and incompatible declared units', () => {
    const duplicate = structuredClone(source.records!); duplicate.rows.push([...duplicate.rows[0]]); expect(() => fleetRows(duplicate)).toThrow(/Duplicate/);
    const orphan = structuredClone(source.records!); orphan.rows.find(row => row[1] === 'container')![2] = 'missing-pod'; expect(() => fleetRows(orphan)).toThrow(/ownership/);
    const missing = structuredClone(source.records!); missing.columns.find(c => c.key === 'cpuUsed')!.key = 'renamed'; expect(() => fleetRows(missing)).toThrow(/Missing chart column/);
    const units = structuredClone(source.records!); units.columns.find(c => c.key === 'memoryUsed')!.unit = 'MB'; expect(() => fleetRows(units)).toThrow(/GiB/);
    const typed = structuredClone(source.records!); typed.columns.find(c => c.key === 'cpuRequest')!.type = 'string'; expect(() => fleetRows(typed)).toThrow(/type number/);
  });
  it('rejects fake available measurements, partial paired metrics and impossible scheduled requests', () => {
    const unavailable = structuredClone(source.records!); unavailable.rows.find(row => row[1] === 'container' && row[7] === 'Unknown')![13] = 0;
    expect(() => fleetRows(unavailable)).toThrow(/Unavailable/);
    const partial = structuredClone(source.records!); partial.rows.find(row => row[1] === 'container' && row[7] === 'Running')![13] = null;
    expect(() => fleetRows(partial)).toThrow(/paired coverage/);
    const over = structuredClone(source.records!); over.rows[0][9] = .1;
    expect(() => fleetRows(over)).toThrow(/Scheduled requests exceed/);
    expect(() => resourceSummary(entities, 'not-in-source')).toThrow(/absent/);
  });
});

describe('Kubernetes linked history and throttling mathematics', () => {
  const entities = fleetRows(fleetResult().records);
  it('reconciles the final minute of every node history to the same resource snapshot', () => {
    for (const node of entities.filter(e => e.kind === 'node')) {
      const result = fleetTrend(entities, node.id), rows = resourceTimepoints(result.records), current = resourceSummary(entities, node.id), last = rows.at(-1)!;
      expect(parseRecordFrame(result.records)).toEqual(result.records); expect(rows).toHaveLength(61); expect(last.timestamp).toBe(FLEET_START + 3600000);
      for (const key of ['cpuUsed', 'memoryUsed', 'networkRx', 'networkTx'] as const) {
        if (current[key].value === null) expect(last[key]).toBeNull(); else expect(last[key]).toBeCloseTo(current[key].value!, 5);
      }
      expect(last.cpuRequested).toBeCloseTo(current.cpuRequested, 5); expect(last.observed).toBe(current.cpuUsed.count);
    }
  });
  it('keeps missing histories unknown while preserving explicit request series', () => {
    const missing = resourceTimepoints(fleetTrend(entities, 'node-au-36').records);
    expect(missing.every(p => p.cpuUsed === null && p.memoryUsed === null && p.observed === 0 && p.cpuRequested > 0)).toBe(true);
    const ready = resourceSummary(entities), gap = resourceSummary(fleetRows(fleetResult('all', 'gaps').records));
    expect(gap.cpuRequested).toBe(ready.cpuRequested); expect(gap.cpuUsed.count).toBe(ready.cpuUsed.count - 12);
  });
  it('uses exact summed period counts for each five-minute node cell', () => {
    const result = fleetThrottling(entities), cells = throttleRows(result.records), cell = cells.find(c => c.nodeId === 'node-au-17' && c.start === FLEET_START + 30 * 60000)!;
    expect(parseRecordFrame(result.records)).toEqual(result.records); expect(cells).toHaveLength(576);
    const samples = fleetScope(entities, cell.nodeId).containers.flatMap(c => [31, 32, 33, 34, 35].map(m => sampleContainer(c, m)));
    expect(cell.periods).toBe(samples.reduce((s, p) => s + p.periods!, 0));
    expect(cell.throttled).toBe(samples.reduce((s, p) => s + p.throttled!, 0));
    expect(cell.percent).toBe(cell.throttled! / cell.periods! * 100);
    expect(cell.percent).toBeGreaterThan(cells.find(c => c.nodeId === 'node-au-17' && c.start === FLEET_START)!.percent!);
    expect(cells.filter(c => c.nodeId === 'node-au-36').every(c => c.percent === null && c.periods === null && c.observed === 0 && c.expected === 12)).toBe(true);
  });
  it('keeps a measured zero throttling rate and rejects overlapping or inconsistent intervals', () => {
    const zero = fleetThrottling(entities).records!; zero.rows[0][6] = 0; expect(throttleRows(zero)[0].percent).toBe(0);
    const impossible = fleetThrottling(entities).records!; impossible.rows[0][6] = Number(impossible.rows[0][5]) + 1; expect(() => throttleRows(impossible)).toThrow(/counts/);
    const overlap = fleetThrottling(entities).records!; overlap.rows[1][3] = Number(overlap.rows[0][3]) + 1; expect(() => throttleRows(overlap)).toThrow(/overlap/);
    const time = fleetTrend(entities).records!; time.rows[1][1] = time.rows[0][1]; expect(() => resourceTimepoints(time)).toThrow(/Duplicate/);
  });
});

describe('Kubernetes drilldown and strict authoring model', () => {
  const entities = createFleet();
  it('keeps the cluster → node → pod → container chain and exact back navigation', () => {
    const node = 'node-au-17', pod = 'pod:node-au-17:0', container = 'pod:node-au-17:0:0';
    expect(fleetBreadcrumb(entities, container).map(e => e.id)).toEqual([node, pod, container]);
    expect(fleetBack(entities, container)).toBe(pod); expect(fleetBack(entities, pod)).toBe(node); expect(fleetBack(entities, node)).toBe('');
    expect(nodeFor(entities, container)).toBe(node); expect(selectExisting(entities, container)).toBe(container);
    expect(selectExisting(fleetRows(fleetResult('risk').records), container)).toBe('');
    expect(fleetBreadcrumb(entities, 'pending:0:0').map(e => e.id)).toEqual(['pending:0', 'pending:0:0']);
    expect(nodeFor(entities, 'pending:0:0')).toBe('');
  });
  it('does not resurrect a standalone pod selection when a linked host navigates back to its node', () => {
    const node = 'node-au-17', pod = 'pod:node-au-17:0', cfg = placementConfig.parse({ selectionOwner: 'host', selectedId: node });
    expect(fleetSelectionId(entities, node, pod, false)).toBe(pod);
    expect(fleetSelectionAction(entities, pod, cfg.selectionOwner)!.localId).toBeNull();
    expect(fleetSelectionId(entities, pod, pod, cfg.selectionOwner === 'host')).toBe(pod);
    expect(fleetSelectionId(entities, fleetBack(entities, pod), pod, cfg.selectionOwner === 'host')).toBe(node);
    expect(fleetSelectionId(entities, '', pod, cfg.selectionOwner === 'host')).toBe('');
    expect(fleetSelectionId(fleetRows(fleetResult('risk').records), pod, pod, cfg.selectionOwner === 'host')).toBe('');
  });
  it('keeps catalogue selection local while a context callback observes clicks without echoing config', () => {
    const fixture = makeKubernetesCatalogFixture('kubernetes-placement'), source = fleetRows(fixture.result.records), cfg = placementConfig.parse(fixture.widget.config);
    const onContextChange = vi.fn(), node = 'node-au-22', pod = 'pod:node-au-22:0';
    expect(cfg.selectionOwner).toBe('local');
    const nodeClick = fleetSelectionAction(source, node, cfg.selectionOwner)!; onContextChange(nodeClick.context);
    expect(onContextChange).toHaveBeenLastCalledWith(expect.objectContaining({ labels: expect.objectContaining({ entityId: node }) }));
    expect(cfg.selectedId).toBe('node-au-17');
    expect(fleetSelectionId(source, cfg.selectedId, nodeClick.localId, cfg.selectionOwner === 'host')).toBe(node);
    const podClick = fleetSelectionAction(source, pod, cfg.selectionOwner)!; onContextChange(podClick.context);
    expect(fleetSelectionId(source, cfg.selectedId, podClick.localId, cfg.selectionOwner === 'host')).toBe(pod);
    expect(nodeFor(source, podClick.localId!)).toBe(node);
    const clear = fleetSelectionAction(source, '', cfg.selectionOwner)!; onContextChange(clear.context);
    expect(fleetSelectionId(source, cfg.selectedId, clear.localId, cfg.selectionOwner === 'host')).toBe('');
    expect(onContextChange).toHaveBeenCalledTimes(3);
    expect(fleetSelectionAction(source, 'not-present', cfg.selectionOwner)).toBeNull();
  });
  it('rejects invented visual options and keeps every editor field bounded', () => {
    for (const schema of [placementConfig, resourceBarsConfig, throttleConfig, resourceTrendConfig]) expect(() => schema.parse({ fake: true })).toThrow();
    expect(() => placementConfig.parse({ pressure: 5 })).toThrow(); expect(() => throttleConfig.parse({ rows: 100 })).toThrow();
    expect(() => placementConfig.parse({ selectionOwner: 'callback' })).toThrow();
    expect(() => resourceTrendConfig.parse({ selectedAt: 'now' })).toThrow(); expect(resourceTrendConfig.parse({ selectedAt: null }).selectedAt).toBeNull();
  });
});
