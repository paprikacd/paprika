// Read the actual visible editing surface. CodeMirror is a contenteditable,
// while older/non-code settings may still use native text inputs.
export async function queryEditorValue(locator) {
  return locator.evaluate(element => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
    const lines = [...element.querySelectorAll(".cm-line")]
    return lines.length ? lines.map(line => line.textContent).join("\n") : element.textContent ?? ""
  })
}

// CodeMirror's editable text occupies its content lines; the scrollable editing
// surface supplies the blank space for multiline authoring.
export async function queryEditorGeometry(locator) {
  return locator.evaluate(element => {
    const surface = element.closest("[data-query-code-editor]")?.querySelector(".cm-scroller") ?? element
    return { height: surface.getBoundingClientRect().height, fontSize: getComputedStyle(element).fontSize, resize: getComputedStyle(surface).resize }
  })
}
