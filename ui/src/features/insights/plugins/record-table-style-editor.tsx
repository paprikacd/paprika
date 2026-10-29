"use client"

import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { GammaSelect } from "../gamma/select"
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
  return <section className={editorStyles.stack} aria-label="Column presentation">
    <h3>Column presentation</h3>
    <p className={editorStyles.hint}>Use bars or threshold colors in numeric columns. Names must match query result columns. Set colors under Value thresholds in Style.</p>
    {!editable && <p role="status" className={editorStyles.hint}>Correct cellStyles in the configuration JSON to edit column presentation.</p>}
    {entries.map((entry, index) => <fieldset key={index} className={styles.rule}>
      <legend>Column style {index + 1}</legend>
      <label className={editorStyles.field}>Result column
        <GammaInput aria-label={`Column ${index + 1} name`} value={typeof entry.column === "string" ? entry.column : ""} maxLength={128} placeholder="For example: cpu_percent"
          onChange={event => updateEntry(index, { column: event.target.value })} />
      </label>
      <label className={editorStyles.field}>Display
        <GammaSelect aria-label={`Column ${index + 1} display`} value={typeof entry.display === "string" ? entry.display : ""}
          options={[{ value: "bar", label: "Gauge bar" }, { value: "color-text", label: "Colored value" }, { value: "color-background", label: "Colored background" }]}
          onValueChange={display => {
            const next: Record<string, unknown> = { ...entry, display }
            if (display === "bar") { next.min = typeof entry.min === "number" ? entry.min : 0; next.max = typeof entry.max === "number" ? entry.max : 100 }
            else { delete next.min; delete next.max }
            update(entries.map((current, i) => i === index ? next : current))
          }} />
      </label>
      {entry.display === "bar" && <>
        <div className={styles.bounds}>
          {(["min", "max"] as const).map(bound => <label className={editorStyles.field} key={bound}>{bound === "min" ? "Minimum" : "Maximum"}
            <GammaInput aria-label={`Column ${index + 1} ${bound === "min" ? "minimum" : "maximum"}`} type="number" step="any"
              value={typeof entry[bound] === "number" ? entry[bound] : ""}
              onChange={event => updateEntry(index, { [bound]: event.target.value === "" ? undefined : Number(event.target.value) })} />
          </label>)}
        </div>
        <p className={editorStyles.hint}>The fixed scale stays the same when rows are filtered or sorted. Negative values extend left from zero; values outside the scale keep their exact reading.</p>
      </>}
      <GammaButton size="sm" variant="quiet" onClick={() => update(entries.filter((_, i) => i !== index))} aria-label={`Remove column style ${index + 1}`}>Remove style</GammaButton>
    </fieldset>)}
    <GammaButton size="sm" disabled={!editable || entries.length >= 16} onClick={() => update([...entries, { column: "", display: "bar", min: 0, max: 100 }])}>Add column style</GammaButton>
  </section>
}
