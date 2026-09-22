import { Code, ConnectError } from "@connectrpc/connect"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DriftQueue,
  driftFilterCounts,
  driftQueueItemFromResource,
  resourceTone,
  sortDriftQueue,
  SyncDiffWorkbench,
  type DriftFilter,
  type DriftQueueItem,
  type SyncDiffWorkbenchClient,
} from "@/components/dashboard/sync-diff-workbench"
import {
  DataClass,
  DataState,
  DriftReason,
  GetApplicationResponse,
  GetDataSourcesResponse,
  GetResourceResponse,
  IgnoreDriftedFieldResponse,
  ListDriftDetailsResponse,
  SyncResourcesResponse,
} from "@/gen/paprika/v1/api_pb"
import type { FleetApplicationsPage } from "@/lib/fleet-client"

const application = {
  name: "payments",
  namespace: "prod",
  outOfSync: 2,
  prunedResources: 1,
  resources: [
    { kind: "Deployment", name: "payments-api", namespace: "prod", status: "OutOfSync" },
    { kind: "Service", name: "payments-api", namespace: "prod", status: "Synced" },
    { kind: "ConfigMap", name: "payments-config", namespace: "prod", status: "Missing" },
    { kind: "Job", name: "payments-old-migration", namespace: "prod", status: "Pruned" },
  ],
  resourceHealth: [
    {
      kind: "Deployment",
      name: "payments-api",
      namespace: "prod",
      health: "Degraded",
      message: "ReplicaSet unavailable",
    },
    { kind: "Service", name: "payments-api", namespace: "prod", health: "Healthy", message: "" },
    {
      kind: "ConfigMap",
      name: "payments-config",
      namespace: "prod",
      health: "Unknown",
      message: "",
    },
  ],
}

function item(patch: Partial<DriftQueueItem> = {}): DriftQueueItem {
  return {
    key: "Deployment/prod/payments-api",
    kind: "Deployment",
    name: "payments-api",
    namespace: "prod",
    syncStatus: "OutOfSync",
    health: "Degraded",
    tone: "degraded",
    toneLabel: "Degraded",
    reason: "ReplicaSet unavailable",
    ...patch,
  }
}

function Harness({ items }: { items: DriftQueueItem[] }) {
  const [filter, setFilter] = useState<DriftFilter>("all")
  const [selectedKey, setSelectedKey] = useState("")
  return (
    <DriftQueue
      items={items}
      filter={filter}
      onFilterChange={setFilter}
      selectedKey={selectedKey}
      onSelect={(next) => setSelectedKey(next.key)}
    />
  )
}

describe("drift queue model", () => {
  it("resolves a tone from the sync state and the reported health", () => {
    expect(resourceTone("Missing", "Unknown")).toBe("missing")
    expect(resourceTone("OutOfSync", "Degraded")).toBe("degraded")
    expect(resourceTone("Synced", "Healthy")).toBe("healthy")
    expect(resourceTone("Pruned", "Unknown")).toBe("pending")
    expect(resourceTone("", "")).toBe("unknown")
  })

  it("counts each filter from the objects the control plane reported", () => {
    const items = application.resources.map((resource, index) =>
      driftQueueItemFromResource({
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
        syncStatus: resource.status,
        health: index === 0 ? "Degraded" : "Healthy",
        healthMessage: "",
      }),
    )
    expect(driftFilterCounts(items)).toEqual({
      all: 4,
      drifted: 3,
      missing: 1,
      degraded: 1,
      pruned: 1,
    })
  })

  it("orders the queue worst first so an incident leads", () => {
    const ordered = sortDriftQueue([
      item({ key: "a", tone: "healthy", name: "a" }),
      item({ key: "b", tone: "failed", name: "b" }),
      item({ key: "c", tone: "degraded", name: "c" }),
    ])
    expect(ordered.map((entry) => entry.key)).toEqual(["b", "c", "a"])
  })
})

describe("DriftQueue", () => {
  it("names each row by object, state and reason", async () => {
    render(<Harness items={[item()]} />)

    expect(
      screen.getByRole("button", {
        name: "Deployment payments-api, Degraded, ReplicaSet unavailable",
      }),
    ).toBeInTheDocument()
  })

  it("shows a changed-field count only when one was reported", () => {
    const { rerender } = render(<Harness items={[item()]} />)
    const queue = screen.getByRole("list")
    expect(within(queue).queryByText("4")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /changed field/ }),
    ).not.toBeInTheDocument()

    rerender(<Harness items={[item({ fieldCount: 4 })]} />)
    expect(
      screen.getByRole("button", { name: /Deployment payments-api.*4 changed fields/ }),
    ).toBeInTheDocument()
  })

  it("marks a truncated field list rather than reporting the visible count as final", () => {
    render(<Harness items={[item({ fieldCount: 40, fieldsTruncated: true })]} />)

    expect(
      screen.getByRole("button", { name: /40 or more changed fields/ }),
    ).toBeInTheDocument()
  })

  it("marks the inspected row as current", async () => {
    const user = userEvent.setup()
    render(<Harness items={[item(), item({ key: "second", name: "payments-worker" })]} />)

    await user.click(screen.getByRole("button", { name: /payments-worker/ }))

    expect(screen.getByRole("button", { name: /payments-worker/ })).toHaveAttribute(
      "aria-current",
      "true",
    )
    expect(screen.getByRole("button", { name: /payments-api/ })).not.toHaveAttribute(
      "aria-current",
    )
  })

  it("says so when a filter matches nothing instead of showing an empty frame", async () => {
    const user = userEvent.setup()
    render(<Harness items={[item()]} />)

    await user.click(screen.getByRole("button", { name: /^Missing 0$/ }))

    expect(screen.getByText("No objects match this filter.")).toBeInTheDocument()
  })

  it("offers no selection checkboxes unless the caller can act on a selection", () => {
    render(<Harness items={[item()]} />)

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })
})

const replaceRoute = vi.fn()
let currentSearch = "namespace=payments&name=checkout-api"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceRoute, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}))

const diff = [
  "--- desired",
  "+++ live",
  "@@ -18,6 +18,6 @@",
  "   spec:",
  "-    replicas: 1",
  "+    replicas: 3",
  "     template:",
].join("\n")

function dataSources(driftState: DataState, reason = ""): GetDataSourcesResponse {
  return new GetDataSourcesResponse({
    sources: [
      { dataClass: DataClass.COST, state: DataState.NOT_CONFIGURED },
      {
        dataClass: DataClass.DRIFT_DETAIL,
        state: driftState,
        unavailableReason: reason,
      },
    ],
  })
}

function applicationsPage(): FleetApplicationsPage {
  return {
    applications: [
      {
        identity: { namespace: "payments", name: "checkout-api" },
        targets: [],
        currentStage: "prod",
        currentClusterLabel: "prod-eu-1",
        sourceType: "git",
        sourceRevision: "9f3a1c2",
        health: "degraded",
        sync: "out_of_sync",
        driftCount: 4,
        missingResourceCount: 1,
        releaseState: "complete",
        rolloutState: "healthy",
        resourceCount: 12,
        repositoryConnection: "healthy",
        observabilityConnection: "healthy",
        blockedGateCount: 0,
        lastTransitionUnixMs: BigInt(0),
        capabilities: [],
      },
    ],
    total: BigInt(1),
    nextCursor: "",
    indexGeneration: BigInt(4412),
    facets: [],
  }
}

function applicationResponse(): GetApplicationResponse {
  return new GetApplicationResponse({
    application: {
      name: "checkout-api",
      namespace: "payments",
      resources: [
        { kind: "Deployment", name: "checkout-api", namespace: "payments", status: "OutOfSync" },
        { kind: "CronJob", name: "reporting-etl", namespace: "payments", status: "Missing" },
        { kind: "Service", name: "checkout-api", namespace: "payments", status: "Synced" },
      ],
      resourceHealth: [
        {
          kind: "Deployment",
          name: "checkout-api",
          namespace: "payments",
          health: "Degraded",
          message: "ReplicaSet unavailable",
        },
        {
          kind: "Service",
          name: "checkout-api",
          namespace: "payments",
          health: "Healthy",
          message: "",
        },
      ],
    },
  })
}

function driftDetailsResponse(state = DataState.OK): ListDriftDetailsResponse {
  return new ListDriftDetailsResponse({
    state,
    driftedCount: 1,
    resources: [
      {
        group: "apps",
        version: "v1",
        kind: "Deployment",
        name: "checkout-api",
        namespace: "payments",
        reason: DriftReason.FIELD_CHANGED,
        changedFieldCount: 4,
        fieldsTruncated: false,
        detailState: DataState.OK,
        lastAppliedBy: "kubectl-client-side-apply",
        lastAppliedAtUnixMs: BigInt(Date.now() - 12 * 60_000),
        fields: [
          { path: "/spec/replicas", desired: "3", live: "1", ignored: false },
          {
            path: "/spec/template/spec/containers/0/image",
            desired: "ghcr.io/acme/checkout-api:9f3a1c2",
            live: "ghcr.io/acme/checkout-api:8c22b90",
            ignored: false,
          },
        ],
      },
    ],
  })
}

function makeClient(overrides: Partial<SyncDiffWorkbenchClient> = {}): SyncDiffWorkbenchClient {
  return {
    getDataSources: vi.fn(async () => dataSources(DataState.OK)),
    queryApplications: vi.fn(async () => applicationsPage()),
    getApplication: vi.fn(async () => applicationResponse()),
    listDriftDetails: vi.fn(async () => driftDetailsResponse()),
    getResource: vi.fn(
      async () => new GetResourceResponse({ diff, apiVersion: "apps/v1", kind: "Deployment" }),
    ),
    ignoreDriftedField: vi.fn(async () => new IgnoreDriftedFieldResponse({})),
    syncResources: vi.fn(async () => new SyncResourcesResponse({})),
    ...overrides,
  }
}

function renderWorkbench(client: SyncDiffWorkbenchClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return render(<SyncDiffWorkbench client={client} />, { wrapper })
}

async function selectDeployment(user: ReturnType<typeof userEvent.setup>) {
  const row = await screen.findByRole("button", { name: /Deployment checkout-api/ })
  await user.click(row)
}

beforeEach(() => {
  currentSearch = "namespace=payments&name=checkout-api"
  replaceRoute.mockReset()
})

describe("SyncDiffWorkbench queue", () => {
  it("lists the application's objects worst first with their real sync reasons", async () => {
    renderWorkbench(makeClient())

    const queue = await screen.findByRole("list")
    const rows = within(queue).getAllByRole("button")
    expect(rows[0]).toHaveAccessibleName(/CronJob reporting-etl, Missing/)
    expect(rows[1]).toHaveAccessibleName(/Deployment checkout-api, Degraded/)
    expect(rows[2]).toHaveAccessibleName(/Service checkout-api, Healthy/)
  })

  it("filters the queue to missing objects and reports the real counts", async () => {
    const user = userEvent.setup()
    renderWorkbench(makeClient())

    await screen.findByRole("button", { name: /Deployment checkout-api/ })
    await user.click(screen.getByRole("button", { name: /^Missing 1$/ }))

    expect(screen.getByRole("button", { name: /CronJob reporting-etl/ })).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Deployment checkout-api, Degraded/ }),
    ).not.toBeInTheDocument()
  })
})

describe("SyncDiffWorkbench drift-detail gating", () => {
  it("omits field counts, the JSON patch mode and the explanation when DRIFT_DETAIL is not configured", async () => {
    const user = userEvent.setup()
    const client = makeClient({
      getDataSources: vi.fn(async () =>
        dataSources(DataState.NOT_CONFIGURED, "no drift collector is configured"),
      ),
    })
    renderWorkbench(client)
    await selectDeployment(user)

    // The RPC behind the absent surfaces is never even called.
    expect(client.listDriftDetails).not.toHaveBeenCalled()

    await screen.findByRole("heading", { name: "checkout-api" })
    expect(screen.queryByRole("heading", { name: /why this drifted/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "JSON patch" })).not.toBeInTheDocument()
    expect(screen.queryByText(/changed field/i)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Deployment checkout-api.*changed field/ }),
    ).not.toBeInTheDocument()
    // No zero stands in for the missing count.
    expect(screen.queryByText(/0 changed fields/)).not.toBeInTheDocument()
    // The diff itself still renders: it is a different data class.
    expect(screen.getByText(/replicas: 3/)).toBeInTheDocument()
    expect(screen.getByText("1 addition · 1 removal")).toBeInTheDocument()
  })

  it("greys the explanation with the server's reason when DRIFT_DETAIL is not available", async () => {
    const user = userEvent.setup()
    const client = makeClient({
      getDataSources: vi.fn(async () =>
        dataSources(DataState.NOT_AVAILABLE, "the cluster agent cannot read managedFields"),
      ),
    })
    renderWorkbench(client)
    await selectDeployment(user)

    const panel = await screen.findByRole("heading", { name: /why this drifted/i })
    expect(panel).toBeInTheDocument()
    expect(
      screen.getByText("the cluster agent cannot read managedFields"),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "JSON patch" })).not.toBeInTheDocument()
  })

  it("explains the drift from managedFields when DRIFT_DETAIL is OK", async () => {
    const user = userEvent.setup()
    renderWorkbench(makeClient())
    await selectDeployment(user)

    await screen.findByRole("heading", { name: /why this drifted/i })
    expect(screen.getByText("kubectl-client-side-apply")).toBeInTheDocument()
    expect(screen.getByText("/spec/replicas")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Deployment checkout-api.*4 changed fields/ }),
    ).toBeInTheDocument()
    expect(screen.getByText("4 changed fields · 1 addition · 1 removal")).toBeInTheDocument()
  })

  it("marks the explanation stale rather than presenting it as current", async () => {
    const user = userEvent.setup()
    renderWorkbench(
      makeClient({
        getDataSources: vi.fn(async () => dataSources(DataState.STALE)),
        listDriftDetails: vi.fn(async () => driftDetailsResponse(DataState.STALE)),
      }),
    )
    await selectDeployment(user)

    await screen.findByRole("heading", { name: /why this drifted/i })
    expect(screen.getByText(/^Stale/)).toBeInTheDocument()
  })
})

describe("SyncDiffWorkbench diff modes", () => {
  it("renders the unified diff and switches to split and JSON patch", async () => {
    const user = userEvent.setup()
    renderWorkbench(makeClient())
    await selectDeployment(user)

    await screen.findByText(/replicas: 1/)
    expect(screen.getAllByText("Desired").length).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "Split" }))
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "JSON patch" }))
    expect(screen.getByText(/"op": "replace"/)).toBeInTheDocument()
    expect(screen.getByText(/"value": 3/)).toBeInTheDocument()
  })
})

describe("SyncDiffWorkbench mutations", () => {
  it("reports an unimplemented selective sync instead of claiming success", async () => {
    const user = userEvent.setup()
    renderWorkbench(
      makeClient({
        syncResources: vi.fn(async () => {
          throw new ConnectError("SyncResources is not implemented", Code.Unimplemented)
        }),
      }),
    )

    const checkbox = await screen.findByRole("checkbox", {
      name: /Select Deployment checkout-api for sync/,
    })
    await user.click(checkbox)
    await user.click(screen.getByRole("button", { name: "Sync 1 selected" }))

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /Selective sync is not implemented on this control plane; no change was made\./,
      ),
    )
  })

  it("reports an unimplemented ignore rule instead of claiming the field is ignored", async () => {
    const user = userEvent.setup()
    renderWorkbench(
      makeClient({
        ignoreDriftedField: vi.fn(async () => {
          throw new ConnectError("IgnoreDriftedField is not implemented", Code.Unimplemented)
        }),
      }),
    )
    await selectDeployment(user)

    await screen.findByRole("heading", { name: /why this drifted/i })
    await user.click(screen.getByRole("button", { name: "Ignore /spec/replicas" }))

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /Ignoring a drifted field is not implemented on this control plane; no change was made\./,
      ),
    )
  })
})

describe("SyncDiffWorkbench application scope", () => {
  it("asks the operator to choose an application when the URL names none", async () => {
    currentSearch = ""
    renderWorkbench(makeClient())

    expect(
      await screen.findByText("Choose an application to load its drift queue."),
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Application" })).toBeInTheDocument()
  })

  it("puts the chosen application in the URL rather than in local state", async () => {
    currentSearch = ""
    const user = userEvent.setup()
    renderWorkbench(makeClient())

    const picker = await screen.findByRole("combobox", { name: "Application" })
    await waitFor(() =>
      expect(
        within(picker).getByRole("option", { name: "payments/checkout-api · 4 drifted" }),
      ).toBeInTheDocument(),
    )
    await user.selectOptions(picker, "payments/checkout-api")

    expect(replaceRoute).toHaveBeenCalledWith(
      "/dashboard/diff/?namespace=payments&name=checkout-api",
      { scroll: false },
    )
  })
})
