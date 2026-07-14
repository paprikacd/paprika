import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  FleetMapApplicationMetadata,
  FleetMapNode,
  FleetMapNodeKind,
  FleetObjectKey,
  Release,
  Rollout,
} from "@/gen/paprika/v1/api_pb"

const mockClient = vi.hoisted(() => ({
  listRollouts: vi.fn(),
  listReleases: vi.fn(),
  queryFleetMap: vi.fn(),
  promoteRollout: vi.fn(),
  abortRollout: vi.fn(),
}))
const navigation = vi.hoisted(() => ({ query: "" }))
const fleetState = vi.hoisted(() => ({
  value: {
    projects: [] as Array<{ namespace: string; name: string }>,
    clusters: [] as Array<{ namespace: string; name: string }>,
    stages: [] as string[],
    namespaces: [] as string[],
  },
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))
vi.mock("@/lib/fleet-scope-context", () => ({
  useFleetScope: () => ({ state: fleetState.value, scope: fleetState.value }),
}))

import RolloutsPage from "./page"

function applicationLeaf(
  namespace: string,
  name: string,
  {
    project = { namespace: "apps", name: "payments" },
    cluster = { namespace: "platform", name: "omega" },
    stage = "production",
  }: {
    project?: { namespace: string; name: string }
    cluster?: { namespace: string; name: string }
    stage?: string
  } = {},
) {
  return new FleetMapNode({
    stableId: `application:${namespace}/${name}`,
    kind: FleetMapNodeKind.APPLICATION,
    application: new FleetObjectKey({ namespace, name }),
    applicationMetadata: new FleetMapApplicationMetadata({
      project: new FleetObjectKey(project),
      currentCluster: new FleetObjectKey(cluster),
      currentStage: stage,
    }),
  })
}

describe("RolloutsPage fleet scope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.query = ""
    fleetState.value = { projects: [], clusters: [], stages: [], namespaces: [] }
    mockClient.listRollouts.mockResolvedValue({ rollouts: [] })
    mockClient.listReleases.mockResolvedValue({ releases: [] })
    mockClient.queryFleetMap.mockResolvedValue({ roots: [], total: 0n })
    mockClient.promoteRollout.mockResolvedValue({})
    mockClient.abortRollout.mockResolvedValue({})
  })

  it("fans out repeated Namespaces and filters Project, Cluster, and Stage through the complete map association", async () => {
    navigation.query =
      "project=apps%2Fpayments&cluster=platform%2Fomega&stage=production" +
      "&namespace=apps&namespace=other&unknown=kept"
    fleetState.value = {
      projects: [{ namespace: "apps", name: "payments" }],
      clusters: [{ namespace: "platform", name: "omega" }],
      stages: ["production"],
      namespaces: ["apps", "other"],
    }
    mockClient.listRollouts.mockImplementation(({ namespace }: { namespace?: string }) => {
      if (namespace === "apps") {
        return Promise.resolve({
          rollouts: [
            new Rollout({ namespace: "apps", name: "checkout-rollout", phase: "Progressing" }),
            new Rollout({ namespace: "apps", name: "unassociated", phase: "Progressing" }),
          ],
        })
      }
      return Promise.resolve({
        rollouts: [new Rollout({ namespace: "other", name: "other-rollout", phase: "Progressing" })],
      })
    })
    mockClient.listReleases.mockImplementation(({ namespace }: { namespace?: string }) =>
      Promise.resolve({
        releases:
          namespace === "apps"
            ? [
                new Release({
                  namespace: "apps",
                  name: "checkout-v1",
                  rolloutRef: "checkout-rollout",
                  application: "checkout",
                }),
              ]
            : [
                new Release({
                  namespace: "other",
                  name: "other-v1",
                  rolloutRef: "other-rollout",
                  application: "other-app",
                }),
              ],
      }),
    )
    const leaves = Array.from({ length: 125 }, (_, index) =>
      index === 124
        ? applicationLeaf("apps", "checkout")
        : applicationLeaf("apps", `fixture-${index}`),
    )
    mockClient.queryFleetMap.mockResolvedValue({
      roots: [
        new FleetMapNode({
          stableId: "group:applications",
          kind: FleetMapNodeKind.GROUP,
          applicationCount: 125n,
          children: leaves,
        }),
      ],
      total: 125n,
    })

    render(<RolloutsPage />)

    expect(await screen.findByText("checkout-rollout")).toBeInTheDocument()
    expect(screen.queryByText("unassociated")).not.toBeInTheDocument()
    expect(screen.queryByText("other-rollout")).not.toBeInTheDocument()
    expect(mockClient.listRollouts.mock.calls.map(([request]) => request)).toEqual([
      { namespace: "apps" },
      { namespace: "other" },
    ])
    expect(mockClient.listReleases.mock.calls.map(([request]) => request)).toEqual([
      { namespace: "apps" },
      { namespace: "other" },
    ])
    expect(mockClient.queryFleetMap).toHaveBeenCalledTimes(1)
    expect(mockClient.queryFleetMap.mock.calls[0][0]).toMatchObject({
      filter: {
        projects: [{ namespace: "apps", name: "payments" }],
        clusters: [{ namespace: "platform", name: "omega" }],
        stages: ["production"],
        namespaces: ["apps", "other"],
      },
    })
    const detail = new URL(
      screen.getByRole("link", { name: "checkout-rollout" }).getAttribute("href")!,
      "https://paprika.test",
    )
    expect(detail.searchParams.getAll("project")).toEqual(["apps/payments"])
    expect(detail.searchParams.getAll("cluster")).toEqual(["platform/omega"])
    expect(detail.searchParams.getAll("stage")).toEqual(["production"])
    expect(detail.searchParams.getAll("namespace")).toEqual(["apps", "other"])
    expect(detail.searchParams.get("unknown")).toBe("kept")
  })

  it("fails the section rather than showing a partial namespace fanout", async () => {
    navigation.query = "namespace=apps&namespace=other"
    fleetState.value = { projects: [], clusters: [], stages: [], namespaces: ["apps", "other"] }
    mockClient.listRollouts.mockImplementation(({ namespace }: { namespace?: string }) =>
      namespace === "apps"
        ? Promise.resolve({ rollouts: [new Rollout({ namespace: "apps", name: "partial" })] })
        : Promise.reject(new Error("other unavailable")),
    )

    render(<RolloutsPage />)

    expect(await screen.findByText("Failed to load rollouts")).toBeInTheDocument()
    expect(screen.queryByText("partial")).not.toBeInTheDocument()
  })

  it("keys action progress by exact namespace/name", async () => {
    fleetState.value = { projects: [], clusters: [], stages: [], namespaces: [] }
    mockClient.listRollouts.mockResolvedValue({
      rollouts: [
        new Rollout({ namespace: "apps", name: "deploy", phase: "Progressing" }),
        new Rollout({ namespace: "other", name: "deploy", phase: "Progressing" }),
      ],
    })
    mockClient.listReleases.mockResolvedValue({ releases: [] })
    mockClient.queryFleetMap.mockResolvedValue({ roots: [], total: 0n })
    let resolvePromote!: () => void
    mockClient.promoteRollout.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePromote = resolve
      }),
    )

    render(<RolloutsPage />)
    const rows = await screen.findAllByRole("row")
    const appRow = rows.find((row) => within(row).queryByText("apps"))!
    const otherRow = rows.find((row) => within(row).queryByText("other"))!

    fireEvent.click(within(appRow).getByRole("button", { name: "Promote" }))
    expect(within(appRow).getByRole("button", { name: "Promote" })).toBeDisabled()
    expect(within(otherRow).getByRole("button", { name: "Promote" })).toBeEnabled()

    await act(async () => resolvePromote())
    await waitFor(() => expect(mockClient.promoteRollout).toHaveBeenCalledWith({ namespace: "apps", name: "deploy" }))
  })
})
