import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SloSourceEditor } from "./slo-source-editor";
import { SLO_DEFAULT_CONFIG } from "./plugins/slo-summary";
import { compileSloQuery } from "./slo";

afterEach(cleanup);

const valid = JSON.stringify(SLO_DEFAULT_CONFIG, null, 2);
const written = (spy: ReturnType<typeof vi.fn>) => JSON.parse(String(spy.mock.calls.at(-1)?.[0]));

describe("SloSourceEditor", () => {
  it("shows the default objective's fields without an error", () => {
    render(<SloSourceEditor config={valid} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.getByLabelText("Objective percent")).toHaveValue("99.9");
    expect(screen.getByLabelText("Total requests selector")).toHaveValue("http_requests_total");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("writes an edited total selector into the config", () => {
    const onConfig = vi.fn();
    render(<SloSourceEditor config={valid} onConfig={onConfig} onQuery={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Total requests selector"), { target: { value: "http_requests_v2_total" } });
    expect(written(onConfig)).toMatchObject({ total: "http_requests_v2_total", objective: 99.9 });
  });

  it("keeps a partly typed objective until it is a number, then commits it", () => {
    const onConfig = vi.fn();
    render(<SloSourceEditor config={valid} onConfig={onConfig} onQuery={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Objective percent"), { target: { value: "99." } });
    expect(onConfig).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Objective percent"), { target: { value: "99.95" } });
    expect(written(onConfig)).toMatchObject({ objective: 99.95 });
  });

  it("explains a bad selector in plain words", () => {
    const bad = JSON.stringify({ ...SLO_DEFAULT_CONFIG, total: "rate(http_requests_total[5m])" });
    render(<SloSourceEditor config={bad} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Use a metric name with optional label matchers");
    expect(screen.queryByText("invalid_selector")).toBeNull();
  });

  it("keeps the generated PromQL in a read-only disclosure", () => {
    render(<SloSourceEditor config={valid} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.queryByLabelText("Generated PromQL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Generated query/ }));
    expect(screen.getByLabelText("Generated PromQL").textContent).toContain("increase(http_requests_total[30d])");
  });

  it("offers the rows control only when the objective is grouped", () => {
    const { rerender } = render(<SloSourceEditor config={valid} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.queryByLabelText("Rows shown")).toBeNull();
    rerender(<SloSourceEditor config={JSON.stringify({ ...SLO_DEFAULT_CONFIG, groupBy: "service", maxRows: 4 })} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.getByLabelText("Rows shown")).toHaveValue(4);
  });

  it("resets an unparseable config to the default objective", () => {
    const onConfig = vi.fn();
    render(<SloSourceEditor config="{not json" onConfig={onConfig} onQuery={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default objective" }));
    expect(JSON.parse(String(onConfig.mock.calls[0][0]))).toEqual(SLO_DEFAULT_CONFIG);
  });

  it("stores the compiled query while the disclosure is closed, and after an objective change", () => {
    const onQuery = vi.fn();
    const { rerender } = render(<SloSourceEditor config={valid} onConfig={vi.fn()} onQuery={onQuery} />);
    expect(onQuery).toHaveBeenLastCalledWith(compileSloQuery(SLO_DEFAULT_CONFIG));
    const next = { ...SLO_DEFAULT_CONFIG, objective: 99.5 };
    rerender(<SloSourceEditor config={JSON.stringify(next)} onConfig={vi.fn()} onQuery={onQuery} />);
    expect(onQuery).toHaveBeenLastCalledWith(compileSloQuery(next));
  });

  it("explains a missing failures selector instead of the exclusive-selector text", () => {
    const withoutBad: Record<string, unknown> = { ...SLO_DEFAULT_CONFIG };
    delete withoutBad.bad;
    render(<SloSourceEditor config={JSON.stringify(withoutBad)} onConfig={vi.fn()} onQuery={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the failures selector");
    expect(screen.queryByText(/not both/)).toBeNull();
  });

  it("keeps the failures selector key while it is blank, so the source choice holds", () => {
    const onConfig = vi.fn();
    render(<SloSourceEditor config={JSON.stringify({ ...SLO_DEFAULT_CONFIG, bad: 'http_requests_total{code="5xx"}' })} onConfig={onConfig} onQuery={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Bad requests selector"), { target: { value: "" } });
    expect(written(onConfig)).toHaveProperty("bad", "");
  });

  it("drops the rows count when the grouping is cleared", () => {
    const onConfig = vi.fn();
    render(<SloSourceEditor config={JSON.stringify({ ...SLO_DEFAULT_CONFIG, groupBy: "service", maxRows: 4 })} onConfig={onConfig} onQuery={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Group by label"), { target: { value: "" } });
    expect(written(onConfig)).not.toHaveProperty("maxRows");
    expect(written(onConfig)).not.toHaveProperty("groupBy");
  });
});
