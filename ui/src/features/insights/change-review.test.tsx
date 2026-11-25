import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangeReview } from "./change-review";
import { documentChanges, type JSONObject } from "./dashboard-patch";

const widget = (id: string, title: string, y = 0) => ({ id, title, type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y, w: 4, h: 2 } });
const before = { schemaVersion: 1, id: "a", title: "Old", widgets: [widget("keep", "Keep"), widget("move", "Move", 0)] } as unknown as JSONObject;
const after = { schemaVersion: 1, id: "a", title: "New", widgets: [widget("keep", "Keep"), widget("move", "Move", 4), widget("add", "Added")] } as unknown as JSONObject;

describe("ChangeReview", () => {
  it("lists one disclosure per changed widget with its field count", () => {
    render(<ChangeReview changes={documentChanges(before, after)} />);
    expect(screen.getByRole("button", { name: /Move · moved/ })).toHaveTextContent("1 field");
    expect(screen.getByRole("button", { name: /Added · added/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Keep ·/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dashboard settings/ })).toHaveTextContent("1 field");
  });

  it("shows the field path and its before and after values when opened", () => {
    render(<ChangeReview changes={documentChanges(before, after)} />);
    fireEvent.click(screen.getByRole("button", { name: /Move · moved/ }));
    expect(screen.getByText("layout.y")).toBeInTheDocument();
    const list = screen.getByText("layout.y").closest("li");
    expect(list?.querySelectorAll("pre")[0]).toHaveTextContent("0");
    expect(list?.querySelectorAll("pre")[1]).toHaveTextContent("4");
  });

  it("passes the widget id to Show widget", () => {
    const onFocusWidget = vi.fn();
    render(<ChangeReview changes={documentChanges(before, after)} onFocusWidget={onFocusWidget} />);
    fireEvent.click(screen.getByRole("button", { name: /Move · moved/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show widget Move" }));
    expect(onFocusWidget).toHaveBeenCalledWith("move");
  });

  it("renders nothing when nothing changed", () => {
    const { container } = render(<ChangeReview changes={documentChanges(before, before)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("caps a long value", () => {
    const long = "x".repeat(5000);
    const changed = { ...before, title: long } as JSONObject;
    render(<ChangeReview changes={documentChanges(before, changed)} />);
    fireEvent.click(screen.getByRole("button", { name: /Dashboard settings/ }));
    const text = screen.getByText("title").closest("li")?.querySelectorAll("pre")[1]?.textContent ?? "";
    expect(text.length).toBeLessThanOrEqual(2010);
    expect(text).toContain("…");
  });
});
