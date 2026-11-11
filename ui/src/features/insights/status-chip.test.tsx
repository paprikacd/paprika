import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_GLYPHS, STATUS_WORDS, StatusChip, statusName, statusStrokeLevel, statusStrokeStyle } from "./status-chip";
import { statusLevels } from "./status";

const here = dirname(fileURLToPath(import.meta.url));

describe("StatusChip", () => {
  it.each(statusLevels)("pairs a decorative %s glyph with the status word", level => {
    const { container, unmount } = render(<StatusChip status={level} />);
    const chip = container.querySelector<HTMLElement>("[data-status]")!;
    expect(chip).toHaveAttribute("data-status", level);
    const glyph = chip.querySelector('[aria-hidden="true"]');
    expect(glyph).toHaveTextContent(STATUS_GLYPHS[level]);
    expect(chip).toHaveTextContent(STATUS_WORDS[level]);
    unmount();
  });

  it("uses the console glyphs for ok, info, warning, critical and unknown", () => {
    expect(STATUS_GLYPHS).toEqual({ ok: "✓", info: "i", warning: "!", critical: "×", unknown: "?" });
  });

  it("announces the status word alongside a custom label", () => {
    const { container } = render(<StatusChip status="warning" label="Elevated" />);
    expect(container.querySelector("[data-status]")).toHaveTextContent("Warning: Elevated");
    expect(screen.getByText("Elevated")).toBeInTheDocument();
    const announced = container.querySelector("[data-status] > span:last-child > span");
    expect(announced).toHaveTextContent(/^Warning:\s*$/);
    expect(announced?.className).toMatch(/srOnly/);
  });

  it("does not repeat the word when the label is the word", () => {
    const { container } = render(<StatusChip status="critical" label="critical" />);
    expect(container.querySelector("[data-status]")!.querySelectorAll("span")).toHaveLength(2);
    expect(container.querySelector("[data-status]")).toHaveTextContent(/^×critical$/);
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

describe("status strokes", () => {
  it("names only warning and critical as stroke levels", () => {
    expect(statusStrokeLevel({ status: "warning" })).toBe("warning");
    expect(statusStrokeLevel({ status: "critical", color: "#123456" })).toBe("critical");
    for (const status of ["ok", "info", "unknown"] as const) expect(statusStrokeLevel({ status })).toBeUndefined();
    expect(statusStrokeLevel({ color: "#123456" })).toBeUndefined();
    expect(statusStrokeLevel(undefined)).toBeUndefined();
  });

  it("gives hex-only bands no stroke colour, so their rendering is unchanged", () => {
    expect(statusStrokeStyle({ color: "#123456" })).toEqual({});
    expect(statusStrokeStyle({ status: "ok" })).toEqual({});
    expect(statusStrokeStyle({ status: "critical" })).toEqual({ "--status-stroke-color": "var(--gamma-status-critical-on)" });
  });

  it("draws a 1 px inset stroke for warning and 2 px for critical, and never hatching", () => {
    const css = readFileSync(join(here, "status-chip.module.css"), "utf8");
    expect(css).toMatch(/:global\(\[data-status-stroke="warning"\]\)[^}]*inset 0 0 0 1px/);
    expect(css).toMatch(/:global\(\[data-status-stroke="critical"\]\)[^}]*inset 0 0 0 2px/);
    expect(css).not.toMatch(/repeating-linear-gradient/);
  });

  it("names a status word for unlabelled bands and keeps the default reading otherwise", () => {
    expect(statusName({ status: "warning" })).toBe("Warning");
    expect(statusName({ color: "#123456" })).toBe("Observed");
    expect(statusName(undefined, "")).toBe("");
  });
});
