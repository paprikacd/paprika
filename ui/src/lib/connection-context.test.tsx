import { act, render, screen } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ConnectionProvider, useConnection } from "@/lib/connection-context"

function ConnectionProbe() {
  const {
    connected,
    lastRequestSucceeded,
    online,
    reportRequestOutcome,
  } = useConnection()

  return (
    <div>
      <span data-testid="online">{String(online)}</span>
      <span data-testid="connected">{String(connected)}</span>
      <span data-testid="outcome">{String(lastRequestSucceeded)}</span>
      <button type="button" onClick={() => reportRequestOutcome(true)}>success</button>
      <button type="button" onClick={() => reportRequestOutcome(false)}>failure</button>
    </div>
  )
}

describe("ConnectionProvider", () => {
  const originalEventSource = globalThis.EventSource
  const initialOnline = navigator.onLine

  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    })
    globalThis.EventSource = vi.fn() as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: initialOnline,
    })
    globalThis.EventSource = originalEventSource
  })

  it("never constructs EventSource", () => {
    render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>
    )

    expect(globalThis.EventSource).not.toHaveBeenCalled()
  })

  it("can render on the server where navigator is unavailable", () => {
    const browserNavigator = globalThis.navigator
    vi.stubGlobal("navigator", undefined)

    try {
      expect(() =>
        renderToString(
          <ConnectionProvider>
            <span>content</span>
          </ConnectionProvider>
        )
      ).not.toThrow()
    } finally {
      vi.stubGlobal("navigator", browserNavigator)
    }
  })

  it("tracks browser online state independently from request outcomes", () => {
    render(
      <ConnectionProvider>
        <ConnectionProbe />
      </ConnectionProvider>
    )

    expect(screen.getByTestId("online")).toHaveTextContent("true")
    expect(screen.getByTestId("connected")).toHaveTextContent("false")
    expect(screen.getByTestId("outcome")).toHaveTextContent("null")

    act(() => screen.getByRole("button", { name: "success" }).click())
    expect(screen.getByTestId("connected")).toHaveTextContent("true")
    expect(screen.getByTestId("outcome")).toHaveTextContent("true")

    act(() => window.dispatchEvent(new Event("offline")))
    expect(screen.getByTestId("online")).toHaveTextContent("false")
    expect(screen.getByTestId("connected")).toHaveTextContent("false")
    expect(screen.getByTestId("outcome")).toHaveTextContent("true")

    act(() => window.dispatchEvent(new Event("online")))
    expect(screen.getByTestId("online")).toHaveTextContent("true")
    expect(screen.getByTestId("connected")).toHaveTextContent("true")

    act(() => screen.getByRole("button", { name: "failure" }).click())
    expect(screen.getByTestId("connected")).toHaveTextContent("false")
    expect(screen.getByTestId("outcome")).toHaveTextContent("false")
  })
})
