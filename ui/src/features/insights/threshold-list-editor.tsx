"use client"

import { useId, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { useInsightsTheme } from "./insights-theme"
import type { Threshold } from "./schema"
import type { StatusMark } from "./status"
import { StatusMarkFields } from "./status-mark-fields"
import "./lazy-style-boundary.css?editor"
import editorStyles from "./editor.module.css"

/** New bands start with the healthy band, then escalate: ok, warning, then critical for every later band. */
const NEW_BAND_STATUSES = ["ok", "warning", "critical"] as const

/** Replaces a band's status and hue, keeping its value and label and omitting absent keys. */
function withStatusMark(threshold: Threshold, mark: StatusMark): Threshold {
  const next: Threshold = { value: threshold.value }
  if (mark.status !== undefined) next.status = mark.status
  if (mark.color !== undefined) next.color = mark.color
  if (threshold.label !== undefined) next.label = threshold.label
  return next
}

/**
 * A band's value as typed text. Only a finite number is written back: an emptied or half-typed field keeps the last
 * stored value (and says so) instead of silently becoming 0. Blur restores the stored value.
 */
function ThresholdValueInput({ value, label, onValue }: { value: number; label: string; onValue: (value: number) => void }) {
  const [text, setText] = useState(() => value.toString())
  const [synced, setSynced] = useState(value)
  const hintId = useId()
  // Resync when the stored value changes from outside (undo, preset, another band's edit).
  if (value !== synced) {
    setSynced(value)
    setText(value.toString())
  }
  const invalid = text.trim() === "" || !Number.isFinite(Number(text))
  return <>
    <GammaInput
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? hintId : undefined}
      type="number"
      step="any"
      value={text}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        if (next.trim() === "" || !Number.isFinite(Number(next))) return
        const parsed = Number(next)
        setSynced(parsed)
        onValue(parsed)
      }}
      onBlur={() => setText(value.toString())}
    />
    {invalid && <small id={hintId} className="text-[11px] text-[var(--gamma-danger)]">Enter a number to update this band.</small>}
  </>
}

/**
 * Editable value bands: a value, a status or hue, and a label for each. The widget's Value thresholds and each
 * record column's own thresholds use this one list. `prefix` names the bands in their labels ("Threshold 2 value",
 * "Column 1 threshold 2 value"), so two lists on one screen keep distinct accessible names.
 */
export function ThresholdListEditor({ thresholds, onChange, prefix = "Threshold", addLabel = "Add threshold", max = 12 }: {
  thresholds: readonly Threshold[]
  onChange: (thresholds: Threshold[]) => void
  prefix?: string
  addLabel?: string
  max?: number
}) {
  const { resolvedTheme } = useInsightsTheme()
  return <>
    {thresholds.map((threshold, index) => (
      <div className={editorStyles.threshold} key={index}>
        <label className={editorStyles.field}>
          At least
          <ThresholdValueInput
            label={`${prefix} ${index + 1} value`}
            value={threshold.value}
            onValue={(value) => onChange(thresholds.map((item, i) => i === index ? { ...item, value } : item))}
          />
        </label>
        <GammaButton
          type="button"
          variant="quiet"
          size="sm"
          iconOnly
          aria-label={`Remove ${prefix.toLowerCase()} ${index + 1}`}
          onClick={() => onChange(thresholds.filter((_, i) => i !== index))}
        >
          <Trash2 size={14} />
        </GammaButton>
        <StatusMarkFields
          name={`${prefix} ${index + 1}`}
          mark={threshold}
          theme={resolvedTheme}
          onChange={(mark) => onChange(thresholds.map((item, i) => i === index ? withStatusMark(item, mark) : item))}
        />
        <label className={editorStyles.thresholdLabel}>
          Label
          <GammaInput
            aria-label={`${prefix} ${index + 1} label`}
            value={threshold.label ?? ""}
            maxLength={80}
            placeholder="e.g. Healthy"
            onChange={(event) => onChange(thresholds.map((item, i) => i === index ? { ...item, label: event.target.value || undefined } : item))}
          />
        </label>
      </div>
    ))}
    <GammaButton
      type="button"
      variant="secondary"
      disabled={thresholds.length >= max}
      onClick={() => onChange([
        ...thresholds,
        { value: thresholds.length ? thresholds[thresholds.length - 1].value + 1 : 0, status: NEW_BAND_STATUSES[Math.min(thresholds.length, NEW_BAND_STATUSES.length - 1)] },
      ])}
    >
      <Plus size={13} /> {addLabel}
    </GammaButton>
  </>
}
