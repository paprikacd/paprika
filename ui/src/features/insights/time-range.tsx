import { useId, useRef, useState } from "react"
import { CalendarRange, RotateCcw, X } from "lucide-react"
import { customTimeRangeSchema, timeRanges, type Dashboard } from "./schema"
import styles from "./workspace-tools.module.css"
import shared from "./insights.module.css"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { resolveDashboardTimeZone } from "./dashboard-time-zone"

export function dashboardRange(dashboard: Dashboard, now: number) {
  return dashboard.customTimeRange
    ? {
        start: Date.parse(dashboard.customTimeRange.from) / 1000,
        end: Date.parse(dashboard.customTimeRange.to) / 1000,
      }
    : { start: now - timeRanges[dashboard.timeRange], end: now }
}

const presetLabels: Record<Dashboard["timeRange"], string> = {
  "15m": "Last 15 minutes",
  "30m": "Last 30 minutes",
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
}

/**
 * A fixed window as a compact label for the select, and the same window with its zone name for the title and screen readers.
 * The year appears only when an end falls outside the current year, and a same-day range shares one date.
 */
export function customRangeLabels(range: { from: string; to: string }, timeZone: string, now: Date = new Date()) {
  const from = new Date(range.from), to = new Date(range.to)
  const yearIn = (date: Date) => new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(date)
  const current = yearIn(now)
  const parts: Intl.DateTimeFormatOptions = {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(yearIn(from) !== current || yearIn(to) !== current ? { year: "numeric" as const } : {}),
  }
  return {
    compact: new Intl.DateTimeFormat(undefined, parts).formatRange(from, to),
    full: new Intl.DateTimeFormat(undefined, { ...parts, timeZoneName: "short" }).formatRange(from, to),
  }
}

/** The label a saved window shows: its preset name, or its compact custom range in the dashboard's zone. */
export function savedRangeLabel(dashboard: Dashboard, now: Date = new Date()) {
  return dashboard.customTimeRange
    ? customRangeLabels(dashboard.customTimeRange, resolveDashboardTimeZone(dashboard.timeZone), now).compact
    : presetLabels[dashboard.timeRange]
}

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** A window choice: a relative preset (customTimeRange undefined) or a fixed window. */
export type TimeRangeChoice = Pick<Dashboard, "timeRange" | "customTimeRange">

/**
 * Chooses the window for whatever view it is given. It never edits a saved dashboard
 * by itself: the owner decides what the choice changes. Returning false keeps the
 * popover open because the choice was not applied.
 */
export function TimeRangeControl({
  dashboard,
  onChange,
  customButton = true,
  className,
  onReset,
  resetLabel,
}: {
  /** The dashboard as this view shows it, so the current window is the one displayed. */
  dashboard: Dashboard
  onChange: (choice: TimeRangeChoice) => boolean | void
  /**
   * Shows the calendar button beside the select. Phones turn it off because the select's "Custom range…" option opens
   * the same popover, and focus then returns to the select.
   */
  customButton?: boolean
  className?: string
  /** Offers a Reset action that returns the view to its saved window. Omitted when the view already shows it. */
  onReset?: () => void
  /** The saved window's label, named in the Reset action. */
  resetLabel?: string
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [error, setError] = useState("")
  const custom = dashboard.customTimeRange
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const displayTimeZone = resolveDashboardTimeZone(dashboard.timeZone)
  const customLabels = custom ? customRangeLabels(custom, displayTimeZone) : undefined
  function close() {
    setOpen(false)
    // Without the calendar button, focus goes back to the select that opened the popover.
    const target = customButton ? trigger.current : root.current?.querySelector<HTMLElement>("[role='combobox']")
    target?.focus()
  }
  function openRange() {
    const range = dashboardRange(dashboard, Math.floor(Date.now() / 1000))
    setFrom(localInput(new Date(range.start * 1000)))
    setTo(localInput(new Date(range.end * 1000)))
    setError("")
    setOpen(true)
  }
  return (
    <div ref={root} className={[styles.range, className].filter(Boolean).join(" ")}>
      <label className={shared.timeSelect}>
        <span className={shared.srOnly}>Time range</span>
        <GammaSelect
          aria-label="Time range"
          title={customLabels?.full}
          size="sm"
          value={custom ? "custom" : dashboard.timeRange}
          onValueChange={(value) => {
            if (value === "custom") openRange()
            else if (onChange({ timeRange: value as Dashboard["timeRange"], customTimeRange: undefined }) !== false) setOpen(false)
          }}
          options={[
            ...(Object.keys(presetLabels) as Dashboard["timeRange"][]).map((value) => ({ value, label: presetLabels[value] })),
            { value: "custom", label: customLabels?.compact ?? "Custom range…", accessibleLabel: customLabels?.full },
          ]}
        />
      </label>
      {customButton && (
        <GammaButton iconOnly size="sm" variant="quiet"
          ref={trigger}
          className={shared.iconButton}
          aria-label="Choose custom time range"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => (open ? close() : openRange())}
        >
          <CalendarRange size={15} />
        </GammaButton>
      )}
      {onReset && (
        <GammaButton
          size="sm"
          variant="quiet"
          onClick={onReset}
          aria-label={resetLabel ? `Reset time range to ${resetLabel}` : "Reset time range"}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Reset
        </GammaButton>
      )}
      {open && (
        <section
          id={id}
          className={styles.rangePopover}
          aria-label="Custom time range"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              close()
            }
          }}
        >
          <div className={styles.sectionTitle}>
            <strong>Custom time range</strong>
            <GammaButton iconOnly size="sm" variant="quiet" className={shared.iconButton} aria-label="Close time range" onClick={close}>
              <X size={15} />
            </GammaButton>
          </div>
          <p>Dates use {timezone}. Choose up to 31 days.</p>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              try {
                if (!from || !to) throw new Error("Choose both a start and end date.")
                const range = customTimeRangeSchema.parse({
                  from: new Date(from).toISOString(),
                  to: new Date(to).toISOString(),
                })
                if (onChange({ timeRange: dashboard.timeRange, customTimeRange: range }) !== false) close()
              } catch {
                setError("Choose valid dates with the end after the start, within 31 days.")
              }
            }}
          >
            <label>
              From
              <GammaInput
                autoFocus
                aria-label="Range start"
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </label>
            <label>
              To
              <GammaInput
                aria-label="Range end"
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            </label>
            {error && (
              <p role="alert" className={shared.validationError}>
                {error}
              </p>
            )}
            <GammaButton size="sm" variant="primary" className={shared.primary} type="submit">
              Apply time range
            </GammaButton>
          </form>
        </section>
      )}
    </div>
  )
}
