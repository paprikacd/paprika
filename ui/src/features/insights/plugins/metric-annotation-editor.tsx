"use client";

import { GammaButton } from "../gamma/button";
import { GammaInput } from "../gamma/input";
import { GammaSelect } from "../gamma/select";
import editorStyles from "../editor.module.css";
import styles from "./record-table-style-editor.module.css";

/** Edits the same persisted JSON as advanced configuration; no event query is made. */
export function MetricAnnotationEditor({ config, onChange }: { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const raw = config.annotations ?? [];
  const editable = Array.isArray(raw) && raw.length <= 20 && raw.every(entry => entry && typeof entry === "object" && !Array.isArray(entry));
  const entries: Record<string, unknown>[] = editable ? raw : [];
  const update = (next: Record<string, unknown>[]) => {
    const result = { ...config };
    if (next.length) result.annotations = next;
    else delete result.annotations;
    onChange(result);
  };
  const edit = (index: number, patch: Record<string, unknown>) => update(entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  return <section className={editorStyles.stack} aria-label="Chart events">
    <h3>Chart events</h3>
    <p className={editorStyles.hint}>Add recorded events with an ISO 8601 timestamp including a timezone. Events are saved on this widget; no additional query runs.</p>
    {!editable && <p role="status" className={editorStyles.hint}>Correct annotations in advanced configuration to edit events.</p>}
    {entries.map((entry, index) => <fieldset key={index} className={styles.rule}>
      <legend>Event {index + 1}</legend>
      <label className={editorStyles.field}>Label<GammaInput aria-label={`Event ${index + 1} label`} maxLength={100} value={typeof entry.label === "string" ? entry.label : ""} onChange={event => edit(index, { label: event.target.value })} /></label>
      <label className={editorStyles.field}>Timestamp<GammaInput aria-label={`Event ${index + 1} timestamp`} placeholder="2026-10-29T12:00:00Z" value={typeof entry.timestamp === "string" ? entry.timestamp : ""} onChange={event => edit(index, { timestamp: event.target.value })} /></label>
      <label className={editorStyles.field}>Severity<GammaSelect aria-label={`Event ${index + 1} severity`} value={typeof entry.severity === "string" ? entry.severity : "info"} options={[{ value: "info", label: "Info" }, { value: "warning", label: "Warning" }, { value: "critical", label: "Critical" }]} onValueChange={severity => edit(index, { severity })} /></label>
      <GammaButton size="sm" variant="quiet" aria-label={`Remove event ${index + 1}`} onClick={() => update(entries.filter((_, i) => i !== index))}>Remove event</GammaButton>
    </fieldset>)}
    <GammaButton size="sm" disabled={!editable || entries.length >= 20} onClick={() => update([...entries, { timestamp: new Date().toISOString(), label: "", severity: "info" }])}>Add event</GammaButton>
  </section>;
}
