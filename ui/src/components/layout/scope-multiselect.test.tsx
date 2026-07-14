import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ScopeMultiselect } from "@/components/layout/scope-multiselect"
import type {
  FleetScopeDimension,
  FleetScopeFacet,
} from "@/lib/fleet-scope-context"
import type { FleetDataStatus } from "@/lib/use-fleet-data"

function objectFacet({
  dimension = "project",
  id,
  label,
  count = BigInt(1),
  selected = false,
  availability = "available",
}: {
  dimension?: "project" | "cluster"
  id: string
  label: string
  count?: bigint | null
  selected?: boolean
  availability?: FleetScopeFacet["availability"]
}): FleetScopeFacet {
  const [namespace, name] = id.split("/")
  return {
    dimension,
    id,
    object: { namespace, name },
    label,
    count: count ?? undefined,
    selected,
    availability,
  }
}

function valueFacet({
  dimension,
  value,
  label = value,
  count = BigInt(1),
  selected = false,
  availability = "available",
}: {
  dimension: "stage" | "namespace"
  value: string
  label?: string
  count?: bigint
  selected?: boolean
  availability?: FleetScopeFacet["availability"]
}): FleetScopeFacet {
  return {
    dimension,
    id: value,
    value,
    label,
    count,
    selected,
    availability,
  }
}

function picker(
  facets: readonly FleetScopeFacet[],
  {
    dimension = "project",
    status = "ready",
    onSelectionChange = vi.fn(),
    onRetry = vi.fn().mockResolvedValue(undefined),
  }: {
    dimension?: FleetScopeDimension
    status?: FleetDataStatus
    onSelectionChange?: (next: readonly FleetScopeFacet[]) => void
    onRetry?: () => void | Promise<void>
  } = {},
) {
  return (
    <ScopeMultiselect
      dimension={dimension}
      facets={facets}
      status={status}
      onSelectionChange={onSelectionChange}
      onRetry={onRetry}
    />
  )
}

describe("ScopeMultiselect", () => {
  it("summarizes all, one, and multiple selections and disambiguates canonical collisions", async () => {
    const user = userEvent.setup()
    const platform = objectFacet({
      id: "team/platform",
      label: "Platform",
      count: BigInt(8),
    })
    const { rerender } = render(picker([platform]))

    expect(
      screen.getByRole("button", {
        name: "Projects, All projects, 1 result",
      }),
    ).toHaveTextContent("All projects")

    rerender(picker([{ ...platform, selected: true }]))
    expect(
      screen.getByRole("button", {
        name: "Projects, Platform, 1 result",
      }),
    ).toHaveTextContent("Platform")

    const collisions = [
      objectFacet({
        id: "team-a/payments",
        label: "Payments",
        selected: true,
        count: BigInt(12),
      }),
      objectFacet({
        id: "team-b/payments",
        label: "Payments",
        count: BigInt(4),
      }),
      objectFacet({
        id: "team-a/payments-api",
        label: "Payments",
        count: BigInt(2),
      }),
      objectFacet({
        id: "team/platform",
        label: "Platform",
        selected: true,
        count: BigInt(8),
      }),
    ]
    rerender(picker(collisions))

    const trigger = screen.getByRole("button", {
      name: "Projects, Payments · team-a/payments +1, 4 results",
    })
    expect(trigger).toHaveTextContent("Payments · team-a/payments +1")

    await user.click(trigger)
    expect(screen.getByText("team-a/payments")).toBeInTheDocument()
    expect(screen.getByText("team-b/payments")).toBeInTheDocument()
    expect(screen.getByText("Payments · team-a/payments-api")).toBeInTheDocument()
    expect(screen.getByText("team/platform")).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", {
        name: /Projects, Payments, team-a\/payments, 12 applications, selected/i,
      }),
    ).toBeChecked()
  })

  it("filters a bounded high-cardinality list and selects every visible result", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const facets = Array.from({ length: 105 }, (_, index) =>
      objectFacet({
        id: `team/project-${index.toString().padStart(3, "0")}`,
        label: `Project ${index}`,
        count: BigInt(index + 1),
      }),
    )
    render(picker(facets, { onSelectionChange }))

    await user.click(
      screen.getByRole("button", {
        name: "Projects, All projects, 105 results",
      }),
    )
    expect(
      screen.getByRole("group", { name: "Projects options" }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(100)
    expect(
      screen.getByText("Showing the first 100 of 105 results. Refine your search to find more."),
    ).toBeInTheDocument()
    expect(screen.getByText("team/project-000")).toBeInTheDocument()

    const filter = screen.getByRole("searchbox", {
      name: "Filter Projects, 105 results",
    })
    await user.type(filter, "project-104")
    expect(filter).toHaveAccessibleName("Filter Projects, 1 result")
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(
      screen.getByRole("checkbox", {
        name: /Projects, Project 104, team\/project-104, 105 applications, not selected/i,
      }),
    ).not.toBeChecked()

    await user.click(
      screen.getByRole("button", {
        name: "Select all 1 visible Project result",
      }),
    )
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange.mock.calls[0][0].map((facet: FleetScopeFacet) => facet.id)).toEqual([
      "team/project-104",
    ])
  })

  it("pins selected unavailable values under the render cap and preserves them when selecting visible options", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const authorized = Array.from({ length: 105 }, (_, index) =>
      objectFacet({
        id: `team/project-${index.toString().padStart(3, "0")}`,
        label: `Project ${index}`,
      }),
    )
    const unavailable = objectFacet({
      id: "legacy/retired",
      label: "Retired",
      selected: true,
      availability: "unavailable",
      count: null,
    })
    render(picker([...authorized, unavailable], { onSelectionChange }))

    await user.click(
      screen.getByRole("button", {
        name: "Projects, Retired, 105 results",
      }),
    )
    expect(screen.getAllByRole("checkbox")).toHaveLength(100)
    expect(
      screen.getByRole("checkbox", {
        name: /Projects, Retired, legacy\/retired, unavailable, selected/i,
      }),
    ).toBeChecked()

    await user.click(
      screen.getByRole("button", {
        name: "Select all 99 visible Project results",
      }),
    )
    const selectedIds = onSelectionChange.mock.calls[0][0].map(
      (facet: FleetScopeFacet) => facet.id,
    )
    expect(selectedIds).toContain("legacy/retired")
    expect(selectedIds).toHaveLength(100)
  })

  it("clears one dimension without closing the control", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      picker(
        [
          valueFacet({ dimension: "stage", value: "production", selected: true }),
          valueFacet({ dimension: "stage", value: "canary", selected: true }),
        ],
        { dimension: "stage", onSelectionChange },
      ),
    )

    await user.click(
      screen.getByRole("button", {
        name: "Stages, production +1, 2 results",
      }),
    )
    await user.click(screen.getByRole("button", { name: "Clear Stages selection" }))

    expect(onSelectionChange).toHaveBeenCalledWith([])
    expect(screen.getByRole("searchbox", { name: "Filter Stages, 2 results" })).toBeVisible()
  })

  it("composes rapid selections before the URL-backed provider rerenders", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      picker(
        [
          valueFacet({ dimension: "stage", value: "canary" }),
          valueFacet({ dimension: "stage", value: "production" }),
        ],
        { dimension: "stage", onSelectionChange },
      ),
    )

    await user.click(
      screen.getByRole("button", {
        name: "Stages, All stages, 2 results",
      }),
    )
    await user.click(screen.getByRole("checkbox", { name: /Stages, canary/i }))
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, production/i }),
    )

    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    expect(
      onSelectionChange.mock.calls[1][0].map(
        (facet: FleetScopeFacet) => facet.id,
      ),
    ).toEqual(["canary", "production"])
  })

  it("resynchronizes after an unissued external scope replaces an observed intermediate URL", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const facets = [
      valueFacet({ dimension: "stage", value: "canary" }),
      valueFacet({ dimension: "stage", value: "production" }),
      valueFacet({ dimension: "stage", value: "staging" }),
    ]
    const { rerender } = render(
      picker(facets, { dimension: "stage", onSelectionChange }),
    )

    await user.click(
      screen.getByRole("button", {
        name: "Stages, All stages, 3 results",
      }),
    )
    await user.click(screen.getByRole("checkbox", { name: /Stages, canary/i }))
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, production/i }),
    )

    rerender(
      picker(
        facets.map((facet) => ({
          ...facet,
          selected: facet.id === "canary",
        })),
        { dimension: "stage", onSelectionChange },
      ),
    )
    rerender(picker(facets, { dimension: "stage", onSelectionChange }))

    await user.click(screen.getByRole("checkbox", { name: /Stages, staging/i }))
    expect(
      onSelectionChange.mock.calls.at(-1)![0].map(
        (facet: FleetScopeFacet) => facet.id,
      ),
    ).toEqual(["staging"])
  })

  it("keeps selected unknown and unavailable values removable without reconciling them", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const legacy = valueFacet({
      dimension: "namespace",
      value: "legacy",
      selected: true,
      count: undefined,
      availability: "unknown",
    })
    const { rerender } = render(
      picker([legacy], {
        dimension: "namespace",
        status: "loading",
        onSelectionChange,
      }),
    )

    const trigger = screen.getByRole("button", {
      name: "Namespaces, legacy, loading results",
    })
    expect(trigger).toHaveAttribute("aria-busy", "true")
    await user.click(trigger)
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading authorized namespaces",
    )
    expect(screen.getByText("Checking availability")).toBeInTheDocument()
    expect(onSelectionChange).not.toHaveBeenCalled()

    rerender(
      picker(
        [{ ...legacy, availability: "unavailable" }],
        {
          dimension: "namespace",
          status: "ready",
          onSelectionChange,
        },
      ),
    )
    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(onSelectionChange).not.toHaveBeenCalled()

    expect(
      screen.getByRole("button", {
        name: "Namespaces, legacy, 0 results",
      }),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("checkbox", {
        name: /Namespaces, legacy, .*unavailable, selected/i,
      }),
    )
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it("reports failed facets and retries without mutating selection or location", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const onRetry = vi.fn().mockResolvedValue(undefined)
    window.history.replaceState({}, "", "/dashboard?namespace=legacy&unknown=kept")
    render(
      picker(
        [
          valueFacet({
            dimension: "namespace",
            value: "legacy",
            selected: true,
            availability: "unknown",
          }),
        ],
        {
          dimension: "namespace",
          status: "error",
          onSelectionChange,
          onRetry,
        },
      ),
    )

    await user.click(
      screen.getByRole("button", {
        name: "Namespaces, legacy, results unavailable",
      }),
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Namespaces could not be loaded. Your current selection is unchanged.",
    )
    await user.click(screen.getByRole("button", { name: "Retry loading Namespaces" }))

    expect(onRetry).toHaveBeenCalledOnce()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(
      window.location.href.endsWith(
        "/dashboard?namespace=legacy&unknown=kept",
      ),
    ).toBe(true)
  })

  it("announces retry progress and handles a rejected retry without changing scope", async () => {
    const user = userEvent.setup()
    let rejectRetry!: (reason: unknown) => void
    const retry = new Promise<void>((_resolve, reject) => {
      rejectRetry = reject
    })
    const onSelectionChange = vi.fn()
    render(
      picker([], {
        dimension: "namespace",
        status: "error",
        onSelectionChange,
        onRetry: () => retry,
      }),
    )

    await user.click(
      screen.getByRole("button", {
        name: "Namespaces, All namespaces, results unavailable",
      }),
    )
    const liveStatus = screen.getByRole("status")
    expect(liveStatus).toHaveTextContent("Results unavailable")
    const retryButton = screen.getByRole("button", {
      name: "Retry loading Namespaces",
    })
    await user.click(retryButton)
    expect(liveStatus).toHaveTextContent("Retrying Namespaces")
    expect(retryButton).toBeDisabled()

    rejectRetry(new Error("still unavailable"))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Retry failed. Try again.",
    )
    expect(retryButton).toBeEnabled()
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it("supports arrow, Home, End, Enter, Space, and Escape with focus restoration", async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const facets = [
      valueFacet({ dimension: "stage", value: "canary" }),
      valueFacet({ dimension: "stage", value: "production" }),
      valueFacet({ dimension: "stage", value: "staging" }),
    ]
    render(picker(facets, { dimension: "stage", onSelectionChange }))

    const trigger = screen.getByRole("button", {
      name: "Stages, All stages, 3 results",
    })
    trigger.focus()
    await user.keyboard("{Enter}")
    const filter = screen.getByRole("searchbox", {
      name: "Filter Stages, 3 results",
    })
    expect(filter).toHaveFocus()

    await user.keyboard("{ArrowDown}")
    const canary = screen.getByRole("checkbox", { name: /Stages, canary/i })
    const production = screen.getByRole("checkbox", { name: /Stages, production/i })
    const staging = screen.getByRole("checkbox", { name: /Stages, staging/i })
    expect(canary).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(production).toHaveFocus()
    await user.keyboard("{End}")
    expect(staging).toHaveFocus()
    await user.keyboard("{Home}")
    expect(canary).toHaveFocus()

    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    expect(onSelectionChange.mock.calls[0][0].map((facet: FleetScopeFacet) => facet.id)).toEqual([
      "canary",
    ])

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.keyboard(" ")
    expect(screen.getByRole("searchbox")).toHaveFocus()
  })

  it("uses a sensible tab order, closes on outside click, and keeps touch targets usable", async () => {
    const user = userEvent.setup()
    render(
      <>
        {picker(
          [valueFacet({ dimension: "namespace", value: "apps", selected: true })],
          { dimension: "namespace" },
        )}
        <button type="button">Outside control</button>
      </>,
    )

    const trigger = screen.getByRole("button", {
      name: "Namespaces, apps, 1 result",
    })
    expect(trigger).toHaveClass("min-h-11")
    await user.click(trigger)
    expect(screen.getByRole("searchbox")).toHaveFocus()
    await user.tab()
    expect(
      screen.getByRole("button", { name: "Select all 1 visible Namespace result" }),
    ).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("button", { name: "Clear Namespaces selection" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("checkbox", { name: /Namespaces, apps/i })).toHaveFocus()

    await user.click(screen.getByRole("button", { name: "Outside control" }))
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Outside control" })).toHaveFocus()

    await user.click(trigger)
    const popup = screen.getByRole("dialog", { name: "Choose Namespaces" })
    expect(popup).toHaveClass("w-[min(22rem,calc(100vw-2rem))]")
    expect(popup.parentElement).toHaveClass("z-[70]")
    expect(within(popup).getAllByRole("button").every((button) => button.className.includes("min-h-11"))).toBe(true)
  })
})
