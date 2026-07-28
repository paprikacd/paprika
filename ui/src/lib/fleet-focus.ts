import type { NamespacedKey } from "@/lib/fleet-query"

export type FleetApplicationIdentity = Readonly<NamespacedKey>

export interface FleetFocusTarget {
  focus(): void
}

type MaybePromise<T> = T | PromiseLike<T>

/**
 * Presentation adapters resolve focus targets from their own refs or controller.
 * The coordinator performs the eventual focus commit so an async, stale adapter
 * can never move focus after a presentation or results change.
 */
export interface FleetFocusAdapter {
  resolveApplicationTarget(
    identity: FleetApplicationIdentity,
    signal: AbortSignal,
  ): MaybePromise<FleetFocusTarget | null>
  resolveResultsHeadingTarget(signal: AbortSignal): MaybePromise<FleetFocusTarget | null>
}

export interface FleetFocusCoordinatorOptions {
  announce(message: string): void
}

export interface FleetFocusCoordinator {
  registerAdapter(presentation: string, adapter: FleetFocusAdapter): () => void
  activatePresentation(presentation: string | null): Promise<void>
  trackFocusedApplication(identity: FleetApplicationIdentity | null): void
  focusedApplication(): FleetApplicationIdentity | null
  updateResults(identities: readonly FleetApplicationIdentity[]): Promise<void>
  settled(): Promise<void>
}

interface AdapterRegistration {
  adapter: FleetFocusAdapter
}

class FocusCoordinator implements FleetFocusCoordinator {
  private readonly adapters = new Map<string, AdapterRegistration>()
  private readonly announce: (message: string) => void
  private activePresentation: string | null = null
  private focused: NamespacedKey | null = null
  private resultKeys = new Set<string>()
  private hasResults = false
  private revision = 0
  private pendingController: AbortController | null = null
  private lastWork: Promise<void> = Promise.resolve()

  constructor(options: FleetFocusCoordinatorOptions) {
    this.announce = options.announce
  }

  registerAdapter(presentation: string, adapter: FleetFocusAdapter): () => void {
    const registration = { adapter }
    this.adapters.set(presentation, registration)

    if (presentation === this.activePresentation) {
      void this.restoreFocus()
    }

    return () => {
      if (this.adapters.get(presentation) !== registration) return

      this.adapters.delete(presentation)
      if (presentation === this.activePresentation) this.invalidatePending()
    }
  }

  activatePresentation(presentation: string | null): Promise<void> {
    this.activePresentation = presentation
    return this.restoreFocus()
  }

  trackFocusedApplication(identity: FleetApplicationIdentity | null): void {
    this.focused = identity ? copyIdentity(identity) : null
    this.invalidatePending()
  }

  focusedApplication(): FleetApplicationIdentity | null {
    return this.focused ? copyIdentity(this.focused) : null
  }

  updateResults(identities: readonly FleetApplicationIdentity[]): Promise<void> {
    this.resultKeys = new Set(identities.map(identityKey))
    this.hasResults = true
    return this.restoreFocus()
  }

  settled(): Promise<void> {
    return this.lastWork
  }

  private restoreFocus(): Promise<void> {
    this.invalidatePending()

    const identity = this.focused ? copyIdentity(this.focused) : null
    const presentation = this.activePresentation
    const registration = presentation ? this.adapters.get(presentation) : undefined

    if (!this.hasResults || !identity || !presentation || !registration) {
      this.lastWork = Promise.resolve()
      return this.lastWork
    }

    const controller = new AbortController()
    const revision = this.revision
    this.pendingController = controller
    const identityIsPresent = this.resultKeys.has(identityKey(identity))

    const work = this.resolveAndCommit({
      controller,
      identity,
      identityIsPresent,
      presentation,
      registration,
      revision,
    })
    this.lastWork = work
    return work
  }

  private async resolveAndCommit(input: {
    controller: AbortController
    identity: NamespacedKey
    identityIsPresent: boolean
    presentation: string
    registration: AdapterRegistration
    revision: number
  }): Promise<void> {
    const { controller, identity, identityIsPresent, presentation, registration, revision } = input

    try {
      const target = identityIsPresent
        ? await registration.adapter.resolveApplicationTarget(copyIdentity(identity), controller.signal)
        : await registration.adapter.resolveResultsHeadingTarget(controller.signal)

      if (!this.isCurrent({ controller, identity, presentation, registration, revision })) return

      if (identityIsPresent) {
        safelyFocus(target)
        return
      }

      this.focused = null
      safelyFocus(target)
      safelyAnnounce(
        this.announce,
        `Application ${identity.namespace}/${identity.name} was removed from the results.`,
      )
    } catch {
      // Focus restoration is best effort and must never break a fleet data update.
    } finally {
      if (this.pendingController === controller) this.pendingController = null
    }
  }

  private isCurrent(input: {
    controller: AbortController
    identity: NamespacedKey
    presentation: string
    registration: AdapterRegistration
    revision: number
  }): boolean {
    return (
      !input.controller.signal.aborted &&
      input.revision === this.revision &&
      input.presentation === this.activePresentation &&
      this.adapters.get(input.presentation) === input.registration &&
      this.focused !== null &&
      identityKey(this.focused) === identityKey(input.identity)
    )
  }

  private invalidatePending(): void {
    this.revision += 1
    this.pendingController?.abort()
    this.pendingController = null
  }
}

export function createFleetFocusCoordinator(
  options: FleetFocusCoordinatorOptions,
): FleetFocusCoordinator {
  return new FocusCoordinator(options)
}

function identityKey(identity: FleetApplicationIdentity): string {
  return `${identity.namespace}/${identity.name}`
}

function copyIdentity(identity: FleetApplicationIdentity): NamespacedKey {
  return { namespace: identity.namespace, name: identity.name }
}

function safelyFocus(target: FleetFocusTarget | null): void {
  try {
    target?.focus()
  } catch {
    // A presentation can unmount between resolving its target and committing focus.
  }
}

function safelyAnnounce(announce: (message: string) => void, message: string): void {
  try {
    announce(message)
  } catch {
    // Assistive feedback must not make a successful results update fail.
  }
}
