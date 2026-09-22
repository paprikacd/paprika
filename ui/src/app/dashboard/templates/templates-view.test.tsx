import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TemplatesClient } from "@/app/dashboard/templates/templates-view"

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
}))

vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome: vi.fn() }),
}))

import { TemplatesView } from "@/app/dashboard/templates/templates-view"

interface Set {
  name: string
  namespace: string
  applications: number
  phase: string
}

function client(applicationsets: Set[]) {
  return {
    listApplicationSets: vi.fn().mockResolvedValue({ applicationsets }),
  }
}

function renderView(fake: ReturnType<typeof client>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TemplatesView client={fake as unknown as TemplatesClient} />
    </QueryClientProvider>,
  )
}

describe("TemplatesView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
  })

  it("lists ApplicationSets with the state and generated count the API returns", async () => {
    renderView(
      client([
        {
          name: "platform-charts",
          namespace: "platform",
          applications: 6,
          phase: "Ready",
        },
        {
          name: "regional-web",
          namespace: "web",
          applications: 0,
          phase: "NotReady",
        },
      ]),
    )

    const table = await screen.findByRole("table", { name: "ApplicationSets" })
    const ready = within(table).getByRole("row", { name: /platform-charts/ })
    expect(within(ready).getByText("Ready")).toBeInTheDocument()
    expect(within(ready).getByText("6")).toBeInTheDocument()
    expect(
      within(ready).getByRole("link", { name: "platform-charts" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("namespace=platform&name=platform-charts"),
    )

    const notReady = within(table).getByRole("row", { name: /regional-web/ })
    expect(within(notReady).getByText("Not ready")).toBeInTheDocument()
  })

  it("reports a phase it does not recognise verbatim rather than guessing", async () => {
    renderView(
      client([
        { name: "odd", namespace: "ops", applications: 1, phase: "Reconciling" },
      ]),
    )

    const row = await screen.findByRole("row", { name: /odd/ })
    expect(within(row).getByText("Reconciling")).toBeInTheDocument()
  })

  it("distinguishes an empty list from a failed one", async () => {
    renderView(client([]))

    expect(
      await screen.findByText("No ApplicationSets are visible in this scope."),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("table", { name: "ApplicationSets" }),
    ).not.toBeInTheDocument()
  })

  it("says the list is unknown, not empty, when the RPC fails", async () => {
    const fake = {
      listApplicationSets: vi.fn().mockRejectedValue(new Error("nope")),
    }
    renderView(fake as unknown as ReturnType<typeof client>)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Paprika could not list ApplicationSets",
    )
  })

  it("narrows to a single selected namespace and no further", async () => {
    navigation.params = new URLSearchParams("namespace=platform")
    const fake = client([])
    renderView(fake)

    await screen.findByText("No ApplicationSets are visible in this scope.")
    expect(fake.listApplicationSets).toHaveBeenCalledWith(
      { namespace: "platform" },
      expect.anything(),
    )

    vi.clearAllMocks()
    navigation.params = new URLSearchParams("namespace=platform&namespace=web")
    const both = client([])
    renderView(both)

    await screen.findAllByText("No ApplicationSets are visible in this scope.")
    expect(both.listApplicationSets).toHaveBeenCalledWith({}, expect.anything())
  })
})
