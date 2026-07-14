import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Release } from "@/gen/paprika/v1/api_pb"

const mockClient = vi.hoisted(() => ({ queryReleases: vi.fn() }))
const replace = vi.hoisted(() => vi.fn())
const query = vi.hoisted(() => ({ value: "" }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(query.value),
}))
vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

import ReleasesPage, { releasePageCount } from "./page"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function release(name: string, namespace = "apps") {
  return new Release({
    name,
    namespace,
    pipeline: "payments",
    target: "production",
    phase: "Complete",
  })
}

const losslessContext =
  "view=matrix&health=degraded&tab=evidence&unknown=kept" +
  "&application_namespace=delivery&application_name=checkout"

function expectLosslessContext(href: string | null) {
  const url = new URL(href ?? "", "https://paprika.test")
  expect(url.searchParams.get("view")).toBe("matrix")
  expect(url.searchParams.get("health")).toBe("degraded")
  expect(url.searchParams.get("tab")).toBe("evidence")
  expect(url.searchParams.get("unknown")).toBe("kept")
  expect(url.searchParams.get("application_namespace")).toBe("delivery")
  expect(url.searchParams.get("application_name")).toBe("checkout")
  return url
}

describe("ReleasesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.value = ""
    mockClient.queryReleases.mockResolvedValue({ releases: [], totalCount: 0n })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("counts and caps pages with uint64-scale totals before converting to a number", () => {
    expect(releasePageCount(BigInt(0))).toBe(1)
    expect(releasePageCount(BigInt(49))).toBe(3)
    expect(releasePageCount(BigInt("18446744073709551615"))).toBe(41_667)
  })

  it("queries the scoped second page and renders exact results with real scoped pagination links", async () => {
    query.value =
      "project=team%2Fpayments&cluster=platform%2Fprod&stage=production" +
      `&namespace=apps&namespace=platform&q=checkout&page=2&${losslessContext}`
    mockClient.queryReleases.mockResolvedValue({
      releases: [release("checkout-v42")],
      totalCount: 49n,
    })

    render(<ReleasesPage />)

    expect(await screen.findByText("checkout-v42")).toBeInTheDocument()
    expect(mockClient.queryReleases).toHaveBeenCalledTimes(1)
    const [request, options] = mockClient.queryReleases.mock.calls[0]
    expect(request).toMatchObject({
      search: "checkout",
      pageSize: 24,
      pageOffset: 24,
      filter: {
        projects: [{ namespace: "team", name: "payments" }],
        clusters: [{ namespace: "platform", name: "prod" }],
        stages: ["production"],
        namespaces: ["apps", "platform"],
        health: [],
        sync: [],
        releaseStates: [],
        rolloutStates: [],
        sourceTypes: [],
      },
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    const previous = expectLosslessContext(
      screen.getByRole("link", { name: "Previous page" }).getAttribute("href"),
    )
    const next = expectLosslessContext(
      screen.getByRole("link", { name: "Next page" }).getAttribute("href"),
    )
    expect(previous.searchParams.getAll("namespace")).toEqual(["apps", "platform"])
    expect(next.searchParams.getAll("namespace")).toEqual(["apps", "platform"])
    expect(previous.searchParams.has("page")).toBe(false)
    expect(next.searchParams.get("page")).toBe("3")
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      `/dashboard?project=team%2Fpayments&cluster=platform%2Fprod&stage=production&namespace=apps&namespace=platform&q=checkout&page=2&${losslessContext}`,
    )
  })

  it("canonicalizes invalid pages and resets pagination after a 250ms debounced search change", async () => {
    vi.useFakeTimers()
    query.value = `namespace=apps&q=old&page=invalid&${losslessContext}`

    render(<ReleasesPage />)

    await act(async () => Promise.resolve())
    expectLosslessContext(replace.mock.calls[0]?.[0])
    expect(new URL(replace.mock.calls[0][0], "https://paprika.test").searchParams.has("page")).toBe(false)
    expect(mockClient.queryReleases).toHaveBeenCalledWith(
      expect.objectContaining({ search: "old", pageOffset: 0 }),
      expect.any(Object),
    )

    fireEvent.change(screen.getByRole("searchbox", { name: "Search releases" }), {
      target: { value: "new release" },
    })
    replace.mockClear()
    await act(async () => vi.advanceTimersByTime(249))
    expect(replace).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    const searched = expectLosslessContext(replace.mock.calls.at(-1)?.[0])
    expect(searched.searchParams.get("q")).toBe("new release")
    expect(searched.searchParams.has("page")).toBe(false)
  })

  it("keeps newer draft keystrokes when an older debounced URL commit arrives, then accepts external navigation", async () => {
    vi.useFakeTimers()
    query.value = ""

    const { rerender } = render(<ReleasesPage />)
    await act(async () => Promise.resolve())
    const searchbox = screen.getByRole("searchbox", { name: "Search releases" })

    fireEvent.change(searchbox, { target: { value: "A" } })
    await act(async () => vi.advanceTimersByTime(250))
    expect(replace).toHaveBeenLastCalledWith("/dashboard/releases?q=A")

    fireEvent.change(searchbox, { target: { value: "AB" } })
    query.value = "q=A"
    rerender(<ReleasesPage />)
    expect(screen.getByRole("searchbox", { name: "Search releases" })).toHaveValue("AB")

    replace.mockClear()
    await act(async () => vi.advanceTimersByTime(250))
    expect(replace).toHaveBeenLastCalledWith("/dashboard/releases?q=AB")

    query.value = "q=AB"
    rerender(<ReleasesPage />)
    expect(screen.getByRole("searchbox", { name: "Search releases" })).toHaveValue("AB")

    query.value = "q=external"
    rerender(<ReleasesPage />)
    expect(screen.getByRole("searchbox", { name: "Search releases" })).toHaveValue("external")
  })

  it("aborts replaced requests and prevents an older completion from overwriting the newest query", async () => {
    query.value = "q=old"
    const oldRequest = deferred<{ releases: Release[]; totalCount: bigint }>()
    const newRequest = deferred<{ releases: Release[]; totalCount: bigint }>()
    mockClient.queryReleases.mockImplementation((request: { search: string }) =>
      request.search === "old" ? oldRequest.promise : newRequest.promise,
    )

    const { rerender, unmount } = render(<ReleasesPage />)
    await waitFor(() => expect(mockClient.queryReleases).toHaveBeenCalledTimes(1))
    const firstSignal = mockClient.queryReleases.mock.calls[0][1].signal as AbortSignal

    query.value = "q=new"
    rerender(<ReleasesPage />)
    await waitFor(() => expect(mockClient.queryReleases).toHaveBeenCalledTimes(2))
    expect(firstSignal.aborted).toBe(true)

    await act(async () => newRequest.resolve({ releases: [release("new-result")], totalCount: 1n }))
    expect(await screen.findByText("new-result")).toBeInTheDocument()
    await act(async () => oldRequest.resolve({ releases: [release("stale-result")], totalCount: 1n }))
    expect(screen.queryByText("stale-result")).not.toBeInTheDocument()
    expect(screen.getByText("new-result")).toBeInTheDocument()

    const secondSignal = mockClient.queryReleases.mock.calls[1][1].signal as AbortSignal
    unmount()
    expect(secondSignal.aborted).toBe(true)
  })

  it("keeps prior data during updates and errors, then retries", async () => {
    const user = userEvent.setup()
    query.value = "q=stable"
    mockClient.queryReleases.mockResolvedValueOnce({
      releases: [release("stable-result")],
      totalCount: 1n,
    })
    const update = deferred<{ releases: Release[]; totalCount: bigint }>()

    const { rerender } = render(<ReleasesPage />)
    expect(await screen.findByText("stable-result")).toBeInTheDocument()

    query.value = "q=failing"
    mockClient.queryReleases.mockReturnValueOnce(update.promise)
    rerender(<ReleasesPage />)
    expect(await screen.findByText("Updating releases…")).toBeInTheDocument()
    expect(screen.getByText("stable-result")).toBeInTheDocument()

    await act(async () => update.reject(new Error("offline")))
    expect(await screen.findByText("Unable to load releases. Try again.")).toBeInTheDocument()
    expect(screen.getByText("stable-result")).toBeInTheDocument()

    mockClient.queryReleases.mockResolvedValueOnce({
      releases: [release("recovered-result")],
      totalCount: 1n,
    })
    await user.click(screen.getByRole("button", { name: "Retry releases" }))
    expect(await screen.findByText("recovered-result")).toBeInTheDocument()
  })

  it("moves a shrunken total to the last page and refetches once, including the zero-total page-one case", async () => {
    query.value = `namespace=apps&page=4&${losslessContext}`
    mockClient.queryReleases.mockResolvedValueOnce({ releases: [], totalCount: 30n })

    const { rerender } = render(<ReleasesPage />)
    await waitFor(() => {
      const corrected = expectLosslessContext(replace.mock.calls.at(-1)?.[0])
      expect(corrected.searchParams.get("page")).toBe("2")
    })

    query.value = `namespace=apps&page=2&${losslessContext}`
    mockClient.queryReleases.mockResolvedValueOnce({
      releases: [release("last-page-result")],
      totalCount: 30n,
    })
    rerender(<ReleasesPage />)
    expect(await screen.findByText("last-page-result")).toBeInTheDocument()
    expect(mockClient.queryReleases).toHaveBeenCalledTimes(2)
    expect(mockClient.queryReleases.mock.calls[1][0]).toMatchObject({ pageOffset: 24 })

    replace.mockClear()
    query.value = `namespace=apps&page=3&${losslessContext}`
    mockClient.queryReleases.mockResolvedValueOnce({ releases: [], totalCount: 0n })
    rerender(<ReleasesPage />)
    await waitFor(() => {
      const corrected = expectLosslessContext(replace.mock.calls.at(-1)?.[0])
      expect(corrected.searchParams.has("page")).toBe(false)
    })
    query.value = `namespace=apps&${losslessContext}`
    mockClient.queryReleases.mockResolvedValueOnce({ releases: [], totalCount: 0n })
    rerender(<ReleasesPage />)
    await waitFor(() => expect(mockClient.queryReleases).toHaveBeenCalledTimes(4))
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
