import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ObservationDetails } from "./observation-tooltip";

afterEach(cleanup);

// Geo bins and calendar days pass a stable key, so a refresh keeps the open panel on the same bin or day.
function Bin({ binKey, revision, reading }: { binKey: string; revision: number; reading: string }) {
  return <ObservationDetails label={`Inspect ${binKey}`} observationKey={binKey} revision={revision} details={<p>Reading {reading}</p>}>
    <span>cell</span>
  </ObservationDetails>;
}

describe("observation panels keyed by a stable identity", () => {
  it("keeps a focused panel open across a refresh with the same key, and shows the new reading", () => {
    const { rerender } = render(<Bin binKey="2026-11-16" revision={1} reading="one" />);
    fireEvent.focus(screen.getByRole("button", { name: "Inspect 2026-11-16" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Reading one");
    rerender(<Bin binKey="2026-11-16" revision={2} reading="two" />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Reading two");
  });

  it("closes the panel when its key is no longer in the data", () => {
    const { rerender } = render(<Bin binKey="2026-11-16" revision={1} reading="one" />);
    fireEvent.focus(screen.getByRole("button", { name: "Inspect 2026-11-16" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(<Bin binKey="2026-11-17" revision={2} reading="two" />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
