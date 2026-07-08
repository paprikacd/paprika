import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InvestigationTriage } from "@/components/dashboard/investigation-triage"

const degradedApplication = {
  name: "payments",
  namespace: "prod",
  phase: "Degraded",
  health: "Degraded",
  outOfSync: 1,
  resources: [
    { kind: "Deployment", name: "payments-api", namespace: "prod", status: "OutOfSync" },
    { kind: "Service", name: "payments-api", namespace: "prod", status: "Synced" },
  ],
  resourceHealth: [
    { kind: "Deployment", name: "payments-api", namespace: "prod", health: "Degraded", message: "0/3 pods available" },
  ],
  healthChecks: [
    { name: "readyz", status: "Degraded", message: "HTTP 503", httpStatusCode: 503 },
  ],
  gates: [],
  conditions: [],
  analysisResults: [],
}

describe("InvestigationTriage", () => {
  it("auto-runs an investigation for the top degraded resource", async () => {
    const investigate = vi.fn().mockResolvedValue({
      summary: "Deployment unavailable",
      narrator: "deterministic",
      findings: [
        {
          id: "pods-unavailable",
          severity: 1,
          title: "Pods are unavailable",
          description: "No ready pods",
          evidence: [{ source: "pod", summary: "CrashLoopBackOff", timestamp: "now" }],
          playbook: ["kubectl describe deployment payments-api"],
        },
      ],
      generatedAtMs: BigInt(1700000000000),
    })

    render(
      <InvestigationTriage
        application={degradedApplication}
        investigate={investigate}
        onSelectResource={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(investigate).toHaveBeenCalledWith({
        kind: "Deployment",
        name: "payments-api",
        namespace: "prod",
        syncStatus: "OutOfSync",
        health: "Degraded",
        healthMessage: "0/3 pods available",
      })
    })
    expect(await screen.findByText("Deployment unavailable")).toBeInTheDocument()
    expect(screen.getByText("Pods are unavailable")).toBeInTheDocument()
    expect(screen.getByText(/Auto-run/i)).toBeInTheDocument()
  })

  it("allows manual investigation reruns and opening the resource", async () => {
    const user = userEvent.setup()
    const investigate = vi.fn().mockResolvedValue({
      summary: "Deployment unavailable",
      narrator: "deterministic",
      findings: [],
      generatedAtMs: BigInt(1700000000000),
    })
    const onSelectResource = vi.fn()

    render(
      <InvestigationTriage
        application={degradedApplication}
        investigate={investigate}
        onSelectResource={onSelectResource}
      />,
    )
    await waitFor(() => expect(investigate).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("button", { name: /run investigation for payments-api/i }))
    expect(investigate).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: /open resource payments-api/i }))
    expect(onSelectResource).toHaveBeenCalledWith({
      kind: "Deployment",
      name: "payments-api",
      namespace: "prod",
      syncStatus: "OutOfSync",
      health: "Degraded",
      healthMessage: "0/3 pods available",
    })
  })
})
