import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidgetEditor } from "./widget-editor"
import { editorProps, widget } from "./widget-editor.test-utils"
import { PREVIEW_SIZE_KEY, readPreviewSize } from "./preview-size"
import type { PreviewFootprints } from "./canvas"

function renderEditor(footprints?: PreviewFootprints) {
  const props = editorProps()
  return render(
    <WidgetEditor
      {...props}
      workspace={{
        preview: <div>Canonical chart preview</div>,
        previewFootprints: footprints,
        dashboardTitle: "Operations",
        dashboardDirty: false,
        saveBusy: false,
        onSaveDashboard: vi.fn(),
        onDiscard: vi.fn(),
        widgets: [widget],
      }}
    />,
  )
}

const group = () => screen.getByRole("group", { name: "Preview size" })
const sized = (document: Document) => document.querySelector<HTMLElement>("[data-preview-size]")!

afterEach(() => {
  try { window.localStorage.removeItem(PREVIEW_SIZE_KEY) } catch { /* jsdom always has storage */ }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("preview size control", () => {
  it("defaults to Fill, which gives the tile the whole pane", () => {
    renderEditor({ dashboard: { width: 305.75, height: 58 } })
    const buttons = within(group()).getAllByRole("button")
    expect(buttons.map(button => button.textContent)).toEqual(["Fill", "Dashboard size", "Compact view"])
    expect(within(group()).getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true")
    expect(sized(document)).toHaveAttribute("data-preview-size", "fill")
    expect(document.querySelector("[style*='--preview-width']")).toBeNull()
  })

  it("draws the tile at its dashboard footprint in pixels when Dashboard size is chosen", () => {
    renderEditor({ dashboard: { width: 305.75, height: 58 }, compact: { width: 311.75, height: 54 } })
    fireEvent.click(within(group()).getByRole("button", { name: "Dashboard size" }))
    expect(within(group()).getByRole("button", { name: "Dashboard size" })).toHaveAttribute("aria-pressed", "true")
    const box = document.querySelector<HTMLElement>("[style*='--preview-width']")!
    expect(box.style.getPropertyValue("--preview-width")).toBe("305.75px")
    expect(box.style.getPropertyValue("--preview-height")).toBe("58px")
    expect(box).toHaveTextContent("Canonical chart preview")
    fireEvent.click(within(group()).getByRole("button", { name: "Compact view" }))
    expect(document.querySelector<HTMLElement>("[style*='--preview-width']")!.style.getPropertyValue("--preview-height")).toBe("54px")
  })

  it("says the size is approximate when the dashboard has not been measured", () => {
    renderEditor(undefined)
    fireEvent.click(within(group()).getByRole("button", { name: "Dashboard size" }))
    expect(screen.getByText(/^Approximate:/)).toBeInTheDocument()
    expect(document.querySelector("[style*='--preview-width']")).toBeNull()
  })

  it("clamps a footprint wider than the pane and says how much is shown", () => {
    // The pane measures 200px, so a 306px tile is clamped and noted rather than scaled.
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() { this.callback([{ contentRect: { width: 200 } }]) }
      disconnect() {}
    })
    renderEditor({ dashboard: { width: 305.75, height: 58 } })
    fireEvent.click(within(group()).getByRole("button", { name: "Dashboard size" }))
    expect(screen.getByText("Shown at 200 of 306 px wide.")).toBeInTheDocument()
  })

  it("remembers the viewer's choice in local storage and falls back to Fill when storage is blocked", () => {
    const { unmount } = renderEditor({ dashboard: { width: 305.75, height: 58 } })
    fireEvent.click(within(group()).getByRole("button", { name: "Compact view" }))
    expect(window.localStorage.getItem(PREVIEW_SIZE_KEY)).toBe("compact")
    unmount()
    renderEditor({ dashboard: { width: 305.75, height: 58 } })
    expect(within(group()).getByRole("button", { name: "Compact view" })).toHaveAttribute("aria-pressed", "true")
    expect(readPreviewSize()).toBe("compact")
  })

  it("keeps working when local storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    renderEditor({ dashboard: { width: 305.75, height: 58 } })
    expect(within(group()).getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(within(group()).getByRole("button", { name: "Dashboard size" }))
    expect(within(group()).getByRole("button", { name: "Dashboard size" })).toHaveAttribute("aria-pressed", "true")
  })
})
