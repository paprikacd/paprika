import { afterEach, describe, expect, it } from "vitest"
import { SHORTCUTS, labelFor, matchShortcut, shouldYield, type ShortcutKeyEvent } from "./shortcuts"

function key(key: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...modifiers }
}

const mac = { metaKey: true }
const other = { ctrlKey: true }

describe("matchShortcut", () => {
  it("maps Command on Mac and Control elsewhere to the same ids", () => {
    expect(matchShortcut(key("z", mac), true)).toBe("undo")
    expect(matchShortcut(key("z", other), false)).toBe("undo")
    expect(matchShortcut(key("s", mac), true)).toBe("save")
    expect(matchShortcut(key("s", other), false)).toBe("save")
    expect(matchShortcut(key("Enter", mac), true)).toBe("apply")
    expect(matchShortcut(key("Enter", other), false)).toBe("apply")
  })

  it("does not treat the other platform's modifier as the shortcut key", () => {
    expect(matchShortcut(key("z", other), true)).toBeUndefined()
    expect(matchShortcut(key("z", mac), false)).toBeUndefined()
    expect(matchShortcut(key("z", { ctrlKey: true, metaKey: true }), true)).toBeUndefined()
  })

  it("maps Shift+Mod+Z to redo, and Ctrl+Y to redo only off Mac", () => {
    expect(matchShortcut(key("Z", { ...mac, shiftKey: true }), true)).toBe("redo")
    expect(matchShortcut(key("Z", { ...other, shiftKey: true }), false)).toBe("redo")
    expect(matchShortcut(key("y", other), false)).toBe("redo")
    expect(matchShortcut(key("y", other), true)).toBeUndefined()
    expect(matchShortcut(key("y", mac), true)).toBeUndefined()
  })

  it("maps Delete and Backspace only without modifiers", () => {
    expect(matchShortcut(key("Delete"), true)).toBe("delete")
    expect(matchShortcut(key("Backspace"), false)).toBe("delete")
    expect(matchShortcut(key("Backspace", { shiftKey: true }), true)).toBeUndefined()
    expect(matchShortcut(key("Backspace", other), false)).toBeUndefined()
  })

  it("ignores Shift on save and apply, and Alt on everything", () => {
    expect(matchShortcut(key("S", { ...mac, shiftKey: true }), true)).toBeUndefined()
    expect(matchShortcut(key("Enter", { ...mac, shiftKey: true }), true)).toBeUndefined()
    expect(matchShortcut(key("z", { ...mac, altKey: true }), true)).toBeUndefined()
  })

  it("gives no match for AltGr on Windows (Control with Alt)", () => {
    expect(matchShortcut(key("s", { ctrlKey: true, altKey: true }), false)).toBeUndefined()
    expect(matchShortcut(key("z", { ctrlKey: true, altKey: true }), false)).toBeUndefined()
  })

  it("gives no match during IME composition", () => {
    expect(matchShortcut(key("z", { ...mac, isComposing: true }), true)).toBeUndefined()
    expect(matchShortcut({ ...key("z", mac), keyCode: 229 }, true)).toBeUndefined()
  })

  it("ignores keys with no shortcut", () => {
    expect(matchShortcut(key("k", mac), true)).toBeUndefined()
    expect(matchShortcut(key("a", other), false)).toBeUndefined()
    expect(matchShortcut(key("d", mac), true)).toBeUndefined()
  })
})

describe("shouldYield", () => {
  const cleanup: HTMLElement[] = []
  afterEach(() => {
    for (const element of cleanup.splice(0)) element.remove()
  })

  function mount(html: string) {
    const host = document.createElement("div")
    host.innerHTML = html
    document.body.append(host)
    cleanup.push(host)
    return host
  }
  const event = (target: EventTarget | null, defaultPrevented = false) => ({ target, defaultPrevented })

  it("yields when the event is already handled", () => {
    const host = mount("<button>Open</button>")
    expect(shouldYield(event(host.querySelector("button"), true), "undo")).toBe(true)
  })

  it("yields undo, redo and delete inside text fields", () => {
    const host = mount('<input aria-label="Title"><textarea></textarea><select><option>a</option></select><div contenteditable="true"><span>x</span></div>')
    for (const selector of ["input", "textarea", "select", "[contenteditable]", "[contenteditable] span"]) {
      const target = host.querySelector(selector)
      expect(shouldYield(event(target), "undo"), selector).toBe(true)
      expect(shouldYield(event(target), "redo"), selector).toBe(true)
      expect(shouldYield(event(target), "delete"), selector).toBe(true)
    }
  })

  it("keeps save and apply in plain inputs, since they have no native meaning there", () => {
    const host = mount('<input aria-label="Title">')
    const input = host.querySelector("input")
    expect(shouldYield(event(input), "save")).toBe(false)
    expect(shouldYield(event(input), "apply")).toBe(false)
  })

  it("yields to CodeMirror for undo, redo, apply and delete, but not for save", () => {
    const host = mount('<div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">SELECT 1</div></div></div>')
    const line = host.querySelector(".cm-line")
    expect(shouldYield(event(line), "undo")).toBe(true)
    expect(shouldYield(event(line), "redo")).toBe(true)
    expect(shouldYield(event(line), "apply")).toBe(true)
    expect(shouldYield(event(line), "delete")).toBe(true)
    expect(shouldYield(event(line), "save")).toBe(false)
  })

  it("does not yield for an ordinary target", () => {
    const host = mount("<article tabindex='0'>Tile</article>")
    const tile = host.querySelector("article")
    for (const id of ["undo", "redo", "save", "apply", "delete"] as const) expect(shouldYield(event(tile), id), id).toBe(false)
  })

  it("yields every shortcut while a dialog, menu or listbox is open", () => {
    for (const overlay of ['<div role="menu"></div>', '<div role="listbox"></div>', '<dialog open></dialog>']) {
      const host = mount(`<article tabindex="0">Tile</article>${overlay}`)
      const tile = host.querySelector("article")
      for (const id of ["undo", "redo", "save", "apply", "delete"] as const) expect(shouldYield(event(tile), id), `${overlay} ${id}`).toBe(true)
    }
  })

  it("keeps every shortcut while a passive hover tooltip is shown", () => {
    // Chart hover tooltips are role="tooltip" and mount under the pointer while the user works.
    const host = mount('<article tabindex="0">Tile</article><div role="tooltip">Request traffic</div>')
    const tile = host.querySelector("article")
    for (const id of ["undo", "redo", "save", "apply", "delete"] as const) expect(shouldYield(event(tile), id), id).toBe(false)
  })

  it("does not yield for a target outside the DOM", () => {
    expect(shouldYield(event(null), "save")).toBe(false)
  })
})

describe("labelFor and the shortcut table", () => {
  it("shows the Command symbol on Mac and Ctrl elsewhere", () => {
    expect(labelFor("undo", true)).toBe("⌘Z")
    expect(labelFor("undo", false)).toBe("Ctrl+Z")
    expect(labelFor("redo", true)).toBe("⌘⇧Z")
    expect(labelFor("save", false)).toBe("Ctrl+S")
    expect(labelFor("apply", true)).toBe("⌘↵")
    expect(labelFor("delete", false)).toBe("Delete / Backspace")
  })

  it("lists each id once with an aria-keyshortcuts value", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(["apply", "delete", "redo", "save", "undo"])
    for (const shortcut of SHORTCUTS) expect(shortcut.aria.length).toBeGreaterThan(0)
  })
})
