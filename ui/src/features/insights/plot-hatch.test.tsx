import { render, screen } from "@testing-library/react";
import { useId } from "react";
import { describe, expect, it } from "vitest";
import { PlotHatchDefs, PlotHatchSvg, plotHatchFill } from "./plot-hatch";

function Plot({ name }: { name: string }) {
  const id = useId();
  return (
    <svg role="img" aria-label={name} width="120" height="24">
      <PlotHatchDefs id={id} />
      <rect data-hatch-tone="missing" fill={plotHatchFill(id)} width="60" height="24" />
      <rect data-hatch-tone="warning" fill={plotHatchFill(id, "warning")} x="60" width="60" height="24" />
    </svg>
  );
}

const targetOf = (fill: Element) => fill.getAttribute("fill")!.replace(/^url\(#(.+)\)$/, "$1");

describe("plot hatching", () => {
  it("gives each plot its own patterns, and every hatched fill resolves to one of them", () => {
    render(<><Plot name="latency" /><Plot name="throughput" /></>);
    const patternIds = screen.getAllByRole("img").flatMap((plot) => [...plot.querySelectorAll("pattern")].map((pattern) => pattern.id));
    expect(patternIds).toHaveLength(4);
    expect(new Set(patternIds).size).toBe(4);
    const fills = [...document.querySelectorAll("[data-hatch-tone]")];
    expect(fills).toHaveLength(4);
    for (const fill of fills) {
      expect(patternIds).toContain(targetOf(fill));
      expect(document.getElementById(targetOf(fill))?.localName).toBe("pattern");
    }
  });

  it("keeps warning hatches on the warning token, separate from missing hatches", () => {
    render(<Plot name="latency" />);
    const stripeOf = (tone: string) => document.getElementById(targetOf(document.querySelector(`[data-hatch-tone="${tone}"]`)!))!.querySelector("line")!;
    expect(stripeOf("missing")).toHaveAttribute("stroke", "var(--gamma-chart-hatch)");
    expect(stripeOf("warning")).toHaveAttribute("stroke", "var(--gamma-warning)");
  });

  it("draws 45 degree stripes, 1.5px wide on a 6px pitch, centred so the tile edge does not clip them", () => {
    render(<svg><PlotHatchDefs id="geometry" /></svg>);
    const pattern = document.getElementById("geometry-hatch")!;
    expect(pattern).toHaveAttribute("width", "6");
    expect(pattern).toHaveAttribute("height", "6");
    expect(pattern).toHaveAttribute("patternUnits", "userSpaceOnUse");
    expect(pattern).toHaveAttribute("patternTransform", "rotate(45)");
    expect(pattern.querySelector("rect")).toHaveAttribute("fill", "var(--gamma-chart-empty)");
    const stripe = pattern.querySelector("line")!;
    expect(stripe).toHaveAttribute("x1", "0.75");
    expect(stripe).toHaveAttribute("x2", "0.75");
    expect(stripe).toHaveAttribute("stroke-width", "1.5");
  });

  it("keeps the patterns in a hidden svg, so charts that render no svg of their own can use them", () => {
    render(
      <>
        <PlotHatchSvg id="shared" />
        <svg role="img" aria-label="host"><rect fill={plotHatchFill("shared", "warning")} width="10" height="10" /></svg>
      </>,
    );
    const hidden = document.querySelector<SVGSVGElement>('svg[aria-hidden="true"]')!;
    expect(hidden).toHaveAttribute("focusable", "false");
    expect(hidden.style.position).toBe("absolute");
    expect(document.getElementById("shared-hatch")?.localName).toBe("pattern");
    expect(document.getElementById("shared-hatch-warning")?.localName).toBe("pattern");
    expect(screen.getByRole("img", { name: "host" }).querySelector("rect")).toHaveAttribute("fill", "url(#shared-hatch-warning)");
  });

  it("names the warning pattern only when the tone is warning", () => {
    expect(plotHatchFill("chart")).toBe("url(#chart-hatch)");
    expect(plotHatchFill("chart", "missing")).toBe("url(#chart-hatch)");
    expect(plotHatchFill("chart", "warning")).toBe("url(#chart-hatch-warning)");
  });
});
