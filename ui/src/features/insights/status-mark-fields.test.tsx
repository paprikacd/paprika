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

/** Keyboard: focus the trigger, ArrowDown opens the listbox at the current value, ArrowDown moves, Enter commits. */
function chooseByKeyboard(steps: number) {
  const trigger = screen.getByRole("combobox", { name: "Band status" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  for (let i = 0; i < steps; i++) fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

/** Pointer: open the listbox and click the named option. */
function chooseByClick(option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Band status" }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("status mark fields", () => {
  it("shows the default status and a swatch of the colour drawn in the light theme", () => {
    picker({ status: "critical" });
    expect(screen.getByRole("combobox", { name: "Band status" })).toHaveTextContent("Critical");
    expect(screen.getByText("Band colour")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Band drawn colour #7f0a12" })).toHaveStyle({ background: "#7f0a12" });
    expect(screen.getByRole("button", { name: "Band use status colour" })).toBeDisabled();
  });

  it("draws the swatch in the dark theme's colour, not the light one", () => {
    picker({ status: "critical" }, "dark");
    expect(screen.getByRole("img", { name: "Band drawn colour #ffd4cc" })).toBeInTheDocument();
  });

  it("changes the level from the keyboard and keeps an existing hue", () => {
    const onChange = picker({ status: "warning", color: "#123456" });
    chooseByKeyboard(1);
    expect(onChange).toHaveBeenLastCalledWith({ status: "critical", color: "#123456" });
  });

  it("writes a hue override and resets it to the status colour", () => {
    const onChange = picker({ status: "ok" });
    fireEvent.change(screen.getByLabelText("Band colour"), { target: { value: "#00aa33" } });
    expect(onChange).toHaveBeenLastCalledWith({ status: "ok", color: "#00aa33" });
    cleanup();
    const reset = picker({ status: "ok", color: "#00aa33" });
    fireEvent.click(screen.getByRole("button", { name: "Band use status colour" }));
    expect(reset).toHaveBeenLastCalledWith({ status: "ok", color: undefined });
  });

  it("keeps a legacy hex-only mark as authored until the author picks a status", () => {
    const onChange = picker({ color: "#123456" });
    expect(screen.getByRole("combobox", { name: "Band status" })).toHaveTextContent("Colour only");
    expect(screen.getByRole("img", { name: "Band drawn colour #123456" })).toBeInTheDocument();
    expect(screen.getByLabelText("Band colour")).toHaveValue("#123456");
    expect(screen.getByRole("button", { name: "Band use status colour" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    chooseByKeyboard(3);
    expect(onChange).toHaveBeenLastCalledWith({ status: "warning", color: "#123456" });
  });

  it("never writes a status for Colour only, from the keyboard or a click", () => {
    const keyboard = picker({ status: "warning", color: "#123456" });
    chooseByKeyboard(0); // Enter on the current level re-commits it, and writes no change.
    expect(keyboard).toHaveBeenLastCalledWith({ status: "warning", color: "#123456" });
    cleanup();
    const onChange = picker({ status: "warning", color: "#123456" });
    chooseByClick("Colour only");
    expect(onChange).toHaveBeenCalledTimes(1);
    const cleared = onChange.mock.calls[0][0] as StatusMark;
    expect(cleared).toEqual({ color: "#123456" });
    expect(cleared).not.toHaveProperty("status");
  });

  it("offers Colour only only when a colour exists, so a status-only band cannot lose its mark", () => {
    picker({ status: "critical" });
    fireEvent.click(screen.getByRole("combobox", { name: "Band status" }));
    expect(screen.queryByRole("option", { name: "Colour only" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Critical" })).toBeInTheDocument();
  });

  it("round-trips pick, clear and pick again with keyboard Enter", () => {
    const onChange = vi.fn();
    const { rerender } = render(<StatusMarkFields name="Band" mark={{ color: "#123456" }} theme="light" onChange={onChange} />);
    // Pick a level on the legacy band: the hue stays and a status is added.
    chooseByKeyboard(3);
    expect(onChange).toHaveBeenLastCalledWith({ status: "warning", color: "#123456" });
    rerender(<StatusMarkFields name="Band" mark={{ status: "warning", color: "#123456" }} theme="light" onChange={onChange} />);
    // Clear the level back to the hex-only mark with Enter on Colour only.
    const trigger = screen.getByRole("combobox", { name: "Band status" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ color: "#123456" });
    expect(onChange.mock.lastCall![0]).not.toHaveProperty("status");
    rerender(<StatusMarkFields name="Band" mark={{ color: "#123456" }} theme="light" onChange={onChange} />);
    expect(screen.getByRole("combobox", { name: "Band status" })).toHaveTextContent("Colour only");
  });
});
