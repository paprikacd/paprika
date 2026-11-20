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
