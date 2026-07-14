"use client"

import { Boxes, Layers, Network, Rocket } from "lucide-react"

import { ScopeMultiselect } from "@/components/layout/scope-multiselect"
import {
  useFleetScope,
  type FleetScopeDimension,
  type FleetScopeFacet,
} from "@/lib/fleet-scope-context"

const scopeControls = [
  { dimension: "project", icon: Layers },
  { dimension: "cluster", icon: Boxes },
  { dimension: "stage", icon: Rocket },
  { dimension: "namespace", icon: Network },
] as const satisfies readonly {
  dimension: FleetScopeDimension
  icon: typeof Layers
}[]

const fallbackSegments = [
  { label: "Projects", value: "All projects", icon: Layers },
  { label: "Clusters", value: "All clusters", icon: Boxes },
  { label: "Stages", value: "All stages", icon: Rocket },
  { label: "Namespaces", value: "All namespaces", icon: Network },
] as const

export function ScopeBar() {
  const { facets, status, mutationError, patchScope, retry } = useFleetScope()
  const hasSelection = facets.some((facet) => facet.selected)

  function updateDimension(
    dimension: FleetScopeDimension,
    next: readonly FleetScopeFacet[],
  ) {
    switch (dimension) {
      case "project":
        return patchScope({
          projects: next.flatMap((facet) =>
            facet.object ? [{ ...facet.object }] : [],
          ),
        })
      case "cluster":
        return patchScope({
          clusters: next.flatMap((facet) =>
            facet.object ? [{ ...facet.object }] : [],
          ),
        })
      case "stage":
        return patchScope({
          stages: next.flatMap((facet) =>
            facet.value ? [facet.value] : [],
          ),
        })
      case "namespace":
        return patchScope({
          namespaces: next.flatMap((facet) =>
            facet.value ? [facet.value] : [],
          ),
        })
    }
  }

  return (
    <section
      aria-label="Current fleet scope"
      className="sticky top-14 z-30 border-b border-border bg-card lg:top-0"
    >
      <div
        data-fleet-scope-scroll
        className="overflow-x-auto overscroll-x-contain"
      >
        <div
          data-fleet-scope-controls
          className="flex min-h-12 min-w-max items-stretch px-4 sm:px-6"
        >
          <div className="flex shrink-0 items-center border-r border-border pr-4">
            <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.16em] text-primary">
              Fleet scope
            </span>
          </div>
          {scopeControls.map(({ dimension, icon: Icon }) => (
            <ScopeMultiselect
              key={dimension}
              dimension={dimension}
              facets={facets}
              status={status}
              onSelectionChange={(next) => updateDimension(dimension, next)}
              onRetry={retry}
              icon={<Icon className="size-3.5 text-muted-foreground" />}
            />
          ))}
          {hasSelection ? (
            <button
              type="button"
              aria-label="Clear fleet scope"
              onClick={() =>
                patchScope({
                  projects: [],
                  clusters: [],
                  stages: [],
                  namespaces: [],
                })
              }
              className="min-h-11 shrink-0 px-4 text-xs font-semibold text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Clear scope
            </button>
          ) : null}
        </div>
      </div>
      {mutationError ? (
        <p
          role="alert"
          className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive sm:px-6"
        >
          This legacy detail URL has multiple namespaces. Open a canonical
          detail link before changing fleet scope.
        </p>
      ) : null}
    </section>
  )
}

export function ScopeBarFallback() {
  return (
    <section
      aria-label="Current fleet scope"
      aria-busy="true"
      className="sticky top-14 z-30 border-b border-border bg-card lg:top-0"
    >
      <div
        data-fleet-scope-scroll
        className="overflow-x-auto overscroll-x-contain"
      >
        <div
          data-fleet-scope-controls
          className="flex min-h-12 min-w-max items-stretch px-4 sm:px-6"
        >
          <div className="flex shrink-0 items-center border-r border-border pr-4">
            <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.16em] text-primary">
              Fleet scope
            </span>
          </div>
          {fallbackSegments.map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="flex min-h-11 shrink-0 items-center gap-2 border-r border-border px-4"
            >
              <Icon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">{label}: </span>
              <span className="text-xs font-medium text-foreground">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
