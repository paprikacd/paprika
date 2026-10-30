import { useId, useRef, useState } from "react"
import { CalendarRange, X } from "lucide-react"
import { customTimeRangeSchema, timeRanges, type Dashboard } from "./schema"
import styles from "./workspace-tools.module.css"
import shared from "./insights.module.css"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"

export function dashboardRange(dashboard: Dashboard, now: number) {
  return dashboard.customTimeRange
    ? {
        start: Date.parse(dashboard.customTimeRange.from) / 1000,
        end: Date.parse(dashboard.customTimeRange.to) / 1000,
      }
    : { start: now - timeRanges[dashboard.timeRange], end: now }
}

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function TimeRangeControl({
  dashboard,
  onChange,
}: {
  dashboard: Dashboard
  onChange: (range: Pick<Dashboard, "timeRange" | "customTimeRange">) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [error, setError] = useState("")
  const custom = dashboard.customTimeRange
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  function close() {
    setOpen(false)
    trigger.current?.focus()
  }
  function openRange() {
    const range = dashboardRange(dashboard, Math.floor(Date.now() / 1000))
    setFrom(localInput(new Date(range.start * 1000)))
    setTo(localInput(new Date(range.end * 1000)))
    setError("")
    setOpen(true)
  }
  return (
    <div className={styles.range}>
      <label className={shared.timeSelect}>
        <span className={shared.srOnly}>Time range</span>
        <GammaSelect
          aria-label="Time range"
          size="sm"
          value={custom ? "custom" : dashboard.timeRange}
          onValueChange={(value) => {
            if (value === "custom") openRange()
            else {
              onChange({
                timeRange: value as Dashboard["timeRange"],
                customTimeRange: undefined,
              })
              setOpen(false)
            }
          }}
          options={[
            {value: "15m", label: "Last 15 minutes"},
            {value: "30m", label: "Last 30 minutes"},
            {value: "1h", label: "Last 1 hour"},
            {value: "6h", label: "Last 6 hours"},
            {value: "24h", label: "Last 24 hours"},
            {value: "7d", label: "Last 7 days"},
            {value: "30d", label: "Last 30 days"},
            {value: "custom", label: "Custom range…"},
          ]}
        />
      </label>
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
                onChange({
                  timeRange: dashboard.timeRange,
                  customTimeRange: range,
                })
                close()
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
      {custom && (
        <span className={styles.rangeSummary} title={`${custom.from} – ${custom.to}`}>
          {new Date(custom.from).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          —{" "}
          {new Date(custom.to).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </div>
  )
}
