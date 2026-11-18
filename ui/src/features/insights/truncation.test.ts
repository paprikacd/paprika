import { describe, expect, it } from "vitest";
import { limitFact, parseTruncation, sourceNotice, truncationNote, truncationOf } from "./truncation";

describe("truncationOf", () => {
  it("is none for a complete result, even with a reason-free empty frame", () => {
    expect(truncationOf(undefined)).toBe("none");
    expect(truncationOf({})).toBe("none");
    expect(truncationOf({ truncated: false, truncation: { reason: "row_limit" } })).toBe("none");
  });

  it.each([
    ["row_limit", "limit"],
    ["partial", "partial"],
    ["provider_warning", "warning"],
  ] as const)("maps %s to %s", (reason, kind) => {
    expect(truncationOf({ truncated: true, truncation: { reason } })).toBe(kind);
  });

  it("keeps the general notice for truncation with no reason (older backends)", () => {
    expect(truncationOf({ truncated: true })).toBe("unknown");
    expect(truncationOf({ truncated: true, truncation: { reason: "something_new" } })).toBe("unknown");
  });

  it("counts a records frame's own truncated flag", () => {
    expect(truncationOf({ records: { columns: [], rows: [], truncated: true }, truncation: { reason: "row_limit", unit: "rows" } })).toBe("limit");
  });
});

describe("limitFact and sourceNotice", () => {
  it("names the cap in its unit, in neutral copy", () => {
    expect(limitFact({ truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "traces" } })).toBe("Showing the first 100 traces · narrow the query to see others");
    expect(limitFact({ truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } })).toBe("First 100 series shown");
    expect(limitFact({ truncated: true, truncation: { reason: "row_limit", unit: "rows" } })).toBe("Source row limit reached · narrow the query to see others");
  });

  it("reads a points cap as a per-series limit, not a total", () => {
    expect(limitFact({ truncated: true, truncation: { reason: "row_limit", limit: 5000, unit: "points" } })).toBe("Up to 5,000 points per series shown");
  });

  it("gives partial, warning and unknown their own amber copy", () => {
    expect(sourceNotice("partial")).toBe("The data source returned a partial response. Narrow the query or check the data source.");
    expect(sourceNotice("warning")).toBe("The data source returned warnings for this query. Narrow the query or check the data source.");
    expect(sourceNotice("unknown")).toBe("Provider response may be incomplete. Narrow the query or check the data source.");
  });
});

describe("truncationNote", () => {
  it("is absent for a complete result", () => {
    expect(truncationNote({ truncated: false })).toBeUndefined();
  });

  it("is the neutral source row limit for a row cap, and the partial wording otherwise", () => {
    expect(truncationNote({ truncated: true, truncation: { reason: "row_limit", limit: 100, unit: "series" } })).toBe("Source row limit reached · narrow the query to see others");
    expect(truncationNote({ truncated: true, truncation: { reason: "partial" } })).toBe("Partial source response");
    expect(truncationNote({ truncated: true, truncation: { reason: "provider_warning" } })).toBe("Partial source response");
    expect(truncationNote({ truncated: true })).toBe("Provider response may be incomplete");
  });

  it("does not claim a source fault for a reason-free truncated records frame", () => {
    expect(truncationNote({ records: { columns: [], rows: [], truncated: true } })).toBe("Provider response may be incomplete");
  });
});

describe("parseTruncation", () => {
  it("keeps a known reason, limit and unit from the wire", () => {
    expect(parseTruncation({ reason: "row_limit", limit: 100, unit: "traces" })).toEqual({ reason: "row_limit", limit: 100, unit: "traces" });
  });

  it("drops an unknown reason or unit instead of trusting it", () => {
    expect(parseTruncation({ reason: "mystery" })).toBeUndefined();
    expect(parseTruncation({ reason: "row_limit", unit: "bytes", limit: Number.NaN })).toEqual({ reason: "row_limit" });
    expect(parseTruncation(null)).toBeUndefined();
  });
});
