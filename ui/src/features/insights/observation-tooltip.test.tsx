import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ObservationDetails, ObservationTooltip, WidgetTooltipProvider } from "./observation-tooltip";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Gives every element a fixed box, so placement is deterministic. */
function stubBoxes(box: (element: HTMLElement) => DOMRect | undefined) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return box(this) ?? new DOMRect(0, 0, 0, 0);
  });
}

/** A pinned panel whose content holds a second, nested inspector. Each anchor is found after its parent renders. */
function NestedInspectors({ onParentDismiss, onChildDismiss }: { onParentDismiss: () => void; onChildDismiss: () => void }) {
  const [parentAnchor, setParentAnchor] = useState<HTMLButtonElement | null>(null);
  const [childAnchor, setChildAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setParentAnchor}>Parent anchor</button>
      {parentAnchor && (
        <ObservationTooltip id="parent" anchor={parentAnchor} pinned onDismiss={onParentDismiss}>
          <button ref={setChildAnchor}>Child anchor</button>
          {childAnchor && <ObservationTooltip id="child" anchor={childAnchor} onDismiss={onChildDismiss}>Child details</ObservationTooltip>}
        </ObservationTooltip>
      )}
    </>
  );
}

/** Two observations with their own triggers, in a dashboard widget when a scope id is given. */
function Pair({ widgetId }: { widgetId?: string }) {
  return (
    <article data-widget-id={widgetId}>
      <ObservationDetails label="Pinned value" details={<span>Pinned details</span>}>1</ObservationDetails>
      <ObservationDetails label="Hover value" details={<span>Hover details</span>}>2</ObservationDetails>
    </article>
  );
}

describe("pinned precedence within one widget", () => {
  it("keeps a pinned observation open when a hover preview starts elsewhere in its widget", () => {
    render(<Pair widgetId="widget" />);
    const pinned = screen.getByRole("button", { name: "Pinned value" }), hover = screen.getByRole("button", { name: "Hover value" });
    fireEvent.focus(pinned);
    fireEvent.click(pinned);
    fireEvent.pointerEnter(hover);
    expect(screen.getByText("Pinned details")).toBeInTheDocument();
    expect(screen.queryByText("Hover details")).not.toBeInTheDocument();
    fireEvent.pointerLeave(hover);
    expect(screen.getByText("Pinned details")).toBeInTheDocument();
  });

  it("lets pinning another observation in the same widget replace the pinned one", () => {
    render(<Pair widgetId="widget" />);
    fireEvent.click(screen.getByRole("button", { name: "Pinned value" }));
    fireEvent.click(screen.getByRole("button", { name: "Hover value" }));
    expect(screen.queryByText("Pinned details")).not.toBeInTheDocument();
    expect(screen.getByText("Hover details")).toBeInTheDocument();
  });

  it("does not let a hover preview in another widget displace a pinned observation", () => {
    render(<><Pair widgetId="first" /><Pair widgetId="second" /></>);
    const [pinnedFirst] = screen.getAllByRole("button", { name: "Pinned value" });
    const [, hoverSecond] = screen.getAllByRole("button", { name: "Hover value" });
    fireEvent.click(pinnedFirst);
    fireEvent.focus(hoverSecond);
    expect(screen.getByText("Pinned details")).toBeInTheDocument();
    expect(screen.getByText("Hover details")).toBeInTheDocument();
  });

  it("applies the same rule to observations under one provider, and keeps separate providers independent", () => {
    render(<WidgetTooltipProvider><Pair /></WidgetTooltipProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Pinned value" }));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Hover value" }));
    expect(screen.queryByText("Hover details")).not.toBeInTheDocument();
    cleanup();
    render(<><WidgetTooltipProvider><Pair /></WidgetTooltipProvider><WidgetTooltipProvider><Pair /></WidgetTooltipProvider></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Pinned value" })[0]);
    fireEvent.pointerEnter(screen.getAllByRole("button", { name: "Hover value" })[1]);
    expect(screen.getByText("Pinned details")).toBeInTheDocument();
    expect(screen.getByText("Hover details")).toBeInTheDocument();
  });

  it("shows one preview at a time across the page, and never closes a pinned one", () => {
    render(<><Pair widgetId="first" /><Pair widgetId="second" /></>);
    const [firstHover, secondHover] = screen.getAllByRole("button", { name: "Hover value" });
    fireEvent.focus(firstHover);
    expect(screen.getAllByText("Hover details")).toHaveLength(1);
    fireEvent.focus(secondHover);
    expect(screen.getAllByText("Hover details")).toHaveLength(1);
  });
});

describe("Escape stack", () => {
  it("closes the most recently pinned observation first, and the next press closes the earlier one", () => {
    render(<><Pair widgetId="first" /><Pair widgetId="second" /></>);
    const [pinnedFirst, pinnedSecond] = screen.getAllByRole("button", { name: "Pinned value" });
    fireEvent.click(pinnedFirst);
    fireEvent.click(pinnedSecond);
    expect(screen.getAllByText("Pinned details")).toHaveLength(2);
    fireEvent.keyDown(pinnedSecond, { key: "Escape" });
    expect(screen.getAllByText("Pinned details")).toHaveLength(1);
    fireEvent.keyDown(pinnedFirst, { key: "Escape" });
    expect(screen.queryByText("Pinned details")).not.toBeInTheDocument();
  });

  it("closes a nested inspector before the panel that contains it", () => {
    const parentDismiss = vi.fn(), childDismiss = vi.fn();
    render(<NestedInspectors onParentDismiss={parentDismiss} onChildDismiss={childDismiss} />);
    expect(screen.getByText("Child details")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Child anchor" }), { key: "Escape" });
    expect(childDismiss).toHaveBeenCalledWith("escape");
    expect(parentDismiss).not.toHaveBeenCalled();
  });

  it("treats a pointer inside a nested inspector as part of its parent, which closes only for a pointer outside both", () => {
    const parentDismiss = vi.fn(), childDismiss = vi.fn();
    render(<NestedInspectors onParentDismiss={parentDismiss} onChildDismiss={childDismiss} />);
    // The child portals to the body, outside the parent's own element.
    const childPanel = screen.getByText("Child details").closest('[role="tooltip"]')!;
    fireEvent.pointerDown(childPanel);
    expect(parentDismiss).not.toHaveBeenCalled();
    expect(childDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(parentDismiss).toHaveBeenCalledWith("outside");
    expect(childDismiss).toHaveBeenCalledWith("outside");
  });
});

describe("focus restore", () => {
  it("returns focus to the trigger when Escape closes a pinned panel that held focus, without reopening it", () => {
    render(<ObservationDetails label="Inspect value" details={<button>Details action</button>}>42</ObservationDetails>);
    const trigger = screen.getByRole("button", { name: "Inspect value" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    const action = screen.getByRole("button", { name: "Details action" });
    act(() => action.focus());
    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Details action" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Details action" })).not.toBeInTheDocument();
  });

  it("returns focus to the trigger when the Close control of a minimised inspector is used", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    stubBoxes(element => {
      if (element.hasAttribute("data-tooltip-obstacle")) return new DOMRect(0, 0, 390, 230);
      if (element.dataset.widgetId === "owner") return new DOMRect(20, 240, 350, 300);
      if (element.dataset.widgetId === "neighbor") return new DOMRect(20, 550, 350, 250);
      if (element.id === "narrow") return element.dataset.inspectorMinimized ? new DOMRect(0, 0, 160, 38) : new DOMRect(0, 0, 300, 180);
      return new DOMRect(100, 300, 20, 20);
    });
    render(<><header data-tooltip-obstacle>Filters</header><article data-widget-id="owner"><button>Point</button></article><article data-widget-id="neighbor">Next chart</article></>);
    const anchor = screen.getByRole("button", { name: "Point" });
    const dismiss = vi.fn();
    render(<ObservationTooltip id="narrow" anchor={anchor} avoidWidget pinned onDismiss={dismiss}><span>Recorded 42</span></ObservationTooltip>);
    fireEvent.click(await screen.findByRole("button", { name: "Minimize inspector" }));
    const close = screen.getByRole("button", { name: "Close inspector" });
    act(() => close.focus());
    fireEvent.click(close);
    expect(dismiss).toHaveBeenCalledWith("close");
    expect(anchor).toHaveFocus();
  });

  it("does not move focus when a pinned panel is dismissed by a pointer outside it", () => {
    render(<ObservationDetails label="Inspect value" details={<button>Details action</button>}>42</ObservationDetails>);
    const trigger = screen.getByRole("button", { name: "Inspect value" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    act(() => screen.getByRole("button", { name: "Details action" }).focus());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Pinned · tap again to close")).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it("closes a transient preview when focus moves to another control, and keeps that control focused", () => {
    render(<><ObservationDetails label="Inspect value" details={<span>Preview details</span>}>42</ObservationDetails><button>Next control</button></>);
    const trigger = screen.getByRole("button", { name: "Inspect value" }), next = screen.getByRole("button", { name: "Next control" });
    act(() => trigger.focus());
    expect(screen.getByText("Preview details")).toBeInTheDocument();
    act(() => next.focus());
    expect(screen.queryByText("Preview details")).not.toBeInTheDocument();
    expect(next).toHaveFocus();
  });
});

describe("placement options", () => {
  const anchorBox = new DOMRect(400, 400, 20, 20), panelBox = new DOMRect(0, 0, 200, 120);
  const mountPanel = (options?: Parameters<typeof ObservationTooltip>[0]["options"]) => {
    const anchor = document.createElement("button");
    anchor.textContent = "Point";
    document.body.append(anchor);
    render(<ObservationTooltip id="placed" anchor={anchor} options={options} onDismiss={() => {}}>Details</ObservationTooltip>);
    return screen.getByRole("tooltip");
  };

  it("keeps the default placement when no option is set", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    stubBoxes(element => element.getAttribute("role") === "tooltip" ? panelBox : anchorBox);
    const tooltip = mountPanel();
    expect(tooltip).toHaveAttribute("data-placement", "bottom");
    expect(tooltip.style.maxWidth).toBe("1000px");
  });

  it("applies a preferred side, a gap and a maximum width", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    stubBoxes(element => element.getAttribute("role") === "tooltip" ? panelBox : anchorBox);
    const tooltip = mountPanel({ placement: "top", offset: 20, maxWidth: 260 });
    expect(tooltip).toHaveAttribute("data-placement", "top");
    // The panel sits 20px above the anchor: 400 - 20 - 120.
    expect(tooltip.style.top).toBe("260px");
    expect(tooltip.style.maxWidth).toBe("260px");
  });

  it("clamps a requested maximum width to the visual viewport", () => {
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 700);
    stubBoxes(element => element.getAttribute("role") === "tooltip" ? panelBox : anchorBox);
    expect(mountPanel({ maxWidth: 900 }).style.maxWidth).toBe("296px");
  });

  it("flips a preferred side that has no room, instead of leaving the viewport", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    stubBoxes(element => element.getAttribute("role") === "tooltip" ? panelBox : new DOMRect(400, 20, 20, 20));
    expect(mountPanel({ placement: "top", offset: 20 })).toHaveAttribute("data-placement", "bottom");
  });
});

describe("dismissal", () => {
  it("dismisses with the reason outside when the pointer leaves, even while pinned", () => {
    const dismiss = vi.fn();
    render(<button>Point</button>);
    const anchor = screen.getByRole("button", { name: "Point" });
    render(<ObservationTooltip id="pinned-outside" anchor={anchor} pinned onDismiss={dismiss}>Details</ObservationTooltip>);
    fireEvent.pointerDown(anchor);
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(dismiss).toHaveBeenCalledWith("outside");
  });

  it("keeps the panel open for a pointer inside it, and leaves Escape to a Gamma menu that is open", () => {
    const dismiss = vi.fn();
    render(<button>Point</button>);
    const anchor = screen.getByRole("button", { name: "Point" });
    render(<ObservationTooltip id="inside" anchor={anchor} onDismiss={dismiss}><button>Inner</button></ObservationTooltip>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inner" }));
    expect(dismiss).not.toHaveBeenCalled();
    const menu = document.createElement("div");
    menu.setAttribute("data-gamma-portal", "");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(menu);
    fireEvent.keyDown(item, { key: "Escape" });
    expect(dismiss).not.toHaveBeenCalled();
  });
});
