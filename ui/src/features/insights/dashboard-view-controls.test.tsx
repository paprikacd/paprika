import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard } from "./schema"

// Behaviour of the toolbar view controls: a time range, refresh interval or variable
// changes only the URL view. It never dirties the saved dashboard or enters edit mode,
// and "Set as dashboard default" is the one way a view writes the document.

vi.mock("./canvas", () => ({
  DashboardCanvas: () => <div data-testid="canvas" />,
}))

const RANGE = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" }
const saved: Dashboard = {
  schemaVersion: 1, id: "ops", title: "Operations", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "env", options: ["prod", "staging"], defaultValue: "prod" }],
  widgets: [],
}

function client(): InsightsClient & { save: ReturnType<typeof vi.fn> } {
  const documents = [saved]
  return {
    list: vi.fn().mockResolvedValue(documents),
    providers: vi.fn().mockResolvedValue([]),
    get: vi.fn(async id => ({ dashboard: documents.find(item => item.id === id)!, etag: '"v1"' })),
    save: vi.fn().mockResolvedValue('"v2"'), remove: vi.fn(),
    query: vi.fn().mockResolvedValue({ series: [] }), metadata: vi.fn().mockResolvedValue({ values: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(),
  } as unknown as InsightsClient & { save: ReturnType<typeof vi.fn> }
}

function setURL(url: string) {
  window.history.replaceState(null, "", url)
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

beforeEach(() => {
  setURL("/dashboard/insights/")
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

async function chooseRange(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Time range" }))
  fireEvent.click(screen.getByRole("option", { name: label }))
  await settle()
}

describe("toolbar view controls", () => {
  it("change the view without dirtying the document or entering edit mode", async () => {
    const api = client()
    setURL("/dashboard/insights/?dashboard=ops")
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Operations" })

    await chooseRange("Last 6 hours")
    expect(screen.queryByRole("button", { name: "Save dashboard" })).not.toBeInTheDocument()
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    expect(new URL(location.href).searchParams.get("range")).toBe("6h")

    fireEvent.click(screen.getByRole("combobox", { name: "Auto refresh" }))
    fireEvent.click(screen.getByRole("option", { name: "30s" }))
    await settle()
    expect(screen.queryByRole("button", { name: "Save dashboard" })).not.toBeInTheDocument()
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    expect(new URL(location.href).searchParams.get("refresh")).toBe("30")

    fireEvent.click(screen.getByRole("combobox", { name: "env" }))
    fireEvent.click(screen.getByRole("option", { name: "staging" }))
    await settle()
    expect(new URL(location.href).searchParams.get("vars")).toBe('{"env":"staging"}')
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it("does not dirty a dashboard that is already in edit mode either", async () => {
    setURL("/dashboard/insights/?dashboard=ops")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    expect(screen.getByText("All changes saved")).toBeInTheDocument()

    await chooseRange("Last 24 hours")
    expect(screen.getByText("All changes saved")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Set as dashboard default" })).toBeInTheDocument()
  })

  it("hides the default action while viewing and offers it in edit mode only when the view differs", async () => {
    setURL("/dashboard/insights/?dashboard=ops")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    await chooseRange("Last 6 hours")
    expect(screen.queryByRole("button", { name: "Set as dashboard default" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    expect(screen.getByRole("button", { name: "Set as dashboard default" })).toBeInTheDocument()
  })

  it("copies the view into the document as the default, and saves it only when asked", async () => {
    const api = client()
    setURL("/dashboard/insights/?dashboard=ops")
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Operations" })
    await chooseRange("Last 6 hours")
    fireEvent.click(screen.getByRole("combobox", { name: "Auto refresh" }))
    fireEvent.click(screen.getByRole("option", { name: "15s" }))
    await settle()
    expect(api.save).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Set as dashboard default" }))
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Set as dashboard default" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ timeRange: "6h", refreshInterval: 15, customTimeRange: undefined }), '"v1"')
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save dashboard" })).not.toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Set as dashboard default" })).not.toBeInTheDocument()
  })

  it("keeps an absolute window in the view and writes it to the document only through the default action", async () => {
    const api = client()
    setURL(`/dashboard/insights/?dashboard=ops&from=${encodeURIComponent(RANGE.from)}&to=${encodeURIComponent(RANGE.to)}`)
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Operations" })
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveTextContent("Custom range")
    expect(screen.getByRole("combobox", { name: "Auto refresh" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Set as dashboard default" }))
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ customTimeRange: RANGE }), '"v1"'))
  })
})

describe("auto refresh follows the view window", () => {
  it("refreshes a relative view window at the view interval", async () => {
    const intervals = vi.spyOn(window, "setInterval")
    setURL("/dashboard/insights/?dashboard=ops&range=6h&refresh=15")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    expect(screen.getByRole("combobox", { name: "Auto refresh" })).toBeEnabled()
    expect(screen.getByRole("combobox", { name: "Auto refresh" })).toHaveTextContent("15s")
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 15_000)).toBe(true))
  })

  it("pauses refresh for a fixed window, whatever interval the view holds", async () => {
    const intervals = vi.spyOn(window, "setInterval")
    setURL(`/dashboard/insights/?dashboard=ops&from=${encodeURIComponent(RANGE.from)}&to=${encodeURIComponent(RANGE.to)}&refresh=15`)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    await settle()
    expect(intervals.mock.calls.some(([, delay]) => delay === 15_000)).toBe(false)
    expect(new URL(location.href).searchParams.get("refresh")).toBe("15")
  })

  it("resumes refresh when a fixed window is replaced by a relative preset", async () => {
    const intervals = vi.spyOn(window, "setInterval")
    setURL(`/dashboard/insights/?dashboard=ops&from=${encodeURIComponent(RANGE.from)}&to=${encodeURIComponent(RANGE.to)}&refresh=15`)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    await chooseRange("Last 1 hour")
    await waitFor(() => expect(intervals.mock.calls.some(([, delay]) => delay === 15_000)).toBe(true))
  })
})

describe("link variables that cannot be applied", () => {
  it("names a value outside the length limit, drops it, and corrects the address with replace", async () => {
    const replace = vi.spyOn(window.history, "replaceState")
    setURL(`/dashboard/insights/?dashboard=ops&vars=${encodeURIComponent(JSON.stringify({ env: "staging", note: "x".repeat(1025) }))}`)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    expect(screen.getByText("Ignored link filter “note” because its name or value is not valid.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(new URL(location.href).searchParams.get("vars")).toBe('{"env":"staging"}')
    expect(replace.mock.calls.some(([, , url]) => String(url).includes("vars=%7B%22env%22%3A%22staging%22%7D"))).toBe(true)
    expect(screen.getByRole("combobox", { name: "env" })).toHaveTextContent("staging")
    expect(screen.getByText("Ignored link filter “note” because its name or value is not valid.")).toBeInTheDocument()
  })

  it("can be dismissed without changing the view", async () => {
    setURL(`/dashboard/insights/?dashboard=ops&vars=${encodeURIComponent(JSON.stringify({ gone: "x" }))}`)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    const notice = screen.getByText(/Ignored link filter “gone”/)
    fireEvent.click(within(notice.parentElement!).getByRole("button", { name: "Dismiss link notice" }))
    expect(screen.queryByText(/Ignored link filter/)).not.toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "env" })).toHaveTextContent("prod")
  })
})

describe("a view change that cannot be linked", () => {
  // The base link is sized so the address fits, but adding a preset overflows it.
  function linkWithRoom(): string {
    const address = (n: number) => `/dashboard/insights/?dashboard=ops&vars=${encodeURIComponent(JSON.stringify({ env: "€".repeat(n) }))}`
    let n = 1024
    while (address(n).length > 8192) n--
    return address(n)
  }

  it("shows a visible error for a preset and leaves the view and the document unchanged", async () => {
    const api = client()
    const url = linkWithRoom()
    setURL(url)
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Operations" })
    expect(location.pathname + location.search).toBe(url)

    await chooseRange("Last 6 hours")
    expect(screen.getByRole("alert")).toHaveTextContent("exceeds the 8192-character URL limit")
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveTextContent("Last 1 hour")
    expect(location.pathname + location.search).toBe(url)
    expect(screen.queryByRole("button", { name: "Save dashboard" })).not.toBeInTheDocument()
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it("shows a visible error for a refresh interval the same way", async () => {
    const url = linkWithRoom()
    setURL(url)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Operations" })
    fireEvent.click(screen.getByRole("combobox", { name: "Auto refresh" }))
    fireEvent.click(screen.getByRole("option", { name: "1m" }))
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent("exceeds the 8192-character URL limit")
    expect(location.pathname + location.search).toBe(url)
    expect(screen.getByRole("combobox", { name: "Auto refresh" })).toHaveTextContent("Auto off")
  })
})
