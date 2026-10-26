"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { GammaButton } from "./button"
import styles from "./confirmation.module.css"
import { lockBodyScroll } from "./scroll-lock"

interface Confirmation {
  title: string
  description: string
  action: string
}

/** Promise adapter for a single, explicitly resolved app-owned confirmation. */
export function useConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null)
  const pending = useRef<((accepted: boolean) => void) | null>(null)
  const resolve = useCallback((accepted: boolean) => {
    const complete = pending.current
    pending.current = null
    setRequest(null)
    complete?.(accepted)
  }, [])
  const ask = useCallback((next: Confirmation) => {
    // Repeated triggers must not replace a decision that is already on screen.
    if (pending.current) return Promise.resolve(false)
    return new Promise<boolean>((complete) => {
      pending.current = complete
      setRequest(next)
    })
  }, [])
  useEffect(() => () => {
    pending.current?.(false)
    pending.current = null
  }, [])
  return { ask, request, resolve }
}

// Adapts Gamma SideSheet's in-scope native modal and deliberate focus-return
// behavior to a compact confirmation. No morph animation or side-panel layout.
export function GammaConfirmation({ request, onResolve }: {
  request: Confirmation | null
  onResolve: (accepted: boolean) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!request || !element) return
    const opener = document.activeElement
    element.showModal()
    cancel.current?.focus()
    const unlock = lockBodyScroll()
    return () => {
      const restore = element.contains(document.activeElement) || document.activeElement === document.body
      element.close()
      unlock()
      if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [request])
  return (
    <dialog ref={dialog} className={styles.dialog} role="alertdialog"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); onResolve(false) }}>
      {request && <>
        <h2 id={`${id}-title`}>{request.title}</h2>
        <p id={`${id}-description`}>{request.description}</p>
        <div className={styles.actions}>
          <GammaButton ref={cancel} onClick={() => onResolve(false)}>Cancel</GammaButton>
          <GammaButton variant="danger" onClick={() => onResolve(true)}>{request.action}</GammaButton>
        </div>
      </>}
    </dialog>
  )
}
