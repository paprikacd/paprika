import { vi } from "vitest"
import type { InsightsClient } from "./client"
import type { Dashboard } from "./schema"

export const liveDashboard: Dashboard = {
  widgets: [{ id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
  refreshInterval: 0,
  timeRange: "1h",
  title: "Dashboard A",
  id: "a",
  schemaVersion: 1,
}

export function liveClient(overrides: Partial<InsightsClient> = {}): InsightsClient {
  return {
    providers: vi.fn().mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]),
    list: vi.fn().mockResolvedValue([liveDashboard]),
    get: vi.fn(async () => ({ dashboard: liveDashboard, etag: '"v1"' })),
    save: vi.fn().mockResolvedValue('"v2"'),
    remove: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ series: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]),
    saveProvider: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true, durationMs: 1, message: "Connected" }),
    metadata: vi.fn().mockResolvedValue({ values: [] }),
    ...overrides,
  }
}

/** Mirrors insights-app.test.tsx: the canvas is replaced so tests drive the focused editor directly. */
export const canvasMock = () => ({
  DashboardCanvas: ({ focus, dashboard, editing, onSelect }: {
    focus?: { render: (preview: import("react").ReactNode) => import("react").ReactNode }
    dashboard: Dashboard
    editing: boolean
    onSelect: (id: string) => void
  }) => focus ? focus.render(<div data-testid="mock-canvas" />) : <div data-testid="mock-canvas">
    {editing && dashboard.widgets.map(widget => <button key={widget.id} onClick={() => onSelect(widget.id)}>Edit {widget.title}</button>)}
  </div>,
})
