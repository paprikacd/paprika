import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import { EXAMPLE_STORAGE_KEY, readExampleWorkspace, writeExampleWorkspace } from "./example-storage"
import { dashboardSchema, writableDashboard, type Dashboard } from "./schema"

vi.mock("./canvas", () => ({
  DashboardCanvas: () => <div data-testid="mock-canvas" />,
}))

const healthy: Dashboard = { schemaVersion: 1, id: "healthy", title: "Healthy example", timeRange: "1h", refreshInterval: 0, widgets: [] }
// A stored zone the canonical list lacks, as an example saved by an older build could hold it.
const stale: Dashboard = { ...healthy, id: "stale", title: "Stale zone example", timeZone: "Factory" }

// Example mode never reaches the server, so the client is only there to satisfy the app's props.
function client(): InsightsClient {
  return {
    providers: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    query: vi.fn().mockResolvedValue({ series: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]),
    saveProvider: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true, durationMs: 1, message: "Connected" }),
    metadata: vi.fn().mockResolvedValue({ values: [] }),
  }
}

afterEach(() => {
  localStorage.clear();
});

describe("copying an example whose stored time zone the canonical list lacks", () => {
  it("opens every example, duplicates the stale one without a zone error, and saves the copy without the stale zone", async () => {
    localStorage.setItem(EXAMPLE_STORAGE_KEY, JSON.stringify({ dashboards: [healthy, stale], activeId: stale.id }));
    render(<InsightsApp client={client()} initialExample />);
    await screen.findByRole("heading", { name: stale.title });

    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText("Dashboard duplicated. Save it to add the copy to your library.");
    expect(screen.queryByText(/IANA time zone/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }));
    await screen.findByText("Example saved in this browser.");
    const dashboards = readExampleWorkspace(localStorage).dashboards;
    const copy = dashboards.find((item) => item.title === `${stale.title} (copy)`);
    expect(copy?.timeZone).toBeUndefined();
    // The original keeps its stored value: copying changes only the copy.
    expect(dashboards.find((item) => item.id === stale.id)?.timeZone).toBe("Factory");
  });
});

describe("writableDashboard", () => {
  it("keeps a canonical zone and an absent zone as they are", () => {
    expect(writableDashboard({ ...healthy, timeZone: "Europe/London" }).timeZone).toBe("Europe/London");
    expect(writableDashboard(healthy).timeZone).toBeUndefined();
  });

  it("unsets a stored zone the canonical list lacks, so the result saves", () => {
    const copy = writableDashboard({ ...stale, id: "copy" });
    expect(copy.timeZone).toBeUndefined();
    expect(dashboardSchema.safeParse(copy).success).toBe(true);
  });

  it("still refuses an invalid field, because only the zone is exempt", () => {
    expect(() => writableDashboard({ ...stale, timeRange: "bogus" })).toThrow();
  });
});

describe("writing an example workspace beside a stale example", () => {
  it("deletes another example without failing on the stale zone, and keeps that zone as stored", () => {
    const store = {
      getItem: () => JSON.stringify({ dashboards: [healthy, stale], activeId: stale.id }),
      setItem: vi.fn(),
    };
    const workspace = readExampleWorkspace(store);
    expect(workspace.dashboards.find((item) => item.id === stale.id)?.timeZone).toBe("Factory");
    writeExampleWorkspace(store, workspace.dashboards.filter((item) => item.id !== healthy.id), stale.id);
    const [written] = JSON.parse(store.setItem.mock.calls[0][1]).dashboards;
    expect(written.id).toBe(stale.id);
    expect(written.timeZone).toBe("Factory");
  });
});
