import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  getApplication: vi.fn(),
  listReleases: vi.fn(),
  getResourceTree: vi.fn(),
  getResourceTreeDetailed: vi.fn(),
}))

const reportRequestOutcome = vi.hoisted(() => vi.fn())
const query = vi.hoisted(() => ({ value: "namespace=ns&name=app" }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.value),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/lib/transport", () => ({
  createTransport: vi.fn(() => ({})),
}))

vi.mock("@/gen/paprika/v1/api_connect", () => ({
  PaprikaService: {},
}))

vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome }),
}))

import ApplicationDetailPage from "./page"

describe("ApplicationDetailPage safe refresh", () => {
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    vi.clearAllMocks()
    query.value = "namespace=ns&name=app"
    mockClient.getApplication.mockResolvedValue({ application: undefined })
    mockClient.listReleases.mockResolvedValue({ releases: [] })
    mockClient.getResourceTree.mockResolvedValue({ nodes: [] })
    mockClient.getResourceTreeDetailed.mockResolvedValue({ nodes: [] })
    globalThis.EventSource = vi.fn() as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it("refreshes once when focus returns without constructing EventSource", async () => {
    render(<ApplicationDetailPage />)

    expect(await screen.findByText("Application not found.")).toBeInTheDocument()
    expect(mockClient.getApplication).toHaveBeenCalledTimes(1)
    expect(mockClient.listReleases).toHaveBeenCalledTimes(1)
    expect(globalThis.EventSource).not.toHaveBeenCalled()

    act(() => window.dispatchEvent(new Event("focus")))

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledTimes(2)
      expect(mockClient.listReleases).toHaveBeenCalledTimes(2)
    })
  })

  it("prefers explicit application identity without consuming repeated shared namespace scope", async () => {
    query.value =
      "namespace=apps&namespace=platform&application_namespace=%20delivery%20&application_name=%20checkout%20"

    render(<ApplicationDetailPage />)

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledWith({ namespace: "delivery", name: "checkout" })
      expect(mockClient.listReleases).toHaveBeenCalledWith({
        namespace: "delivery",
        applicationName: "checkout",
      })
    })
    expect(query.value).toContain("namespace=apps&namespace=platform")
  })

  it("falls back to the legacy namespace and name pair", async () => {
    query.value = "namespace=%20legacy%20&name=%20payments%20"

    render(<ApplicationDetailPage />)

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledWith({ namespace: "legacy", name: "payments" })
    })
  })

  it("falls back to a complete legacy pair when either explicit identity value is blank", async () => {
    query.value =
      "application_namespace=%20&application_name=ignored&namespace=legacy&name=payments"

    render(<ApplicationDetailPage />)

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledWith({ namespace: "legacy", name: "payments" })
    })
  })

  it("does not query with an incomplete legacy identity pair", async () => {
    query.value = "namespace=legacy"

    render(<ApplicationDetailPage />)
    await act(async () => Promise.resolve())

    expect(mockClient.getApplication).not.toHaveBeenCalled()
    expect(mockClient.listReleases).not.toHaveBeenCalled()
  })
})
