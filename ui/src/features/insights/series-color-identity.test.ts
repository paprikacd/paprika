import { describe, expect, it } from "vitest";
import { seriesRole, seriesSlot, SERIES_ROLE_SLOT } from "./series-palette";
import { assignSeriesColors, fnv1a32, seriesIdentity, wellKnownSeriesRole, type SeriesColorRule, type SeriesColorSubject } from "./series-colors";
import { displaySeriesNames } from "./series-display";
import { seriesName, type Series } from "./chart-data";
import { PALETTE } from "./chart-renderer-shared";

const named = (name: string, labels: Record<string, string> = { service: name }): SeriesColorSubject => ({ name, labels });
const colorOf = (subjects: SeriesColorSubject[], input = {}) => assignSeriesColors(subjects, input).map(choice => choice.color);
/** Colour by identity, so an assertion does not depend on the order subjects were passed in. */
const byName = (subjects: SeriesColorSubject[], input = {}) => Object.fromEntries(subjects.map((subject, index) => [seriesIdentity(subject), assignSeriesColors(subjects, input)[index].color]));
const home = (name: string) => fnv1a32(name) % 8;
/** A name whose FNV-1a home slot is the given slot. */
const nameWithHome = (slot: number, prefix = "svc") => Array.from({ length: 200 }, (_, index) => `${prefix}-${index}`).find(name => home(name) === slot)!;

describe("FNV-1a identity hash", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("is deterministic and hashes the UTF-8 bytes of the identity", () => {
    expect(fnv1a32("checkout")).toBe(fnv1a32("checkout"));
    expect(fnv1a32("café")).not.toBe(fnv1a32("cafe"));
  });

  it("pins the home slots of the names the Insights fixtures use", () => {
    expect(["catalog", "checkout", "worker", "1h", "6h", "24h", "inbound", "outbound", "search", "notifications"].map(home)).toEqual([0, 1, 7, 4, 3, 1, 6, 5, 1, 7]);
  });
});

describe("series identity", () => {
  it("is the series name, the full name series-display starts from", () => {
    expect(seriesIdentity({ name: "checkout", labels: { service: "checkout" } })).toBe("checkout");
    expect(seriesIdentity({ name: "prod · checkout", labels: {} })).toBe("prod · checkout");
  });

  it("falls back to the labels, sorted, when a series has no name", () => {
    expect(seriesIdentity({ name: "", labels: { zone: "b", app: "a" } })).toBe("app=a, zone=b");
    expect(seriesIdentity({ labels: {} })).toBe("");
  });

  it("agrees with the name the series reads when that name is not generated", () => {
    const entry: Series = { name: "checkout", labels: { service: "checkout" }, points: [] };
    expect(seriesIdentity(entry)).toBe(seriesName(entry, 4));
  });
});

describe("name mode assignment", () => {
  it("gives a lone series its identity slot", () => {
    expect(colorOf([named("checkout")])).toEqual([seriesSlot(1)]);
    expect(colorOf([named("catalog")])).toEqual([seriesSlot(0)]);
  });

  it("never depends on provider order", () => {
    const services = ["catalog", "checkout", "worker", "frontend", "api", "search", "cache"].map(name => named(name));
    const expected = byName(services);
    for (let rotation = 0; rotation < services.length; rotation++) {
      const shuffled = [...services.slice(rotation), ...services.slice(0, rotation)].toReversed();
      expect(byName(shuffled)).toEqual(expected);
    }
  });

  it("steps a clashing series to the next free slot, in identity order", () => {
    // checkout and search both hash to slot 1. checkout comes first in identity order, so it keeps slot 1.
    expect(colorOf([named("checkout"), named("search")])).toEqual([seriesSlot(1), seriesSlot(2)]);
    expect(colorOf([named("search"), named("checkout")])).toEqual([seriesSlot(2), seriesSlot(1)]);
  });

  it("repeats no colour while slots remain", () => {
    const eight = Array.from({ length: 8 }, (_, index) => named(`svc-${index}`));
    expect(new Set(colorOf(eight)).size).toBe(8);
  });

  it("uses every slot once and then repeats, when there are more series than slots", () => {
    const nine = Array.from({ length: 9 }, (_, index) => named(`svc-${index}`));
    const colors = colorOf(nine);
    expect(new Set(colors).size).toBe(8);
    expect(colors.every(color => PALETTE.includes(color))).toBe(true);
  });

  it("gives series that share a name and labels distinct colours, decided by their labels", () => {
    const first = { name: "Value", labels: { pod: "a" } }, second = { name: "Value", labels: { pod: "b" } };
    expect(colorOf([first, second])[0]).not.toBe(colorOf([first, second])[1]);
    expect(colorOf([first, second])).toEqual(colorOf([second, first]).toReversed());
  });

  it("keeps a series' slot when its neighbours change, as long as it does not clash", () => {
    const alone = byName([named("checkout")]);
    const crowded = byName([named("catalog"), named("checkout"), named("worker")]);
    expect(crowded.checkout).toBe(alone.checkout);
    expect(crowded.checkout).toBe(seriesSlot(1));
  });
});

describe("precedence", () => {
  it("lets an authored hex rule beat a well-known label and the widget colour", () => {
    const rules: SeriesColorRule[] = [{ label: "status", value: "500", color: "#123456" }];
    expect(colorOf([{ name: "", labels: { status: "500" } }], { rules, widgetColor: "#aa1122" })).toEqual(["#123456"]);
  });

  it("lets an authored role rule beat a well-known label", () => {
    const rules: SeriesColorRule[] = [{ label: "status", value: "500", role: "traffic" }];
    expect(colorOf([{ name: "", labels: { status: "500" } }], { rules })).toEqual([seriesRole("traffic")]);
  });

  it("gives a well-known label its role before the hashed slot", () => {
    expect(colorOf([{ name: "", labels: { status: "503" } }])).toEqual([seriesRole("server-error")]);
  });

  it("gives the widget colour to the first series in identity order, when nothing else names it", () => {
    expect(colorOf([named("worker"), named("api")], { widgetColor: "#aa1122" })).toEqual([seriesSlot(7), "#aa1122"]);
  });

  it("gives a lone series the widget colour, ahead of its hashed slot", () => {
    expect(colorOf([named("checkout")], { widgetColor: "#aa1122" })).toEqual(["#aa1122"]);
  });

  it("does not let the widget colour override a series a rule or label names", () => {
    const subjects = [{ name: "", labels: { quantile: "0.95" } }, named("worker")];
    const colors = colorOf(subjects, { widgetColor: "#aa1122" });
    expect(colors[0]).toBe(seriesRole("p95"));
    expect(colors[1]).toBe(seriesSlot(7));
  });

  it("keeps a hashed series off a slot a role claims", () => {
    const slot = SERIES_ROLE_SLOT.p99 - 1;
    const hashed = nameWithHome(slot);
    expect(colorOf([named(hashed), { name: "", labels: { quantile: "0.99" } }])).toEqual([seriesSlot(slot + 1), seriesRole("p99")]);
  });
});

describe("well-known labels", () => {
  it.each([
    [{ status: "200" }, "success"],
    [{ status: "204" }, "success"],
    [{ status: "2xx" }, "success"],
    [{ status_code: "404" }, "client-error"],
    [{ http_status: "429" }, "client-error"],
    [{ http_status_code: "4XX" }, "client-error"],
    [{ response_code: "500" }, "server-error"],
    [{ status: "503" }, "server-error"],
    [{ status: "5xx" }, "server-error"],
    [{ quantile: "0.5" }, "p50"],
    [{ quantile: "0.50" }, "p50"],
    [{ quantile: "0.95" }, "p95"],
    [{ quantile: "0.99" }, "p99"],
    [{ percentile: "50" }, "p50"],
    [{ percentile: "95" }, "p95"],
    [{ percentile: "99" }, "p99"],
    [{ quantile: "p95" }, "p95"],
    [{ quantile: "P99" }, "p99"],
    [{ percentile: "p50" }, "p50"],
  ])("recognises %j as %s", (labels, role) => {
    expect(wellKnownSeriesRole(labels)).toBe(role);
  });

  it.each<Record<string, string>>([
    { status: "301" },
    { status: "100" },
    { status: "5000" },
    { status: "abc" },
    { code: "500" },
    { quantile: "0.9" },
    { percentile: "90" },
    { quantile: "p90" },
    { le: "0.5" },
    { service: "checkout" },
  ])("does not give %j a role", labels => {
    expect(wellKnownSeriesRole(labels)).toBeUndefined();
  });

  it("reads only labels, never a series name", () => {
    expect(wellKnownSeriesRole({})).toBeUndefined();
    expect(colorOf([named("checkout_p99", {})])).toEqual([seriesSlot(home("checkout_p99"))]);
  });

  it("takes the first recognised status key in a fixed order, whatever the object's key order", () => {
    expect(wellKnownSeriesRole({ http_status: "500", status: "200" })).toBe("success");
    expect(wellKnownSeriesRole({ status: "200", http_status: "500" })).toBe("success");
  });
});

describe("index mode", () => {
  it("keeps the position slots, wrapping after eight", () => {
    const subjects = Array.from({ length: 10 }, (_, index) => named(`svc-${index}`));
    expect(colorOf(subjects, { mode: "index" })).toEqual(subjects.map((_, index) => seriesSlot(index)));
  });

  it("gives the widget colour to the first position and an authored rule its rule", () => {
    const subjects = [named("checkout"), named("worker"), named("catalog")];
    const rules: SeriesColorRule[] = [{ label: "service", value: "worker", color: "#15c7a1" }];
    expect(colorOf(subjects, { mode: "index", rules, widgetColor: "#aa1122" })).toEqual(["#aa1122", "#15c7a1", seriesSlot(2)]);
  });

  it("ignores well-known labels, as the position slots always did", () => {
    expect(colorOf([{ name: "", labels: { status: "500" } }], { mode: "index" })).toEqual([seriesSlot(0)]);
  });

  it("depends on order, which is the point of the mode", () => {
    const subjects = [named("checkout"), named("worker")];
    expect(colorOf(subjects, { mode: "index" })).not.toEqual(colorOf(subjects.toReversed(), { mode: "index" }).toReversed());
  });

  it("is the default only when name mode is not chosen", () => {
    const subjects = [named("worker")];
    expect(colorOf(subjects, { mode: undefined })).toEqual(colorOf(subjects, { mode: "name" }));
    expect(colorOf(subjects, { mode: "index" })).toEqual([seriesSlot(0)]);
  });
});

describe("cross-widget stability", () => {
  it("gives one service the same colour in two widgets when neither clashes", () => {
    const overview = byName([named("catalog"), named("checkout"), named("worker")]);
    const budget = byName([named("checkout")]);
    expect(budget.checkout).toBe(overview.checkout);
  });

  it("is a function of identity, not of how many series a widget shows", () => {
    const wide = Array.from({ length: 3 }, (_, index) => named(`svc-${index}`));
    expect(byName(wide.slice(0, 1))["svc-0"]).toBe(byName(wide)["svc-0"]);
  });

  it("keeps a series named by a rule the same colour in another widget with the same rules", () => {
    const rules: SeriesColorRule[] = [{ label: "window", value: "1h", color: "#348cf0" }];
    expect(byName([{ name: "1h", labels: { window: "1h" } }], { rules })["1h"]).toBe("#348cf0");
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
});
