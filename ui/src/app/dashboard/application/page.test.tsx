import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  getApplication: vi.fn(),
  listReleases: vi.fn(),
  getResourceTree: vi.fn(),
  getResourceTreeDetailed: vi.fn(),
}))

const reportRequestOutcome = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("namespace=ns&name=app"),
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
})
