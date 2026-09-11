import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  ApplicationSummary,
  Cluster,
  DataClass,
  DataSourceStatus,
  DataState,
  FleetConnectionState,
  FleetHealth,
  FleetHealthBucket,
  FleetSyncState,
  GetDataSourcesResponse,
  GetSystemStatusResponse,
  LifecyclePhaseState,
  ListClustersResponse,
  ListRolloutHistoryResponse,
  ListRolloutsResponse,
  ListSourceEventsResponse,
  QueryApplicationsResponse,
  ResourceUnit,
  SourceEventKind,
  SourceEventOutcome,
} from "@/gen/paprika/v1/api_pb"
import {
  DEFAULT_FLEET_QUERY,
  mergeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"

import { OverviewView } from "./overview-view"
import type { OverviewClient } from "./use-overview-data"

const ALL_CLASSES = [
  DataClass.CLUSTER_INVENTORY,
  DataClass.CLUSTER_CAPACITY,
  DataClass.APPLICATION_SIGNALS,
  DataClass.COST,
  DataClass.SOURCE_EVENTS,
  DataClass.ROLLOUT_HISTORY,
  DataClass.PIPELINE_RUNS,
  DataClass.COMMIT_METADATA,
  DataClass.OWNERSHIP,
  DataClass.DRIFT_DETAIL,
  DataClass.LIFECYCLE,
]

function dataSources(
  overrides: Partial<Record<DataClass, DataState>> = {},
  reasons: Partial<Record<DataClass, string>> = {}
) {
  return new GetDataSourcesResponse({
    sources: ALL_CLASSES.map(
      (dataClass) =>
        new DataSourceStatus({
          dataClass,
          state: overrides[dataClass] ?? DataState.NOT_CONFIGURED,
          unavailableReason:
            reasons[dataClass] ??
            (overrides[dataClass] === undefined
              ? "this data class is not configured"
              : ""),
          provider: overrides[dataClass] === DataState.OK ? "fixture" : "",
        })
    ),
    indexGeneration: BigInt(4412),
  })
}

function systemStatus() {
  return new GetSystemStatusResponse({
    indexGeneration: BigInt(4412),
    total: BigInt(57),
    health: [
      new FleetHealthBucket({ health: FleetHealth.HEALTHY, count: BigInt(41) }),
      new FleetHealthBucket({
        health: FleetHealth.PROGRESSING,
        count: BigInt(6),
      }),
      new FleetHealthBucket({ health: FleetHealth.DEGRADED, count: BigInt(4) }),
      new FleetHealthBucket({ health: FleetHealth.FAILED, count: BigInt(2) }),
      new FleetHealthBucket({ health: FleetHealth.MISSING, count: BigInt(1) }),
      new FleetHealthBucket({ health: FleetHealth.UNKNOWN, count: BigInt(3) }),
    ],
    attentionTotal: BigInt(6),
    hasMoreAttention: true,
    attention: [
      new ApplicationSummary({
        identity: { namespace: "payments", name: "checkout-api" },
        project: { namespace: "payments", name: "core" },
        health: FleetHealth.FAILED,
        sync: FleetSyncState.SYNCED,
        resourceCount: 22,
        lastTransitionUnixMs: BigInt(0),
      }),
    ],
  })
}

function applicationsPage(withLifecycle = false) {
  return new QueryApplicationsResponse({
    total: BigInt(57),
    indexGeneration: BigInt(4412),
    applications: [
      new ApplicationSummary({
        identity: { namespace: "payments", name: "checkout-api" },
        project: { namespace: "payments", name: "core" },
        health: FleetHealth.DEGRADED,
        sync: FleetSyncState.SYNCED,
        resourceCount: 22,
        currentStage: "prod",
        currentClusterLabel: "prod-eu-1",
        lifecycle: withLifecycle
          ? {
              states: [
                LifecyclePhaseState.SUCCEEDED,
                LifecyclePhaseState.SUCCEEDED,
                LifecyclePhaseState.RUNNING,
                LifecyclePhaseState.SUCCEEDED,
                LifecyclePhaseState.BLOCKED,
                LifecyclePhaseState.PENDING,
              ],
            }
          : undefined,
      }),
    ],
  })
}

interface Fake extends OverviewClient {
  calls: Record<string, number>
  scopes: FleetQueryState[]
}

function fakeClient(
  overrides: Partial<Record<DataClass, DataState>> = {},
  options: {
    reasons?: Partial<Record<DataClass, string>>
    lifecycle?: boolean
  } = {}
): Fake {
  const calls: Record<string, number> = {}
  const scopes: FleetQueryState[] = []
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  return {
    calls,
    scopes,
    getDataSources: async () => {
      count("getDataSources")
      return dataSources(overrides, options.reasons)
    },
    getSystemStatus: async () => {
      count("getSystemStatus")
      return systemStatus()
    },
    queryApplications: async (state) => {
      count("queryApplications")
      scopes.push(state)
      return applicationsPage(options.lifecycle)
    },
    listRollouts: async () => {
      count("listRollouts")
      return new ListRolloutsResponse({ rollouts: [] })
    },
    listRolloutHistory: async () => {
      count("listRolloutHistory")
      return new ListRolloutHistoryResponse({
        state: DataState.OK,
        entries: [],
      })
    },
    listSourceEvents: async () => {
      count("listSourceEvents")
      return new ListSourceEventsResponse({
        state: DataState.OK,
        events: [
          {
            identity: { namespace: "payments", name: "evt-1" },
            kind: SourceEventKind.GIT_PUSH,
            repositoryUrl: "acme/checkout-api",
            reference: "main",
            outcome: SourceEventOutcome.ACCEPTED,
            triggeredApplicationCount: 3,
            receivedAtUnixMs: BigInt(Date.now()),
          },
        ],
      })
    },
    listClusters: async () => {
      count("listClusters")
      return new ListClustersResponse({
        total: BigInt(1),
        clusters: [
          new Cluster({
            identity: { namespace: "paprika-system", name: "prod-eu-1" },
            displayName: "prod-eu-1",
            connection: FleetConnectionState.HEALTHY,
            kubernetesVersion: "v1.31.4",
            applicationCount: BigInt(24),
            targetCount: BigInt(31),
            inventory: {
              state: DataState.NOT_AVAILABLE,
              unavailableReason: "node listing is denied for this cluster",
            },
            capacity: {
              cpu: {
                unit: ResourceUnit.MILLICORES,
                usedState: DataState.NOT_AVAILABLE,
                requestedState: DataState.OK,
                requested: 61_200,
                allocatableState: DataState.OK,
                allocatable: 72_000,
                unavailableReason: "no metrics provider is configured",
              },
            },
          }),
        ],
      })
    },
  }
}

function renderOverview(
  client: Fake,
  state: FleetQueryState = DEFAULT_FLEET_QUERY
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <OverviewView state={state} client={client} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe("OverviewView — data-state gating", () => {
  it("omits the source triggers board entirely when nothing records events", async () => {
    const client = fakeClient()
    renderOverview(client)

    await screen.findByRole("region", { name: "02 Health posture" })
    expect(screen.queryByRole("region", { name: /Source triggers/ })).toBeNull()
    expect(client.calls.listSourceEvents).toBeUndefined()
  })

  it("renders the source triggers board once a recorder exists", async () => {
    renderOverview(fakeClient({ [DataClass.SOURCE_EVENTS]: DataState.OK }))

    expect(await screen.findByText("acme/checkout-api → main")).toBeDefined()
    expect(
      screen.getByRole("region", { name: "05 Source triggers" })
    ).toBeDefined()
  })

  it("omits the clusters board when no cluster projection exists", async () => {
    const client = fakeClient()
    renderOverview(client)

    await screen.findByRole("region", { name: "02 Health posture" })
    expect(
      screen.queryByRole("region", { name: /Clusters · capacity/ })
    ).toBeNull()
    expect(client.calls.listClusters).toBeUndefined()
  })

  it("keeps a cluster's own facts while greying only what it cannot measure", async () => {
    renderOverview(
      fakeClient({
        [DataClass.CLUSTER_INVENTORY]: DataState.OK,
        [DataClass.CLUSTER_CAPACITY]: DataState.OK,
      })
    )

    const board = await screen.findByRole("region", {
      name: "06 Clusters · capacity",
    })
    expect(
      await within(board).findByText("node listing is denied for this cluster")
    ).toBeDefined()
    expect(within(board).getByText("24")).toBeDefined()
    expect(within(board).getByText("— / 61.2 / 72.0 cores")).toBeDefined()
    expect(within(board).getByText("used unavailable")).toBeDefined()
    expect(within(board).queryByText(/0 nodes/)).toBeNull()
    expect(within(board).queryByText(/0 pods/)).toBeNull()
  })

  it("omits the lifecycle board when no lifecycle projection exists", async () => {
    renderOverview(fakeClient())

    await screen.findByRole("region", { name: "02 Health posture" })
    expect(
      screen.queryByRole("region", { name: /Application lifecycle/ })
    ).toBeNull()
  })

  it("greys the lifecycle board with the server's reason when it cannot answer", async () => {
    renderOverview(
      fakeClient(
        { [DataClass.LIFECYCLE]: DataState.NOT_AVAILABLE },
        { reasons: { [DataClass.LIFECYCLE]: "the pipeline projection is offline" } }
      )
    )

    const board = await screen.findByRole("region", {
      name: "01 Application lifecycle",
    })
    expect(
      within(board).getByText("the pipeline projection is offline")
    ).toBeDefined()
    expect(within(board).queryByRole("heading", { name: "Source" })).toBeNull()
  })

  it("rolls real lifecycle vectors up into per-phase figures", async () => {
    renderOverview(
      fakeClient({ [DataClass.LIFECYCLE]: DataState.OK }, { lifecycle: true })
    )

    const board = await screen.findByRole("region", {
      name: "01 Application lifecycle",
    })
    expect(
      await within(board).findByText(
        "1 of 1 application running, blocked or failing at Test"
      )
    ).toBeDefined()
    expect(
      within(board).getByText(
        "0 of 1 application running, blocked or failing at Source"
      )
    ).toBeDefined()
  })

  it("offers no recent-rollouts tab when nothing records rollout history", async () => {
    const client = fakeClient()
    renderOverview(client)

    await screen.findByRole("region", { name: "04 Rollouts" })
    expect(screen.queryByRole("group", { name: "Rollout window" })).toBeNull()
    expect(client.calls.listRolloutHistory).toBeUndefined()
  })

  it("offers the recent-rollouts tab once a recorder exists", async () => {
    renderOverview(fakeClient({ [DataClass.ROLLOUT_HISTORY]: DataState.OK }))

    const tabs = await screen.findByRole("group", { name: "Rollout window" })
    expect(within(tabs).getByRole("button", { name: /Recent/ })).toBeDefined()
  })
})

describe("OverviewView — fleet figures", () => {
  it("reports health counts from the server's own buckets", async () => {
    renderOverview(fakeClient())
    const user = userEvent.setup()

    await screen.findByText("Showing 1 of 6 ranked by blast radius.")
    const format = screen.getByRole("group", {
      name: "Health posture format",
    })
    await user.click(within(format).getByRole("button", { name: "Bars" }))

    expect(
      screen.getByRole("link", { name: "Healthy — 41 of 57 applications" })
    ).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Failed — 2 of 57 applications" })
    ).toBeDefined()
  })

  it("shows the server-ranked attention window with its true total", async () => {
    renderOverview(fakeClient())

    const footnote = await screen.findByText(
      "Showing 1 of 6 ranked by blast radius."
    )
    expect(footnote).toBeDefined()
  })
})

describe("OverviewView — scope", () => {
  it("carries the operator's scope into the fleet query and every link out", async () => {
    const client = fakeClient()
    const scoped = mergeFleetQuery(DEFAULT_FLEET_QUERY, {
      projects: [{ namespace: "payments", name: "core" }],
    })
    renderOverview(client, scoped)

    await screen.findByText("Showing 1 of 6 ranked by blast radius.")

    expect(client.scopes[0].projects).toEqual([
      { namespace: "payments", name: "core" },
    ])
    expect(
      screen
        .getByRole("link", { name: "Open inventory" })
        .getAttribute("href")
    ).toContain("project=payments%2Fcore")
  })
})

describe("OverviewView — customise and collapse", () => {
  it("removes a board from the page when it is switched off", async () => {
    renderOverview(fakeClient())
    const user = userEvent.setup()

    await screen.findByText("Showing 1 of 6 ranked by blast radius.")
    await user.click(screen.getByRole("button", { name: "Customise" }))

    const chip = screen.getByRole("button", { name: "Needs attention" })
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    await user.click(chip)

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "03 Needs attention" })
      ).toBeNull()
    })

    await user.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(
      await screen.findByRole("region", { name: "03 Needs attention" })
    ).toBeDefined()
  })

  it("collapses a board without removing its header", async () => {
    renderOverview(fakeClient())
    const user = userEvent.setup()

    await screen.findByText("Showing 1 of 6 ranked by blast radius.")
    const board = screen.getByRole("region", { name: "03 Needs attention" })

    await user.click(
      within(board).getByRole("button", {
        name: "Collapse Needs attention board",
      })
    )

    expect(
      within(board).queryByText("Showing 1 of 6 ranked by blast radius.")
    ).toBeNull()
    expect(
      within(board).getByRole("button", { name: "Expand Needs attention board" })
    ).toBeDefined()
  })
})
