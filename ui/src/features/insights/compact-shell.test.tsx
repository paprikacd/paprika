import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import InsightsApp from "./insights-app";
import type { InsightsClient } from "./client";
import type { Dashboard } from "./schema";

vi.mock("./canvas", () => ({ DashboardCanvas: ({ referenceCompact }: { referenceCompact?: boolean }) => <div data-testid="canvas" data-reference-compact={referenceCompact || undefined} /> }));
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

function setup({ dense = true, theme = "dark", width = 1440, fine = true } = {}) {
  window.history.replaceState(null, "", "/dashboard/insights/");
  window.localStorage.setItem("paprika-insights-compact-view", String(dense));
  window.localStorage.setItem("paprika-insights-theme", theme);
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    matches: query === "(min-width: 1024px)" ? width >= 1024 : query === "(max-width: 950px)" ? width <= 950 : query === "(pointer: fine)" ? fine : false,
    media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  const dashboard: Dashboard = { schemaVersion: 1, id: "edge", title: "Edge Watch", description: "Synthetic local observations; no production traffic.", widgets: [{ id: "stat", type: "stat", title: "Observed", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 1 } }], refreshInterval: 0, timeRange: "1h" };
  const client: InsightsClient = {
    providers: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([dashboard]),
    get: vi.fn().mockResolvedValue({ dashboard, etag: '"v1"' }), save: vi.fn(), remove: vi.fn(), query: vi.fn(),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(), metadata: vi.fn().mockResolvedValue({ values: [] }),
  };
  const before = JSON.stringify(dashboard);
  const view = render(<InsightsApp client={client} />);
  return { ...view, client, dashboard, before };
}

it("honors stored compact intent with an expandable rail and accessible context without saving documents", async () => {
  const { container, client, dashboard, before } = setup();
  await screen.findByRole("heading", { name: "Edge Watch" });
  const root = container.querySelector('[data-insights-theme="dark"]')!;
  expect(root).toHaveAttribute("data-density", "compact");
  expect(root).toHaveAttribute("data-compact-shell", "true");
  const navigation = screen.getByRole("complementary", { name: "Insights navigation" });
  expect(navigation).toHaveAttribute("data-navigation-expanded", "false");
  const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(navigation).toHaveAttribute("data-navigation-expanded", "true");
  fireEvent.click(toggle);
  expect(navigation).toHaveAttribute("data-navigation-expanded", "false");
  expect(screen.getByText("Dashboard context")).toBeInTheDocument();
  expect(screen.getByText(dashboard.description!)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit dashboard" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Compact view" }));
  await waitFor(() => expect(root).toHaveAttribute("data-density", "standard"));
  expect(root).not.toHaveAttribute("data-compact-shell");
  expect(toggle).toHaveAttribute("aria-expanded", "true"); // Ordinary sidebar preference survived.
  expect(client.save).not.toHaveBeenCalled();
  expect(JSON.stringify(dashboard)).toBe(before);
});

it.each([{ dense: false, theme: "dark", width: 1440 }, { dense: true, theme: "light", width: 1440 }, { dense: true, theme: "dark", width: 1000 }, { dense: true, theme: "dark", width: 390 }])("retains ordinary chrome outside dark compact desktop: %j", async options => {
  const { container } = setup(options);
  await screen.findByRole("heading", { name: "Edge Watch" });
  expect(container.querySelector("[data-compact-shell]")).toBeNull();
  expect(screen.queryByText("Dashboard context")).not.toBeInTheDocument();
  expect(screen.getByText("Synthetic local observations; no production traffic.")).toBeVisible();
});

it("leaves compact chrome while editing without clearing the stored preference", async () => {
  const { container, client } = setup();
  await screen.findByRole("heading", { name: "Edge Watch" });
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
  expect(await screen.findByLabelText("Dashboard title")).toHaveValue("Edge Watch");
  expect(container.querySelector("[data-compact-shell]")).toBeNull();
  expect(window.localStorage.getItem("paprika-insights-compact-view")).toBe("true");
  expect(client.save).not.toHaveBeenCalled();
});

it.each([true, false])("limits tighter calendar/state layout to fine-pointer compact desktop (%s)", async fine => {
  setup({ fine });
  await screen.findByRole("heading", { name: "Edge Watch" });
  if (fine) expect(screen.getByTestId("canvas")).toHaveAttribute("data-reference-compact", "true");
  else expect(screen.getByTestId("canvas")).not.toHaveAttribute("data-reference-compact");
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
  expect(screen.getByTestId("canvas")).not.toHaveAttribute("data-reference-compact");
});
