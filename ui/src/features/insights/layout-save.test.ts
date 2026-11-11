import { describe, expect, it, vi } from "vitest"

import { createBundleImporter, type BundleImportRequest } from "./bundle-import"
import { createInsightsClient } from "./client"
import type { Dashboard, Provider } from "./schema"
import { buildDashboardBundle } from "./workspace-transfer"

// A small stand-in for the Insights API. It enforces what the server enforces on
// a save: no two widgets share a grid cell, and the conditional-write headers. The
// real client talks to it through fetch, so these tests cover the request the UI sends.
type Box = { x: number; y: number; w: number; h: number }
function overlapping(dashboard: Dashboard): [string, string] | undefined {
  const widgets = dashboard.widgets
  for (let j = 0; j < widgets.length; j++) {
    for (let i = 0; i < j; i++) {
      const a: Box = widgets[i].layout, b: Box = widgets[j].layout
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return [widgets[i].id, widgets[j].id]
    }
  }
  return undefined
}

function emulator(initial: Dashboard[] = []) {
  let counter = 0
  const tag = () => `"${(++counter).toString(16).padStart(64, "0")}"`
  const stored = new Map<string, { value: Dashboard; etag: string }>()
  for (const dashboard of initial) stored.set(dashboard.id, { value: structuredClone(dashboard), etag: tag() })
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://insights.test").pathname.replace(/^\/api\/insights/, "")
    const method = init?.method ?? "GET"
    if (path === "/saved-queries" && method === "GET") return json({ queries: [] })
    if (path === "/dashboards" && method === "GET") return json({ dashboards: [...stored.values()].map(entry => entry.value) })
    const match = /^\/dashboards\/([^/]+)$/.exec(path)
    if (!match) return json({ error: "not emulated" }, 404)
    const id = decodeURIComponent(match[1])
    const current = stored.get(id)
    if (method === "GET") return current ? json(current.value, 200, { ETag: current.etag }) : json({ error: "dashboard not found" }, 404)
    if (method !== "PUT") return json({ error: "not emulated" }, 405)
    const headers = new Headers(init?.headers)
    if (headers.get("If-None-Match") === "*" && current) return json({ error: "document already exists" }, 412)
    if (headers.get("If-Match") && headers.get("If-Match") !== current?.etag) return json({ error: "document changed" }, 412)
    const body = JSON.parse(String(init?.body)) as Dashboard
    const pair = overlapping(body)
    if (pair) {
      return json({ error: `widget "${pair[1]}" overlaps widget "${pair[0]}"`, issues: [], total: 1, truncated: false }, 400)
    }
    const etag = tag()
    stored.set(id, { value: structuredClone(body), etag })
    return json(body, 200, { ETag: etag })
  })
  return { fetcher, stored }
}

// A dashboard saved before the layout rule was enforced for the UI: its widgets overlap.
const overlappingDashboard: Dashboard = {
  schemaVersion: 1, id: "overlap", title: "Overlap", timeRange: "1h", refreshInterval: 0,
  widgets: [
    { id: "requests", title: "Requests", type: "timeseries", providerId: "prom", query: "up", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 } },
    { id: "latency", title: "Latency", type: "timeseries", providerId: "prom", query: "up", unit: "ms", layout: { x: 4, y: 0, w: 6, h: 4 } },
  ],
}

describe("saving the layout as the canvas draws it", () => {
  it("loads a stored overlapping dashboard and saves a title edit", async () => {
    const server = emulator([overlappingDashboard])
    vi.stubGlobal("fetch", server.fetcher)
    try {
      const client = createInsightsClient("/api/insights", () => "token")
      const loaded = await client.get("overlap")
      // The server would reject the stored layout as it stands.
      expect(overlapping(loaded.dashboard)).toEqual(["requests", "latency"])
      const etag = await client.save({ ...loaded.dashboard, title: "Renamed" }, loaded.etag)
      expect(etag).toBeDefined()
      const stored = server.stored.get("overlap")!.value
      expect(stored.title).toBe("Renamed")
      expect(overlapping(stored)).toBeUndefined()
      expect(stored.widgets.map(widget => widget.layout)).toEqual([
        { x: 0, y: 0, w: 6, h: 4 },
        { x: 4, y: 4, w: 6, h: 4 },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("sends a dashboard that is already drawn byte-identical to the one the UI holds", async () => {
    const drawn: Dashboard = {
      ...overlappingDashboard, id: "drawn",
      widgets: [
        { ...overlappingDashboard.widgets[0], layout: { x: 0, y: 0, w: 6, h: 4 } },
        { ...overlappingDashboard.widgets[1], layout: { x: 6, y: 0, w: 6, h: 4 } },
      ],
    }
    const server = emulator([])
    vi.stubGlobal("fetch", server.fetcher)
    try {
      const client = createInsightsClient("/api/insights", () => "token")
      await client.save(drawn)
      const put = server.fetcher.mock.calls.map(([, init]) => init).find(init => init?.method === "PUT")!
      expect(put.body).toBe(JSON.stringify(drawn))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("confirms an overlapping bundle whose acknowledgement was lost after the write", async () => {
    const providers: Provider[] = [{ id: "prom", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]
    const server = emulator([])
    vi.stubGlobal("fetch", server.fetcher)
    try {
      const client = createInsightsClient("/api/insights", () => "token")
      // The write reaches the server, then the response is lost. The importer must read the dashboard back and
      // compare it with what it meant to write, so the target it fingerprints has to be the layout that was stored.
      const lostAcknowledgement = {
        ...client,
        save: async (item: Dashboard, etag?: string) => {
          await client.save(item, etag)
          throw new Error("Connection reset after the write")
        },
      }
      const saved: Dashboard[] = []
      const environment = {
        client: lostAcknowledgement, providers, dashboards: [], onQueriesChange: vi.fn(),
        onDashboardSaved: vi.fn((item: Dashboard) => { saved.push(item) }),
      }
      const result = await createBundleImporter()({
        sessionId: "lost-acknowledgement",
        bundle: buildDashboardBundle([overlappingDashboard], []),
        providerMapping: { prom: "prom" },
        queryChoices: {},
      }, environment)
      expect(result).toMatchObject({ complete: true, added: 1, errors: [] })
      expect(overlapping(server.stored.get(saved[0].id)!.value)).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("imports an old overlapping bundle completely through the real client", async () => {
    const providers: Provider[] = [{ id: "prom", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]
    const server = emulator([])
    vi.stubGlobal("fetch", server.fetcher)
    try {
      const client = createInsightsClient("/api/insights", () => "token")
      const run = createBundleImporter()
      const saved: Dashboard[] = []
      const environment = {
        client, providers, dashboards: [], onQueriesChange: vi.fn(),
        onDashboardSaved: vi.fn((item: Dashboard) => { saved.push(item) }),
      }
      const request: BundleImportRequest = {
        sessionId: "overlap-bundle",
        bundle: buildDashboardBundle([overlappingDashboard], []),
        providerMapping: { prom: "prom" },
        queryChoices: {},
      }
      const result = await run(request, environment)
      expect(result).toMatchObject({ complete: true, added: 1, errors: [] })
      expect(saved).toHaveLength(1)
      const stored = server.stored.get(saved[0].id)!.value
      expect(overlapping(stored)).toBeUndefined()
      expect(stored.widgets.map(widget => widget.title)).toEqual(["Requests", "Latency"])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
