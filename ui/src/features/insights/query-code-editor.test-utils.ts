import { act } from "@testing-library/react"
import { EditorView } from "@codemirror/view"

/** Drive the real editor model in unit tests; browser tests type into its textbox. */
export function queryEditorView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element)
  if (!view) throw new Error("Expected a mounted CodeMirror query editor")
  return view
}
export function readQueryEditor(element: HTMLElement): string { return queryEditorView(element).state.doc.toString() }
export function changeQueryEditor(element: HTMLElement, value: string) {
  const view = queryEditorView(element)
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } }))
}
