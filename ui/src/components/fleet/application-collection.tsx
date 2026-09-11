"use client"

import { useEffect } from "react"

import type { DataSourceMap } from "@/components/fleet/data-sources"
import type {
  FleetApplicationSummary,
  FleetCapability,
} from "@/lib/fleet-client"
import type {
  FleetApplicationIdentity,
  FleetFocusCoordinator,
  FleetFocusTarget,
} from "@/lib/fleet-focus"
import type { NamespacedKey } from "@/lib/fleet-query"

/**
 * Everything both row presentations need. The row model is one row per
 * application in both, which is what keeps `aria-rowcount` and the
 * `{loaded} loaded / {total} indexed` sentinel counting the same thing.
 */
export interface ApplicationCollectionProps {
  applications: readonly FleetApplicationSummary[]
  total: bigint
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
  focusCoordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  /** The boot-time capability probe. Absent means: assume nothing. */
  sources: DataSourceMap | undefined
}

/**
 * The authorized actions a row may offer. They stay disabled here: the fleet
 * list is a place to find the thing, and every mutation is confirmed on the
 * application's own screen.
 */
export function ApplicationCapabilityActions({
  identity,
  capabilities,
}: {
  identity: NamespacedKey
  capabilities: readonly FleetCapability[]
}) {
  const key = identityKey(identity)
  const actions: readonly { capability: FleetCapability; label: string; short: string }[] = [
    { capability: "application_sync", label: `Sync ${key}`, short: "Sync" },
    { capability: "release_rollback", label: `Roll back ${key}`, short: "Roll back" },
    { capability: "gate_approve", label: `Approve gate for ${key}`, short: "Approve" },
    { capability: "pipeline_retry", label: `Retry pipeline for ${key}`, short: "Retry" },
  ]
  const visible = actions.filter((action) => capabilities.includes(action.capability))
  if (visible.length === 0) return null

  return (
    <span className="flex flex-wrap gap-1">
      {visible.map((action) => (
        <button
          key={action.capability}
          type="button"
          aria-label={action.label}
          disabled
          title="Open the application detail to perform this authorized action"
          className="inline-flex h-5.5 items-center rounded-[2px] border border-rule bg-card px-1.5 text-meta whitespace-nowrap text-neutral-800 disabled:cursor-not-allowed disabled:opacity-80"
        >
          {action.short}
        </button>
      ))}
    </span>
  )
}

export function useApplicationFocusAdapter({
  presentation,
  applications,
  coordinator,
  getResultsHeadingTarget,
  getTarget,
  scrollToIndex,
}: {
  presentation: "table" | "queue"
  applications: readonly FleetApplicationSummary[]
  coordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  getTarget: (key: string) => FleetFocusTarget | null
  scrollToIndex: (index: number) => void
}) {
  useEffect(
    () =>
      coordinator.registerAdapter(presentation, {
        resolveApplicationTarget: async (identity, signal) => {
          const key = identityKey(identity)
          const current = getTarget(key)
          if (current) return current

          const index = applications.findIndex(
            (application) => application.identity && identityKey(application.identity) === key,
          )
          if (index < 0 || signal.aborted) return null
          scrollToIndex(index)

          for (let attempt = 0; attempt < 6; attempt += 1) {
            await nextFrame(signal)
            if (signal.aborted) return null
            const target = getTarget(key)
            if (target) return target
          }
          return null
        },
        resolveResultsHeadingTarget: () => getResultsHeadingTarget(),
      }),
    [applications, coordinator, getResultsHeadingTarget, getTarget, presentation, scrollToIndex],
  )
}

export function applicationKey(application: FleetApplicationSummary, index: number): string {
  return application.identity ? identityKey(application.identity) : `identity-unavailable:${index}`
}

export function identityKey(identity: FleetApplicationIdentity): string {
  return `${identity.namespace}/${identity.name}`
}

export function releaseFocusOwnership(
  currentTarget: HTMLElement,
  nextTarget: EventTarget | null,
  onFocusedApplication: (identity: NamespacedKey | null) => void,
): void {
  if (nextTarget instanceof Node && currentTarget.contains(nextTarget)) return
  // Moving to a control that changes the presentation is not abandoning the
  // row — the row is about to be redrawn somewhere else and focus should
  // follow it. The marker sits on the control or on any ancestor of it, so a
  // wrapped primitive can carry it without knowing about focus at all.
  if (
    nextTarget instanceof HTMLElement &&
    nextTarget.closest('[data-preserve-fleet-focus="true"]')
  ) {
    return
  }
  onFocusedApplication(null)
}

export function observeMeasuredElementRect(
  instance: { scrollElement: Element | null },
  callback: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
  const element = instance.scrollElement
  if (!element) return undefined

  const measure = () => {
    const rect = element.getBoundingClientRect()
    callback({
      width: rect.width || 1120,
      height: rect.height || 560,
    })
  }
  measure()

  if (typeof ResizeObserver === "undefined") return undefined
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  return () => observer.disconnect()
}

function nextFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const complete = () => {
      signal.removeEventListener("abort", cancel)
      resolve()
    }
    const cancel = () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
      else clearTimeout(frame)
      complete()
    }
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(complete)
        : window.setTimeout(complete, 16)
    signal.addEventListener("abort", cancel, { once: true })
  })
}
