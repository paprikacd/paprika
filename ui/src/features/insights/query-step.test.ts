import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_TARGET_POINTS, MAX_ALIGN_GRAIN_SECONDS, alignGrain, alignedWindowEnd, queryStep } from "./query-step";

type Fixture = {
  ladderSeconds: number[];
  cases: { name: string; rangeSeconds: number; targetPoints: number; minStepSeconds: number; step: number }[];
  alignCases: { name: string; rangeSeconds: number; nowSeconds: number; end: number }[];
};

// The same cases are run by the Go port (internal/querystep), so they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/query-step.json");
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("query step conformance fixtures", () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    expect(queryStep(testCase.rangeSeconds, testCase.targetPoints, testCase.minStepSeconds)).toBe(testCase.step);
  });
});

describe("query step align conformance fixtures", () => {
  it.each(fixture.alignCases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    expect(alignedWindowEnd(testCase.nowSeconds, testCase.rangeSeconds)).toBe(testCase.end);
  });

  it("caps the grain at 15 seconds", () => {
    expect(alignGrain(7 * 24 * 3600)).toBe(MAX_ALIGN_GRAIN_SECONDS);
  });
});

describe("queryStep", () => {
  it("aims at the default target for preset ranges", () => {
    expect(DEFAULT_TARGET_POINTS).toBe(300);
    // 7 days at 300 points is 2016 s, which snaps to the 30-minute rung.
    expect(queryStep(7 * 24 * 3600)).toBe(1800);
  });

  it("keeps a 15 s scrape floor on a 15-minute range", () => {
    // Without the floor the step would be 3 s, asking for ten samples per real scrape.
    expect(queryStep(15 * 60, DEFAULT_TARGET_POINTS, 15)).toBe(15);
  });

  it("moves to the next rung when the nearest one over-samples", () => {
    // 185 * 300 s over 300 points: the nearest rung is 120 s, which would hold 462 points.
    expect(queryStep(185 * 300)).toBe(300);
  });

  it("only uses ladder rungs, apart from a minimum that is off the ladder", () => {
    for (const span of [60, 900, 3600, 86400, 2592000]) {
      expect(fixture.ladderSeconds).toContain(queryStep(span));
    }
    expect(queryStep(3600, DEFAULT_TARGET_POINTS, 20)).toBe(20);
  });
});
