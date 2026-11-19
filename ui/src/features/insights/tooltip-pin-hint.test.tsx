import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("renders the shared pin hint as the footer itself, so the order is set in one place and footers never nest", () => {
    // Each panel with a pin hint renders TooltipPinHint once, unwrapped: TooltipPinHint is already the tooltipFooter
    // block, so a wrapper would stack two dividers and inset the hint differently from the body.
    for (const file of ["plot-tooltip.tsx", "observation-tooltip.tsx", "chart-renderers.tsx"]) {
      const source = readFileSync(join(process.cwd(), "src/features/insights", file), "utf8");
      expect(source.match(/<TooltipPinHint\b/g), file).toHaveLength(1);
      expect(source, file).not.toMatch(/tooltipFooter[}"`][^>]*>\s*<TooltipPinHint\b/);
      expect(source, file).not.toContain("<TooltipInstructions");
      expect(source, file).not.toContain("TOOLTIP_PIN_HINT_PINNED");
    }
  });

  it("is the copy every hint panel shows, not hand-written wording", () => {
    // Each panel that shows a pin hint renders the shared component or helper, and none repeats the copy by hand.
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
      expect(source, file).toMatch(/<TooltipPinHint|tooltipPinHint\(|TOOLTIP_PIN_HINT_(OPEN|PINNED)/);
      expect(source, file).not.toMatch(/Enter or tap to (pin|release)|press Escape to close|Enter to pin|Pinned · press Escape|Move across the chart/);
    }
  });
});
