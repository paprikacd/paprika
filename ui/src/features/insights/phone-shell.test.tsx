import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InsightsApp from "./insights-app";
import type { InsightsClient } from "./client";
import type { Dashboard } from "./schema";

vi.mock("./canvas", () => ({ DashboardCanvas: () => <div data-testid="canvas" /> }));
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

function setup({ width = 390, customTimeRange, variables, description = "Synthetic local observations." }: { width?: number; customTimeRange?: Dashboard["customTimeRange"]; variables?: Dashboard["variables"]; description?: string } = {}) {
  window.history.replaceState(null, "", "/dashboard/insights/");
  window.localStorage.setItem("paprika-insights-compact-view", "false");
  window.localStorage.setItem("paprika-insights-theme", "light");
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    matches: query === "(max-width: 600px)" ? width <= 600
      : query === "(max-width: 950px)" ? width <= 950
      : false,
    media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  const dashboard: Dashboard = {
    schemaVersion: 1, id: "edge", title: "Edge Watch", description,
    widgets: [{ id: "stat", type: "stat", title: "Observed", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 1 } }],
    refreshInterval: 0, timeRange: "1h", ...(customTimeRange ? { customTimeRange } : {}), ...(variables ? { variables } : {}),
  };
  const client: InsightsClient = {
    providers: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([dashboard]),
    get: vi.fn().mockResolvedValue({ dashboard, etag: '"v1"' }), save: vi.fn(), remove: vi.fn(), query: vi.fn(),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(), metadata: vi.fn().mockResolvedValue({ values: [] }),
  };
  const view = render(<InsightsApp client={client} />);
  return { ...view, client };
}

async function openPhoneMenu() {
  const trigger = await screen.findByRole("button", { name: "Dashboard actions" });
  fireEvent.click(trigger);
  return { trigger, menu: await screen.findByRole("menu", { name: "Dashboard actions" }) };
}

describe("phone shell header", () => {
  it("keeps the title and one Dashboard actions menu, without the canvas tools row", async () => {
    const { container, client } = setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const root = container.querySelector("[data-insights-theme]")!;
    expect(root).toHaveAttribute("data-phone-shell", "true");
    expect(screen.getAllByRole("button", { name: "Dashboard actions" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dashboard as code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Query inspector" })).not.toBeInTheDocument();
    expect(screen.queryByText("Canvas")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ widgets?$/)).not.toBeInTheDocument();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("lists the actions in groups, with Edit first", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    const names = [...menu.querySelectorAll("[role^='menuitem']")].map(item => item.getAttribute("data-label"));
    expect(names).toEqual([
      "Edit dashboard", "Dashboard as code", "Query inspector",
      "Manage dashboards", "Build with AI",
      "Auto refresh off", "Every 15 s", "Every 30 s", "Every 1 min",
    ]);
    expect(within(screen.getByRole("group", { name: "Dashboard" })).getAllByRole("menuitem")).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "Workspace" })).getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitemradio", { name: "Auto refresh off" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Every 15 s" })).toHaveAttribute("aria-checked", "false");
  });

  it("opens the menu from the keyboard and returns focus to the trigger on Escape", async () => {
    setup();
    const trigger = await screen.findByRole("button", { name: "Dashboard actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Edit dashboard" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit dashboard" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("Edit from the menu focuses the dashboard title and shows the save action", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit dashboard" }));
    const title = await screen.findByLabelText("Dashboard title");
    expect(title).toHaveValue("Edge Watch");
    expect(title).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).not.toBeInTheDocument();
  });

  it("hides the Keyboard shortcuts hint while editing at phone width", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit dashboard" }));
    await screen.findByLabelText("Dashboard title");
    expect(screen.getByText("Editing canvas", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("Save returns focus to the Dashboard actions trigger, not the page body", async () => {
    const { client } = setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit dashboard" }));
    await screen.findByLabelText("Dashboard title");
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(client.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByLabelText("Dashboard title")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Dashboard actions" })).toHaveFocus();
  });

  it("returns focus to the menu trigger when the query inspector closes", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { trigger, menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Query inspector" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close query inspector" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to the menu trigger when the manage panel closes", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { trigger, menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Manage dashboards" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close dashboard manager" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("changes auto refresh from the menu as a view change, not a document edit", async () => {
    const { client } = setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Every 15 s" }));
    await openPhoneMenu();
    expect(screen.getByRole("menuitemradio", { name: "Every 15 s" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Auto refresh off" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("disables the auto refresh choices under a fixed custom range", async () => {
    setup({ customTimeRange: { from: "2026-11-19T00:00:00Z", to: "2026-11-19T06:00:00Z" } });
    await screen.findByRole("heading", { name: "Edge Watch" });
    const { menu } = await openPhoneMenu();
    const radio = within(menu).getByRole("menuitemradio", { name: /Every 15 s/ });
    expect(radio).toHaveAttribute("aria-disabled", "true");
    expect(radio).toHaveTextContent("Fixed custom range");
    expect(within(menu).getByRole("menuitemradio", { name: /Auto refresh off/ })).toHaveAttribute("aria-checked", "false");
  });
});

describe("phone control row", () => {
  it("holds the time range select and refresh in one group, without the calendar button or auto refresh select", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const group = screen.getByRole("group", { name: "Dashboard view" });
    expect(within(group).getByRole("combobox", { name: "Time range" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Refresh data" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose custom time range" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Auto refresh" })).not.toBeInTheDocument();
  });

  it("chooses a custom range from the select and returns focus to the select on Escape", async () => {
    setup();
    await screen.findByRole("heading", { name: "Edge Watch" });
    const select = screen.getByRole("combobox", { name: "Time range" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "Custom range…" }));
    const popover = await screen.findByRole("region", { name: "Custom time range" });
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(select).toHaveFocus();
  });

  it("shows the variables chip in the control row and returns focus to it from the sheet", async () => {
    setup({ variables: [{ name: "cluster", label: "Cluster", options: ["omega", "alpha"], defaultValue: "omega" }] });
    await screen.findByRole("heading", { name: "Edge Watch" });
    const group = screen.getByRole("group", { name: "Dashboard view" });
    const chip = within(group).getByRole("button", { name: /^Dashboard variables:/ });
    fireEvent.click(chip);
    const sheet = await screen.findByRole("dialog", { name: "Dashboard variables" });
    fireEvent(sheet, new Event("cancel", { cancelable: true }));
    expect(chip).toHaveFocus();
  });

  it("clamps the description to two lines with the full text in the page, and no disclosure", async () => {
    const description = "Synthetic local observations. Node readiness is independently sampled; missing samples remain unknown.";
    setup({ description });
    await screen.findByRole("heading", { name: "Edge Watch" });
    expect(screen.queryByText("Dashboard context")).not.toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });
});

describe("description clamp in the app", () => {
  const description = "Synthetic local observations. Node readiness is independently sampled; missing samples remain unknown.";

  // jsdom has no layout: report the description as taller than its two-line box, so the clamp offers More.
  function stubOverflow() {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(34);
  }

  it.each([390, 800])("offers More at %ipx, wired to the full description", async (width) => {
    stubOverflow();
    setup({ width, description });
    await screen.findByRole("heading", { name: "Edge Watch" });
    const more = await screen.findByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-controls", screen.getByText(description).id);
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the plain description at desktop width, with no More", async () => {
    stubOverflow();
    setup({ width: 1512, description });
    await screen.findByRole("heading", { name: "Edge Watch" });
    expect(screen.getByText(description).tagName).toBe("P");
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});

describe("tablet width keeps the full header", () => {
  it("shows Edit as a visible button and only the Manage, Build with AI and Keyboard shortcuts menu items", async () => {
    const { container } = setup({ width: 800 });
    await screen.findByRole("heading", { name: "Edge Watch" });
    expect(container.querySelector("[data-phone-shell]")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit dashboard" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose custom time range" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Auto refresh" })).toBeInTheDocument();
    const { menu } = await openPhoneMenu();
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Manage dashboards", "Build with AI", "Keyboard shortcuts"]);
    expect(within(menu).queryByRole("group")).not.toBeInTheDocument();
  });
});
