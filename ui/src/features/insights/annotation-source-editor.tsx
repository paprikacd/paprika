"use client"

import type { Widget } from "./schema"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { SavedQueryBindingEditor, SavedQueryPicker } from "./saved-query-controls"
import { useSavedQueryLibrary } from "./saved-query-context"
import styles from "./editor.module.css"

/** Event data is a second saved-query reference, not executable plugin code. */
export function AnnotationSourceEditor({ widget, onChange }: { widget: Widget; onChange: (widget: Widget) => void }) {
  const library = useSavedQueryLibrary()
  const source = widget.annotationSource
  const saved = library.queries.find(query => query.id === source?.queryRef.id)
  return <section className={styles.stack} aria-label="Event data">
    <h3>Event data</h3>
    <p className={styles.hint}>Overlay recorded events or intervals from a saved records query. Intervals overlapping the displayed series are shown.</p>
    {!source ? <GammaButton size="sm" variant="secondary" onClick={() => onChange({ ...widget, annotationSource: { queryRef: { id: "" }, timestampColumn: "date", labelColumn: "label" } })}>Add event query</GammaButton> : <>
      <SavedQueryPicker queries={library.queries} kind="records" value={source.queryRef.id} label="Event saved query" disabled={library.loading} onChange={id => onChange({ ...widget, annotationSource: { ...source, queryRef: id === source.queryRef.id ? source.queryRef : { id } } })} />
      {library.error && <p role="alert" className={styles.error}>{library.error}</p>}
      {saved && <SavedQueryBindingEditor query={saved} bindings={source.queryRef.bindings} variables={library.variables} values={library.values} onChange={bindings => onChange({ ...widget, annotationSource: { ...source, queryRef: { id: source.queryRef.id, bindings: bindings.filter(binding => binding.source === "variable" || binding.source === "constant") } } })} />}
      {([ ["timestampColumn", "Timestamp column"], ["endColumn", "End timestamp column (optional)"], ["labelColumn", "Label column"], ["severityColumn", "Severity column (optional)"] ] as const).map(([key, label]) => <label key={key} className={styles.field}>{label}
        <GammaInput aria-label={label} maxLength={128} value={source[key] ?? ""} onChange={event => onChange({ ...widget, annotationSource: { ...source, [key]: event.target.value || (key === "severityColumn" || key === "endColumn" ? undefined : "") } })} />
      </label>)}
      <GammaButton size="sm" variant="quiet" onClick={() => { const next = { ...widget }; delete next.annotationSource; onChange(next) }}>Remove event query</GammaButton>
    </>}
  </section>
}
