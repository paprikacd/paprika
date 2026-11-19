import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObservationTooltip } from "./observation-tooltip";
import { TOOLTIP_PIN_HINT_OPEN, TOOLTIP_PIN_HINT_PINNED, TooltipPinHint, tooltipPinHint } from "./tooltip-content";

afterEach(cleanup);

// One pin vocabulary: the open and pinned copy, then the keyboard and touch dismissal guidance, in this order.
describe("TooltipPinHint instructions", () => {
  it("says how to keep the panel open, then how to close it once pinned", () => {
    expect(TOOLTIP_PIN_HINT_OPEN).toBe("Click, tap or press Enter to keep open");
    expect(TOOLTIP_PIN_HINT_PINNED).toBe("Pinned · select again to close");
    expect(tooltipPinHint(false)).toBe(TOOLTIP_PIN_HINT_OPEN);
    expect(tooltipPinHint(true)).toBe(TOOLTIP_PIN_HINT_PINNED);
  });

  it("renders the pin copy before the dismissal instructions", () => {
    const { container, rerender } = render(<TooltipPinHint pinned={false} />);
    const footer = container.firstElementChild!;
    const text = footer.textContent ?? "";
    expect(text.indexOf(TOOLTIP_PIN_HINT_OPEN)).toBe(0);
    expect(text.indexOf("Page Up/Down to scroll")).toBeGreaterThan(TOOLTIP_PIN_HINT_OPEN.length - 1);
    expect(text.indexOf("Swipe to scroll")).toBeGreaterThan(text.indexOf("Esc to close"));
    expect(screen.getByText(TOOLTIP_PIN_HINT_OPEN)).toBeInTheDocument();
    rerender(<TooltipPinHint pinned />);
    expect(screen.getByText(TOOLTIP_PIN_HINT_PINNED)).toBeInTheDocument();
    expect(screen.queryByText(TOOLTIP_PIN_HINT_OPEN)).not.toBeInTheDocument();
  });

  it("is rendered by ObservationTooltip by default, and only opts out with pinHint={false}", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const { unmount } = render(<ObservationTooltip id="with-hint" anchor={anchor} onDismiss={() => undefined}>Reading</ObservationTooltip>);
    expect(screen.getByText(TOOLTIP_PIN_HINT_OPEN)).toBeInTheDocument();
    unmount();
    render(<ObservationTooltip id="without-hint" anchor={anchor} pinHint={false} onDismiss={() => undefined}>Reading</ObservationTooltip>);
    expect(screen.queryByText(TOOLTIP_PIN_HINT_OPEN)).not.toBeInTheDocument();
    expect(screen.getByText("Reading")).toBeInTheDocument();
  });

  it("is never rendered by a host: the observation panel owns the footer, so each host cannot forget or restyle it", () => {
    for (const file of ["plot-tooltip.tsx", "observation-tooltip.tsx", "chart-renderers.tsx", "stat-sparkline.tsx", "plugins/record-charts.tsx", "plugins/metric-distributions.tsx", "plugins/records.tsx", "plugins/small-multiples.tsx", "plugins/status-grid.tsx", "plugins/uptime-views.tsx", "plugins/rich-metrics.tsx"]) {
      const source = readFileSync(join(process.cwd(), "src/features/insights", file), "utf8");
      expect(source.match(/<TooltipPinHint\b/g) ?? [], file).toHaveLength(file === "observation-tooltip.tsx" ? 1 : 0);
      expect(source, file).not.toContain("<TooltipInstructions");
      expect(source, file).not.toContain("TOOLTIP_PIN_HINT_PINNED");
    }
  });

  it("is the copy every hint panel shows, not hand-written wording", () => {
    // No panel repeats the pin copy by hand; the wording comes from the shared helper.
    const panels = [
      "stat-sparkline.tsx",
      "plugins/record-charts.tsx",
      "plugins/metric-distributions.tsx",
      "plugins/records.tsx",
      "plugins/small-multiples.tsx",
      "plugins/status-grid.tsx",
      "plugins/rich-metrics.tsx",
      "observation-tooltip.tsx",
    ];
    for (const file of panels) {
      const source = readFileSync(join(process.cwd(), "src/features/insights", file), "utf8");
      expect(source, file).not.toMatch(/Enter or tap to (pin|release)|press Escape to close|Enter to pin|Pinned · press Escape|Move across the chart/);
    }
  });
});
