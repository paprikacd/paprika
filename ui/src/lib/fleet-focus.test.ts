import { describe, expect, it, vi } from "vitest"

import {
  createFleetFocusCoordinator,
  type FleetFocusAdapter,
  type FleetFocusTarget,
} from "@/lib/fleet-focus"

function application(namespace: string, name: string) {
  return { namespace, name }
}

function target() {
  return { focus: vi.fn() } satisfies FleetFocusTarget
}

function adapter(
  applicationTarget: FleetFocusTarget | null = target(),
  headingTarget: FleetFocusTarget | null = target(),
) {
  const resolveApplicationTarget = vi.fn<FleetFocusAdapter["resolveApplicationTarget"]>(
    () => applicationTarget,
  )
  const resolveResultsHeadingTarget = vi.fn<FleetFocusAdapter["resolveResultsHeadingTarget"]>(
    () => headingTarget,
  )
  return {
    adapter: {
      resolveApplicationTarget,
      resolveResultsHeadingTarget,
    } satisfies FleetFocusAdapter,
    applicationTarget,
    headingTarget,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("fleet focus coordinator", () => {
  it("restores the focused Application identity after filtered results or a refetch", async () => {
    const announce = vi.fn()
    const table = adapter()
    const coordinator = createFleetFocusCoordinator({ announce })
    coordinator.registerAdapter("table", table.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    await coordinator.updateResults([
      application("apps", "payments"),
      application("apps", "checkout"),
    ])
    await coordinator.updateResults([application("apps", "checkout")])

    expect(table.adapter.resolveApplicationTarget).toHaveBeenCalledTimes(2)
    expect(table.adapter.resolveApplicationTarget).toHaveBeenLastCalledWith(
      application("apps", "checkout"),
      expect.any(AbortSignal),
    )
    expect(table.applicationTarget?.focus).toHaveBeenCalledTimes(2)
    expect(announce).not.toHaveBeenCalled()
  })

  it("moves focus to the results heading and announces a removed item exactly once", async () => {
    const announce = vi.fn()
    const table = adapter()
    const coordinator = createFleetFocusCoordinator({ announce })
    coordinator.registerAdapter("table", table.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    await coordinator.updateResults([application("apps", "payments")])
    await coordinator.updateResults([application("apps", "payments")])

    expect(table.adapter.resolveResultsHeadingTarget).toHaveBeenCalledTimes(1)
    expect(table.headingTarget?.focus).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(
      "Application apps/checkout was removed from the results.",
    )
    expect(coordinator.focusedApplication()).toBeNull()
  })

  it("restores the identity through presentation switches", async () => {
    const table = adapter()
    const matrix = adapter()
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    coordinator.registerAdapter("table", table.adapter)
    coordinator.registerAdapter("matrix", matrix.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))
    await coordinator.updateResults([application("apps", "checkout")])

    await coordinator.activatePresentation("matrix")

    expect(table.applicationTarget?.focus).toHaveBeenCalledTimes(1)
    expect(matrix.adapter.resolveApplicationTarget).toHaveBeenCalledWith(
      application("apps", "checkout"),
      expect.any(AbortSignal),
    )
    expect(matrix.applicationTarget?.focus).toHaveBeenCalledTimes(1)
  })

  it("does not let a stale async presentation steal focus", async () => {
    const staleResolution = deferred<FleetFocusTarget | null>()
    const staleTarget = target()
    const table = adapter()
    table.adapter.resolveApplicationTarget.mockImplementation(() => staleResolution.promise)
    const matrix = adapter()
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    coordinator.registerAdapter("table", table.adapter)
    coordinator.registerAdapter("matrix", matrix.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    const oldUpdate = coordinator.updateResults([application("apps", "checkout")])
    await coordinator.activatePresentation("matrix")
    staleResolution.resolve(staleTarget)
    await oldUpdate

    expect(staleTarget.focus).not.toHaveBeenCalled()
    expect(matrix.applicationTarget?.focus).toHaveBeenCalledTimes(1)
    expect(table.adapter.resolveApplicationTarget.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it("suppresses a stale removed-item fallback when newer results retain the identity", async () => {
    const headingResolution = deferred<FleetFocusTarget | null>()
    const headingTarget = target()
    const announce = vi.fn()
    const table = adapter()
    table.adapter.resolveResultsHeadingTarget.mockImplementation(() => headingResolution.promise)
    const coordinator = createFleetFocusCoordinator({ announce })
    coordinator.registerAdapter("table", table.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    const staleUpdate = coordinator.updateResults([application("apps", "payments")])
    await coordinator.updateResults([application("apps", "checkout")])
    headingResolution.resolve(headingTarget)
    await staleUpdate

    expect(headingTarget.focus).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(coordinator.focusedApplication()).toEqual(application("apps", "checkout"))
    expect(table.applicationTarget?.focus).toHaveBeenCalledTimes(1)
  })

  it("invalidates pending focus work when the active adapter unregisters", async () => {
    const resolution = deferred<FleetFocusTarget | null>()
    const staleTarget = target()
    const table = adapter()
    table.adapter.resolveApplicationTarget.mockImplementation(() => resolution.promise)
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    const unregister = coordinator.registerAdapter("table", table.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    const update = coordinator.updateResults([application("apps", "checkout")])
    unregister()
    resolution.resolve(staleTarget)
    await update

    expect(staleTarget.focus).not.toHaveBeenCalled()
    expect(table.adapter.resolveApplicationTarget.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it("keeps a replacement adapter registered when an old cleanup runs", async () => {
    const oldTable = adapter()
    const replacement = adapter()
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    const unregisterOld = coordinator.registerAdapter("table", oldTable.adapter)
    coordinator.registerAdapter("table", replacement.adapter)
    unregisterOld()
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    await coordinator.updateResults([application("apps", "checkout")])

    expect(oldTable.adapter.resolveApplicationTarget).not.toHaveBeenCalled()
    expect(replacement.applicationTarget?.focus).toHaveBeenCalledTimes(1)
  })

  it("restores through an adapter registered after its presentation becomes active", async () => {
    const table = adapter()
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))
    await coordinator.updateResults([application("apps", "checkout")])

    coordinator.registerAdapter("table", table.adapter)
    await coordinator.settled()

    expect(table.applicationTarget?.focus).toHaveBeenCalledTimes(1)
  })

  it("leaves selection and zoom in external URL state", async () => {
    const urlState = {
      selected: application("apps", "payments"),
      zoom: "project:tenant/payments",
    }
    const before = structuredClone(urlState)
    const table = adapter()
    const coordinator = createFleetFocusCoordinator({ announce: vi.fn() })
    coordinator.registerAdapter("table", table.adapter)
    await coordinator.activatePresentation("table")
    coordinator.trackFocusedApplication(application("apps", "checkout"))

    await coordinator.updateResults([application("apps", "payments")])

    expect(urlState).toEqual(before)
    expect(coordinator).not.toHaveProperty("selected")
    expect(coordinator).not.toHaveProperty("zoom")
  })
})
