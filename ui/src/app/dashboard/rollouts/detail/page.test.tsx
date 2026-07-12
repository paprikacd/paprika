import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  getRollout: vi.fn(),
  promoteRollout: vi.fn(),
  abortRollout: vi.fn(),
}))
const query = vi.hoisted(() => ({ value: "namespace=legacy&name=rollout" }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.value),
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
    mockClient.getRollout.mockResolvedValue({ rollout: undefined })
  })

  it("prefers explicit rollout identity and preserves repeated shared namespace scope", async () => {
    query.value =
      "namespace=apps&namespace=platform&rollout_namespace=%20delivery%20&rollout_name=%20checkout-rollout%20"

    render(<RolloutDetailPage />)

    await waitFor(() => {
      expect(mockClient.getRollout).toHaveBeenCalledWith({
        namespace: "delivery",
        name: "checkout-rollout",
      })
    })
    expect(query.value).toContain("namespace=apps&namespace=platform")
  })

  it("falls back to legacy namespace and name links", async () => {
    query.value = "namespace=%20legacy%20&name=%20rollout%20"

    render(<RolloutDetailPage />)

    await waitFor(() => {
      expect(mockClient.getRollout).toHaveBeenCalledWith({ namespace: "legacy", name: "rollout" })
    })
  })

  it("falls back to a complete legacy pair when either explicit rollout value is blank", async () => {
    query.value =
      "rollout_namespace=delivery&rollout_name=%20&namespace=legacy&name=rollout"

    render(<RolloutDetailPage />)

    await waitFor(() => {
      expect(mockClient.getRollout).toHaveBeenCalledWith({ namespace: "legacy", name: "rollout" })
    })
  })

  it("does not query with an incomplete legacy rollout identity pair", async () => {
    query.value = "name=rollout"

    render(<RolloutDetailPage />)
    await waitFor(() => expect(mockClient.getRollout).not.toHaveBeenCalled())
  })
})
