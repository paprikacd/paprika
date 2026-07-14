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
const replace = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.value),
  useRouter: () => ({ replace }),
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
    replace.mockReset()
    window.history.replaceState({}, "", "/dashboard/application")
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
      "namespace=apps&namespace=platform&application_namespace=%20delivery%20&application_name=%20checkout%20&unknown=kept"

    render(<ApplicationDetailPage />)

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledWith({ namespace: "delivery", name: "checkout" })
      expect(mockClient.listReleases).toHaveBeenCalledWith({
        namespace: "delivery",
        applicationName: "checkout",
      })
    })
    expect(query.value).toContain("namespace=apps&namespace=platform")
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard?namespace=apps&namespace=platform&application_namespace=+delivery+&application_name=+checkout+&unknown=kept",
    )
    expect(replace).not.toHaveBeenCalled()
  })

  it("falls back to the legacy namespace and name pair", async () => {
    query.value = "namespace=legacy&name=payments&unknown=kept"
    window.history.replaceState({}, "", "/dashboard/application#resources")

    render(<ApplicationDetailPage />)

    await waitFor(() => {
      expect(mockClient.getApplication).toHaveBeenCalledWith({ namespace: "legacy", name: "payments" })
    })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(
      "/dashboard/application?namespace=legacy&unknown=kept&application_namespace=legacy&application_name=payments#resources",
    )
  })

  it("renders recovery when an explicit application identity is incomplete", async () => {
    query.value =
      "application_namespace=%20&application_name=ignored&namespace=legacy&name=payments&tab=resources&unknown=kept"

    render(<ApplicationDetailPage />)

    await act(async () => Promise.resolve())
    expect(mockClient.getApplication).not.toHaveBeenCalled()
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/missing application identity/i)
    expect(screen.getByRole("link", { name: "Back to Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard?application_namespace=+&application_name=ignored&namespace=legacy&name=payments&tab=resources&unknown=kept",
    )
  })

  it("renders recovery instead of querying with an incomplete legacy identity pair", async () => {
    query.value = "namespace=legacy&tab=resources&unknown=kept"

    render(<ApplicationDetailPage />)
    await act(async () => Promise.resolve())

    expect(mockClient.getApplication).not.toHaveBeenCalled()
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/missing application identity/i)
    expect(screen.getByRole("link", { name: "Back to Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard?namespace=legacy&tab=resources&unknown=kept",
    )
  })

  it("renders ambiguity instead of guessing between repeated legacy namespaces", async () => {
    query.value = "namespace=apps&namespace=platform&name=checkout&unknown=kept"

    render(<ApplicationDetailPage />)

    expect(await screen.findByText(/ambiguous application identity/i)).toBeInTheDocument()
    expect(mockClient.getApplication).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
