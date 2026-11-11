import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StarterSummary } from "./client";
import { dashboardSchema, type Dashboard, type Provider } from "./schema";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { StarterPicker, type StarterPickerProps } from "./starter-picker";
import { parseDashboardBundle, type DashboardBundle } from "./workspace-transfer";
import type { BundleImportReview } from "./bundle-import";

const startersDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../internal/insights/starters");
const starterFiles = readdirSync(startersDir).filter((name) => name.endsWith(".json")).sort();
const documents = new Map(
  starterFiles.map((name) => [
    name.replace(/\.json$/, ""),
    JSON.parse(readFileSync(join(startersDir, name), "utf8")) as Dashboard & { description?: string },
  ]),
);

/** The portable bundle the server returns for a starter, checked by the browser's own parser. */
function bundleFor(id: string): DashboardBundle {
  return parseDashboardBundle(
    JSON.stringify({ kind: "PaprikaDashboardLibrary", schemaVersion: 1, dashboards: [documents.get(id)] }),
    "json",
  );
}

function summaryFor(id: string): StarterSummary {
  const document = documents.get(id)! as unknown as {
    title: string;
    description: string;
    variables?: { name: string }[];
    widgets: { type: string; dataKind?: string; layout: { x: number; y: number; w: number; h: number } }[];
  };
  return {
    id,
    title: document.title,
    description: document.description,
    widgetCount: document.widgets.length,
    variables: (document.variables ?? []).map((variable) => variable.name),
    providers: [...new Set(document.widgets.map((widget) => widget.dataKind ?? "metrics"))],
    tiles: document.widgets.map((widget) => ({ type: widget.type, ...widget.layout })),
  };
}

const providers: Provider[] = [{ id: "metrics-provider-id", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }];
const review: BundleImportReview = { dashboards: [], queries: [] };

function renderPicker(overrides: Partial<StarterPickerProps> = {}) {
  const props: StarterPickerProps = {
    providers,
    listStarters: vi.fn(async () => [...documents.keys()].sort().map(summaryFor)),
    getStarter: vi.fn(async (id: string) => bundleFor(id)),
    onReviewBundle: vi.fn(async () => review),
    onImportBundle: vi.fn(),
    onRefreshQueries: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}}>
      <StarterPicker {...props} />
    </SavedQueryLibraryProvider>,
  );
  return props;
}

describe("starter picker", () => {
  it("lists each starter with its title, a thumbnail of its widgets, and what it needs", async () => {
    renderPicker();
    const list = await screen.findByRole("list", { name: "Templates" });
    const cards = within(list).getAllByRole("button");
    expect(cards).toHaveLength(documents.size);
    const service = within(list).getByRole("button", { name: /^Service overview/ });
    expect(service.querySelector("small")).toHaveTextContent(/^5 widgets · needs metrics · variables service, namespace$/);
    const thumbnail = service.querySelector('[data-testid="starter-thumbnail"]') as HTMLElement;
    expect(thumbnail.getAttribute("aria-hidden")).toBe("true");
    expect(thumbnail.querySelectorAll("[data-tile]")).toHaveLength(5);
    // The thumbnail places tiles on the 12-column grid, so the first tile starts at the left edge.
    expect((thumbnail.querySelector("[data-tile]") as HTMLElement).style.left).toBe("0%");
  });

  it("hands the chosen starter's bundle to the import review and saves nothing itself", async () => {
    const props = renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /^SLO and burn rate/ }));
    await waitFor(() => expect(props.onReviewBundle).toHaveBeenCalledTimes(1));
    expect(props.getStarter).toHaveBeenCalledWith("slo-burn-rate");
    const reviewed = vi.mocked(props.onReviewBundle!).mock.calls[0][0];
    expect(reviewed.dashboards.map((dashboard) => dashboard.id)).toEqual(["slo-burn-rate"]);
    expect(reviewed.dashboards[0].widgets).toHaveLength(4);
    expect(props.onImportBundle).not.toHaveBeenCalled();
  });

  it("returns to the list from a chosen starter and closes", async () => {
    const props = renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /^Namespace capacity/ }));
    await waitFor(() => expect(props.onReviewBundle).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /All templates/ }));
    expect(await screen.findByRole("list", { name: "Templates" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close templates" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a template that cannot be loaded and leaves the list usable", async () => {
    const props = renderPicker({
      getStarter: vi.fn(async () => {
        throw new Error("Starter service is unavailable.");
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Service overview/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Starter service is unavailable.");
    expect(props.onReviewBundle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /All templates/ }));
    expect(await screen.findByRole("list", { name: "Templates" })).toBeInTheDocument();
  });

  it("reports a failed listing with its reason", async () => {
    renderPicker({ listStarters: vi.fn(async () => { throw new Error("Templates cannot be listed right now."); }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Templates cannot be listed right now.");
  });

  it("shows only the most recent choice when an earlier template arrives late", async () => {
    let resolveFirst: (bundle: DashboardBundle) => void = () => {};
    const getStarter = vi.fn((id: string) =>
      id === "service-overview"
        ? new Promise<DashboardBundle>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(bundleFor(id)),
    );
    const props = renderPicker({ getStarter });
    fireEvent.click(await screen.findByRole("button", { name: /^Service overview/ }));
    fireEvent.click(screen.getByRole("button", { name: /All templates/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Namespace capacity/ }));
    await waitFor(() => expect(props.onReviewBundle).toHaveBeenCalledTimes(1));
    resolveFirst(bundleFor("service-overview"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(props.onReviewBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onReviewBundle!).mock.calls[0][0].dashboards[0].id).toBe("namespace-capacity");
  });

  it("every embedded starter parses in the browser's dashboard schema", () => {
    expect(starterFiles.length).toBeGreaterThanOrEqual(4);
    for (const [id, document] of documents) {
      expect(() => dashboardSchema.parse(document), id).not.toThrow();
      expect(documents.get(id)).toHaveProperty("id", id);
    }
  });
});
