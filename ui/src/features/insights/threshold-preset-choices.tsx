"use client"

import { useId } from "react"
import { GammaButton } from "./gamma/button"
import type { Threshold } from "./schema"
import { suggestedPresetIds, thresholdPresets } from "./threshold-presets"
import "./lazy-style-boundary.css?editor"
import editorStyles from "./editor.module.css"

/** Two band lists match when every band has the same value, status, colour and label, in the same order. */
function sameBands(a: readonly Threshold[], b: readonly Threshold[]) {
  return a.length === b.length && a.every((band, index) => {
    const other = b[index]
    return band.value === other.value && band.status === other.status && band.color === other.color && band.label === other.label
  })
}

/** Starts the Value thresholds from a named preset. A preset that has no scale for this unit is disabled. */
export function ThresholdPresetChoices({ unit, thresholds, onChoose }: {
  unit: string
  thresholds: readonly Threshold[]
  onChoose: (thresholds: Threshold[]) => void
}) {
  const headingId = useId()
  const suggested = suggestedPresetIds(unit)
  const ordered = [
    ...thresholdPresets.filter((preset) => suggested.includes(preset.id)),
    ...thresholdPresets.filter((preset) => !suggested.includes(preset.id)),
  ]
  return <div role="group" aria-labelledby={headingId} className="grid gap-1.5">
    <p id={headingId} className="m-0 text-xs font-semibold">Start from a preset</p>
    <div className="flex flex-wrap gap-1.5">
      {ordered.map((preset) => {
        const bands = preset.build(unit)
        const fits = suggested.includes(preset.id)
        return <GammaButton key={preset.id} type="button" size="sm" variant="secondary" disabled={bands === undefined}
          aria-pressed={bands !== undefined && sameBands(thresholds, bands)}
          title={bands === undefined ? "No preset fits this unit" : fits ? "Fits this unit" : undefined}
          onClick={() => bands && onChoose(bands)}>
          {preset.name}
        </GammaButton>
      })}
    </div>
    {suggested.length > 0 && <small className={editorStyles.hint}>Presets that fit {unit.trim()} come first.</small>}
  </div>
}
