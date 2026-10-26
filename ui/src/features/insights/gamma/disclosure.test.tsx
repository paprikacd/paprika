import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GammaDisclosure } from "./disclosure";

describe("Gamma comparison disclosure", () => {
  it("opens with the keyboard, labels its region and unmounts closed details", async () => {
    const user = userEvent.setup();
    render(
      <GammaDisclosure
        title="Compare changes for Availability"
        meta="3 changes"
      >
        <p>Current query: up</p>
      </GammaDisclosure>,
    );
    const trigger = screen.getByRole("button", {
      name: "Compare changes for Availability 3 changes",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Current query: up")).not.toBeInTheDocument();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveFocus();
    expect(
      screen.getByRole("region", {
        name: "Compare changes for Availability 3 changes",
      }),
    ).toHaveTextContent("Current query: up");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByText("Current query: up")).not.toBeInTheDocument();
  });
});
