import { describe, expect, it } from "vitest";
import { seriesRole, seriesSlot, SERIES_ROLE_SLOT } from "./series-palette";
import { assignSeriesColors, fnv1a32, identitySlot, isGenericSeries, seriesIdentity, wellKnownSeriesRole, type SeriesColorRule, type SeriesColorSubject } from "./series-colors";
import { displaySeriesNames } from "./series-display";
import { seriesName, type Series } from "./chart-data";
import { PALETTE } from "./chart-renderer-shared";

// Subjects use the names Prometheus returns for a labelled series, e.g. {service="checkout"}, so the tests exercise
// the identity the provider path produces, not a bare name.
const promName = (labels: Record<string, string>) => `{${Object.keys(labels).sort().map(key => `${key}=${JSON.stringify(labels[key])}`).join(", ")}}`;
const svc = (service: string): SeriesColorSubject => ({ name: promName({ service }), labels: { service } });
const colorOf = (subjects: SeriesColorSubject[], input = {}) => assignSeriesColors(subjects, input).map(choice => choice.color);
/** The colour of each series keyed by its identity, so an assertion does not depend on the order subjects were passed in. */
const byIdentity = (subjects: SeriesColorSubject[], input = {}) => {
  const choices = assignSeriesColors(subjects, input);
  return Object.fromEntries(subjects.map((subject, index) => [seriesIdentity(subject), choices[index].color]));
};
/** The home slot of a service, as the series' identity hashes it. */
const home = (service: string) => identitySlot(`service=${service}`);

describe("FNV-1a and the identity slot", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("pins the slots of realistic identities", () => {
    expect(["service=catalog", "service=checkout", "service=worker", "service=search", "service=notifications", "service=api"].map(identitySlot)).toEqual([1, 6, 3, 0, 1, 4]);
  });

  it("separates the low-bit twins that FNV-1a's % 8 alone merged", () => {
    expect(["pod-a", "pod-i", "pod-q", "pod-y"].map(identitySlot)).toEqual([4, 1, 7, 6]);
    expect(identitySlot("node-0")).not.toBe(identitySlot("node-8"));
  });

  it("is deterministic", () => {
    expect(identitySlot("service=checkout")).toBe(identitySlot("service=checkout"));
  });
});

describe("series identity", () => {
  it("is the labels without __name__, so a Prometheus series and a record group with the same label match", () => {
    const prometheus = { name: '{service="checkout"}', labels: { __name__: "http_requests", service: "checkout" } };
    const record = { name: "requests", labels: { service: "checkout" } };
    expect(seriesIdentity(prometheus)).toBe("service=checkout");
    expect(seriesIdentity(prometheus)).toBe(seriesIdentity(record));
  });

  it("sorts its labels, so label order cannot change it", () => {
    expect(seriesIdentity({ labels: { zone: "b", app: "a" } })).toBe("app=a, zone=b");
  });

  it("falls back to the name when a series has no labels besides __name__", () => {
    expect(seriesIdentity({ name: "checkout", labels: {} })).toBe("checkout");
    expect(seriesIdentity({ name: "up", labels: { __name__: "up" } })).toBe("up");
    expect(seriesIdentity({ name: "prod · checkout", labels: {} })).toBe("prod · checkout");
  });

  it("recognises unlabelled generic series only", () => {
    expect(["Value", "Series 3", ""].map(name => isGenericSeries({ name }))).toEqual([true, true, true]);
    expect(isGenericSeries({ labels: {} })).toBe(true);
    expect(isGenericSeries({ name: "Value", labels: { pod: "a" } })).toBe(false);
    expect(isGenericSeries({ name: "checkout", labels: {} })).toBe(false);
  });
});

describe("generic series", () => {
  it("draw the first slot, whatever their name", () => {
    expect(colorOf([{ name: "Value", labels: {} }])).toEqual([seriesSlot(0)]);
    expect(colorOf([{ name: "Series 4", labels: {} }])).toEqual([seriesSlot(0)]);
    expect(colorOf([{ name: "", labels: {} }])).toEqual([seriesSlot(0)]);
  });

  it("keep hashed series off the first slot when they share a widget with one", () => {
    const colors = colorOf([{ name: "Value", labels: {} }, svc("search")]);
    expect(colors[0]).toBe(seriesSlot(0));
    expect(colors[1]).not.toBe(seriesSlot(0));
  });

  it("let a widget colour override them when the widget draws one series", () => {
    expect(colorOf([{ name: "Value", labels: {} }], { widgetColor: "#aa1122" })).toEqual(["#aa1122"]);
  });
});

describe("name mode assignment", () => {
  it("gives a lone series its identity slot", () => {
    expect(colorOf([svc("checkout")])).toEqual([seriesSlot(6)]);
    expect(colorOf([svc("catalog")])).toEqual([seriesSlot(1)]);
  });

  it("never depends on provider order", () => {
    const services = ["catalog", "checkout", "worker", "frontend", "api", "search", "cart"].map(svc);
    const expected = byIdentity(services);
    for (let rotation = 0; rotation < services.length; rotation++) {
      const shuffled = [...services.slice(rotation), ...services.slice(0, rotation)].toReversed();
      expect(byIdentity(shuffled)).toEqual(expected);
    }
  });

  it("steps a clashing series to the next free slot, in identity order", () => {
    // catalog and notifications share home slot 1. catalog sorts first, so it keeps slot 1 and notifications steps to 2.
    expect(home("catalog")).toBe(home("notifications"));
    expect(colorOf([svc("catalog"), svc("notifications")])).toEqual([seriesSlot(1), seriesSlot(2)]);
    expect(colorOf([svc("notifications"), svc("catalog")])).toEqual([seriesSlot(2), seriesSlot(1)]);
  });

  it("repeats no colour while slots remain", () => {
    const eight = ["api", "auth", "cart", "catalog", "checkout", "frontend", "gateway", "inventory"].map(svc);
    expect(new Set(colorOf(eight)).size).toBe(8);
  });

  it("uses every slot and then repeats, when there are more series than slots", () => {
    const nine = [...["api", "auth", "cart", "catalog", "checkout", "frontend", "gateway", "inventory"].map(svc), svc("worker")];
    const colors = colorOf(nine);
    expect(new Set(colors).size).toBe(8);
    expect(colors.every(color => PALETTE.includes(color))).toBe(true);
  });

  it("keeps a series at its home slot when no other series in the widget shares or takes it", () => {
    // Homes 6, 3 and 1 are distinct and no role or generic series is present, so each series draws its home slot
    // whichever other series are present.
    const trio = [svc("checkout"), svc("worker"), svc("catalog")];
    expect(byIdentity(trio)).toEqual({ "service=checkout": seriesSlot(6), "service=worker": seriesSlot(3), "service=catalog": seriesSlot(1) });
    expect(byIdentity([svc("checkout"), svc("worker")])["service=checkout"]).toBe(seriesSlot(6));
    expect(byIdentity([svc("checkout")])["service=checkout"]).toBe(seriesSlot(6));
  });

  it("gives the same colour to one service in two widgets when neither widget clashes on it", () => {
    const overview = byIdentity([svc("catalog"), svc("checkout"), svc("worker")]);
    const budget = byIdentity([svc("checkout"), svc("payments")]);
    expect(budget["service=checkout"]).toBe(overview["service=checkout"]);
  });

  it("gives series that differ only by metric name distinct colours, in the same order whichever comes first", () => {
    const requests = { name: 'http_requests{service="checkout"}', labels: { __name__: "http_requests", service: "checkout" } };
    const latency = { name: 'latency{service="checkout"}', labels: { __name__: "latency", service: "checkout" } };
    const colors = colorOf([requests, latency]);
    expect(colors[0]).not.toBe(colors[1]);
    expect(colorOf([latency, requests])).toEqual(colors.toReversed());
  });
});

describe("precedence", () => {
  it("lets an authored hex rule beat a well-known label and the widget colour", () => {
    const rules: SeriesColorRule[] = [{ label: "status_code", value: "5xx", color: "#123456" }];
    expect(colorOf([{ name: "", labels: { status_code: "5xx" } }], { rules, widgetColor: "#aa1122" })).toEqual(["#123456"]);
  });

  it("lets an authored role rule beat a well-known label", () => {
    const rules: SeriesColorRule[] = [{ label: "status_code", value: "5xx", role: "traffic" }];
    expect(colorOf([{ name: "", labels: { status_code: "5xx" } }], { rules })).toEqual([seriesRole("traffic")]);
  });

  it("gives a status class its role before the hashed slot", () => {
    expect(colorOf([{ name: "", labels: { status: "5xx" } }])).toEqual([seriesRole("server-error")]);
  });

  it("gives the widget colour to a single-series widget ahead of its hashed slot", () => {
    expect(colorOf([svc("checkout")], { widgetColor: "#aa1122" })).toEqual(["#aa1122"]);
  });

  it("does not apply the widget colour to a multi-series widget", () => {
    expect(colorOf([svc("catalog"), svc("checkout")], { widgetColor: "#aa1122" })).toEqual([seriesSlot(1), seriesSlot(6)]);
  });

  it("does not let the widget colour override a series a role names", () => {
    expect(colorOf([{ name: "", labels: { status: "5xx" } }], { widgetColor: "#aa1122" })).toEqual([seriesRole("server-error")]);
  });

  it("keeps a hashed series off a slot a role claims", () => {
    // api's home is slot 4, which the p99 role claims (SERIES_ROLE_SLOT.p99 - 1), so api steps to slot 5.
    expect(SERIES_ROLE_SLOT.p99 - 1).toBe(4);
    expect(colorOf([svc("api"), { name: "", labels: { quantile: "0.99" } }])).toEqual([seriesSlot(5), seriesRole("p99")]);
  });
});

describe("well-known labels", () => {
  it.each([
    [{ status: "2xx" }, "success"],
    [{ status_code: "4xx" }, "client-error"],
    [{ http_status: "5XX" }, "server-error"],
    [{ http_status_code: "5xx" }, "server-error"],
    [{ response_code: "5xx" }, "server-error"],
    [{ quantile: "0.5" }, "p50"],
    [{ quantile: "0.50" }, "p50"],
    [{ quantile: "0.95" }, "p95"],
    [{ quantile: "0.99" }, "p99"],
    [{ quantile: "p95" }, "p95"],
    [{ quantile: "P99" }, "p99"],
    [{ percentile: "50" }, "p50"],
    [{ percentile: "p50" }, "p50"],
  ])("recognises %j as %s", (labels, role) => {
    expect(wellKnownSeriesRole(labels)).toBe(role);
  });

  it.each<Record<string, string>>([
    { status: "200" },
    { status: "201" },
    { status: "404" },
    { status: "500" },
    { status: "503" },
    { status: "301" },
    { status: "5000" },
    { status: "abc" },
    { status: "6xx" },
    { code: "500" },
    { quantile: "0.9" },
    { percentile: "90" },
    { quantile: "p90" },
    { le: "0.5" },
    { service: "checkout" },
  ])("does not give %j a role", labels => {
    expect(wellKnownSeriesRole(labels)).toBeUndefined();
  });

  it("keeps distinct numeric status codes distinct in one widget", () => {
    const codes = ["200", "201", "404", "429", "500", "503"].map(code => ({ name: promName({ status_code: code }), labels: { status_code: code } }));
    const colors = colorOf(codes);
    expect(new Set(colors).size).toBe(codes.length);
    // No code takes a status role: the role colours never appear.
    expect(colors).not.toContain(seriesRole("server-error"));
    expect(colors).not.toContain(seriesRole("success"));
    expect(colors).not.toContain(seriesRole("client-error"));
  });

  it("reads only labels, never a series name", () => {
    expect(wellKnownSeriesRole({})).toBeUndefined();
    expect(colorOf([{ name: "checkout_p99", labels: {} }])).toEqual([seriesSlot(identitySlot("checkout_p99"))]);
  });

  it("takes the first recognised class key in a fixed order, whatever the object's key order", () => {
    expect(wellKnownSeriesRole({ http_status: "5xx", status: "2xx" })).toBe("success");
    expect(wellKnownSeriesRole({ status: "2xx", http_status: "5xx" })).toBe("success");
  });
});

describe("index mode", () => {
  it("keeps the position slots, wrapping after eight", () => {
    const subjects = Array.from({ length: 10 }, (_, index) => svc(`svc-${index}`));
    expect(colorOf(subjects, { mode: "index" })).toEqual(subjects.map((_, index) => seriesSlot(index)));
  });

  it("gives the widget colour to the first position and an authored rule its rule", () => {
    const subjects = [svc("checkout"), svc("worker"), svc("catalog")];
    const rules: SeriesColorRule[] = [{ label: "service", value: "worker", color: "#15c7a1" }];
    expect(colorOf(subjects, { mode: "index", rules, widgetColor: "#aa1122" })).toEqual(["#aa1122", "#15c7a1", seriesSlot(2)]);
  });

  it("ignores well-known labels, as the position slots always did", () => {
    expect(colorOf([{ name: "", labels: { status: "5xx" } }], { mode: "index" })).toEqual([seriesSlot(0)]);
  });

  it("depends on order, which is the point of the mode", () => {
    const subjects = [svc("checkout"), svc("worker")];
    expect(colorOf(subjects, { mode: "index" })).not.toEqual(colorOf(subjects.toReversed(), { mode: "index" }).toReversed());
  });
});

describe("display names do not decide identity", () => {
  it("keeps the colour when series-display shortens the label", () => {
    const series: Series[] = [
      { name: "prod · checkout", labels: {}, points: [] },
      { name: "prod · worker", labels: {}, points: [] },
    ];
    expect(displaySeriesNames(series)).toEqual(["checkout", "worker"]);
    expect(colorOf(series.map(entry => ({ name: entry.name, labels: entry.labels })))).toEqual(colorOf([{ name: "prod · checkout" }, { name: "prod · worker" }]));
  });

  it("names a labelled series by its labels, not by series-display's name", () => {
    const entry: Series = { name: '{service="checkout"}', labels: { service: "checkout" }, points: [] };
    expect(seriesName(entry, 0)).toBe('{service="checkout"}');
    expect(seriesIdentity(entry)).toBe("service=checkout");
  });
});
