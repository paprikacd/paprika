"use client"

import { useEffect, useId, useRef } from "react"
import { X } from "lucide-react"
import { GammaButton } from "./gamma/button"
import { lockBodyScroll } from "./gamma/scroll-lock"
import { TraceWaterfall } from "./trace-waterfall"
import styles from "./trace-dialog.module.css"

/** A trace needs a common time axis and enough room to compare its spans. */
export function TraceDialog({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), id = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement
    element.showModal()
    close.current?.focus()
    const unlock = lockBodyScroll()
    return () => {
      const restore = element.contains(document.activeElement) || document.activeElement === document.body
      if (element.open) element.close()
      unlock()
      if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <header className={styles.header}>
      <div><h2 id={`${id}-title`}>Trace detail</h2><span title={traceId}>{traceId}</span></div>
      <GammaButton ref={close} variant="quiet" size="sm" iconOnly aria-label="Close trace detail" onClick={onClose}><X size={17} aria-hidden="true" /></GammaButton>
    </header>
    <div className={styles.content}><TraceWaterfall traceId={traceId} /></div>
  </dialog>
}
