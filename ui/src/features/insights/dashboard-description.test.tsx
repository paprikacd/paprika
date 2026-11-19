import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClampedDescription } from "./dashboard-description";

const text = "Synthetic local provider observations. Node readiness is independently sampled; missing samples remain unknown.";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** jsdom has no layout. Report the text as taller than its clamped box while `overflow` is true. */
function stubOverflow(overflow: () => boolean) {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => (overflow() ? 60 : 34));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(34);
}

describe("ClampedDescription", () => {
  it("keeps the full text in the page and shows no toggle when the text fits", () => {
    stubOverflow(() => false);
    render(<ClampedDescription text={text} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More|Less/ })).not.toBeInTheDocument();
  });

  it("shows More when the two-line clamp hides text, and toggles the full text", () => {
    stubOverflow(() => true);
    render(<ClampedDescription text={text} />);
    const more = screen.getByRole("button", { name: "More" });
    const paragraph = screen.getByText(text);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", paragraph.id);
    expect(paragraph).not.toHaveAttribute("data-expanded");
    fireEvent.click(more);
    const less = screen.getByRole("button", { name: "Less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    expect(paragraph).toHaveAttribute("data-expanded");
    fireEvent.click(less);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    expect(paragraph).not.toHaveAttribute("data-expanded");
    expect(screen.getByText(text)).toBe(paragraph);
  });

  it("measures again on window resize when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    let overflow = false;
    stubOverflow(() => overflow);
    render(<ClampedDescription text={text} />);
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    overflow = true;
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
  });

  it("measures again when the observed box changes size", () => {
    let overflow = false;
    let notify: (() => void) | undefined;
    class FakeObserver {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    stubOverflow(() => overflow);
    render(<ClampedDescription text={text} />);
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    overflow = true;
    act(() => notify?.());
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});
