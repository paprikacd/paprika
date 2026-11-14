import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { SeriesColorEditor } from "./series-color-editor";

function Form({ initial = {} }: { initial?: Record<string, unknown> }) {
  const [config, setConfig] = useState<Record<string, unknown>>(initial);
  return <><SeriesColorEditor config={config} onChange={setConfig} /><output aria-label="Saved configuration">{JSON.stringify(config)}</output></>;
}
const saved = () => JSON.parse(screen.getByLabelText("Saved configuration").textContent!) as { seriesColors?: Record<string, unknown>[] };
const pick = (name: string, option: string) => {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(screen.getByRole("option", { name: option }));
};

describe("series colour editor sources", () => {
  const roleRule = { seriesColors: [{ label: "quantile", value: "p95", role: "p95" }] };

  it("shows a role-only rule as its role, with no empty colour field", () => {
    render(<Form initial={roleRule} />);
    expect(screen.getByRole("combobox", { name: "Color rule 1 source" })).toHaveTextContent("Role: p95");
    expect(screen.queryByRole("textbox", { name: "Color rule 1 color" })).not.toBeInTheDocument();
  });

  it("switches a role rule to a hex colour and drops the role key", () => {
    render(<Form initial={roleRule} />);
    pick("Color rule 1 source", "Hex colour");
    expect(saved().seriesColors![0]).toEqual({ label: "quantile", value: "p95", color: "#00cee2" });
    expect(Object.keys(saved().seriesColors![0]!)).not.toContain("role");
    fireEvent.change(screen.getByRole("textbox", { name: "Color rule 1 color" }), { target: { value: "#123456" } });
    expect(saved().seriesColors![0]).toEqual({ label: "quantile", value: "p95", color: "#123456" });
  });

  it("switches a hex rule to a role and drops the colour key", () => {
    render(<Form initial={{ seriesColors: [{ label: "quantile", value: "p50", color: "#8f9e54" }] }} />);
    pick("Color rule 1 source", "Role: p50");
    expect(saved().seriesColors![0]).toEqual({ label: "quantile", value: "p50", role: "p50" });
    expect(Object.keys(saved().seriesColors![0]!)).not.toContain("color");
  });
});
