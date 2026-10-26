// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { undo, redo } from "@codemirror/commands"
import { startCompletion } from "@codemirror/autocomplete"
import { QueryCodeEditor } from "./query-code-editor"
import { changeQueryEditor, queryEditorView, readQueryEditor } from "./query-code-editor.test-utils"

// jsdom has no layout; real popup placement and visibility are covered by E2E.
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()

describe("query code editor", () => {
  it("edits the actual accessible document, keeps undo/redo, and reflects external value changes", () => {
    const onChange = vi.fn()
    const { rerender } = render(<QueryCodeEditor value="up" onChange={onChange} />)
    const textbox = screen.getByRole("textbox", { name: "PromQL query" })
    expect(textbox).toHaveAttribute("contenteditable", "true")
    changeQueryEditor(textbox, "sum(up)")
    expect(onChange).toHaveBeenLastCalledWith("sum(up)")
    act(() => { undo(queryEditorView(textbox)) })
    expect(readQueryEditor(textbox)).toBe("up")
    act(() => { redo(queryEditorView(textbox)) })
    expect(readQueryEditor(textbox)).toBe("sum(up)")
    onChange.mockClear()
    rerender(<QueryCodeEditor value="rate(http_requests_total[5m])" onChange={onChange} />)
    expect(readQueryEditor(textbox)).toBe("rate(http_requests_total[5m])")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("honors an ancestor fieldset disabled state and restores editing when enabled", async () => {
    const onChange = vi.fn()
    const { rerender } = render(<fieldset disabled><QueryCodeEditor value="up" onChange={onChange} /></fieldset>)
    const textbox = screen.getByRole("textbox", { name: "PromQL query" })
    expect(textbox).toHaveAttribute("contenteditable", "false")
    changeQueryEditor(textbox, "sum(up)")
    expect(onChange).not.toHaveBeenCalled()
    expect(readQueryEditor(textbox)).toBe("up")
    rerender(<fieldset><QueryCodeEditor value="up" onChange={onChange} /></fieldset>)
    await waitFor(() => expect(textbox).toHaveAttribute("contenteditable", "true"))
    changeQueryEditor(textbox, "sum(up)")
    expect(onChange).toHaveBeenCalledWith("sum(up)")
  })

  it("rejects oversized edits without truncating the query or damaging undo", () => {
    const onChange = vi.fn()
    render(<QueryCodeEditor value="up" onChange={onChange} />)
    const textbox = screen.getByRole("textbox", { name: "PromQL query" })
    changeQueryEditor(textbox, "a".repeat(8193))
    expect(readQueryEditor(textbox)).toBe("up")
    expect(screen.getByText(/last edit was not applied/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("accepts a visible completion with Tab immediately and leaves normal Tab navigation unhandled", async () => {
    const onChange = vi.fn()
    render(<QueryCodeEditor value="" onChange={onChange} parameters={[{ name: "service" }]} />)
    const textbox = screen.getByRole("textbox", { name: "PromQL query" })
    changeQueryEditor(textbox, "up{service={{ser")
    act(() => { queryEditorView(textbox).focus(); startCompletion(queryEditorView(textbox)) })
    await screen.findByRole("option", { name: /service/ })
    fireEvent.keyDown(textbox, { key: "Tab", code: "Tab", bubbles: true })
    expect(readQueryEditor(textbox)).toBe("up{service={{service}}")
    expect(onChange).toHaveBeenLastCalledWith("up{service={{service}}")
    const tab = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })
    fireEvent(textbox, tab)
    expect(tab.defaultPrevented).toBe(false)
  })

  it("keeps typed templates intact and reports provider syntax issues", async () => {
    function Editor() {
      const [value, setValue] = useState("up{service={{service}},region={{region}}}")
      return <QueryCodeEditor value={value} onChange={setValue} parameters={[{ name: "service" }, { name: "region" }]} />
    }
    render(<Editor />)
    const textbox = screen.getByRole("textbox", { name: "PromQL query" })
    expect(screen.getByRole("status", { name: "Query syntax status" })).toHaveTextContent("Syntax checked")
    expect(readQueryEditor(textbox)).toBe("up{service={{service}},region={{region}}}")
    changeQueryEditor(textbox, "sum(")
    await waitFor(() => expect(screen.getByRole("status", { name: "Query syntax status" })).toHaveTextContent("syntax issue"))
  })

  it("switches provider language and aborts pending discovery without rewriting the query", () => {
    const onChange = vi.fn()
    const { rerender } = render(<QueryCodeEditor value="{}" onChange={onChange} provider={{ id: "tempo", name: "Tempo", type: "tempo", capabilities: ["traces"] }} />)
    expect(screen.getByRole("textbox", { name: "TraceQL query" })).toBeInTheDocument()
    rerender(<QueryCodeEditor value="{}" onChange={onChange} provider={{ id: "prom", name: "Prometheus", type: "prometheus", capabilities: ["metrics"] }} />)
    expect(readQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }))).toBe("{}")
    expect(onChange).not.toHaveBeenCalled()
  })
})
