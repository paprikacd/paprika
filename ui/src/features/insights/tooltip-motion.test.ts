import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

afterEach(() => { document.head.querySelectorAll("style[data-tooltip-motion-test]").forEach(node => node.remove()); });

it("keeps tooltip geometry synchronous even when the global reduced-motion rule supplies a nonzero duration", () => {
  const source = readFileSync("src/features/insights/chart-styles.module.css", "utf8");
  const globalSource = readFileSync("src/app/globals.css", "utf8");
  const reducedMotion = globalSource.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*(\*, \*::before, \*::after\s*\{[^}]+\})/);
  expect(reducedMotion).not.toBeNull();
  const style = document.createElement("style");
  style.dataset.tooltipMotionTest = "true";
  // Activate the actual reduced-motion declarations independently of the test
  // DOM's media-query emulation. Browser geometry remains covered by E2E.
  style.textContent = `${source}\n${reducedMotion![1]}`;
  document.head.append(style);
  const panel = document.createElement("div");
  panel.className = "heatmapTooltip";
  document.body.append(panel);
  try {
    const computed = getComputedStyle(panel);
    expect(computed.position).toBe("fixed");
    expect(computed.transitionDuration).toBe("0.01ms");
    // The CSS initial value is "all". A tiny nonzero global duration must not
    // turn synchronous left/top writes into interpolated geometry reads.
    expect(computed.transitionProperty || "all").toBe("none");
  } finally { panel.remove(); }
});
