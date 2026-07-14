import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  getRollout: vi.fn(),
  promoteRollout: vi.fn(),
  abortRollout: vi.fn(),
}))
const query = vi.hoisted(() => ({ value: "namespace=legacy&name=rollout" }))
const replace = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.value),
  useRouter: () => ({ replace }),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

import RolloutDetailPage from "./page"

describe("RolloutDetailPage identity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.value = "namespace=legacy&name=rollout"
    window.history.replaceState({}, "", "/dashboard/rollouts/detail")
    mockClient.getRollout.mockResolvedValue({ rollout: undefined })
  })

  it("prefers explicit rollout identity and preserves repeated shared namespace scope", async () => {
    query.value =
      "namespace=apps&namespace=platform&rollout_namespace=%20delivery%20&rollout_name=%20checkout-rollout%20&unknown=kept"

    render(<RolloutDetailPage />)

    await waitFor(() => {
      expect(mockClient.getRollout).toHaveBeenCalledWith({
        namespace: "delivery",
        name: "checkout-rollout",
      })
    })
    expect(query.value).toContain("namespace=apps&namespace=platform")
    expect(replace).not.toHaveBeenCalled()
  })

  it("falls back to legacy namespace and name links", async () => {
    query.value = "namespace=legacy&name=rollout&unknown=kept"
    window.history.replaceState({}, "", "/dashboard/rollouts/detail#analysis")

    render(<RolloutDetailPage />)

    await waitFor(() => {
      expect(mockClient.getRollout).toHaveBeenCalledWith({ namespace: "legacy", name: "rollout" })
    })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(
      "/dashboard/rollouts/detail?namespace=legacy&unknown=kept&rollout_namespace=legacy&rollout_name=rollout#analysis",
    )
  })

  it("renders recovery when an explicit rollout identity is incomplete", async () => {
    query.value =
      "rollout_namespace=delivery&rollout_name=%20&namespace=legacy&name=rollout&tab=analysis&unknown=kept"

    render(<RolloutDetailPage />)

    await waitFor(() => expect(mockClient.getRollout).not.toHaveBeenCalled())
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/missing rollout identity/i)
    expect(screen.getByRole("link", { name: "Back to Rollouts" })).toHaveAttribute(
      "href",
      "/dashboard/rollouts?rollout_namespace=delivery&rollout_name=+&namespace=legacy&name=rollout&tab=analysis&unknown=kept",
    )
  })

  it("renders recovery instead of querying with an incomplete legacy rollout identity pair", async () => {
    query.value = "name=rollout&tab=analysis&unknown=kept"

    render(<RolloutDetailPage />)
    await waitFor(() => expect(mockClient.getRollout).not.toHaveBeenCalled())
    expect(screen.getByRole("alert")).toHaveTextContent(/missing rollout identity/i)
    expect(screen.getByRole("link", { name: "Back to Rollouts" })).toHaveAttribute(
      "href",
      "/dashboard/rollouts?name=rollout&tab=analysis&unknown=kept",
    )
  })

  it("renders ambiguity for repeated legacy namespace scope", async () => {
    query.value = "namespace=apps&namespace=platform&name=rollout&unknown=kept"
    const { getByText } = render(<RolloutDetailPage />)
    expect(getByText(/ambiguous rollout identity/i)).toBeInTheDocument()
    expect(mockClient.getRollout).not.toHaveBeenCalled()
  })
})
