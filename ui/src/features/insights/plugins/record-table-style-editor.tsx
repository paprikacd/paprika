"use client"

import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { GammaSelect } from "../gamma/select"
import { GammaSwitch } from "../gamma/switch"
import editorStyles from "../editor.module.css"
import styles from "./record-table-style-editor.module.css"

/** Guided column rules edit the same JSON draft as the advanced editor. */
export function RecordTableStyleEditor({ config, onChange }: {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}) {
  const raw = config.cellStyles ?? []
  const editable = Array.isArray(raw) && raw.length <= 16 && raw.every(entry => entry && typeof entry === "object" && !Array.isArray(entry))
  const entries: Record<string, unknown>[] = editable ? raw : []
  const update = (next: Record<string, unknown>[]) => {
    const result = { ...config }
    if (next.length) result.cellStyles = next
    else delete result.cellStyles
    onChange(result)
  }
  const updateEntry = (index: number, patch: Record<string, unknown>) => update(entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry))
  const time = config.timeSelection && typeof config.timeSelection === "object" && !Array.isArray(config.timeSelection) ? config.timeSelection as Record<string, unknown> : undefined
  const updateTime = (patch: Record<string, unknown>) => onChange({ ...config, timeSelection: { ...time, ...patch } })
  return <section className={editorStyles.stack} aria-label="Column presentation">
    <h3>Column presentation</h3>
    <p className={editorStyles.hint}>Use gauges or threshold colors for numbers, status badges for text, or a sparkline from a JSON history string. Names must match query result columns. Set numeric colors under Value thresholds in Style.</p>
    {!editable && <p role="status" className={editorStyles.hint}>Correct cellStyles in the configuration JSON to edit column presentation.</p>}
    {entries.map((entry, index) => <fieldset key={index} className={styles.rule}>
      <legend>Column style {index + 1}</legend>
      <label className={editorStyles.field}>Result column
        <GammaInput aria-label={`Column ${index + 1} name`} value={typeof entry.column === "string" ? entry.column : ""} maxLength={128} placeholder="For example: cpu_percent"
          onChange={event => updateEntry(index, { column: event.target.value })} />
      </label>
      <label className={editorStyles.field}>Display
        <GammaSelect aria-label={`Column ${index + 1} display`} value={typeof entry.display === "string" ? entry.display : ""}
          options={[{ value: "bar", label: "Gauge bar" }, { value: "bar-segments", label: "Segmented gauge" }, { value: "color-text", label: "Colored value" }, { value: "color-background", label: "Colored background" }, { value: "sparkline", label: "History sparkline" }, { value: "status-badge", label: "Status badge" }]}
          onValueChange={display => {
            const next: Record<string, unknown> = { ...entry, display }
            if (display === "bar" || display === "bar-segments") { next.min = typeof entry.min === "number" ? entry.min : 0; next.max = typeof entry.max === "number" ? entry.max : 100 }
            else { delete next.min; delete next.max }
            if (display !== "bar-segments") delete next.segments
            if (display !== "bar" && display !== "bar-segments") delete next.barColorMode
            if (display !== "status-badge") delete next.mappings
            if (display !== "sparkline") delete next.thresholdColumn
            if (display === "status-badge") delete next.unit
            update(entries.map((current, i) => i === index ? next : current))
          }} />
      </label>
      {(entry.display === "bar" || entry.display === "bar-segments") && <>
        <div className={styles.bounds}>
          {(["min", "max"] as const).map(bound => <label className={editorStyles.field} key={bound}>{bound === "min" ? "Minimum" : "Maximum"}
            <GammaInput aria-label={`Column ${index + 1} ${bound === "min" ? "minimum" : "maximum"}`} type="number" step="any"
              value={typeof entry[bound] === "number" ? entry[bound] : ""}
              onChange={event => updateEntry(index, { [bound]: event.target.value === "" ? undefined : Number(event.target.value) })} />
          </label>)}
        </div>
        <label className={editorStyles.field}>Gauge colors
          <GammaSelect aria-label={`Column ${index + 1} gauge colors`} value={typeof entry.barColorMode === "string" ? entry.barColorMode : "gradient"}
            options={[{ value: "gradient", label: "Threshold bands" }, { value: "value", label: "Current value threshold" }]}
            onValueChange={barColorMode => updateEntry(index, { barColorMode })} />
        </label>
        <p className={editorStyles.hint}>The fixed scale stays the same when rows are filtered or sorted. Negative values extend left from zero; values outside the scale keep their exact reading.</p>
        {entry.display === "bar-segments" && <label className={editorStyles.field}>Segments
          <GammaInput aria-label={`Column ${index + 1} segments`} type="number" min={4} max={60} step={1}
            value={typeof entry.segments === "number" ? entry.segments : ""} placeholder="24"
            onChange={event => updateEntry(index, { segments: event.target.value === "" ? undefined : Number(event.target.value) })} />
        </label>}
      </>}
      {entry.display !== "sparkline" && entry.display !== "status-badge" && <label className={editorStyles.field}>Value unit (optional)
        <GammaInput aria-label={`Column ${index + 1} value unit`} value={typeof entry.unit === "string" ? entry.unit : ""} maxLength={24} placeholder="For example: %"
          onChange={event => updateEntry(index, { unit: event.target.value || undefined })} />
      </label>}
      {entry.display === "status-badge" && <div className={editorStyles.stack}>
        <p className={editorStyles.hint}>Match exact text from the result. Unmapped and missing values remain neutral and retain their original text.</p>
        {(Array.isArray(entry.mappings) ? entry.mappings : []).map((raw, mappingIndex) => {
          const mapping = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
          const mappings = entry.mappings as unknown[]
          const change = (patch: Record<string, unknown>) => updateEntry(index, { mappings: mappings.map((current, i) => i === mappingIndex ? { ...mapping, ...patch } : current) })
          return <fieldset className={styles.mapping} key={mappingIndex}><legend>Status {mappingIndex + 1}</legend>
            <label className={editorStyles.field}>Exact value<GammaInput aria-label={`Column ${index + 1} status ${mappingIndex + 1} value`} value={typeof mapping.value === "string" ? mapping.value : ""} maxLength={128} onChange={event => change({ value: event.target.value })} /></label>
            <label className={editorStyles.field}>Indicator color<GammaInput aria-label={`Column ${index + 1} status ${mappingIndex + 1} color`} value={typeof mapping.color === "string" ? mapping.color : ""} maxLength={7} placeholder="#20cba3" onChange={event => change({ color: event.target.value })} /></label>
            <GammaButton size="sm" variant="quiet" aria-label={`Remove column ${index + 1} status ${mappingIndex + 1}`} onClick={() => updateEntry(index, { mappings: mappings.filter((_, i) => i !== mappingIndex) })}>Remove status</GammaButton>
          </fieldset>
        })}
        <GammaButton size="sm" disabled={Array.isArray(entry.mappings) && entry.mappings.length >= 16} onClick={() => updateEntry(index, { mappings: [...(Array.isArray(entry.mappings) ? entry.mappings : []), { value: "", color: "#20cba3" }] })}>Add status</GammaButton>
      </div>}
      {entry.display === "sparkline" && <>
        <label className={editorStyles.field}>History unit (optional)
          <GammaInput aria-label={`Column ${index + 1} history unit`} value={typeof entry.unit === "string" ? entry.unit : ""} maxLength={24} placeholder="For example: %"
            onChange={event => updateEntry(index, { unit: event.target.value || undefined })} />
        </label>
        <label className={editorStyles.field}>Color from numeric column (optional)
          <GammaInput aria-label={`Column ${index + 1} threshold column`} value={typeof entry.thresholdColumn === "string" ? entry.thresholdColumn : ""} maxLength={128} placeholder="For example: risk"
            onChange={event => updateEntry(index, { thresholdColumn: event.target.value || undefined })} />
        </label>
        <p className={editorStyles.hint}>Color the whole history using this row’s numeric value and the widget’s Value thresholds. Missing values or thresholds use a neutral color.</p>
        <p className={editorStyles.hint}>Use a string column containing a JSON array of up to 240 objects with an ordered ISO timestamp and numeric or null value. Gaps remain gaps; this does not run another query.</p>
      </>}
      <GammaButton size="sm" variant="quiet" onClick={() => update(entries.filter((_, i) => i !== index))} aria-label={`Remove column style ${index + 1}`}>Remove style</GammaButton>
    </fieldset>)}
    <GammaButton size="sm" disabled={!editable || entries.length >= 16} onClick={() => update([...entries, { column: "", display: "bar", min: 0, max: 100 }])}>Add column style</GammaButton>
    <GammaSwitch label="Focus dashboard time from a row" description="Offer an explicit Focus time action using a recorded start and duration." checked={!!time} onChange={enabled => {
      const next = { ...config }
      if (enabled) next.timeSelection = { start: "", duration: "", durationUnit: "minutes", paddingSeconds: 300 }
      else delete next.timeSelection
      onChange(next)
    }} />
    {time && <fieldset className={styles.rule}><legend>Time selection</legend>
      <label className={editorStyles.field}>Start timestamp column<GammaInput aria-label="Time selection start column" value={typeof time.start === "string" ? time.start : ""} maxLength={128} onChange={event => updateTime({ start: event.target.value })} /></label>
      <label className={editorStyles.field}>Duration column<GammaInput aria-label="Time selection duration column" value={typeof time.duration === "string" ? time.duration : ""} maxLength={128} onChange={event => updateTime({ duration: event.target.value })} /></label>
      <label className={editorStyles.field}>Duration unit<GammaSelect aria-label="Time selection duration unit" value={typeof time.durationUnit === "string" ? time.durationUnit : "minutes"} options={[{ value: "milliseconds", label: "Milliseconds" }, { value: "seconds", label: "Seconds" }, { value: "minutes", label: "Minutes" }]} onValueChange={durationUnit => updateTime({ durationUnit })} /></label>
      <label className={editorStyles.field}>Padding (seconds)<GammaInput aria-label="Time selection padding" type="number" min={0} max={86400} value={typeof time.paddingSeconds === "number" ? time.paddingSeconds : 0} onChange={event => updateTime({ paddingSeconds: Number(event.target.value) })} /></label>
      <p className={editorStyles.hint}>The interval and padding must fit within 31 days. Missing or invalid data leaves the row action disabled.</p>
    </fieldset>}
  </section>
}
