"use client"

import { cn } from "@/lib/utils"

export interface SegOption<T extends string> {
  value: T
  label: string
  /**
   * Accessible name, when the visible label is too terse to stand alone out of
   * context — "Treemap" on its own does not say what it does, where
   * "Show treemap view" does. Defaults to the visible label.
   */
  ariaLabel?: string
  /** Shown after the label in a lighter weight, e.g. a count. */
  hint?: string
  disabled?: boolean
}

/**
 * The segmented control: a small set of mutually exclusive choices shown
 * side by side. Used for view switchers and format toggles.
 *
 * These are pressed-state buttons rather than tabs, because they re-render
 * one region in place rather than swapping between labelled panels. Wire
 * `label` to whatever names the group ("View", "Group by") so the choice is
 * announced with its subject.
 */
function Seg<T extends string>({
  options,
  value,
  onValueChange,
  label,
  className,
}: {
  options: readonly SegOption<T>[]
  value: T
  onValueChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="seg"
      className={cn(
        "inline-flex h-[22px] overflow-hidden border border-rule",
        className
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "inline-flex h-full cursor-pointer items-center gap-1 border-0 border-l border-rule px-[9px] text-micro font-semibold whitespace-nowrap first:border-l-0",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              "disabled:cursor-not-allowed disabled:opacity-45",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.07]"
            )}
          >
            {option.label}
            {option.hint ? (
              <span
                className={cn(
                  "font-mono text-meta font-normal",
                  selected ? "opacity-80" : "opacity-70"
                )}
              >
                {option.hint}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export { Seg }
