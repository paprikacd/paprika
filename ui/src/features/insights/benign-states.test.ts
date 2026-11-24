import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_INCOMPLETE, EMPTY_RANGE, NO_DATA, PARTIAL_CHIP, seriesShown, staleChip, staleDetail } from "./benign-states";

describe("benign state copy", () => {
  it("words a series cap one way", () => {
    expect(seriesShown(12, 13)).toBe("Showing 12 of 13 series");
    expect(seriesShown(100, 150)).toBe("Showing 100 of 150 series");
  });

  it("keeps the stale chip and its sentence together", () => {
    expect(staleChip("3 h")).toBe("Stale · 3 h");
    expect(staleDetail("3 h")).toBe("Last valid sample: 3 h before range end.");
  });

  it("holds the empty and partial strings", () => {
    expect(NO_DATA).toBe("No data");
    expect(PARTIAL_CHIP).toBe("Partial");
    expect(EMPTY_RANGE.title).toBe("No data in this time range");
    expect(EMPTY_INCOMPLETE.title).toBe("No observations returned");
  });
});

// Each benign state has one home. Host code imports these strings rather than writing them, so a state reads the same
// in every chart. The two copy modules are the only files allowed to spell them out.
describe("benign state scan", () => {
  const root = join(process.cwd(), "src/features/insights");
  const copyModules = new Set(["benign-states.ts", "truncation.ts"]);
  const forbidden = [
    /["'`]No data/, />No data</, /Stale · /, /series not shown/, /First \d+ of/, /First \{[A-Za-z_]+\} of/,
    // A series cap written out in JSX or a template instead of seriesShown().
    /Showing (\{[^}]+\}|\$\{[^}]+\}|\d+) of (\{[^}]+\}|\$\{[^}]+\}|\d+) series/,
  ];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "testdata" ? [] : sourceFiles(path);
      if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name) || copyModules.has(entry.name)) return [];
      return [path];
    });
  }

  it("keeps the spelled-out states in the copy modules", () => {
    const offenders = sourceFiles(root).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${path.slice(root.length + 1)}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});
