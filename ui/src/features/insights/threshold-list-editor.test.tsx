import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThresholdListEditor } from "./threshold-list-editor";
import type { Threshold } from "./schema";

afterEach(cleanup);

const bands: Threshold[] = [{ value: 5, status: "warning" }];

function setup(thresholds: Threshold[] = bands) {
  const onChange = vi.fn();
  const view = render(<ThresholdListEditor thresholds={thresholds} onChange={onChange} />);
  const input = screen.getByRole("spinbutton", { name: "Threshold 1 value" }) as HTMLInputElement;
  return { onChange, input, view };
}

describe("threshold value field", () => {
  it("never writes 0 when the field is cleared, and says what to do", () => {
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a number to update this band.")).toBeInTheDocument();
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("writes the typed number", () => {
    const { onChange, input } = setup();
    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith([{ value: 7, status: "warning" }]);
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("resyncs the text when the stored value changes from outside", () => {
    const { input, view, onChange } = setup();
    fireEvent.change(input, { target: { value: "" } });
    view.rerender(<ThresholdListEditor thresholds={[{ value: 42, status: "warning" }]} onChange={onChange} />);
    expect((screen.getByRole("spinbutton", { name: "Threshold 1 value" }) as HTMLInputElement).value).toBe("42");
    expect(screen.queryByText("Enter a number to update this band.")).toBeNull();
  });

  it("restores the stored value on blur", () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("5");
    expect(onChange).not.toHaveBeenCalledWith([expect.objectContaining({ value: 0 })]);
    expect(screen.queryByText("Enter a number to update this band.")).toBeNull();
  });
});
