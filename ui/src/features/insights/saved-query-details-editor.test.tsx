import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SavedQueryDetailsEditor } from "./saved-query-details-editor";
import { savedQuerySchema, type SavedQuery } from "./schema";

const base: SavedQuery = { schemaVersion: 1, id: "requests", name: "Requests", providerId: "metrics", kind: "metrics", query: "up" };
function harness(query = base, disabled = false) {
  const change = vi.fn();
  let current = query;
  function Harness() {
    const [value, setValue] = useState(query);
    return <SavedQueryDetailsEditor query={value} disabled={disabled} onChange={(patch) => { change(patch); current = { ...current, ...patch }; setValue(current); }} />;
  }
  render(<Harness />);
  return { change, current: () => current, open: () => fireEvent.click(screen.getByRole("button", { name: /Library details/ })) };
}

describe("saved query library details editor", () => {
  it("exposes tags directly without nesting the image and metadata editors", () => {
    const change = vi.fn();
    const { rerender } = render(<SavedQueryDetailsEditor query={base} onChange={change} section="tags" collapsible={false} />);
    expect(screen.getByLabelText("New tag")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Library details/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cover image")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "reusable" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(change).toHaveBeenCalledWith({ tags: ["reusable"] });
    rerender(<SavedQueryDetailsEditor query={base} onChange={change} section="metadata" collapsible={false} />);
    expect(screen.getByLabelText("Cover image")).toBeVisible();
    expect(screen.getByLabelText("New metadata key")).toBeVisible();
    expect(screen.queryByLabelText("New tag")).not.toBeInTheDocument();
  });
  it("keeps optional details collapsed and edits images, tags, and custom values into a valid query", () => {
    const h = harness();
    expect(screen.queryByLabelText("Cover image")).not.toBeInTheDocument();
    h.open();
    fireEvent.change(screen.getByLabelText("Cover image"), { target: { value: "/images/services.png" } });
    expect(screen.getByAltText("Saved query cover preview")).toHaveAttribute("src", "/images/services.png");
    fireEvent.change(screen.getByLabelText("New tag"), { target: { value: " production " } });
    fireEvent.keyDown(screen.getByLabelText("New tag"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove tag production" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New metadata key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("New metadata value"), { target: { value: "platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByLabelText("team", { exact: true }), { target: { value: "infrastructure" } });
    expect(savedQuerySchema.parse(h.current())).toMatchObject({ imageUrl: "/images/services.png", tags: ["production"], metadata: { team: "infrastructure" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag production" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove metadata team" }));
    fireEvent.change(screen.getByLabelText("Cover image"), { target: { value: "" } });
    expect(h.current()).toMatchObject({ imageUrl: undefined, tags: [], metadata: {} });
  });

  it("reports invalid images and loading errors without pretending the image is available", () => {
    const h = harness(); h.open();
    fireEvent.change(screen.getByLabelText("Cover image"), { target: { value: "javascript:alert(1)" } });
    expect(screen.getByLabelText("Cover image")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cover image"), { target: { value: "https://images.example.com/missing.png" } });
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText(/Image could not be loaded/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cover image"), { target: { value: "/valid.png" } });
    expect(screen.getByRole("img")).toHaveAttribute("src", "/valid.png");
  });

  it("rejects duplicate tags, duplicate metadata keys and reserved keys without losing saved values", () => {
    const h = harness({ ...base, tags: ["production"], metadata: { team: "platform" } }); h.open();
    fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "production" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already included");
    fireEvent.change(screen.getByLabelText("New metadata key"), { target: { value: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByText(/That key already exists/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New metadata key"), { target: { value: "__proto__" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByText(/without reserved names/)).toBeInTheDocument();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("honors disabled state while allowing details to be inspected", () => {
    const h = harness({ ...base, tags: ["production"], metadata: { team: "platform" } }, true); h.open();
    expect(screen.getByLabelText("Cover image")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove tag production" })).toBeDisabled();
    expect(screen.getByLabelText("team", { exact: true })).toBeDisabled();
  });
});
