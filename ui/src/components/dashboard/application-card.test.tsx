import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Application } from "@/gen/paprika/v1/api_pb"

vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => ({})) }))
vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

import { ApplicationCard } from "@/components/dashboard/application-card"

describe("ApplicationCard navigation", () => {
  it("keeps fleet and unknown query state with a dedicated application identity", () => {
    const application = new Application({
      namespace: "delivery",
      name: "checkout",
      phase: "Healthy",
      health: "Healthy",
    })

    render(
      <ApplicationCard
        application={application}
        query="namespace=apps&project=tenant%2Fretail&view=heatmap&unknown=kept"
      />,
    )

    for (const link of screen.getAllByRole("link")) {
      const url = new URL(link.getAttribute("href")!, "https://paprika.test")
      expect(url.pathname).toBe("/dashboard/application")
      expect(url.searchParams.get("namespace")).toBe("apps")
      expect(url.searchParams.get("unknown")).toBe("kept")
      expect(url.searchParams.get("application_namespace")).toBe("delivery")
      expect(url.searchParams.get("application_name")).toBe("checkout")
    }
  })
})
