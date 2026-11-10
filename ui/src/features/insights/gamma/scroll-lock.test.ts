import { afterEach, describe, expect, it, vi } from "vitest"
import { lockBodyScroll } from "./scroll-lock"

const originalBodyStyle = document.body.style.cssText

afterEach(() => {
  document.body.style.cssText = originalBodyStyle
  vi.restoreAllMocks()
})

function classicScrollbar(width = 16) {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() =>
    document.body.style.overflow === "hidden" ? 1200 : 1200 - width,
  )
}

describe("Gamma nested scroll locks", () => {
  it.each([true, false])("restores the host overflow after nested cleanup (parent first: %s)", (parentFirst) => {
    const body = document.createElement("div")
    body.style.overflow = "auto"
    const parent = lockBodyScroll(body), child = lockBodyScroll(body)
    const first = parentFirst ? parent : child, last = parentFirst ? child : parent
    first()
    first()
    expect(body.style.overflow).toBe("hidden")
    last()
    expect(body.style.overflow).toBe("auto")
  })

  it("adds only the removed viewport gutter to existing stylesheet padding, then restores the stylesheet", () => {
    const stylesheet = document.createElement("style")
    stylesheet.textContent = "body { padding-right: 12px; }"
    document.head.append(stylesheet)
    document.body.style.overflow = "auto"
    document.body.style.removeProperty("padding-right")
    classicScrollbar()
    const unlock = lockBodyScroll()
    try {
      expect(document.body.style.overflow).toBe("hidden")
      expect(getComputedStyle(document.body).paddingRight).toBe("28px")
      unlock()
      expect(document.body.style.overflow).toBe("auto")
      expect(document.body.style.paddingRight).toBe("")
      expect(getComputedStyle(document.body).paddingRight).toBe("12px")
    } finally {
      unlock()
      stylesheet.remove()
    }
  })

  it.each([true, false])("compensates once and restores inline values after nested body cleanup (parent first: %s)", (parentFirst) => {
    document.body.style.setProperty("overflow", "scroll", "important")
    document.body.style.setProperty("padding-right", "7px", "important")
    classicScrollbar(20)
    const parent = lockBodyScroll(), child = lockBodyScroll()
    const first = parentFirst ? parent : child, last = parentFirst ? child : parent
    try {
      expect(document.body.style.paddingRight).toBe("27px")
      first()
      first()
      expect(document.body.style.overflow).toBe("hidden")
      expect(document.body.style.paddingRight).toBe("27px")
      last()
      expect(document.body.style.overflow).toBe("scroll")
      expect(document.body.style.getPropertyPriority("overflow")).toBe("important")
      expect(document.body.style.paddingRight).toBe("7px")
      expect(document.body.style.getPropertyPriority("padding-right")).toBe("important")
    } finally {
      parent()
      child()
    }
  })

  it.each([1200, 1184])("leaves padding untouched when hiding overflow removes no gutter (root width: %s)", rootWidth => {
    document.body.style.paddingRight = "5px"
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200)
    // The smaller root models an existing stable gutter; the full-width root
    // models overlay scrollbars or a page that does not need a scrollbar.
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(rootWidth)
    const unlock = lockBodyScroll()
    try {
      expect(document.body.style.overflow).toBe("hidden")
      expect(document.body.style.paddingRight).toBe("5px")
      expect(document.body.style.getPropertyPriority("padding-right")).toBe("")
    } finally {
      unlock()
    }
    expect(document.body.style.paddingRight).toBe("5px")
  })

  it("does not apply viewport compensation to a custom element host", () => {
    const host = document.createElement("div")
    host.style.overflow = "auto"
    host.style.paddingRight = "9px"
    const bodyStyle = document.body.style.cssText
    classicScrollbar()
    const unlock = lockBodyScroll(host)
    try {
      expect(host.style.overflow).toBe("hidden")
      expect(host.style.paddingRight).toBe("9px")
      expect(document.body.style.cssText).toBe(bodyStyle)
    } finally {
      unlock()
    }
    expect(host.style.overflow).toBe("auto")
    expect(host.style.paddingRight).toBe("9px")
  })
})
