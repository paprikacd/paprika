import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { ApplicationTable } from "@/components/fleet/application-table"
import type { DataSourceMap, DataStateName } from "@/components/fleet/data-sources"
import type { FleetCostResult } from "@/components/fleet/fleet-cost"
import type { GroupDimension } from "@/components/fleet/fleet-rows"
import type { FleetApplicationSummary } from "@/lib/fleet-client"
import { createFleetFocusCoordinator } from "@/lib/fleet-focus"

function harness(costs?: FleetCostResult, identities: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (costs) {
    client.setQueryData(["console", "cost", identities.join(",")], costs)
  }
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return Wrapper
}

function renderTable({
  applications,
  sources,
  group = "none",
  total,
  costs,
}: {
  applications: FleetApplicationSummary[]
  sources?: DataSourceMap
  group?: GroupDimension
  total?: bigint
  costs?: FleetCostResult
}) {
  const keys = applications
    .map((application) => application.identity)
    .filter((identity) => identity !== undefined)
    .map((identity) => `${identity.namespace}/${identity.name}`)

  return render(
    <ApplicationTable
      applications={applications}
      total={total ?? BigInt(applications.length)}
      group={group}
      sources={sources}
      onSelectApplication={vi.fn()}
      onFocusedApplication={vi.fn()}
      focusCoordinator={createFleetFocusCoordinator({ announce: vi.fn() })}
      getResultsHeadingTarget={() => null}
    />,
    { wrapper: harness(costs, keys) },
  )
}

function source(state: DataStateName, reason = "") {
  return {
    state,
    provider: "fixture",
    observedAtUnixMs: BigInt(1_725_000_000_000),
    stalenessBudgetMs: BigInt(90_000),
    unavailableReason: reason,
    retentionLimit: 0,
    retentionWindowMs: BigInt(0),
  }
}

function application(
  name: string,
  overrides: Partial<FleetApplicationSummary> = {},
): FleetApplicationSummary {
  return {
    identity: { namespace: "payments", name },
    project: { namespace: "tenant", name: "core" },
    targets: [],
    currentStage: "prod",
    currentClusterLabel: "prod-eu-1",
    sourceType: "helm",
    sourceRevision: "f8a31b2",
    health: "healthy",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 14,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(1_725_000_000_000),
    capabilities: [],
    ...overrides,
  }
}

function withLifecycle(
  application: FleetApplicationSummary,
  states: string[],
): FleetApplicationSummary {
  return { ...application, lifecycle: { states } } as FleetApplicationSummary
}

describe("ApplicationTable data-state gating", () => {
  it("omits the cost and lifecycle columns entirely when neither class is configured", () => {
    renderTable({
      applications: [application("checkout-api")],
      sources: {
        cost: { dataClass: "cost", ...source("not_configured", "no cost source is configured") },
        lifecycle: { dataClass: "lifecycle", ...source("not_configured") },
      },
    })

    const table = screen.getByRole("table", { name: "Applications" })
    expect(
      within(table).queryByRole("columnheader", { name: /cost/i }),
    ).not.toBeInTheDocument()
    expect(
      within(table).queryByRole("columnheader", { name: "LIFECYCLE" }),
    ).not.toBeInTheDocument()
    expect(table).toHaveAttribute("aria-colcount", "7")
    // Not a zero, not a dash, not a "connect a source" placeholder in the row.
    expect(within(table).queryByText("$0")).not.toBeInTheDocument()
  })

  it("omits both columns when the capability probe has not answered at all", () => {
    renderTable({ applications: [application("checkout-api")] })

    expect(screen.getByRole("table", { name: "Applications" })).toHaveAttribute(
      "aria-colcount",
      "7",
    )
  })

  it("renders the cost column with the server's figure once cost is configured", () => {
    renderTable({
      applications: [application("checkout-api")],
      sources: { cost: { dataClass: "cost", ...source("ok") } },
      costs: {
        state: "ok",
        basis: "billing",
        costs: new Map([
          [
            "payments/checkout-api",
            {
              application: { namespace: "payments", name: "checkout-api" },
              state: "ok" as const,
              basis: "billing" as const,
              monthlyAmount: 4130,
              currency: "USD",
              unavailableReason: "",
            },
          ],
        ]),
      },
    })

    const table = screen.getByRole("table", { name: "Applications" })
    expect(within(table).getByRole("columnheader", { name: "COST/MO" })).toBeInTheDocument()
    expect(within(table).getByText("$4.1k")).toBeInTheDocument()
    expect(table).toHaveAttribute("aria-colcount", "8")
  })

  it("marks an estimated cost so it cannot read as a measurement", () => {
    renderTable({
      applications: [application("checkout-api")],
      sources: { cost: { dataClass: "cost", ...source("ok") } },
      costs: { state: "ok", basis: "rate_card_requested", costs: new Map() },
    })

    expect(
      screen.getByRole("columnheader", { name: "COST/MO EST." }),
    ).toBeInTheDocument()
  })

  it("greys a configured-but-unavailable cost column and states the reason once", () => {
    renderTable({
      applications: [application("checkout-api")],
      sources: {
        cost: {
          dataClass: "cost",
          ...source("not_available", "the billing export has not been read yet"),
        },
      },
      costs: { state: "not_available", basis: "unspecified", costs: new Map() },
    })

    expect(screen.getByRole("columnheader", { name: "COST/MO" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cost unavailable — the billing export has not been read yet",
    )
    expect(
      screen.getByLabelText(
        "Cost unavailable: the billing export has not been read yet",
      ),
    ).toBeInTheDocument()
  })

  it("draws the lifecycle strip from the row's own vector", () => {
    renderTable({
      applications: [
        withLifecycle(application("checkout-api"), [
          "succeeded",
          "succeeded",
          "failed",
          "succeeded",
          "succeeded",
          "blocked",
        ]),
      ],
      sources: { lifecycle: { dataClass: "lifecycle", ...source("ok") } },
    })

    expect(screen.getByRole("columnheader", { name: "LIFECYCLE" })).toBeInTheDocument()
    expect(
      screen.getByRole("img", {
        name: "Lifecycle: source · Succeeded, build · Succeeded, test · Failed, render · Succeeded, deploy · Succeeded, verify · Blocked",
      }),
    ).toBeInTheDocument()
  })

  it("omits the lifecycle column when the class is configured but no row carries a vector", () => {
    renderTable({
      applications: [application("checkout-api")],
      sources: { lifecycle: { dataClass: "lifecycle", ...source("ok") } },
    })

    expect(
      screen.queryByRole("columnheader", { name: "LIFECYCLE" }),
    ).not.toBeInTheDocument()
  })
})

describe("ApplicationTable row model", () => {
  it("counts applications, not group headers, in the pagination contract", () => {
    renderTable({
      applications: [
        application("checkout-api"),
        application("ledger-worker", { project: { namespace: "tenant", name: "risk" } }),
      ],
      group: "project",
      total: BigInt(200),
    })

    const table = screen.getByRole("table", { name: "Applications" })
    expect(table).toHaveAttribute("aria-rowcount", "201")
    expect(
      within(table).getByRole("row", { name: "payments/checkout-api" }),
    ).toHaveAttribute("aria-rowindex", "2")
    expect(
      within(table).getByRole("row", { name: "payments/ledger-worker" }),
    ).toHaveAttribute("aria-rowindex", "3")
  })

  it("summarises each group from its own rows and collapses on request", () => {
    renderTable({
      applications: [
        application("checkout-api", { health: "degraded", sync: "out_of_sync" }),
        application("ledger-worker"),
      ],
      group: "project",
    })

    expect(screen.getByText("2 apps · 1 unhealthy · 1 drifted")).toBeInTheDocument()

    const collapse = screen.getByRole("button", { name: "Collapse tenant/core" })
    expect(collapse).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(collapse)

    expect(
      screen.queryByRole("row", { name: "payments/checkout-api" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Expand tenant/core" }),
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("names health and sync in words as well as colour", () => {
    renderTable({
      applications: [application("checkout-api", { health: "degraded", sync: "out_of_sync" })],
    })

    const row = screen.getByRole("row", { name: "payments/checkout-api" })
    expect(within(row).getByText("Degraded")).toBeInTheDocument()
    expect(within(row).getByText("Drifted")).toBeInTheDocument()
    expect(within(row).getByRole("img", { name: "Degraded" })).toBeInTheDocument()
  })

  it("offers only the actions the server authorized", () => {
    renderTable({
      applications: [
        application("checkout-api", {
          capabilities: ["application_sync", "release_rollback"],
        }),
        application("read-only"),
      ],
    })

    const authorized = screen.getByRole("row", { name: "payments/checkout-api" })
    expect(
      within(authorized).getByRole("button", { name: "Sync payments/checkout-api" }),
    ).toBeDisabled()
    expect(
      within(authorized).getByRole("button", { name: "Roll back payments/checkout-api" }),
    ).toBeDisabled()
    expect(
      within(screen.getByRole("row", { name: "payments/read-only" })).queryByRole("button"),
    ).not.toBeInTheDocument()
  })
})
