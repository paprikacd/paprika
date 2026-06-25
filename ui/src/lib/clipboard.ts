/**
 * copyToClipboard is a small SSR-safe wrapper around navigator.clipboard.
 * Centralized so UI components can be unit-tested by mocking this module,
 * avoiding tight coupling to the DOM Clipboard API (which happy-dom/jsdom
 * implementations make hard to stub reliably).
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(text)
  } else if (typeof document !== "undefined") {
    const el = document.createElement("textarea")
    el.value = text
    el.setAttribute("readonly", "")
    el.style.position = "absolute"
    el.style.left = "-9999px"
    document.body.appendChild(el)
    el.select()
    try {
      document.execCommand("copy")
    } finally {
      document.body.removeChild(el)
    }
  }
}
