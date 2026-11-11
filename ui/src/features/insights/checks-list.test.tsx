import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb";
import { ChecksList, checkCountsText, hasErrors } from "./checks-list";
import { parseCheckReport } from "./client";
import type { Dashboard } from "./schema";

// The bodies the Go handlers write (internal/insights TestCheckWireGolden), not hand-made copies.
type Golden = {
  save: Record<string, unknown> & { issues: unknown[] };
  lintDryRun: Record<string, unknown> & { issues: unknown[] };
  checkedSave: { checks: Record<string, unknown> };
};
const golden: Golden = JSON.parse(
  readFileSync(join(process.cwd(), "src/features/insights/testdata/checks-contract.golden.json"), "utf8"),
);

const dashboard = {
  widgets: [
    { id: "latency", title: "Latency" },
    { id: "requests", title: "Requests" },
    { id: "a", title: "Widget a" },
  ],
} as Pick<Dashboard, "widgets">;

function finding(overrides: Partial<ConstructorParameters<typeof CheckFinding>[0]> = {}) {
  return new CheckFinding({
    ruleId: "schema.widget.layout",
    severity: Severity.ERROR,
    source: Source.SCHEMA,
    widgetId: "requests",
    pointer: "/widgets/0/layout/w",
    message: "widget layout is outside the dashboard grid",
    fix: "Keep w from 1 to 12.",
    ...overrides,
  });
}

describe("parsing check reports from the wire", () => {
  it("reads a rejected save body with its counts", () => {
    const report = parseCheckReport(golden.save);
    expect(report).toBeInstanceOf(CheckReport);
    expect(report.issues).toHaveLength(2);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(0);
    expect(hasErrors(report)).toBe(true);
  });

  it("reads the warnings a checked save carries", () => {
    const report = parseCheckReport(golden.checkedSave.checks);
    expect(report.issues.map((issue) => issue.ruleId)).toEqual(["stat.density"]);
    expect(report.issues[0].severity).toBe(Severity.WARNING);
    expect(report.warningCount).toBe(1);
    expect(hasErrors(report)).toBe(false);
  });

  it("derives missing counts and truncation from older bodies", () => {
    const report = parseCheckReport({ issues: golden.save.issues });
    expect(report.total).toBe(2);
    expect(report.truncated).toBe(false);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(0);
    expect(report.infoCount).toBe(0);
  });

  it("keeps an unrecognised severity from failing the whole report", () => {
    const report = parseCheckReport({
      issues: [{ ruleId: "future.rule", severity: "SEVERITY_FATAL", source: "SOURCE_FUTURE", message: "m" }],
    });
    expect(report.issues[0].severity).toBe(Severity.UNSPECIFIED);
    expect(report.issues[0].source).toBe(Source.UNSPECIFIED);
    expect(report.infoCount).toBe(1);
    expect(report.errorCount).toBe(0);
  });
});

describe("ChecksList", () => {
  it("shows the counts, then errors before warnings, each with a word and a glyph", () => {
    const report = new CheckReport({
      issues: [
        finding({ severity: Severity.WARNING, ruleId: "stat.density", widgetId: "a", pointer: "/widgets/0/options/showStatBar" }),
        ...parseCheckReport(golden.save).issues,
      ],
      total: 3,
      errorCount: 2,
      warningCount: 1,
      infoCount: 0,
    });
    render(<ChecksList label="Dashboard checks" report={report} dashboard={dashboard} />);

    expect(screen.getByRole("region", { name: "Dashboard checks" })).toBeInTheDocument();
    expect(screen.getByText("2 errors, 1 warning")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 4 }).map((node) => node.textContent);
    expect(headings).toEqual(["Errors (2)", "Warnings (1)"]);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-severity", "error");
    expect(items[2]).toHaveAttribute("data-severity", "warning");
    // The word carries the meaning; the glyph is hidden from assistive technology.
    expect(within(items[0]).getByText("Error")).toBeInTheDocument();
    expect(within(items[2]).getByText("Warning")).toBeInTheDocument();
    expect(items[0].querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("names each widget by its title, reads the pointer, and states the fix", () => {
    const report = parseCheckReport(golden.save);
    render(<ChecksList label="Checks" report={report} dashboard={dashboard} />);
    const [shape, layout] = screen.getAllByRole("listitem");
    expect(within(shape).getByText("Latency")).toBeInTheDocument();
    expect(within(shape).getByText("/widgets/1/options/thresholds/1/color")).toBeInTheDocument();
    expect(within(shape).getByText("schema.widget.options")).toBeInTheDocument();
    expect(within(shape).queryByText(/Fix:/)).not.toBeInTheDocument();
    expect(within(layout).getByText("Requests")).toBeInTheDocument();
    expect(within(layout).getByText(/Keep x and y at least 0/)).toBeInTheDocument();
  });

  it("falls back to the widget id and to the whole dashboard when there is no title", () => {
    const report = new CheckReport({
      issues: [finding({ widgetId: "gone" }), finding({ widgetId: "", pointer: "", ruleId: "doc.rule" })],
      total: 2,
      errorCount: 2,
    });
    render(<ChecksList label="Checks" report={report} dashboard={dashboard} />);
    const [missing, whole] = screen.getAllByRole("listitem");
    expect(within(missing).getByText("gone")).toBeInTheDocument();
    expect(within(whole).getByText("Whole dashboard")).toBeInTheDocument();
  });

  it("says when the list is truncated, using the full counts", () => {
    const report = new CheckReport({
      issues: Array.from({ length: 32 }, (_, index) => finding({ message: `problem ${index}`, pointer: `/widgets/${index}` })),
      total: 40,
      truncated: true,
      errorCount: 40,
    });
    render(<ChecksList label="Checks" report={report} />);
    expect(screen.getByText("40 errors")).toBeInTheDocument();
    expect(screen.getByText("Showing 32 of 40 findings. Fix these and check again to see the rest.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(32);
  });

  it("reads an empty report as no findings", () => {
    render(<ChecksList label="Checks" report={new CheckReport({ total: 0 })} />);
    expect(checkCountsText(new CheckReport({ total: 0 }))).toBe("No findings");
    expect(screen.getByText("No findings")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("offers a focus button per widget finding, reached and activated from the keyboard", async () => {
    const user = userEvent.setup();
    const onFocusWidget = vi.fn();
    const report = parseCheckReport(golden.save);
    render(<ChecksList label="Checks" report={report} dashboard={dashboard} onFocusWidget={onFocusWidget} />);

    const latency = screen.getByRole("button", { name: "Show widget Latency" });
    const requests = screen.getByRole("button", { name: "Show widget Requests" });
    await user.tab();
    expect(latency).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onFocusWidget).toHaveBeenLastCalledWith("latency");
    await user.tab();
    expect(requests).toHaveFocus();
    await user.keyboard(" ");
    expect(onFocusWidget).toHaveBeenLastCalledWith("requests");
    expect(onFocusWidget).toHaveBeenCalledTimes(2);
  });

  it("offers no focus button without a callback or for a widget the dashboard does not have", () => {
    const report = new CheckReport({ issues: [finding({ widgetId: "gone" })], total: 1, errorCount: 1 });
    const { rerender } = render(<ChecksList label="Checks" report={report} dashboard={dashboard} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<ChecksList label="Checks" report={report} dashboard={dashboard} onFocusWidget={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
