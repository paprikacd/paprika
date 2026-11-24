import { describe, expect, it } from "vitest";
import type { QueryResult } from "../schema";
import { KUBERNETES_FIXTURE_OPTIONS, kubernetesFixture, kubernetesFleetSeries } from "./kubernetes-fixtures";
import {
  CONTROL_PLANE_BARS_QUERY,
  KUBERNETES_SIGNALS,
  PLACEMENT_QUERY,
  RESOURCE_BARS_BY_POD_QUERY,
  RESOURCE_TREND_QUERY,
  THROTTLE_BY_POD_QUERY,
} from "./kubernetes-queries";
import { placementModel, resourceGroups, resourceStrips, throttleCells } from "./kubernetes-data";

type Series = NonNullable<QueryResult["series"]>[number];
const at = (timestamp: number, value: number | null) => ({ timestamp, value });
const row = (labels: Record<string, string>, points: { timestamp: number; value: number | null }[]): Series => ({ name: labels.signal ?? "s", labels, points });
const result = (...series: Series[]): QueryResult => ({ series });
const T = KUBERNETES_FIXTURE_OPTIONS.start;

describe("kubernetes queries", () => {
  it("names every signal the adapters read, and only those", () => {
    const used = new Set<string>();
    for (const query of [PLACEMENT_QUERY, RESOURCE_BARS_BY_POD_QUERY, CONTROL_PLANE_BARS_QUERY, THROTTLE_BY_POD_QUERY, RESOURCE_TREND_QUERY]) {
      for (const match of query.matchAll(/"signal", "([^"]+)"/g)) used.add(match[1]);
    }
    expect([...used].sort()).toEqual(Object.keys(KUBERNETES_SIGNALS).sort());
  });

  it("uses the namespace variable in every namespace-scoped query and none in the control plane", () => {
    for (const query of [PLACEMENT_QUERY, RESOURCE_BARS_BY_POD_QUERY, THROTTLE_BY_POD_QUERY, RESOURCE_TREND_QUERY]) {
      expect(query).toContain("{{namespace}}");
    }
    expect(CONTROL_PLANE_BARS_QUERY).not.toContain("{{namespace}}");
  });
});

describe("placement adapter", () => {
  it("reports a request ratio from counts and keeps unavailable capacity unavailable", () => {
    const data = result(
      row({ node: "n1", signal: "cpu-allocatable" }, [at(T, 4)]),
      row({ node: "n1", signal: "memory-allocatable" }, [at(T, null)]),
      row({ node: "n1", signal: "node-ready" }, [at(T, 1)]),
      row({ namespace: "a", pod: "p1", node: "n1", signal: "cpu-request" }, [at(T, 3)]),
      row({ namespace: "a", pod: "p1", node: "n1", signal: "memory-request" }, [at(T, 1)]),
    );
    const { model, issues } = placementModel(data, {});
    expect(issues).toEqual([]);
    expect(model.nodes[0].pressure).toBeCloseTo(0.75);
    expect(model.nodes[0].memoryAllocatable).toBeNull();
    expect(model.nodes[0].memoryRequested).toBe(1);
    expect(model.nodes[0].pods).toHaveLength(1);
  });

  it("lists pending pods and pods on nodes outside the returned capacity", () => {
    const data = result(
      row({ node: "n1", signal: "cpu-allocatable" }, [at(T, 4)]),
      row({ namespace: "a", pod: "pending", node: "", signal: "cpu-request" }, [at(T, 1)]),
      row({ namespace: "a", pod: "lost", node: "n9", signal: "cpu-request" }, [at(T, 1)]),
    );
    const { model } = placementModel(data, {});
    expect(model.pending.map(p => p.pod)).toEqual(["pending"]);
    expect(model.outside.map(p => p.pod)).toEqual(["lost"]);
  });

  it("sorts by pressure, caps the nodes and counts the rest", () => {
    const series: Series[] = [];
    for (let i = 0; i < 5; i++) {
      series.push(row({ node: `n${i}`, signal: "cpu-allocatable" }, [at(T, 10)]));
      series.push(row({ namespace: "a", pod: `p${i}`, node: `n${i}`, signal: "cpu-request" }, [at(T, i)]));
    }
    const { model } = placementModel(result(...series), { maxNodes: 2 });
    expect(model.nodes.map(n => n.node)).toEqual(["n4", "n3"]);
    expect(model.hiddenNodes).toBe(3);
    expect(model.totalNodes).toBe(5);
  });

  it("reports unlabelled, unknown, negative and duplicate series as issues instead of throwing", () => {
    const data = result(
      row({ node: "n1" }, [at(T, 1)]),
      row({ node: "n1", signal: "bogus" }, [at(T, 1)]),
      row({ node: "n1", signal: "cpu-allocatable" }, [at(T, -2)]),
      row({ namespace: "a", pod: "p1", node: "n1", signal: "cpu-request" }, [at(T, 1)]),
      row({ namespace: "a", pod: "p1", node: "n1", signal: "cpu-request" }, [at(T, 2)]),
    );
    const { issues } = placementModel(data, {});
    const messages = issues.map(issue => issue.message).join("\n");
    expect(messages).toContain("Each series needs a signal label, such as cpu-request.");
    expect(messages).toContain('Signal "bogus" is not used by this widget.');
    expect(messages).toContain("negative or non-finite");
    expect(messages).toContain("Duplicate cpu-request series for a/p1.");
  });

  it("rejects an unknown config key through the strict schema", () => {
    expect(() => placementModel(result(), { nope: true } as never)).toThrow();
  });
});

describe("resource bars adapter", () => {
  it("sorts by the busiest share of request, caps the groups and keeps limits only where declared", () => {
    const data = result(
      row({ pod: "hot" , signal: "cpu-usage" }, [at(T, 1.8)]),
      row({ pod: "hot" , signal: "cpu-request" }, [at(T, 2)]),
      row({ pod: "cold", signal: "cpu-usage" }, [at(T, 0.1)]),
      row({ pod: "cold", signal: "cpu-request" }, [at(T, 2)]),
      row({ pod: "cold", signal: "memory-usage" }, [at(T, null)]),
      row({ pod: "cold", signal: "memory-request" }, [at(T, 2)]),
    );
    const { model, issues } = resourceGroups(data, { maxGroups: 1 });
    expect(issues).toEqual([]);
    expect(model.groups.map(g => g.name)).toEqual(["hot"]);
    expect(model.hiddenGroups).toBe(1);
    expect(model.groups[0].cpuLimit).toBeNull();
  });

  it("keeps a missing memory usage as null, not zero", () => {
    const data = result(row({ pod: "a", signal: "memory-usage" }, [at(T, null)]), row({ pod: "a", signal: "memory-request" }, [at(T, 1)]));
    expect(resourceGroups(data, {}).model.groups[0].memoryUsage).toBeNull();
  });

  it("groups by the configured label", () => {
    const data = result(row({ container: "manager", signal: "cpu-request" }, [at(T, 1)]));
    expect(resourceGroups(data, { groupLabel: "container" }).model.groups.map(g => g.name)).toEqual(["manager"]);
    expect(resourceGroups(data, {}).issues.map(i => i.message)).toEqual(["Series cpu-request has no pod label."]);
  });
});

describe("throttle adapter", () => {
  it("keeps zero periods neutral and a missing count unavailable", () => {
    const data = result(
      row({ pod: "p", signal: "throttled" }, [at(T, 0), at(T + 60000, null)]),
      row({ pod: "p", signal: "periods" }, [at(T, 0), at(T + 60000, 300)]),
    );
    const { model, issues } = throttleCells(data, {});
    expect(issues).toEqual([]);
    const [cell0, cell1] = model.rows[0].cells;
    expect(cell0.neutral).toBe(true);
    expect(cell0.percent).toBeNull();
    expect(cell1.percent).toBeNull();
    expect(cell1.periods).toBe(300);
  });

  it("computes percent from counts and summarises rows and columns", () => {
    const data = result(
      row({ pod: "p", signal: "throttled" }, [at(T, 30)]),
      row({ pod: "p", signal: "periods" }, [at(T, 300)]),
    );
    const { model } = throttleCells(data, {});
    expect(model.rows[0].cells[0].percent).toBeCloseTo(10);
    expect(model.rows[0].percent).toBeCloseTo(10);
    expect(model.columnPercent[0]).toBeCloseTo(10);
    // One sample has no spacing to infer, so the cell has zero width and the renderer draws a minimum.
    expect(model.columns[0].start).toBeLessThanOrEqual(model.columns[0].end);
  });

  it("flags throttled counts above the periods", () => {
    const data = result(row({ pod: "p", signal: "throttled" }, [at(T, 5)]), row({ pod: "p", signal: "periods" }, [at(T, 2)]));
    expect(throttleCells(data, {}).issues.map(i => i.message)).toContain("Throttled periods exceed periods for p.");
  });
});

describe("resource strips adapter", () => {
  it("reports more than one series for a signal and never overwrites the first", () => {
    const data = result(row({ signal: "cpu-usage" }, [at(T, 1)]), row({ signal: "cpu-usage" }, [at(T, 2)]));
    const { model, issues } = resourceStrips(data, {});
    expect(issues.map(i => i.message)).toEqual(["More than one series for cpu-usage; each strip needs one."]);
    expect(model.lines["cpu-usage"]).toEqual([{ timestamp: T, value: 1 }]);
  });
});

describe("fixtures", () => {
  it("encode every family the adapters accept, with no issues, in the ready preset", () => {
    const fleet = kubernetesFleetSeries({ nodes: [], pods: [], networkRx: () => null, networkTx: () => null }, KUBERNETES_FIXTURE_OPTIONS);
    expect(fleet.placement.series).toEqual([]);
    const ready = kubernetesFixture("kubernetes-placement", "ready");
    expect(placementModel(ready.result, ready.widget.config).issues).toEqual([]);
    expect(placementModel(ready.result, {}).model.pending).toHaveLength(1);
    const bars = kubernetesFixture("kubernetes-resource-bars", "ready");
    expect(resourceGroups(bars.result, bars.widget.config).issues).toEqual([]);
    const throttle = kubernetesFixture("kubernetes-throttle-matrix", "ready");
    expect(throttleCells(throttle.result, throttle.widget.config).issues).toEqual([]);
    const trend = kubernetesFixture("kubernetes-resource-trend", "ready");
    expect(resourceStrips(trend.result, trend.widget.config).issues).toEqual([]);
  });

  it("keeps the gaps preset honest: some unavailable samples and some neutral throttle cells", () => {
    const throttle = throttleCells(kubernetesFixture("kubernetes-throttle-matrix", "gaps").result, {}).model;
    const cells = throttle.rows.flatMap(r => r.cells);
    expect(cells.some(c => c.throttled === null)).toBe(true);
    expect(cells.some(c => c.neutral)).toBe(true);
  });

  it("gives an empty result for the empty preset", () => {
    expect(kubernetesFixture("kubernetes-placement", "empty").result.series).toEqual([]);
  });
});
