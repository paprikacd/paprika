import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard, Drilldown } from "./schema"
import type { DrilldownBinding } from "./schema"
import type { DrilldownContext } from "./drilldown"
import { writeExampleWorkspace } from "./example-storage"

// Characterisation of every URL and history write the workspace makes for its
// main flows. The recorder wraps the real History API, so the expectations pin
// what the browser receives: push versus replace, the URL, and the order.
// Edit-mode and dirty transitions are recorded alongside each step.

vi.mock("./canvas", () => ({
  DashboardCanvas: ({ dashboard, onDrilldown, onSelection, onTimeRange }: {
    dashboard: Dashboard
    onDrilldown?: (link: Drilldown, context: DrilldownContext) => void
    onSelection?: (widget: Dashboard["widgets"][number], context: DrilldownContext) => void
    onTimeRange?: (window: { start: number; end: number }) => void
  }) => {
    const widget = dashboard.widgets[0]
    const link = widget?.drilldowns?.[0]
    return <div>
      {link && onDrilldown && <button onClick={() => onDrilldown(link, { labels: { service: followLabel }, value: 1, series: "api" })}>Follow signal</button>}
      {widget?.selectionBindings?.length && onSelection && <button onClick={() => onSelection(widget, { labels: { env: selectLabel } })}>Select staging</button>}
      {onTimeRange && <button onClick={() => onTimeRange({ start: Date.parse(RANGE.from), end: Date.parse(RANGE.to) })}>Brush window</button>}
    </div>
  },
}))

const RANGE = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" }
// The signal label a drilldown carries into the target's variable.
let followLabel = "api"
// The environment a selection carries; a long value makes the selected link too long to write.
let selectLabel = "staging"
const binding: DrilldownBinding = { variable: "env", source: "label", value: "env" }
const source: Dashboard = {
  schemaVersion: 1, id: "source", title: "Source", timeRange: "1h", refreshInterval: 0, customTimeRange: RANGE,
  variables: [{ name: "env", options: ["prod", "staging"], defaultValue: "prod" }],
  widgets: [{
    id: "signal", title: "Signal", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 2 },
    selectionBindings: [binding],
    drilldowns: [{ id: "details", title: "Details", dashboardId: "target", bindings: [{ variable: "service", source: "label", value: "service" }] }],
  }],
}
const target: Dashboard = {
  ...source, id: "target", title: "Target", customTimeRange: undefined,
  variables: [{ name: "service", label: "Service", defaultValue: "default" }, { name: "env", options: ["prod", "staging"], defaultValue: "prod" }],
  widgets: [{ ...source.widgets[0], drilldowns: undefined }],
}

function client(): InsightsClient {
  const documents = [source, target]
  return {
    list: vi.fn().mockResolvedValue(documents), providers: vi.fn().mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]),
    get: vi.fn(async id => ({ dashboard: documents.find(item => item.id === id)!, etag: '"v1"' })),
    save: vi.fn().mockResolvedValue('"v2"'), remove: vi.fn(),
    query: vi.fn().mockResolvedValue({ series: [] }), metadata: vi.fn().mockResolvedValue({ values: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(),
  }
}

// Fresh dashboards get random ids; the trace names them once so it stays stable.
const normalise = (text: string) => text.replace(/dashboard-[0-9a-f-]{36}/g, "dashboard-NEW")
const VARS_CHECKOUT = "%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22checkout%22%7D"
const STAGING = "%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D"
const BRUSH = "from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z"

interface Entry { step: string; ops: string[]; url: string; editing: boolean; dirty: boolean }
let entries: Entry[] = []
let ops: string[] = []
let writeText: ReturnType<typeof vi.fn>
let rawReplace: History["replaceState"]

function record(step: string) {
  entries.push({
    step,
    ops: ops.splice(0),
    url: normalise(location.pathname + location.search),
    editing: screen.queryByRole("button", { name: "Save dashboard" }) !== null,
    dirty: screen.queryByText("Unsaved changes") !== null,
  })
}
function setURL(url: string) {
  rawReplace(null, "", url)
}
// Lets confirmations and deferred view writes finish before the trace is read.
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

beforeEach(() => {
  entries = []
  ops = []
  const rawPush = window.history.pushState.bind(window.history)
  rawReplace = window.history.replaceState.bind(window.history)
  setURL("/dashboard/insights/")
  vi.spyOn(window.history, "pushState").mockImplementation((data, unused, url) => {
    ops.push(`push ${normalise(String(url))}`)
    rawPush(data, unused, url)
  })
  vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    ops.push(`replace ${normalise(String(url))}`)
    rawReplace(data, unused, url)
  })
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)
})
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "clipboard")
  localStorage.clear()
})

describe("dashboard view history characterisation", () => {
  it("records the URL, history operation and edit mode for filters, selection, brush, range, refresh and save", async () => {
    setURL("/dashboard/insights/?dashboard=target&vars=%7B%22service%22%3A%22worker%22%7D")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Target" })
    record("load shared link")

    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "checkout" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }))
    record("apply text variable")

    fireEvent.click(screen.getByRole("combobox", { name: "env" }))
    fireEvent.click(screen.getByRole("option", { name: "staging" }))
    record("choose dropdown variable")

    fireEvent.click(screen.getByRole("button", { name: "Select staging" }))
    record("select a signal")

    fireEvent.click(screen.getByRole("combobox", { name: "Auto refresh" }))
    fireEvent.click(screen.getByRole("option", { name: "15s" }))
    record("auto refresh")

    fireEvent.click(screen.getByRole("button", { name: "Brush window" }))
    record("brush a window")

    fireEvent.click(screen.getByRole("combobox", { name: "Time range" }))
    fireEvent.click(screen.getByRole("option", { name: "Last 6 hours" }))
    record("toolbar preset")

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    record("enter edit mode")

    fireEvent.click(screen.getByRole("button", { name: "Set as dashboard default" }))
    record("set view as default")

    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save dashboard" })).not.toBeInTheDocument())
    record("save")

    fireEvent.click(screen.getByRole("button", { name: "Copy dashboard link" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    record("copy link")

    expect(normalise(String(writeText.mock.calls.at(-1)?.[0]))).toBe(`${location.origin}/dashboard/insights/?dashboard=target&vars=${STAGING}&range=6h&refresh=15`)
    expect(entries).toEqual(LIVE_FLOW)
  })

  it("records drilldown pushes, the return link, library navigation, and popstate restores", async () => {
    setURL("/dashboard/insights/?dashboard=source")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Source" })
    record("load source")

    fireEvent.click(screen.getByRole("button", { name: "Follow signal" }))
    await screen.findByRole("heading", { name: "Target" })
    record("drilldown")

    fireEvent.click(screen.getByRole("button", { name: "Back to Source" }))
    await screen.findByRole("heading", { name: "Source" })
    record("return link")

    fireEvent.click(screen.getByRole("button", { name: "Target" }))
    await screen.findByRole("heading", { name: "Target" })
    record("library open")

    await act(async () => {
      setURL("/dashboard/insights/?dashboard=source")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await screen.findByRole("heading", { name: "Source" })
    record("popstate to source")

    await act(async () => {
      setURL("/dashboard/insights/?dashboard=missing")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("linked dashboard is unavailable"))
    record("popstate to a missing dashboard")

    expect(entries).toEqual(DRILLDOWN_FLOW)
  })

  it("keeps the view and reports the limit when a selection cannot be linked", async () => {
    // The shared link is just under the limit; the selected value pushes the address over it.
    selectLabel = "€".repeat(300)
    try {
      setURL(`/dashboard/insights/?dashboard=target&vars=${encodeURIComponent(JSON.stringify({ service: "€".repeat(880) }))}`)
      render(<InsightsApp client={client()} />)
      await screen.findByRole("heading", { name: "Target" })
      record("load near the limit")
      fireEvent.click(screen.getByRole("button", { name: "Select staging" }))
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("exceeds the 8192-character URL limit"))
      record("selection past the limit")
    } finally {
      selectLabel = "staging"
    }

    expect(screen.getByRole("combobox", { name: "env" })).toHaveTextContent("prod")
    expect(entries.map(entry => [entry.step, entry.ops])).toEqual([
      ["load near the limit", [`replace /dashboard/insights/?dashboard=target&vars=${encodeURIComponent(JSON.stringify({ service: "€".repeat(880) }))}`]],
      ["selection past the limit", []],
    ])
  })

  it("keeps the current dashboard when a drilldown cannot be linked under a base path", async () => {
    // The default path fits the address limit; the /paprika prefix does not. The check uses the real path.
    followLabel = "€".repeat(892)
    try {
      setURL("/paprika/dashboard/insights/?dashboard=source")
      render(<InsightsApp client={client()} />)
      await screen.findByRole("heading", { name: "Source" })
      record("load under base path")
      fireEvent.click(screen.getByRole("button", { name: "Follow signal" }))
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("exceeds the 8192-character URL limit"))
      record("drilldown under base path")
    } finally {
      followLabel = "api"
    }

    expect(screen.getByRole("heading", { name: "Source" })).toBeInTheDocument()
    expect(entries.map(entry => [entry.step, entry.ops, entry.url])).toEqual([
      ["load under base path", ["replace /paprika/dashboard/insights/?dashboard=source"], "/paprika/dashboard/insights/?dashboard=source"],
      ["drilldown under base path", [], "/paprika/dashboard/insights/?dashboard=source"],
    ])
  })

  it("keeps a missing shared dashboard in the address bar and records no write", async () => {
    setURL("/dashboard/insights/?dashboard=missing")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Source" })
    expect(screen.getByRole("alert")).toHaveTextContent("linked dashboard is unavailable")
    record("missing dashboard link")

    expect(entries).toEqual(INVALID_LINK_MISSING_FLOW)
  })

  it("opens a link whose variable is no longer declared, drops it with a notice, and corrects the address", async () => {
    setURL("/dashboard/insights/?dashboard=target&vars=%7B%22gone%22%3A%22x%22%7D")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Target" })
    expect(screen.getByText("Ignored link filter “gone”: this dashboard no longer declares it.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    record("undeclared variable link")

    fireEvent.click(screen.getByRole("button", { name: "Dismiss link notice" }))
    expect(screen.queryByText("Ignored link filter “gone”: this dashboard no longer declares it.")).not.toBeInTheDocument()
    expect(entries).toEqual(INVALID_LINK_VARIABLE_FLOW)
  })

  it("prunes view values when undo removes their declarations and resets the view for a new dashboard", async () => {
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Source" })
    record("load without a link")

    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }))
    record("declare a variable")

    fireEvent.change(screen.getByLabelText("variable_1"), { target: { value: "active value" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }))
    record("apply a variable value")

    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(screen.queryByLabelText("variable_1")).not.toBeInTheDocument())
    record("undo the declaration")

    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    await screen.findByRole("button", { name: "Save dashboard" })
    record("new dashboard")

    expect(entries).toEqual(VIEW_RESET_FLOW)
  })

  it("example mode keeps a shared link that cannot be rewritten on screen, leaves the address alone and reports why", async () => {
    writeExampleWorkspace(localStorage, [source, target], source.id)
    const link = `/dashboard/insights/?dashboard=target&vars=${encodeURIComponent(JSON.stringify({ service: "€".repeat(903) }))}&example=1`
    setURL(link)
    render(<InsightsApp client={client()} initialExample />)
    await screen.findByRole("heading", { name: "Target" })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("exceeds the 8192-character URL limit"))
    expect(screen.getByLabelText("Service")).toHaveValue("€".repeat(903))
    record("example long link")

    expect(entries).toEqual([{ step: "example long link", ops: [], url: normalise(link), editing: false, dirty: false }])
  })

  it("example mode flags every view write, and the copied link carries the flag", async () => {
    writeExampleWorkspace(localStorage, [source, target], source.id)
    render(<InsightsApp client={client()} initialExample />)
    await screen.findByRole("heading", { name: "Source" })
    record("open example")

    fireEvent.click(screen.getByRole("button", { name: "Target" }))
    await screen.findByRole("heading", { name: "Target" })
    record("example library open")

    fireEvent.click(screen.getByRole("button", { name: "Copy dashboard link" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    record("example copy link")

    expect(normalise(String(writeText.mock.calls.at(-1)?.[0]))).toBe(`${location.origin}/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22default%22%7D&example=1`)

    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "checkout" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }))
    record("example apply text variable")

    fireEvent.click(screen.getByRole("combobox", { name: "env" }))
    fireEvent.click(screen.getByRole("option", { name: "staging" }))
    record("example choose dropdown variable")

    fireEvent.click(screen.getByRole("button", { name: "Select staging" }))
    record("example select a signal")

    fireEvent.click(screen.getByRole("button", { name: "Brush window" }))
    record("example brush a window")

    fireEvent.click(screen.getByRole("combobox", { name: "Time range" }))
    fireEvent.click(screen.getByRole("option", { name: "Last 6 hours" }))
    record("example toolbar preset")

    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(await screen.findByRole("button", { name: "Remove variable 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }))
    await settle()
    record("example remove a declared variable")

    // The Code panel replaces the whole document, so applyDocument prunes the values it removed.
    fireEvent.click(screen.getByRole("button", { name: "Dashboard as code" }))
    fireEvent.click(screen.getByRole("button", { name: /^JSON$/ }))
    const code = screen.getByLabelText("Dashboard source") as HTMLTextAreaElement
    const next = JSON.parse(code.value) as Dashboard
    delete next.variables
    fireEvent.change(code, { target: { value: JSON.stringify(next) } })
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }))
    await settle()
    record("example document removes every variable")

    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Discard changes" }))
    await settle()
    record("example new dashboard")

    expect(entries).toEqual(EXAMPLE_FLOW)
  })
})

// Expected traces for the view contract in drilldowns.md: filter steps push a Back entry, view
// controls and corrections replace, and a write that leaves the address unchanged adds no entry.
const at = (query: string) => `/dashboard/insights/?dashboard=target&${query}`
const LIVE_FLOW: Entry[] = [
  {step: "load shared link", ops: [`replace ${at("vars=%7B%22service%22%3A%22worker%22%7D")}`], url: at("vars=%7B%22service%22%3A%22worker%22%7D"), editing: false, dirty: false},
  {step: "apply text variable", ops: [`push ${at(`vars=${VARS_CHECKOUT}`)}`], url: at(`vars=${VARS_CHECKOUT}`), editing: false, dirty: false},
  {step: "choose dropdown variable", ops: [`push ${at(`vars=${STAGING}`)}`], url: at(`vars=${STAGING}`), editing: false, dirty: false},
  // Re-selecting the value already applied leaves the address unchanged, so it adds no Back entry.
  {step: "select a signal", ops: [], url: at(`vars=${STAGING}`), editing: false, dirty: false},
  {step: "auto refresh", ops: [`replace ${at(`vars=${STAGING}&refresh=15`)}`], url: at(`vars=${STAGING}&refresh=15`), editing: false, dirty: false},
  {step: "brush a window", ops: [`push ${at(`vars=${STAGING}&${BRUSH}&refresh=15`)}`], url: at(`vars=${STAGING}&${BRUSH}&refresh=15`), editing: false, dirty: false},
  {step: "toolbar preset", ops: [`replace ${at(`vars=${STAGING}&range=6h&refresh=15`)}`], url: at(`vars=${STAGING}&range=6h&refresh=15`), editing: false, dirty: false},
  {step: "enter edit mode", ops: [], url: at(`vars=${STAGING}&range=6h&refresh=15`), editing: true, dirty: false},
  {step: "set view as default", ops: [], url: at(`vars=${STAGING}&range=6h&refresh=15`), editing: true, dirty: true},
  {step: "save", ops: [], url: at(`vars=${STAGING}&range=6h&refresh=15`), editing: false, dirty: false},
  {step: "copy link", ops: [], url: at(`vars=${STAGING}&range=6h&refresh=15`), editing: false, dirty: false},
]
const DRILLDOWN_FLOW: Entry[] = [
  {step: "load source", ops: ["replace /dashboard/insights/?dashboard=source"], url: "/dashboard/insights/?dashboard=source", editing: false, dirty: false},
  {step: "drilldown", ops: ["push /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22api%22%7D&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22api%22%7D&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z", editing: false, dirty: false},
  {step: "return link", ops: ["push /dashboard/insights/?dashboard=source"], url: "/dashboard/insights/?dashboard=source", editing: false, dirty: false},
  {step: "library open", ops: ["push /dashboard/insights/?dashboard=target"], url: "/dashboard/insights/?dashboard=target", editing: false, dirty: false},
  {step: "popstate to source", ops: [], url: "/dashboard/insights/?dashboard=source", editing: false, dirty: false},
  {step: "popstate to a missing dashboard", ops: ["replace /dashboard/insights/?dashboard=source"], url: "/dashboard/insights/?dashboard=source", editing: false, dirty: false},
]
const VIEW_RESET_FLOW: Entry[] = [
  {step: "load without a link", ops: ["replace /dashboard/insights/?dashboard=source"], url: "/dashboard/insights/?dashboard=source", editing: false, dirty: false},
  {step: "declare a variable", ops: [], url: "/dashboard/insights/?dashboard=source", editing: true, dirty: true},
  {step: "apply a variable value", ops: ["push /dashboard/insights/?dashboard=source&vars=%7B%22env%22%3A%22prod%22%2C%22variable_1%22%3A%22active+value%22%7D"], url: "/dashboard/insights/?dashboard=source&vars=%7B%22env%22%3A%22prod%22%2C%22variable_1%22%3A%22active+value%22%7D", editing: true, dirty: true},
  {step: "undo the declaration", ops: ["replace /dashboard/insights/?dashboard=source&vars=%7B%22env%22%3A%22prod%22%7D"], url: "/dashboard/insights/?dashboard=source&vars=%7B%22env%22%3A%22prod%22%7D", editing: true, dirty: false},
  {step: "new dashboard", ops: ["replace /dashboard/insights/?dashboard=dashboard-NEW"], url: "/dashboard/insights/?dashboard=dashboard-NEW", editing: true, dirty: true},
]
const EXAMPLE_FLOW: Entry[] = [
  {"step": "open example", "ops": ["replace /dashboard/insights/?dashboard=source&example=1"], "url": "/dashboard/insights/?dashboard=source&example=1", "editing": false, "dirty": false},
  {"step": "example library open", "ops": ["push /dashboard/insights/?dashboard=target&example=1"], "url": "/dashboard/insights/?dashboard=target&example=1", "editing": false, "dirty": false},
  {"step": "example copy link", "ops": [], "url": "/dashboard/insights/?dashboard=target&example=1", "editing": false, "dirty": false},
  {step: "example apply text variable", ops: ["push /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22checkout%22%7D&example=1"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22prod%22%2C%22service%22%3A%22checkout%22%7D&example=1", editing: false, dirty: false},
  {step: "example choose dropdown variable", ops: ["push /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&example=1"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&example=1", editing: false, dirty: false},
  {step: "example select a signal", ops: [], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&example=1", editing: false, dirty: false},
  {step: "example brush a window", ops: ["push /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z&example=1"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z&example=1", editing: false, dirty: false},
  {step: "example toolbar preset", ops: ["replace /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&range=6h&example=1"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%2C%22service%22%3A%22checkout%22%7D&range=6h&example=1", editing: false, dirty: false},
  {step: "example remove a declared variable", ops: ["replace /dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%7D&range=6h&example=1"], url: "/dashboard/insights/?dashboard=target&vars=%7B%22env%22%3A%22staging%22%7D&range=6h&example=1", editing: true, dirty: true},
  {step: "example document removes every variable", ops: ["replace /dashboard/insights/?dashboard=target&range=6h&example=1"], url: "/dashboard/insights/?dashboard=target&range=6h&example=1", editing: true, dirty: true},
  {step: "example new dashboard", ops: ["replace /dashboard/insights/?dashboard=dashboard-NEW&example=1"], url: "/dashboard/insights/?dashboard=dashboard-NEW&example=1", editing: true, dirty: true},
]
const INVALID_LINK_MISSING_FLOW: Entry[] = [
  {step: "missing dashboard link", ops: [], url: "/dashboard/insights/?dashboard=missing", editing: false, dirty: false},
]
const INVALID_LINK_VARIABLE_FLOW: Entry[] = [
  {step: "undeclared variable link", ops: ["replace /dashboard/insights/?dashboard=target"], url: "/dashboard/insights/?dashboard=target", editing: false, dirty: false},
]
