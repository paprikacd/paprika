"use client"

import { Search, X } from "lucide-react"
import {
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react"

import { cn } from "@/lib/utils"

export interface SearchFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "defaultValue" | "onChange" | "children"
  > {
  /** Names the query surface. Hidden only when the surrounding chrome already says it. */
  label: string
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /** Adds an explicit search action and handles Enter. */
  onSearch?: (value: string) => void
  description?: string
  error?: string
  /** `bar` sits inside a toolbar; `field` is a standalone, framed field. */
  variant?: "field" | "bar"
  hideLabel?: boolean
  clearLabel?: string
  /** Names the explicit search action; only rendered when `onSearch` is set. */
  searchLabel?: string
  className?: string
}

/**
 * Gamma Search field, adapted to the console's paper/steel vocabulary.
 *
 * A labelled native search input with a clear action that returns focus to the
 * field, and — when the caller passes `onSearch` — an explicit search action
 * that Enter also triggers. Clearing emits an empty string; the component
 * never filters or fetches on its own.
 */
export function SearchField({
  label,
  value,
  defaultValue,
  onChange,
  onSearch,
  description,
  error,
  variant = "field",
  hideLabel = false,
  clearLabel = "Clear search",
  searchLabel = "Search",
  className,
  id,
  disabled,
  readOnly,
  ...props
}: SearchFieldProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const descriptionId = `${inputId}-description`
  const errorId = `${inputId}-error`
  const inputRef = useRef<HTMLInputElement>(null)
  const [internal, setInternal] = useState(defaultValue ?? "")
  const controlled = value !== undefined
  const current = controlled ? value : internal

  const emit = (next: string) => {
    if (!controlled) setInternal(next)
    onChange?.(next)
  }

  const clear = () => {
    emit("")
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && onSearch) {
      event.preventDefault()
      onSearch(current)
    }
  }

  const describedBy =
    [description ? descriptionId : "", error ? errorId : ""]
      .filter(Boolean)
      .join(" ") || undefined

  return (
    <div className={cn("min-w-0", className)}>
      <div
        data-slot="search-field"
        className={cn(
          "flex w-full min-w-0 items-center gap-2",
          variant === "field" &&
            "h-[34px] border border-rule bg-card px-2.5 focus-within:border-ring",
          disabled && "opacity-55"
        )}
      >
        <Search
          className="size-3.5 shrink-0 text-neutral-600"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <label
          htmlFor={inputId}
          className={cn(
            hideLabel
              ? "sr-only"
              : "flex-none font-mono text-kicker tracking-[0.12em] text-neutral-600 uppercase"
          )}
        >
          {label}
        </label>
        <input
          {...props}
          ref={inputRef}
          id={inputId}
          type="search"
          value={current}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => emit(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "min-w-0 flex-1 border-0 bg-transparent text-console",
            "placeholder:text-neutral-500",
            "[&::-webkit-search-cancel-button]:appearance-none",
            variant === "field"
              ? "outline-none"
              : "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        />
        {current.length > 0 ? (
          <button
            type="button"
            aria-label={clearLabel}
            disabled={disabled || readOnly}
            onClick={clear}
            className={cn(
              "inline-flex size-[22px] flex-none cursor-pointer items-center justify-center border-0 bg-transparent",
              "text-neutral-600 hover:bg-inset hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
              "pointer-coarse:size-11",
              "disabled:cursor-not-allowed"
            )}
          >
            <X className="size-3" strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
        {onSearch ? (
          <button
            type="button"
            aria-label={searchLabel}
            disabled={disabled}
            onClick={() => onSearch(current)}
            className={cn(
              "inline-flex h-[22px] flex-none cursor-pointer items-center border border-rule bg-card px-2",
              "font-cond text-note font-semibold tracking-[0.04em]",
              "hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
              "pointer-coarse:h-11",
              "disabled:cursor-not-allowed"
            )}
          >
            Search
          </button>
        ) : null}
      </div>
      {description && !error ? (
        <p id={descriptionId} className="mt-1 text-note text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-note text-status-failed-text">
          {error}
        </p>
      ) : null}
    </div>
  )
}
