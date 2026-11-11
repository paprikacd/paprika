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

/** Shown in place of a lazy panel that could not load. The rest of the dashboard keeps rendering. */
export function LazyFailure({ label, unsaved = false, onClose }: { label: string; unsaved?: boolean; onClose?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  return (
    <section className={styles.lazyFailure} role="alert" aria-labelledby="lazy-failure-title">
      <h3 id="lazy-failure-title" ref={heading} tabIndex={-1}>{label} did not load</h3>
      <p>Reload the page to try again.{unsaved && " Your unsaved changes are kept on this page until you reload, and reloading discards them."}</p>
      <div className={styles.actions}>
        <GammaButton variant="primary" size="sm" onClick={reloadPage}>Reload the page</GammaButton>
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

/** Catches a failed lazy chunk (or a render error) inside one panel so the surrounding dashboard stays mounted. */
export class LazyPanelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error(error)
  }
  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.renderFailure) return this.props.renderFailure()
    return <LazyFailure label={this.props.label} unsaved={this.props.unsaved} onClose={this.props.onClose} />
  }
}

/** Renders nothing; its effect reports that the lazy content it sits beside has mounted. */
export function MountSignal({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount()
  }, [onMount])
  return null
}
