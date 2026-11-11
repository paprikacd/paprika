import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_DASHBOARD_URL_LENGTH, type DashboardNavigation } from "./drilldown"
import { readDashboardView, serialiseDashboardView, useDashboardView, VIEW_HISTORY, type ViewAction } from "./dashboard-view"

const ROUTE = "/dashboard/insights/"
const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" }

function setAddress(search: string) {
  window.history.replaceState(null, "", `${ROUTE}${search}`)
}

beforeEach(() => setAddress(""))
afterEach(() => { vi.restoreAllMocks(); setAddress("") })

describe("readDashboardView", () => {
  it("returns null when no dashboard is named", () => {
    expect(readDashboardView()).toBeNull()
    setAddress("?example=1")
    expect(readDashboardView()).toBeNull()
  })

  it("reads the dashboard, variables and a fixed window", () => {
    setAddress(`?dashboard=ops&vars=${encodeURIComponent('{"env":"prod","service":"api"}')}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
    expect(readDashboardView()).toEqual({ dashboardId: "ops", variables: { env: "prod", service: "api" }, customTimeRange: range })
  })

  it("ignores parameters it does not own, including the example flag", () => {
    setAddress("?dashboard=ops&example=1&utm_source=chat")
    expect(readDashboardView()).toEqual({ dashboardId: "ops" })
  })

  it("rejects a repeated owned parameter rather than choosing one", () => {
    for (const name of ["dashboard", "vars", "from", "to"]) {
      const query = name === "dashboard" ? "dashboard=a&dashboard=b" : name === "vars" ? "dashboard=a&vars=%7B%7D&vars=%7B%7D" :
        name === "from" ? `dashboard=a&from=${range.from}&from=${range.from}&to=${range.to}` : `dashboard=a&from=${range.from}&to=${range.to}&to=${range.to}`
      setAddress(`?${query}`)
      expect(() => readDashboardView()).toThrow(`Dashboard URL repeats “${name}”`)
    }
  })

  it("rejects variables or a window without a dashboard", () => {
    setAddress('?vars=%7B%22env%22%3A%22prod%22%7D')
    expect(() => readDashboardView()).toThrow("Choose a dashboard before passing variables or a time range")
    setAddress(`?from=${range.from}&to=${range.to}`)
    expect(() => readDashboardView()).toThrow("Choose a dashboard before passing variables or a time range")
  })

  it("rejects a window with only one end", () => {
    setAddress(`?dashboard=ops&from=${range.from}`)
    expect(() => readDashboardView()).toThrow("Dashboard URL time ranges require both from and to")
  })

  it.each([
    ["not JSON", "%7Bnope"],
    ["an array", "%5B%5D"],
    ["a number value", "%7B%22env%22%3A1%7D"],
    ["a nested value", "%7B%22env%22%3A%7B%22x%22%3A%22y%22%7D%7D"],
    ["an invalid name", "%7B%22bad-name%22%3A%22x%22%7D"],
  ])("rejects variables that are %s", (_label, encoded) => {
    setAddress(`?dashboard=ops&vars=${encoded}`)
    expect(() => readDashboardView()).toThrow("Dashboard URL variables must be valid named string values")
  })

  it("rejects an address longer than the URL limit", () => {
    setAddress(`?dashboard=ops&note=${"x".repeat(MAX_DASHBOARD_URL_LENGTH)}`)
    expect(() => readDashboardView()).toThrow("Dashboard URL parameters are invalid or too long")
  })

  it("decodes encoded characters in variable values exactly", () => {
    const value = 'a "quoted" \\ value & 50% + "{{x}}" línea\nnext'
    setAddress(`?dashboard=ops&vars=${encodeURIComponent(JSON.stringify({ service: value }))}`)
    expect(readDashboardView()).toEqual({ dashboardId: "ops", variables: { service: value } })
  })
})

describe("serialiseDashboardView", () => {
  it("writes the dashboard alone when nothing else is set", () => {
    expect(serialiseDashboardView({ dashboardId: "ops" })).toBe(`${ROUTE}?dashboard=ops`)
  })

  it("sorts variables by name so equal views produce equal addresses", () => {
    const state: DashboardNavigation = { dashboardId: "ops", variables: { region: "eu", env: "prod", service: "api" } }
    expect(serialiseDashboardView(state)).toBe(`${ROUTE}?dashboard=ops&vars=${encodeURIComponent('{"env":"prod","region":"eu","service":"api"}')}`)
  })

  it("writes the fixed window as from and to", () => {
    expect(serialiseDashboardView({ dashboardId: "ops", customTimeRange: range })).toBe(
      `${ROUTE}?dashboard=ops&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z`,
    )
  })

  it("appends the example flag only when asked", () => {
    expect(serialiseDashboardView({ dashboardId: "ops" }, { example: true })).toBe(`${ROUTE}?dashboard=ops&example=1`)
    expect(serialiseDashboardView({ dashboardId: "ops", variables: { env: "prod" } }, { example: true })).toBe(`${ROUTE}?dashboard=ops&vars=%7B%22env%22%3A%22prod%22%7D&example=1`)
  })

  it("keeps the current Insights path and falls back to the canonical route elsewhere", () => {
    window.history.replaceState(null, "", "/dashboard/insights")
    expect(serialiseDashboardView({ dashboardId: "ops" })).toBe("/dashboard/insights/?dashboard=ops")
    window.history.replaceState(null, "", "/somewhere/else")
    expect(serialiseDashboardView({ dashboardId: "ops" })).toBe(`${ROUTE}?dashboard=ops`)
  })

  it("refuses a view that the parser would not accept", () => {
    expect(() => serialiseDashboardView({ dashboardId: "bad id" })).toThrow()
    expect(() => serialiseDashboardView({ dashboardId: "ops", customTimeRange: { from: range.to, to: range.from } })).toThrow()
  })
})

describe("view round trips", () => {
  it.each<[string, DashboardNavigation]>([
    ["a dashboard only", { dashboardId: "ops" }],
    ["several variables", { dashboardId: "ops", variables: { region: "eu", env: "prod", service: "api" } }],
    ["a fixed window", { dashboardId: "ops", customTimeRange: range }],
    ["encoded characters", { dashboardId: "ops", variables: { service: 'checkout"api\\{{x}} & 100% +1 é' } }],
    ["variables and a window", { dashboardId: "ops", variables: { env: "" }, customTimeRange: range }],
  ])("parse(serialise(view)) keeps %s", (_label, state) => {
    const url = serialiseDashboardView(state)
    setAddress(url.slice(ROUTE.length))
    expect(readDashboardView()).toEqual(state)
  })

  it("keeps the example flag out of the parsed view but in the written address", () => {
    const state: DashboardNavigation = { dashboardId: "ops", variables: { env: "prod" } }
    const url = serialiseDashboardView(state, { example: true })
    setAddress(url.slice(ROUTE.length))
    expect(readDashboardView()).toEqual(state)
    expect(new URL(url, "http://localhost").searchParams.get("example")).toBe("1")
  })

  it("serialises a parsed address to the same canonical text", () => {
    setAddress("?dashboard=ops&vars=%7B%22service%22%3A%22api%22%2C%22env%22%3A%22prod%22%7D&example=1")
    const parsed = readDashboardView()!
    expect(serialiseDashboardView(parsed)).toBe(`${ROUTE}?dashboard=ops&vars=${encodeURIComponent('{"env":"prod","service":"api"}')}`)
  })
})

describe("VIEW_HISTORY", () => {
  it("records every action as push, replace or none", () => {
    expect(VIEW_HISTORY).toEqual({
      load: "replace", keep: "none", prune: "replace", variables: "replace", selection: "replace", brush: "replace",
      range: "replace", reset: "replace", recover: "replace", navigate: "push", popstate: "none",
    } satisfies Record<ViewAction, string>)
  })
})

describe("useDashboardView", () => {
  it("pushes a navigation entry and replaces for view changes, with the example flag", () => {
    const pushState = vi.spyOn(window.history, "pushState")
    const replaceState = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useDashboardView("ops"))

    act(() => result.current.apply({ dashboardId: "ops" }, "navigate", false))
    expect(pushState).toHaveBeenLastCalledWith(window.history.state, "", `${ROUTE}?dashboard=ops`)

    act(() => result.current.apply({ dashboardId: "ops", variables: { env: "prod" } }, "variables", true))
    expect(replaceState).toHaveBeenLastCalledWith(window.history.state, "", `${ROUTE}?dashboard=ops&vars=%7B%22env%22%3A%22prod%22%7D&example=1`)
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledTimes(1)
  })

  it("makes a view current only for its own dashboard", () => {
    const { result } = renderHook(() => useDashboardView("ops"))
    expect(result.current.current).toBeUndefined()
    act(() => result.current.apply({ dashboardId: "other" }, "reset", false))
    expect(result.current.current).toBeUndefined()
    act(() => result.current.apply({ dashboardId: "ops", customTimeRange: range }, "brush", false))
    expect(result.current.current).toEqual({ dashboardId: "ops", customTimeRange: range })
  })

  it("sets the view without writing the address for none-recorded actions", () => {
    const pushState = vi.spyOn(window.history, "pushState")
    const replaceState = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useDashboardView("ops"))
    act(() => result.current.apply({ dashboardId: "ops", variables: { env: "prod" } }, "popstate", false))
    act(() => result.current.apply({ dashboardId: "ops" }, "keep", false))
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
    expect(result.current.current).toEqual({ dashboardId: "ops" })
  })

  it("leaves the view unchanged when the address cannot be written", () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useDashboardView("ops", false))
    act(() => result.current.apply({ dashboardId: "ops" }, "reset", false))
    const before = result.current.current
    // Each value is valid on its own; the nine together exceed the address limit.
    const tooLong: DashboardNavigation = {
      dashboardId: "ops",
      variables: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`v${index}`, "x".repeat(1000)])),
    }
    expect(() => act(() => result.current.apply(tooLong, "variables", false))).toThrow("exceeds the 8192-character URL limit")
    expect(result.current.current).toBe(before)
    expect(replaceState).toHaveBeenCalledTimes(1)
  })

  it("shows a view without writing the address", () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useDashboardView("ops", false))
    act(() => result.current.show({ dashboardId: "ops", variables: { env: "prod" } }))
    expect(result.current.current).toEqual({ dashboardId: "ops", variables: { env: "prod" } })
    expect(replaceState).not.toHaveBeenCalled()
  })

  it("reflects an address for recovery without changing the current view", () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useDashboardView("ops"))
    act(() => result.current.apply({ dashboardId: "ops", variables: { env: "prod" } }, "variables", false))
    replaceState.mockClear()
    act(() => result.current.reflect({ dashboardId: "ops" }, "recover", false))
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", `${ROUTE}?dashboard=ops`)
    expect(result.current.current).toEqual({ dashboardId: "ops", variables: { env: "prod" } })
  })
})
