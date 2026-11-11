import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusMarkFields } from "./status-mark-fields";
import type { StatusMark } from "./status";

afterEach(cleanup);

function picker(mark: StatusMark, theme: "light" | "dark" = "light") {
  const onChange = vi.fn();
  render(<StatusMarkFields name="Band" mark={mark} theme={theme} onChange={onChange} />);
  return onChange;
}

/** Opens the level listbox from the keyboard, moves with ArrowDown and commits with Enter. */
function chooseByKeyboard(label: string, steps: number) {
  const trigger = screen.getByRole("combobox", { name: label });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  for (let i = 0; i < steps; i++) fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("status mark fields", () => {
  it("shows the default status as the level and a swatch of the colour drawn in the light theme", () => {
    picker({ status: "critical" });
    expect(screen.getByRole("combobox", { name: "Band level" })).toHaveTextContent("Critical");
    expect(screen.getByRole("img", { name: "Band drawn colour #7f0a12" })).toHaveStyle({ background: "#7f0a12" });
    expect(screen.getByRole("button", { name: "Band use status colour" })).toBeDisabled();
  });

  it("draws the swatch in the dark theme's colour, not the light one", () => {
    picker({ status: "critical" }, "dark");
    expect(screen.getByRole("img", { name: "Band drawn colour #ffd4cc" })).toBeInTheDocument();
  });

  it("changes the level from the keyboard and keeps an existing hue", () => {
    const onChange = picker({ status: "warning", color: "#123456" });
    chooseByKeyboard("Band level", 1);
    expect(onChange).toHaveBeenLastCalledWith({ status: "critical", color: "#123456" });
  });

  it("writes a hue override and resets it to the status colour", () => {
    const onChange = picker({ status: "ok" });
    fireEvent.change(screen.getByLabelText("Band hue override"), { target: { value: "#00aa33" } });
    expect(onChange).toHaveBeenLastCalledWith({ status: "ok", color: "#00aa33" });
    cleanup();
    const reset = picker({ status: "ok", color: "#00aa33" });
    fireEvent.click(screen.getByRole("button", { name: "Band use status colour" }));
    expect(reset).toHaveBeenLastCalledWith({ status: "ok", color: undefined });
  });

  it("keeps a legacy hex-only mark as authored until the author picks a status", () => {
    const onChange = picker({ color: "#123456" });
    expect(screen.getByRole("combobox", { name: "Band level" })).toHaveTextContent("Colour only");
    expect(screen.getByRole("img", { name: "Band drawn colour #123456" })).toBeInTheDocument();
    expect(screen.getByLabelText("Band hue override")).toHaveValue("#123456");
    expect(screen.getByRole("button", { name: "Band use status colour" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    chooseByKeyboard("Band level", 3);
    expect(onChange).toHaveBeenLastCalledWith({ status: "warning", color: "#123456" });
  });
});
