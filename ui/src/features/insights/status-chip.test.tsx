import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_GLYPHS, STATUS_WORDS, StatusChip, bandReading, statusStrokeLevel, statusStrokeStyle } from "./status-chip";
import { statusLevels } from "./status";

const here = dirname(fileURLToPath(import.meta.url));

describe("StatusChip", () => {
  it.each(statusLevels)("pairs a decorative %s glyph with the status word", level => {
    const { container, unmount } = render(<StatusChip status={level} />);
    const chip = container.querySelector<HTMLElement>("[data-status]")!;
    expect(chip).toHaveAttribute("data-status", level);
    expect(chip.querySelector('[aria-hidden="true"]')).toHaveTextContent(STATUS_GLYPHS[level]);
    expect(chip).toHaveTextContent(STATUS_WORDS[level]);
    unmount();
  });

  it("uses the console glyphs for ok, info, warning, critical and unknown", () => {
    expect(STATUS_GLYPHS).toEqual({ ok: "✓", info: "i", warning: "!", critical: "×", unknown: "?" });
  });

  it("announces the status word alongside a custom label", () => {
    const { container } = render(<StatusChip status="warning" label="Elevated" />);
    const announced = container.querySelector("[data-status] > span:last-child > span");
    expect(announced).toHaveTextContent(/^Warning:\s*$/);
    expect(announced?.className).toMatch(/srOnly/);
    expect(container.querySelector("[data-status]")).toHaveTextContent("Warning: Elevated");
  });

  it.each(["critical", "Critical", "Critical 90%", "90% · critical"])("does not repeat the word when the label already names it (%s)", label => {
    const { container } = render(<StatusChip status="critical" label={label} />);
    expect(container.querySelector("[data-status] > span:last-child")!.querySelector("span")).toBeNull();
    expect(container.querySelector("[data-status]")!.textContent).not.toMatch(/Critical: /);
  });

  it("is non-interactive by default", () => {
    const { container } = render(<StatusChip status="ok" />);
    const chip = container.querySelector("[data-status]")!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip).not.toHaveAttribute("role");
    expect(chip).not.toHaveAttribute("tabindex");
  });

  it("takes its mark from a hue override and its text tone from the status token", () => {
    const { container } = render(<StatusChip status="critical" color="#123456" />);
    const chip = container.querySelector<HTMLElement>("[data-status]")!;
    expect(chip.style.getPropertyValue("--chip-mark")).toBe("#123456");
    expect(chip.style.getPropertyValue("--chip-text")).toBe("var(--gamma-status-critical-text)");
    expect(chip.style.getPropertyValue("--chip-soft")).toBe("var(--gamma-status-critical-soft)");
  });
});

describe("band readings", () => {
  it("reads a status-only band as its word, a labelled band with its word, and a hex band with its label or fallback", () => {
    expect(bandReading({ status: "warning" })).toBe("Warning");
    expect(bandReading({ status: "critical", label: "Down" })).toBe("Down · Critical");
    expect(bandReading({ status: "critical", label: "Critical 90%" })).toBe("Critical 90%");
    expect(bandReading({ color: "#123456" })).toBe("Observed");
    expect(bandReading({ color: "#123456", label: "Legacy" })).toBe("Legacy");
    expect(bandReading(undefined, "")).toBe("");
  });
});

describe("status frames", () => {
  it("names only warning and critical as frame levels", () => {
    expect(statusStrokeLevel({ status: "warning" })).toBe("warning");
    expect(statusStrokeLevel({ status: "critical", color: "#123456" })).toBe("critical");
    for (const status of ["ok", "info", "unknown"] as const) expect(statusStrokeLevel({ status })).toBeUndefined();
    expect(statusStrokeLevel({ color: "#123456" })).toBeUndefined();
    expect(statusStrokeLevel(undefined)).toBeUndefined();
  });

  it("draws a frame only where at least 4 px and half the size remain as fill, in both directions", () => {
    // Critical: size - 4 >= max(4, size / 2), so 8 px is the first size.
    expect(statusStrokeLevel({ status: "critical" }, { width: 7, height: 18 })).toBeUndefined();
    expect(statusStrokeLevel({ status: "critical" }, { width: 8, height: 18 })).toBe("critical");
    expect(statusStrokeLevel({ status: "critical" }, { width: 18, height: 7 })).toBeUndefined();
    // Warning: size - 2 >= max(4, size / 2), so 6 px is the first size.
    expect(statusStrokeLevel({ status: "warning" }, { width: 5, height: 18 })).toBeUndefined();
    expect(statusStrokeLevel({ status: "warning" }, { width: 6, height: 18 })).toBe("warning");
    expect(statusStrokeLevel({ status: "warning" }, undefined)).toBe("warning");
  });

  it("draws the frame in the widget text colour, and a hex-only band or an ok band gets no frame", () => {
    expect(statusStrokeStyle({ color: "#123456" })).toEqual({});
    expect(statusStrokeStyle({ status: "ok" })).toEqual({});
    expect(statusStrokeStyle({ status: "critical" }, { width: 3, height: 18 })).toEqual({});
    expect(statusStrokeStyle({ status: "critical" })).toEqual({ "--status-stroke-color": "var(--widget-text, var(--gamma-ink))" });
  });

  it("uses a 1 px frame for warning and 2 px for critical, with no keyline, and never hatching", () => {
    const css = readFileSync(join(here, "status-chip.module.css"), "utf8");
    expect(css).toMatch(/:global\(\[data-status-stroke="warning"\]\)[^}]*inset 0 0 0 1px var\(--status-stroke-color/);
    expect(css).toMatch(/:global\(\[data-status-stroke="critical"\]\)[^}]*inset 0 0 0 2px var\(--status-stroke-color/);
    expect(css).not.toMatch(/status-keyline/);
    expect(css).not.toMatch(/repeating-linear-gradient/);
  });
});
