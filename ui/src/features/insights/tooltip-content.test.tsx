import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipPinHint, tooltipPinHint, TOOLTIP_PIN_HINT_OPEN, TOOLTIP_PIN_HINT_PINNED } from "./tooltip-content";

// Every observation panel shows one pin hint: the keep-open or close copy first, then the dismissal instructions in
// the same sticky footer.
describe("TooltipPinHint", () => {
  it("states how to keep the panel open, or close it once pinned, with one vocabulary", () => {
    expect(tooltipPinHint(false)).toBe(TOOLTIP_PIN_HINT_OPEN);
    expect(tooltipPinHint(true)).toBe(TOOLTIP_PIN_HINT_PINNED);
    expect(TOOLTIP_PIN_HINT_OPEN).toBe("Click, tap or press Enter to keep open");
    expect(TOOLTIP_PIN_HINT_PINNED).toBe("Pinned · select again to close");
  });

  it.each([false, true])("keeps the dismissal instructions inside the sticky footer (pinned: %s)", (pinned) => {
    const { container } = render(<TooltipPinHint pinned={pinned} />);
    const footer = container.firstElementChild as HTMLElement;
    const instructions = footer.querySelector("[data-tooltip-instructions]");
    expect(instructions).not.toBeNull();
    expect(screen.getByText(/Page Up\/Down to scroll · Esc to close/)).toBeInTheDocument();
    expect(screen.getByText(/Swipe to scroll · tap outside to close/)).toBeInTheDocument();
    // The footer carries the sticky rule only through its instructions, so both must sit in the same element.
    expect(footer.querySelector("[data-tooltip-instructions]")).toBe(instructions);
    expect(footer.textContent?.indexOf(pinned ? "Pinned" : "Click")).toBeLessThan(footer.textContent?.indexOf("Page Up") ?? 0);
  });
});
