import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({ getApplicationSet: vi.fn() }))
const query = vi.hoisted(() => ({ value: "" }))
const replace = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(query.value),
}))
vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

import ApplicationSetDetailPage from "./page"

describe("ApplicationSetDetailPage identity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.getApplicationSet.mockResolvedValue({ applicationset: undefined })
  })

  it("uses an explicit identity and retains scoped breadcrumb state", async () => {
    query.value = "namespace=apps&applicationset_namespace=platform&applicationset_name=generated&unknown=kept"
    render(<ApplicationSetDetailPage />)
    await waitFor(() => {
      expect(mockClient.getApplicationSet).toHaveBeenCalledWith({ namespace: "platform", name: "generated" })
    })
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard?namespace=apps&applicationset_namespace=platform&applicationset_name=generated&unknown=kept",
    )
  })

  it("migrates one legacy identity but rejects repeated legacy namespace scope", async () => {
    query.value = "namespace=platform&name=generated&unknown=kept"
    const { rerender } = render(<ApplicationSetDetailPage />)
    await waitFor(() => expect(mockClient.getApplicationSet).toHaveBeenCalled())
    expect(replace).toHaveBeenCalledWith(
      "/dashboard/applicationsets/detail?namespace=platform&unknown=kept&applicationset_namespace=platform&applicationset_name=generated",
    )

    vi.clearAllMocks()
    query.value = "namespace=apps&namespace=platform&name=generated&unknown=kept"
    rerender(<ApplicationSetDetailPage />)
    expect(await screen.findByText(/ambiguous application set identity/i)).toBeInTheDocument()
    expect(mockClient.getApplicationSet).not.toHaveBeenCalled()
  })
})
