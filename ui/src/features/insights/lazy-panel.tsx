"use client"

import { Component, useEffect, useRef, type ReactNode } from "react"
import { GammaButton } from "./gamma/button"
import styles from "./insights.module.css"

/**
 * A failed lazy import is cached by React.lazy and by the bundler runtime, so the only recovery is a new page load.
 * Reloading discards in-memory state; the dashboard stays mounted until then.
 */
export function reloadPage() {
  window.location.reload()
}

/**
 * A chunk that could not be fetched or parsed. The bundler names it ChunkLoadError; browsers word a failed dynamic
 * import in their own way, which the message patterns cover.
 */
export function isChunkLoadError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.name === "ChunkLoadError" ||
    /Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(error.message)
}

/** Shown in place of a lazy panel that failed. The rest of the dashboard keeps rendering. */
export function LazyFailure({ label, kind, unsaved = false, onClose, onRetry }: {
  label: string
  /** "load": the chunk is cached as failed, so only a reload recovers. "render": a bug; rendering again may succeed. */
  kind: "load" | "render"
  unsaved?: boolean
  onClose?: () => void
  onRetry?: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  if (kind === "load") return (
    <section className={styles.lazyFailure} role="alert" aria-labelledby="lazy-failure-title">
      <h3 id="lazy-failure-title" ref={heading} tabIndex={-1}>{label} did not load</h3>
      <p>Reload the page to try again.{unsaved && " Your unsaved changes are kept on this page until you reload, and reloading discards them."}</p>
      <div className={styles.actions}>
        <GammaButton variant="primary" size="sm" onClick={reloadPage}>Reload the page</GammaButton>
        {onClose && <GammaButton variant="secondary" size="sm" onClick={onClose}>Back to dashboard</GammaButton>}
      </div>
    </section>
  )
  return (
    <section className={styles.lazyFailure} role="alert" aria-labelledby="lazy-failure-title">
      <h3 id="lazy-failure-title" ref={heading} tabIndex={-1}>{label} failed to render</h3>
      <p>The error is logged. The rest of the dashboard keeps working.{unsaved && " Your unsaved changes are kept."}</p>
      <div className={styles.actions}>
        {onRetry && <GammaButton variant="primary" size="sm" onClick={onRetry}>Render again</GammaButton>}
        {onClose && <GammaButton variant="secondary" size="sm" onClick={onClose}>Back to dashboard</GammaButton>}
      </div>
    </section>
  )
}

interface BoundaryProps {
  label: string
  unsaved?: boolean
  onClose?: () => void
  /** Replaces the default message, for places where a block of text cannot render (SVG). */
  renderFailure?: () => ReactNode
  children: ReactNode
}

/** Contains an error from one panel (a failed chunk or a render bug) so the surrounding dashboard stays mounted. */
export class LazyPanelBoundary extends Component<BoundaryProps, { failed: boolean; error?: unknown }> {
  state: { failed: boolean; error?: unknown } = { failed: false }
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }
  componentDidCatch(error: unknown) {
    // The dashboard's error page logs the same way, so these errors reach the same place.
    console.error(error)
  }
  private retry = () => this.setState({ failed: false, error: undefined })
  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.renderFailure) return this.props.renderFailure()
    return <LazyFailure
      label={this.props.label}
      kind={isChunkLoadError(this.state.error) ? "load" : "render"}
      unsaved={this.props.unsaved}
      onClose={this.props.onClose}
      onRetry={this.retry}
    />
  }
}

/** Renders nothing; its effect reports that the lazy content it sits beside has mounted. */
export function MountSignal({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount()
  }, [onMount])
  return null
}
