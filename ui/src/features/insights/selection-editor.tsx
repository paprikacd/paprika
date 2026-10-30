"use client"

import { useId } from "react"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { useSavedQueryLibrary } from "./saved-query-context"
import type { DrilldownBinding, Widget } from "./schema"
import styles from "./drilldown.module.css"
import { supportsDashboardSelection } from "./selection-support"
import type { QueryFields } from "./query-connections"

/** Explicitly map a selected record/series to this dashboard's runtime filters. */
export function SelectionEditor({ widget, onChange, queryFields }: { widget: Widget; onChange: (next: Widget) => void; queryFields?: QueryFields }) {
  const listId = useId()
  const { variables } = useSavedQueryLibrary()
  const bindings = widget.selectionBindings ?? []
  const recordColumns = queryFields?.recordColumns
  const fieldNames = recordColumns ? recordColumns.map(column => column.name) : queryFields?.labels.map(label => label.name) ?? []
  const hasFieldSnapshot = !!recordColumns || !!queryFields?.seriesCount
  const update = (next: DrilldownBinding[]) => {
    const copy = { ...widget }
    if (next.length) copy.selectionBindings = next
    else delete copy.selectionBindings
    onChange(copy)
  }
  if (!supportsDashboardSelection(widget)) {
    if (!bindings.length) return null
    return <section className={styles.card} aria-label="Dashboard selection filters">
      <strong>Filter this dashboard on selection</strong>
      <p className={styles.help}>This visualization cannot update dashboard filters on selection. {bindings.length === 1 ? "The existing selection binding is" : `The ${bindings.length} existing selection bindings are`} retained but inactive; choose a visualization that supports selection to use or edit them.</p>
      <GammaButton size="sm" variant="quiet" onClick={() => update([])}>Remove inactive selection bindings</GammaButton>
    </section>
  }
  const available = variables.filter(v => !bindings.some(b => b.variable === v.name))
  return <section className={styles.card} aria-label="Dashboard selection filters">
    <strong>Filter this dashboard on selection</strong>
    <p className={styles.help}>Click a record or series to update the mapped dashboard filters. Saved defaults remain unchanged.</p>
    {bindings.map((binding, index) => {
      const selectedLabel = queryFields?.labels.find(label => label.name === binding.value)
      const missing = binding.source === "label" && !!binding.value && hasFieldSnapshot && !fieldNames.includes(binding.value) && !queryFields?.partial
      const someSeries = binding.source === "label" && !recordColumns && selectedLabel && queryFields && selectedLabel.present < queryFields.seriesCount
        ? `“${binding.value}” appears in ${selectedLabel.present} of ${queryFields.seriesCount} loaded series; some selections may not contain it.` : ""
      const feedbackId = missing || someSeries ? `${listId}-binding-${index}-feedback` : undefined
      return <fieldset className={styles.binding} key={index}>
      <legend>Selection binding {index + 1}</legend>
      <div className={styles.field}><span>Dashboard variable</span>
        <GammaSelect aria-label={`Selection ${index + 1} variable`} value={binding.variable} options={variables.map(v => ({ value: v.name, label: v.label || v.name, disabled: bindings.some((b, i) => i !== index && b.variable === v.name) }))} onValueChange={variable => update(bindings.map((b, i) => i === index ? { ...b, variable } : b))} />
      </div>
      <div className={styles.field}><span>Value source</span>
        <GammaSelect aria-label={`Selection ${index + 1} source`} value={binding.source} options={[{value:"label",label:"Record field / label"},{value:"series",label:"Series name"},{value:"value",label:"Numeric value"},{value:"constant",label:"Constant"}]} onValueChange={source => update(bindings.map((b, i) => i !== index ? b : source === "label" ? { variable: b.variable, source, value: b.variable } : source === "constant" ? { variable: b.variable, source, value: "" } : { variable: b.variable, source: source as "series" | "value" }))} />
      </div>
      {(binding.source === "label" || binding.source === "constant") && <label className={styles.field}><span>{binding.source === "label" ? "Field or label key" : "Constant value"}</span><GammaInput aria-label={`Selection ${index + 1} ${binding.source === "label" ? "field" : "constant"}`} aria-describedby={feedbackId} list={binding.source === "label" && hasFieldSnapshot ? `${listId}-fields` : undefined} value={binding.value ?? ""} maxLength={binding.source === "label" ? 128 : 1024} onChange={event => update(bindings.map((b, i) => i === index ? { ...b, value: event.target.value } : b))} />
        {missing && <span id={feedbackId} className={styles.help}>The current result has no “{binding.value}” {recordColumns ? "field" : "label"}. You can still enter a key expected in later results.</span>}
        {someSeries && <span id={feedbackId} className={styles.help}>{someSeries}</span>}
      </label>}
      <GammaButton size="sm" variant="quiet" onClick={() => update(bindings.filter((_, i) => i !== index))}>Remove selection binding</GammaButton>
    </fieldset>})}
    {hasFieldSnapshot && <><datalist id={`${listId}-fields`}>{fieldNames.map(name => <option key={name} value={name}>{recordColumns?.find(column => column.name === name)?.type}</option>)}</datalist><p className={styles.help}>Available result {recordColumns ? "fields" : "labels"}: {fieldNames.length ? fieldNames.slice(0, 6).join(", ") : "none"}{fieldNames.length > 6 ? ` · ${fieldNames.length - 6} more in suggestions` : ""}{queryFields?.partial ? " · limited result" : ""}. Availability depends on the selected observation.</p></>}
    <GammaButton size="sm" variant="quiet" disabled={!available.length} onClick={() => available[0] && update([...bindings, { variable: available[0].name, source: "label", value: available[0].name }])}>Add selection binding</GammaButton>
    {!variables.length && <p className={styles.help}>Add a dashboard variable to connect a selection.</p>}
  </section>
}
