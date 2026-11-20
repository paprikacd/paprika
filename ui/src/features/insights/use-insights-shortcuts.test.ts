// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useInsightsShortcuts, type ChartCommands, type InsightsShortcutTargets } from "./use-insights-shortcuts"

function targets(overrides: Partial<InsightsShortcutTargets> = {}): InsightsShortcutTargets {
  return {
    editing: true,
    chartOpen: false,
    chart: { current: null },
    blocked: false,
    undoDashboard: vi.fn(),
    redoDashboard: vi.fn(),
    save: vi.fn(),
    removeTile: vi.fn(),
    duplicateTile: vi.fn(),
    openShortcuts: vi.fn(),
    ...overrides,
  }
}

function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe("useInsightsShortcuts scope", () => {
  const nodes: HTMLElement[] = []
  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove()
  })

  function mount(html: string) {
    const host = document.createElement("div")
    host.innerHTML = html
    document.body.append(host)
    nodes.push(host)
    return host
  }

  it("saves for a key press inside the Insights root", () => {
    const host = mount('<div data-root><button>Inside</button></div>')
    const save = vi.fn()
    renderHook(() => useInsightsShortcuts({ current: host.querySelector<HTMLElement>("[data-root]") }, targets({ save })))
    const event = keydown(host.querySelector("button")!, { key: "s", ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("leaves Control+S from an element outside the Insights root to the console", () => {
    const host = mount('<div data-root></div><button>Console</button>')
    const save = vi.fn()
    renderHook(() => useInsightsShortcuts({ current: host.querySelector<HTMLElement>("[data-root]") }, targets({ save })))
    const event = keydown(host.querySelector("button")!, { key: "s", ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })
})

describe("useInsightsShortcuts apply and save", () => {
  const nodes: HTMLElement[] = []
  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove()
  })

  function mountRoot(): HTMLElement {
    const host = document.createElement("div")
    host.innerHTML = '<div data-root><button>Inside</button></div>'
    document.body.append(host)
    nodes.push(host)
    return host.querySelector<HTMLElement>("[data-root]")!
  }

  function chart(overrides: Partial<ChartCommands> = {}): ChartCommands {
    return { undo: vi.fn(), redo: vi.fn(), apply: vi.fn(), applyAndSave: vi.fn(), canApply: true, canApplyAndSave: true, ...overrides }
  }

  it("runs applyAndSave, and not save, for Control+Shift+S with an open chart", () => {
    const root = mountRoot()
    const commands = chart()
    const save = vi.fn()
    const { unmount } = renderHook(() => useInsightsShortcuts({ current: root }, targets({ save, chart: { current: commands } })))
    const event = keydown(root.querySelector("button")!, { key: "S", ctrlKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(commands.applyAndSave).toHaveBeenCalledTimes(1)
    expect(commands.apply).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    unmount()
  })

  it("keeps Control+S as save even with a chart open", () => {
    const root = mountRoot()
    const commands = chart()
    const save = vi.fn()
    const { unmount } = renderHook(() => useInsightsShortcuts({ current: root }, targets({ save, chart: { current: commands } })))
    keydown(root.querySelector("button")!, { key: "s", ctrlKey: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(commands.applyAndSave).not.toHaveBeenCalled()
    unmount()
  })

  it("does nothing for Control+Shift+S without a chart, with an invalid draft, or while blocked", () => {
    const root = mountRoot()
    const cases: Partial<InsightsShortcutTargets>[] = [
      { chart: { current: null } },
      { chart: { current: chart({ canApply: false, canApplyAndSave: false }) } },
      // A valid draft with nothing changed in the chart or the dashboard has nothing to apply or save.
      { chart: { current: chart({ canApplyAndSave: false }) } },
      { chart: { current: chart() }, blocked: true },
    ]
    for (const overrides of cases) {
      const save = vi.fn()
      const { unmount } = renderHook(() => useInsightsShortcuts({ current: root }, targets({ save, ...overrides })))
      const event = keydown(root.querySelector("button")!, { key: "S", ctrlKey: true, shiftKey: true })
      expect(event.defaultPrevented).toBe(false)
      expect(save).not.toHaveBeenCalled()
      unmount()
    }
  })

  it("applies and saves once when Control+Shift+S is held", () => {
    const root = mountRoot()
    const commands = chart()
    const { unmount } = renderHook(() => useInsightsShortcuts({ current: root }, targets({ chart: { current: commands } })))
    keydown(root.querySelector("button")!, { key: "S", ctrlKey: true, shiftKey: true, repeat: true })
    expect(commands.applyAndSave).not.toHaveBeenCalled()
    keydown(root.querySelector("button")!, { key: "S", ctrlKey: true, shiftKey: true })
    expect(commands.applyAndSave).toHaveBeenCalledTimes(1)
    unmount()
  })
})

describe("useInsightsShortcuts duplicate", () => {
  const nodes: HTMLElement[] = []
  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove()
  })

  // A tile with its Edit chip and actions trigger, a text field inside it, and a console button outside the root.
  function mount(extra = "") {
    const host = document.createElement("div")
    host.innerHTML = `<div data-root>
      <article data-widget-id="latency" tabindex="0">
        <button data-widget-edit="latency">Edit</button>
        <button data-widget-actions="latency">More</button>
        <button data-tile-body>Body</button>
        <input aria-label="Filter" />
      </article>${extra}
    </div><button>Console</button>`
    document.body.append(host)
    nodes.push(host)
    return host
  }
  const root = (host: HTMLElement) => ({ current: host.querySelector<HTMLElement>("[data-root]") })

  it("duplicates the focused tile, and reports the press as handled", () => {
    const host = mount()
    const duplicateTile = vi.fn()
    renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile })))
    const event = keydown(host.querySelector("article")!, { key: "d", ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(duplicateTile).toHaveBeenCalledWith("latency")
  })

  it("keeps a held or blocked Mod+D from the browser bookmark, without copying again", () => {
    const host = mount()
    const duplicateTile = vi.fn()
    const first = renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile })))
    const repeat = keydown(host.querySelector("article")!, { key: "d", ctrlKey: true, repeat: true })
    expect(repeat.defaultPrevented).toBe(true)
    expect(duplicateTile).not.toHaveBeenCalled()
    first.unmount()
    const blocked = mount()
    renderHook(() => useInsightsShortcuts(root(blocked), targets({ duplicateTile, blocked: true })))
    const busy = keydown(blocked.querySelector("article")!, { key: "d", ctrlKey: true })
    expect(busy.defaultPrevented).toBe(true)
    expect(duplicateTile).not.toHaveBeenCalled()
  })

  it("duplicates from the tile's Edit chip and its actions trigger too", () => {
    const host = mount()
    const duplicateTile = vi.fn()
    renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile })))
    keydown(host.querySelector("[data-widget-edit]")!, { key: "d", ctrlKey: true })
    keydown(host.querySelector("[data-widget-actions]")!, { key: "d", ctrlKey: true })
    expect(duplicateTile.mock.calls).toEqual([["latency"], ["latency"]])
  })

  it("removes the tile from its actions trigger with Delete, as from its Edit chip", () => {
    const host = mount()
    const removeTile = vi.fn()
    renderHook(() => useInsightsShortcuts(root(host), targets({ removeTile })))
    const event = keydown(host.querySelector("[data-widget-actions]")!, { key: "Delete" })
    expect(event.defaultPrevented).toBe(true)
    expect(removeTile).toHaveBeenCalledWith("latency")
  })

  it("leaves Mod+D alone on the tile's other controls, in text fields, and outside the tile", () => {
    const host = mount()
    const duplicateTile = vi.fn()
    renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile })))
    const body = keydown(host.querySelector("[data-tile-body]")!, { key: "d", ctrlKey: true })
    const field = keydown(host.querySelector("input")!, { key: "d", ctrlKey: true })
    const console = keydown(host.querySelector("button:last-of-type")!, { key: "d", ctrlKey: true })
    expect([body.defaultPrevented, field.defaultPrevented, console.defaultPrevented]).toEqual([false, false, false])
    expect(duplicateTile).not.toHaveBeenCalled()
  })

  it("yields while a menu is open, in view mode, and while a chart is open", () => {
    const host = mount('<div role="menu"><button role="menuitem">Remove</button></div>')
    const duplicateTile = vi.fn()
    const menuOpen = renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile })))
    keydown(host.querySelector("article")!, { key: "d", ctrlKey: true })
    expect(duplicateTile).not.toHaveBeenCalled()
    menuOpen.unmount()
    host.querySelector('[role="menu"]')!.remove()
    renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile, editing: false })))
    keydown(host.querySelector("article")!, { key: "d", ctrlKey: true })
    expect(duplicateTile).not.toHaveBeenCalled()
    renderHook(() => useInsightsShortcuts(root(host), targets({ duplicateTile, chartOpen: true })))
    keydown(host.querySelector("article")!, { key: "d", ctrlKey: true })
    expect(duplicateTile).not.toHaveBeenCalled()
  })
})
