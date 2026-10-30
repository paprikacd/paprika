import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ObservationTooltip } from "./observation-tooltip";
import { installTooltipPointerTracking, placePointerTooltip } from "./tooltip-pointer";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  { name: "ordinary body", scale: 1, left: 0, top: 0 },
  { name: "translated dialog", scale: 1, left: 100, top: 50 },
  { name: "translated and scaled dialog", scale: 2, left: 100, top: 50 },
])("keeps repeated pointer placements in viewport coordinates in an $name portal", async ({ scale, left, top }) => {
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.id === "translated-tip") {
      return new DOMRect(left + scale * parseFloat(this.style.left || "0"), top + scale * parseFloat(this.style.top || "0"), 160 * scale, 100 * scale);
    }
    return new DOMRect(100, 100, 600, 500);
  });
  const stop = installTooltipPointerTracking();
  try {
    render(left ? <dialog open><button>Translated chart</button></dialog> : <button>Translated chart</button>);
    const anchor = screen.getByRole("button", { name: "Translated chart" });
    const move = (x: number, y: number) => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(anchor, event);
    };
    move(400, 200);
    render(<ObservationTooltip id="translated-tip" anchor={anchor} onDismiss={() => {}} onEnter={() => {}} onLeave={() => {}}>Observation</ObservationTooltip>);
    const tooltip = screen.getByRole("tooltip");
    for (const [x, y] of [[400, 200], [400, 250], [450, 250], [450, 300], [400, 300]]) {
      move(x, y);
      const expected = placePointerTooltip({ x, y }, { width: 160 * scale, height: 100 * scale }, { width: 1000, height: 800 });
      await waitFor(() => {
        const actual = tooltip.getBoundingClientRect();
        expect(actual.left).toBeCloseTo(expected.left);
        expect(actual.top).toBeCloseTo(expected.top);
      });
    }
  } finally { stop(); }
});
