import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { durationPhrase, comparisonLabel, StatDelta, type StatComparisonState } from "./stat-comparison";

const HOUR = 3_600_000;
const base = (overrides: Partial<StatComparisonState> = {}): StatComparisonState => ({ window: "previous", span: HOUR, unit: "req/s", decimals: 1, ...overrides });
const outcome = { state: "ok" as const, current: { timestamp: 2000, value: 112 }, baseline: { timestamp: 1000, value: 100 }, delta: 12, percent: 12, direction: "up" as const };
const format = (timestamp: number) => `t${timestamp}`;

afterEach(cleanup);

describe("stat change chip", () => {
  it("names the earlier window by its length, and the 1 d and 7 d windows by their fixed offsets", () => {
    expect(comparisonLabel("previous", HOUR)).toBe("vs 1 h earlier");
    expect(comparisonLabel("previous", 15 * 60_000)).toBe("vs 15 min earlier");
    expect(comparisonLabel("1d", HOUR)).toBe("vs 1 d earlier");
    expect(comparisonLabel("7d", HOUR)).toBe("vs 7 d earlier");
    expect(durationPhrase(90 * 60_000)).toBe("1.5 h");
  });
  it("shows a glyph, the signed change and the window, with neutral ink and no status colour", () => {
    const { container } = render(<StatDelta state={base({ outcome })} formatTime={format} />);
    const chip = container.querySelector<HTMLElement>("[data-stat-delta]")!;
    expect(chip).toHaveAttribute("data-stat-delta", "up");
    expect(chip.textContent).toContain("vs 1 h earlier: +12.0%");
    expect(chip).not.toHaveAttribute("aria-label");
    expect(chip.textContent).toContain("▲");
    expect(chip.textContent).toContain("+12.0%");
    expect(chip.getAttribute("title")).toContain("Exact change +12 req/s");
    expect(chip.getAttribute("title")).toContain("earlier sample t1000");
    expect(chip.getAttribute("style")).toBeNull();
  });
  it("names better or worse only when the author set the better direction", () => {
    const { container, rerender } = render(<StatDelta state={base({ outcome, good: "up" })} formatTime={format} />);
    expect(container.querySelector("[data-stat-delta]")!.textContent).toContain("vs 1 h earlier: +12.0%, better");
    expect(container.querySelector("[data-stat-delta]")!.textContent).toContain("better");
    expect(container.querySelector("[data-stat-delta]")).toHaveAttribute("title", expect.stringContaining("better"));
    rerender(<StatDelta state={base({ outcome, good: "down" })} formatTime={format} />);
    expect(container.querySelector("[data-stat-delta]")!.textContent).toContain("vs 1 h earlier: +12.0%, worse");
  });
  it("says unavailable in words, never as zero", () => {
    render(<StatDelta state={base({ outcome: { state: "unavailable", reason: "no_prior_sample" } })} formatTime={format} />);
    expect(screen.getByText("No earlier sample")).toBeInTheDocument();
    expect(screen.queryByText(/0(\.0)?%/)).toBeNull();
  });
  it("names a failed earlier window as unavailable", () => {
    const { container } = render(<StatDelta state={base({ error: "provider failed" })} formatTime={format} />);
    expect(screen.getByText("Earlier period unavailable")).toBeInTheDocument();
    expect(container.querySelector("[data-stat-delta]")).toHaveAttribute("title", "provider failed");
  });
  it("reserves an empty slot while the earlier window loads", () => {
    const { container } = render(<StatDelta state={base()} formatTime={format} />);
    const slot = container.querySelector("[data-stat-delta]")!;
    expect(slot).toHaveAttribute("data-stat-delta", "loading");
    expect(slot.textContent).toBe("");
  });
  it("marks a partial earlier response", () => {
    const { container } = render(<StatDelta state={base({ outcome: { ...outcome, state: "partial" } })} formatTime={format} />);
    expect(container.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta-state", "partial");
    expect(container.textContent).toContain("partial");
  });
  it("tells a screen reader the whole change, with its window and verdict, once", () => {
    const { container } = render(<StatDelta state={base({ outcome, good: "up" })} formatTime={format} />);
    const spoken = container.querySelector("[data-stat-spoken]")!;
    expect(spoken.textContent).toBe("vs 1 h earlier: +12.0%, better");
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
  it("names the window in the unavailable state's spoken text", () => {
    const { container } = render(<StatDelta state={base({ outcome: { state: "unavailable", reason: "no_prior_sample" } })} formatTime={format} />);
    expect(container.querySelector("[data-stat-spoken]")!.textContent).toBe("vs 1 h earlier: No earlier sample");
  });
  it("reads a change that rounds to zero as flat, with no arrow", () => {
    const { container } = render(<StatDelta state={base({ outcome: { ...outcome, delta: 0.001, percent: 0.001, direction: "up" } })} formatTime={format} />);
    expect(container.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta", "flat");
    expect(container.textContent).not.toContain("▲");
    expect(container.textContent).toContain("≈0.0%");
  });
});
