import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  Cluster,
  FleetConnectionState,
  FleetObjectKey,
} from "@/gen/paprika/v1/api_pb"

import { ClustersBoard } from "./clusters-board"

function cluster(name: string, connection: FleetConnectionState): Cluster {
  return new Cluster({
    identity: new FleetObjectKey({ namespace: "fleet", name }),
    server: `https://${name}.example`,
    connection,
  })
}

describe("ClustersBoard", () => {
  it("says so plainly when no cluster is registered", () => {
    render(<ClustersBoard clusters={[]} />)
    expect(
      screen.getByText(/no clusters are registered in this scope/i),
    ).toBeInTheDocument()
  })

  it("bounds the board and reports what it is showing", () => {
    const clusters = Array.from({ length: 30 }, (_, index) =>
      cluster(`cluster-${index}`, FleetConnectionState.HEALTHY),
    )
    render(<ClustersBoard clusters={clusters} />)

    // A control plane can drive far more clusters than a summary board should
    // draw; the board must not grow one cell per cluster.
    expect(screen.getAllByRole("listitem")).toHaveLength(9)
    expect(screen.getByText(/9 of 30 clusters/i)).toBeInTheDocument()
  })

  it("leads with the clusters that need a look", () => {
    const clusters = [
      cluster("healthy-a", FleetConnectionState.HEALTHY),
      cluster("healthy-b", FleetConnectionState.HEALTHY),
      cluster("degraded", FleetConnectionState.UNHEALTHY),
      cluster("disabled", FleetConnectionState.DISABLED),
    ]
    render(<ClustersBoard clusters={clusters} />)

    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "")
    expect(names[0]).toContain("degraded")
    expect(names[1]).toContain("disabled")
  })

  it("does not annotate the footnote when every cluster fits", () => {
    render(
      <ClustersBoard
        clusters={[cluster("only", FleetConnectionState.HEALTHY)]}
      />,
    )
    expect(screen.queryByText(/of 1 clusters/i)).not.toBeInTheDocument()
  })
})
