import {
  StrictMode,
  type ReactNode,
} from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  AdminSessionProvider,
  useAdminSession,
} from "@/lib/admin-session-context"

const validSession = {
  subject: "alice@example.com",
  accessMode: "kubernetes-port-forward-admin",
  idleExpiresAt: "2099-07-18T05:10:00Z",
  absoluteExpiresAt: "2099-07-18T05:30:00Z",
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function SessionProbe() {
  const session = useAdminSession()
  return (
    <>
      <output data-testid="session-status">{session.status}</output>
      <output data-testid="session-subject">{session.subject ?? ""}</output>
      <button type="button" onClick={session.retry}>
        Probe now
      </button>
    </>
  )
}

function renderProvider(children: ReactNode = <SessionProbe />) {
  return render(
    <AdminSessionProvider>
      {children}
    </AdminSessionProvider>,
  )
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("AdminSessionProvider", () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.history.replaceState({}, "", "/dashboard")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("probes the same-origin no-store endpoint and treats an explicit 404 as ordinary", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 404 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    window.history.replaceState(
      {},
      "",
      "/dashboard?admin=true&auth=failed",
    )

    renderProvider()

    await waitFor(() =>
      expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary"),
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith("/admin/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByTestId("session-subject")).toBeEmptyDOMElement()
  })

  it("accepts only the reviewed session description and exposes no opaque token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(validSession),
    )
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()

    await waitFor(() =>
      expect(screen.getByTestId("session-status")).toHaveTextContent("admin"),
    )
    expect(screen.getByTestId("session-subject")).toHaveTextContent(
      "alice@example.com",
    )
    expect(screen.getByTestId("session-status").parentElement?.outerHTML)
      .not.toContain("token")
  })

  it.each([
    ["null", null],
    ["array", [validSession]],
    [
      "missing subject",
      {
        accessMode: validSession.accessMode,
        idleExpiresAt: validSession.idleExpiresAt,
        absoluteExpiresAt: validSession.absoluteExpiresAt,
      },
    ],
    ["blank subject", { ...validSession, subject: " " }],
    [
      "wrong access mode",
      { ...validSession, accessMode: "ordinary-dashboard" },
    ],
    [
      "non-string idle expiry",
      { ...validSession, idleExpiresAt: 4_078_000_000 },
    ],
    [
      "invalid absolute expiry",
      { ...validSession, absoluteExpiresAt: "later" },
    ],
    [
      "calendar-invalid day",
      { ...validSession, idleExpiresAt: "2099-02-30T05:10:00Z" },
    ],
    [
      "invalid non-leap-year day",
      { ...validSession, idleExpiresAt: "2100-02-29T05:10:00Z" },
    ],
    [
      "invalid month",
      { ...validSession, idleExpiresAt: "2099-13-18T05:10:00Z" },
    ],
    [
      "invalid hour",
      { ...validSession, idleExpiresAt: "2099-07-18T24:10:00Z" },
    ],
    [
      "invalid minute",
      { ...validSession, idleExpiresAt: "2099-07-18T05:60:00Z" },
    ],
    [
      "invalid second",
      { ...validSession, idleExpiresAt: "2099-07-18T05:10:60Z" },
    ],
    [
      "invalid offset hour",
      { ...validSession, idleExpiresAt: "2099-07-18T05:10:00+24:00" },
    ],
    [
      "invalid offset minute",
      { ...validSession, idleExpiresAt: "2099-07-18T05:10:00+10:60" },
    ],
    [
      "too many fractional digits",
      {
        ...validSession,
        idleExpiresAt: "2099-07-18T05:10:00.1234567890Z",
      },
    ],
    [
      "idle expiry after absolute expiry",
      {
        ...validSession,
        idleExpiresAt: "2099-07-18T05:31:00Z",
      },
    ],
    [
      "idle expiry after absolute expiry only at nanosecond precision",
      {
        ...validSession,
        idleExpiresAt: "2099-07-18T05:30:00.123456790Z",
        absoluteExpiresAt: "2099-07-18T05:30:00.123456789Z",
      },
    ],
    [
      "expired session",
      {
        ...validSession,
        idleExpiresAt: "2020-07-18T05:10:00Z",
        absoluteExpiresAt: "2020-07-18T05:30:00Z",
      },
    ],
    ["leaked token", { ...validSession, token: "must-not-enter-ui-state" }],
    ["unexpected field", { ...validSession, podUID: "pod-a" }],
  ])("keeps malformed 200 JSON unknown: %s", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)),
    )

    renderProvider()

    await flushAsyncWork()
    expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")
    expect(screen.getByTestId("session-subject")).toBeEmptyDOMElement()
  })

  it.each([
    {
      name: "a leap day with one fractional digit and Z",
      idleExpiresAt: "2096-02-29T05:10:00.1Z",
      absoluteExpiresAt: "2096-02-29T05:30:00.2Z",
    },
    {
      name: "nanoseconds with a positive numeric offset",
      idleExpiresAt: "2099-07-18T15:10:00.123456789+10:00",
      absoluteExpiresAt: "2099-07-18T15:30:00.987654321+10:00",
    },
    {
      name: "whole seconds with a negative numeric offset",
      idleExpiresAt: "2099-07-17T19:10:00-10:00",
      absoluteExpiresAt: "2099-07-17T19:30:00-10:00",
    },
  ])(
    "accepts Go RFC3339Nano timestamps: $name",
    async ({ idleExpiresAt, absoluteExpiresAt }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse({
            ...validSession,
            idleExpiresAt,
            absoluteExpiresAt,
          }),
        ),
      )

      renderProvider()

      await flushAsyncWork()
      expect(screen.getByTestId("session-status")).toHaveTextContent("admin")
    },
  )

  it("keeps syntactically invalid 200 JSON unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )

    renderProvider()

    await flushAsyncWork()
    expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")
  })

  it.each([401, 500, 503])(
    "treats HTTP %s as unknown instead of inferring an ordinary session",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, { status }),
        ),
      )

      renderProvider()

      await flushAsyncWork()
      expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")
    },
  )

  it("aborts a timed-out request and schedules recovery without waiting on fetch", async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) => {
        signal = init?.signal ?? undefined
        return pending.promise
      },
    )
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await flushAsyncWork()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    expect(signal?.aborted).toBe(true)
    expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("keeps fetch rejection unknown and retries with capped exponential delays", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("connection refused"),
    )
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await flushAsyncWork()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    for (const [delay, calls] of [
      [1_000, 2],
      [2_000, 3],
      [4_000, 4],
      [8_000, 5],
      [16_000, 6],
      [30_000, 7],
      [30_000, 8],
    ] as const) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1))
      expect(fetchMock).toHaveBeenCalledTimes(calls - 1)
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(fetchMock).toHaveBeenCalledTimes(calls)
      expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")
    }
  })

  it("recovers automatically from unknown to a reviewed admin session", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse(validSession))
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await flushAsyncWork()
    expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")

    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(screen.getByTestId("session-status")).toHaveTextContent("admin")
    expect(screen.getByTestId("session-subject")).toHaveTextContent(
      "alice@example.com",
    )
  })

  it("recovers automatically from unknown to an explicit ordinary response", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await flushAsyncWork()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary")
  })

  it("manual retry probes immediately and cancels the scheduled automatic retry", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await flushAsyncWork()
    fireEvent.click(screen.getByRole("button", { name: "Probe now" }))
    await flushAsyncWork()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary")
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("coalesces Retry clicks and starts one replacement only after the aborted probe settles", async () => {
    const pending = deferred<Response>()
    const replacement = deferred<Response>()
    let firstSignal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        firstSignal = init?.signal ?? undefined
        return pending.promise
      })
      .mockReturnValueOnce(replacement.promise)
    vi.stubGlobal("fetch", fetchMock)

    renderProvider()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const retry = screen.getByRole("button", { name: "Probe now" })
    fireEvent.click(retry)
    fireEvent.click(retry)
    fireEvent.click(retry)

    expect(firstSignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()

    pending.resolve(jsonResponse(validSession))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId("session-status")).toHaveTextContent("unknown")

    replacement.resolve(new Response(null, { status: 404 }))
    await waitFor(() =>
      expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary"),
    )
    expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary")
  })

  it("ignores a late StrictMode response from the aborted probe", async () => {
    const stale = deferred<Response>()
    let staleSignal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        staleSignal = init?.signal ?? undefined
        return stale.promise
      })
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)

    render(
      <StrictMode>
        <AdminSessionProvider>
          <SessionProbe />
        </AdminSessionProvider>
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary"),
    )
    expect(staleSignal?.aborted).toBe(true)
    stale.resolve(jsonResponse(validSession))
    await flushAsyncWork()
    expect(screen.getByTestId("session-status")).toHaveTextContent("ordinary")
  })

  it("aborts work and clears retry timers on unmount", async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined
      return pending.promise
    })
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = renderProvider()
    await flushAsyncWork()
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(jsonResponse(validSession))
    await flushAsyncWork()
  })

  it("drops a queued manual retry when the provider unmounts", async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined
      return pending.promise
    })
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = renderProvider()
    await flushAsyncWork()
    fireEvent.click(screen.getByRole("button", { name: "Probe now" }))
    expect(signal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()

    unmount()
    pending.resolve(jsonResponse(validSession))
    await flushAsyncWork()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears a scheduled backoff retry on unmount", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("offline"),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = renderProvider()
    await flushAsyncWork()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
