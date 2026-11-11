import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BreachSummary, formatBreachDuration } from "./breach-summary";

afterEach(cleanup);

describe("formatBreachDuration", () => {
  it("uses seconds, minutes, then hours and minutes", () => {
    expect(formatBreachDuration(0)).toBe("0 s");
    expect(formatBreachDuration(45_000)).toBe("45 s");
    expect(formatBreachDuration(14 * 60_000)).toBe("14 min");
    expect(formatBreachDuration(60 * 60_000)).toBe("1 h");
    expect(formatBreachDuration(65 * 60_000)).toBe("1 h 5 min");
  });
});

describe("BreachSummary", () => {
  it("renders nothing without breaches", () => {
    const { container } = render(<BreachSummary summary={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the level in words with its interval count and duration", () => {
    const { container } = render(<BreachSummary summary={[{ level: "critical", intervals: 2, samples: 0, duration: 14 * 60_000 }]} />);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent(/^Critical · 2 intervals · 14 min$/);
  });

  it("uses the singular for one interval and separates the levels", () => {
    const { container } = render(<BreachSummary summary={[
      { level: "critical", intervals: 1, samples: 0, duration: 60_000 },
      { level: "warning", intervals: 3, samples: 0, duration: 5 * 60_000 },
    ]} />);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Critical · 1 interval · 1 min; Warning · 3 intervals · 5 min");
  });

  it("names single samples apart from intervals, and never shows a zero-length interval", () => {
    const { container } = render(<BreachSummary summary={[
      { level: "critical", intervals: 0, samples: 1, duration: 0 },
      { level: "warning", intervals: 1, samples: 2, duration: 2 * 60_000 },
    ]} />);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Critical · 1 single sample; Warning · 1 interval · 2 min · 2 single samples");
    expect(container.textContent).not.toContain("0 s");
  });

  it("says when the figures come from a partial result and how many bands are not shaded", () => {
    const { container } = render(<BreachSummary summary={[{ level: "warning", intervals: 1, samples: 0, duration: 60_000 }]} partial unshaded={1} />);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Warning · 1 interval · 1 min · partial result · 1 more band not shaded");
  });
});
