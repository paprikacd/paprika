import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSloQuery, evaluateSlo, SloConfigError, sloStep, validateSloConfig, type SloConfig } from "./slo";
import type { QueryResult } from "./schema";

type SloCase = {
  name: string;
  kind: "compile" | "step" | "evaluate";
  config?: unknown;
  start?: number;
  end?: number;
  result?: QueryResult;
  expected: Record<string, unknown>;
};

// The shared cases are also run by the Go port, so they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/slo.json");
const fixture: { cases: SloCase[] } = JSON.parse(readFileSync(fixturePath, "utf8"));

/**
 * Fields absent from expected are not checked. Arrays must have the same length. Numbers match within 1e-9 relative, and
 * null matches null. The Go runner applies the same rules.
 */
function partialMatch(actual: unknown, expected: unknown, path = "$"): string | undefined {
  if (expected === null) return actual === null ? undefined : `${path}: ${JSON.stringify(actual)} != null`;
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))
      ? undefined
      : `${path}: ${JSON.stringify(actual)} != ${expected}`;
  }
  if (typeof expected !== "object") return actual === expected ? undefined : `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: length ${JSON.stringify(actual)} vs ${expected.length}`;
    for (let index = 0; index < expected.length; index++) {
      const mismatch = partialMatch(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  for (const key of Object.keys(expected)) {
    const mismatch = partialMatch((actual as Record<string, unknown> | undefined)?.[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    if (mismatch) return mismatch;
  }
  return undefined;
}

describe("slo conformance fixtures", () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    if (testCase.kind === "compile") {
      const error = validateSloConfig(testCase.config) ?? null;
      let actual: unknown = error;
      if (error === null) {
        try {
          const query = compileSloQuery(testCase.config as SloConfig);
          if ("query" in testCase.expected) {
            expect(query).toBe(testCase.expected.query);
            return;
          }
        } catch (caught) {
          if (!(caught instanceof SloConfigError)) throw caught;
          actual = caught.code;
        }
      }
      if ("error" in testCase.expected) expect(actual).toEqual(testCase.expected.error);
      return;
    }
    if (testCase.kind === "step") {
      expect(sloStep(testCase.start ?? 0, testCase.end ?? 0)).toBe(testCase.expected.step);
      return;
    }
    const error = validateSloConfig(testCase.config);
    expect(error).toBeUndefined();
    const evaluation = JSON.parse(JSON.stringify(evaluateSlo(testCase.config as SloConfig, testCase.result ?? {}))) as unknown;
    expect(partialMatch(evaluation, testCase.expected)).toBeUndefined();
  });
});

describe("slo config validation", () => {
  it("rejects a non-object config before reading its fields", () => {
    expect(validateSloConfig("30d")).toBe("invalid_config");
  });

  it("names the first failing field in the order the Go port checks them", () => {
    expect(validateSloConfig({ objective: 49, period: "90d", total: "x" })).toBe("invalid_objective");
  });
});
