import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { TraceDialog } from "./trace-dialog"
import { TraceFetcherProvider } from "./trace-waterfall"

describe("trace detail dialog", () => {
  it("opens a full trace, closes accessibly and returns focus to the opener", async () => {
    const fetchTrace = vi.fn(async () => ({ spans: [{ spanId: "root", service: "api", operation: "GET", startTime: 1000, durationMs: 200, status: "ok" }] }))
    function Example() {
      const [open, setOpen] = useState(false)
      return <TraceFetcherProvider fetchTrace={fetchTrace}><button onClick={() => setOpen(true)}>View waterfall</button>{open && <TraceDialog traceId="abc" onClose={() => setOpen(false)} />}</TraceFetcherProvider>
    }
    render(<Example />)
    const opener = screen.getByRole("button", { name: "View waterfall" })
    opener.focus(); fireEvent.click(opener)
    const dialog = screen.getByRole("dialog", { name: "Trace detail" })
    expect(screen.getByRole("button", { name: "Close trace detail" })).toHaveFocus()
    await screen.findByRole("region", { name: "Trace abc waterfall" })
    fireEvent.click(screen.getByRole("button", { name: "Close trace detail" }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })
})
