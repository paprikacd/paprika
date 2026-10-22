"use client"

import { AlertCircle, Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { copyToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

type CopyState = "idle" | "copied" | "error"

/**
 * Gamma CopyField, adapted for the console's dense identifier rows.
 *
 * The read-only value keeps its own truncation; the copy control is a real
 * 22px button that reports pending, success and retryable failure. A live
 * region announces the result without moving focus. The value is always
 * available in the `title` and to assistive technology, even when the row
 * truncates it visually.
 */
export function CopyField({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const [state, setState] = useState<CopyState>("idle")
  const resetTimer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => window.clearTimeout(resetTimer.current),
    []
  )

  if (!value) return null

  const resetLater = () => {
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState("idle"), 2200)
  }

  const handleCopy = async () => {
    try {
      await copyToClipboard(value)
      setState("copied")
    } catch {
      setState("error")
    }
    resetLater()
  }

  const Icon =
    state === "copied" ? Check : state === "error" ? AlertCircle : Copy
  const action =
    state === "copied"
      ? "Copied"
      : state === "error"
        ? `Copy ${label} failed; retry`
        : `Copy ${label}`

  return (
    <span
      data-slot="copy-field"
      className={cn(
        "group inline-flex min-w-0 items-center justify-end gap-1",
        className
      )}
    >
      <span
        className="min-w-0 truncate font-mono text-note"
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={action}
        title={action}
        className={cn(
          "inline-flex size-[22px] flex-none cursor-pointer items-center justify-center border border-transparent text-neutral-500",
          "hover:border-rule hover:bg-inset hover:text-foreground",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          "pointer-coarse:size-11",
          state === "copied" && "text-status-healthy-text",
          state === "error" && "text-status-failed-text"
        )}
      >
        <Icon className="size-3" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied"
          ? `${label} copied`
          : state === "error"
            ? `${label} copy failed. Retry.`
            : ""}
      </span>
    </span>
  )
}
