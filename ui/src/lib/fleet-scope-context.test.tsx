import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FleetMapResult } from "@/lib/fleet-client"
import {
  FleetScopeProvider,
  useFleetScope,
} from "@/lib/fleet-scope-context"

const navigation = vi.hoisted(() => {
  const replace = vi.fn()
  return {
    pathname: "/dashboard/applications",
    query: "",
    replace,
    router: { replace },
  }
})

const fleetRpc = vi.hoisted(() => ({
  queryFleetMap: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

vi.mock("@/lib/fleet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fleet-client")>()
  return {
    ...actual,
    queryFleetMap: fleetRpc.queryFleetMap,
  }
})

function mapResult(
  facets: FleetMapResult["facets"] = [],
): FleetMapResult {
  return {
    roots: [],
    total: BigInt(0),
    indexGeneration: BigInt(7),
    facets,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  })
}

function ScopeProbe() {
  const fleetScope = useFleetScope()
  return (
    <div>
      <output data-testid="scope-state">
        {JSON.stringify({
          projects: fleetScope.scope.projects,
          clusters: fleetScope.scope.clusters,
          stages: fleetScope.scope.stages,
          namespaces: fleetScope.scope.namespaces,
        })}
      </output>
      <output data-testid="facet-status">{fleetScope.status}</output>
      <output data-testid="scope-mutation-error">
        {fleetScope.mutationError?.reason ?? ""}
      </output>
      <ul>
        {fleetScope.facets.map((facet) => (
          <li
            key={`${facet.dimension}:${facet.id}`}
            data-testid={`facet-${facet.dimension}-${facet.id}`}
            data-selected={facet.selected}
            data-availability={facet.availability}
          >
            {facet.label}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          fleetScope.patchScope({
            projects: [{ namespace: "team", name: "next" }],
          })
        }
      >
        Change project
      </button>
      <button
        type="button"
        onClick={() =>
          fleetScope.patchScope({ namespaces: ["replacement"] })
        }
      >
        Change namespace
      </button>
      <button
        type="button"
        onClick={() => void fleetScope.retry().catch(() => undefined)}
      >
        Retry facets
      </button>
    </div>
  )
}

function renderProvider(children: ReactNode = <ScopeProbe />) {
  const queryClient = newQueryClient()
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <FleetScopeProvider>{children}</FleetScopeProvider>
      </QueryClientProvider>,
    ),
  }
}

describe("FleetScopeProvider", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboard/applications"
    navigation.query = ""
    navigation.replace.mockReset()
    fleetRpc.queryFleetMap.mockReset()
    fleetRpc.queryFleetMap.mockResolvedValue(mapResult())
    window.history.replaceState({}, "", "/dashboard/applications")
  })

  it("shares one parsed route scope with every consumer", async () => {
    navigation.query =
      "project=team%2Fpayments&cluster=platform%2Fprod&stage=production&namespace=apps"
    const firstScopes: unknown[] = []
    const secondScopes: unknown[] = []

    function Consumer({ observations }: { observations: unknown[] }) {
      const { scope } = useFleetScope()
      observations.push(scope)
      return <span>{scope.namespaces.join(",")}</span>
    }

    renderProvider(
      <>
        <Consumer observations={firstScopes} />
        <Consumer observations={secondScopes} />
      </>,
    )

    await waitFor(() => expect(fleetRpc.queryFleetMap).toHaveBeenCalledOnce())
    expect(firstScopes.at(-1)).toBe(secondScopes.at(-1))
    expect(firstScopes.at(-1)).toEqual({
      projects: [{ namespace: "team", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["production"],
      namespaces: ["apps"],
    })
  })

  it("keeps selected facets present while loading and marks settled missing values unavailable", async () => {
    navigation.query = "project=team%2Fmissing&namespace=legacy"
    const request = deferred<FleetMapResult>()
    fleetRpc.queryFleetMap.mockReturnValue(request.promise)

    renderProvider()

    expect(screen.getByTestId("facet-project-team/missing")).toHaveAttribute(
      "data-availability",
      "unknown",
    )
    expect(screen.getByTestId("facet-project-team/missing")).toHaveAttribute(
      "data-selected",
      "true",
    )
    expect(screen.getByTestId("facet-namespace-legacy")).toHaveAttribute(
      "data-availability",
      "unknown",
    )

    await act(async () => {
      request.resolve(
        mapResult([
          {
            dimension: "project",
            object: { namespace: "team", name: "platform" },
            label: "Platform",
            count: BigInt(3),
          },
          {
            dimension: "namespace",
            value: "modern",
            label: "modern",
            count: BigInt(2),
          },
        ]),
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId("facet-status")).toHaveTextContent("empty"),
    )
    expect(screen.getByTestId("facet-project-team/missing")).toHaveAttribute(
      "data-availability",
      "unavailable",
    )
    expect(screen.getByTestId("facet-namespace-legacy")).toHaveAttribute(
      "data-availability",
      "unavailable",
    )
    expect(screen.getByTestId("facet-project-team/platform")).toHaveAttribute(
      "data-availability",
      "available",
    )
  })

  it("aborts the obsolete facet request and ignores its late response", async () => {
    navigation.query = "namespace=first"
    const first = deferred<FleetMapResult>()
    const second = deferred<FleetMapResult>()
    let firstSignal: AbortSignal | undefined
    fleetRpc.queryFleetMap.mockImplementation((state, options = {}) => {
      if (state.namespaces[0] === "first") {
        firstSignal = options.signal
        return first.promise
      }
      return second.promise
    })

    const { queryClient, rerender } = renderProvider()
    await waitFor(() => expect(fleetRpc.queryFleetMap).toHaveBeenCalledOnce())

    navigation.query = "namespace=second"
    rerender(
      <QueryClientProvider client={queryClient}>
        <FleetScopeProvider>
          <ScopeProbe />
        </FleetScopeProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    await act(async () => {
      second.resolve(
        mapResult([
          {
            dimension: "namespace",
            value: "second",
            label: "second",
            count: BigInt(1),
          },
        ]),
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId("facet-namespace-second")).toHaveAttribute(
        "data-availability",
        "available",
      ),
    )

    await act(async () => {
      first.resolve(
        mapResult([
          {
            dimension: "namespace",
            value: "first",
            label: "first",
            count: BigInt(99),
          },
        ]),
      )
      await Promise.resolve()
    })

    expect(screen.queryByTestId("facet-namespace-first")).not.toBeInTheDocument()
    expect(screen.getByTestId("facet-namespace-second")).toBeInTheDocument()
  })

  it("leaves URL state intact after failure and retries without treating empty facets as authoritative", async () => {
    const user = userEvent.setup()
    navigation.query = "namespace=legacy&tab=events&unknown=kept"
    fleetRpc.queryFleetMap
      .mockRejectedValueOnce(new Error("facets unavailable"))
      .mockResolvedValueOnce(
        mapResult([
          {
            dimension: "namespace",
            value: "modern",
            label: "modern",
            count: BigInt(1),
          },
        ]),
      )

    renderProvider()

    await waitFor(() =>
      expect(screen.getByTestId("facet-status")).toHaveTextContent("error"),
    )
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(screen.getByTestId("facet-namespace-legacy")).toHaveAttribute(
      "data-availability",
      "unknown",
    )

    await user.click(screen.getByRole("button", { name: "Retry facets" }))

    await waitFor(() =>
      expect(screen.getByTestId("facet-status")).toHaveTextContent("empty"),
    )
    expect(fleetRpc.queryFleetMap).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("facet-namespace-legacy")).toHaveAttribute(
      "data-availability",
      "unavailable",
    )
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it("patches scope losslessly, clears only invalidated transients, and retains the current hash", async () => {
    const user = userEvent.setup()
    navigation.pathname = "/dashboard/application"
    navigation.query =
      "project=team%2Fold&namespace=legacy&q=payments&view=heatmap&page=4&cursor=next" +
      "&selected=apps%2Fcheckout&zoom=project%3Ateam%2Fold" +
      "&application_namespace=apps&application_name=checkout&tab=events&unknown=kept"
    window.history.replaceState(
      {},
      "",
      `/dashboard/application?${navigation.query}#resources`,
    )

    renderProvider()
    await user.click(screen.getByRole("button", { name: "Change project" }))

    expect(navigation.replace).toHaveBeenCalledOnce()
    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/application?namespace=legacy&q=payments&view=heatmap" +
        "&application_namespace=apps&application_name=checkout&tab=events&unknown=kept" +
        "&project=team%2Fnext#resources",
      { scroll: false },
    )
  })

  it("migrates an unambiguous legacy detail identity before replacing fleet namespaces", async () => {
    const user = userEvent.setup()
    navigation.pathname = "/dashboard/application"
    navigation.query = "namespace=legacy&name=checkout&tab=events"
    window.history.replaceState(
      {},
      "",
      `/dashboard/application?${navigation.query}#history`,
    )

    renderProvider()
    await user.click(screen.getByRole("button", { name: "Change namespace" }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/application?tab=events&application_namespace=legacy" +
        "&application_name=checkout&namespace=replacement#history",
      { scroll: false },
    )
  })

  it("reports ambiguous legacy identity instead of guessing during a scope change", async () => {
    const user = userEvent.setup()
    navigation.pathname = "/dashboard/application"
    navigation.query = "namespace=one&namespace=two&name=checkout&tab=events"
    window.history.replaceState(
      {},
      "",
      `/dashboard/application?${navigation.query}`,
    )

    renderProvider()
    await user.click(screen.getByRole("button", { name: "Change namespace" }))

    expect(navigation.replace).not.toHaveBeenCalled()
    expect(screen.getByTestId("scope-mutation-error")).toHaveTextContent(
      "multiple_legacy_namespaces",
    )
  })
})
