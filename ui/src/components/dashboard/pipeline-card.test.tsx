import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Pipeline } from "@/gen/paprika/v1/api_pb"
import { PipelineCard } from "@/components/dashboard/pipeline-card"

describe("PipelineCard navigation", () => {
  it("keeps fleet and unknown query state with a dedicated pipeline identity", () => {
    render(
      <PipelineCard
        pipeline={new Pipeline({ namespace: "ci", name: "checkout-build", phase: "Running" })}
        query="namespace=apps&stage=prod&unknown=kept"
      />,
    )

    const link = screen.getByRole("link", { name: /checkout-build/i })
    const url = new URL(link.getAttribute("href")!, "https://paprika.test")
    expect(url.searchParams.get("namespace")).toBe("apps")
    expect(url.searchParams.get("unknown")).toBe("kept")
    expect(url.searchParams.get("pipeline_namespace")).toBe("ci")
    expect(url.searchParams.get("pipeline_name")).toBe("checkout-build")
  })
})
