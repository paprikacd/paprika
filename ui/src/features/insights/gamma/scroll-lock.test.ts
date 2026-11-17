import { describe, expect, it } from "vitest"
import { lockBodyScroll } from "./scroll-lock"

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
})
