// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useInsightsShortcuts, type InsightsShortcutTargets } from "./use-insights-shortcuts"

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
