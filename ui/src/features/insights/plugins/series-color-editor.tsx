"use client";

import { GammaButton } from "../gamma/button";
import { GammaInput } from "../gamma/input";
import editorStyles from "../editor.module.css";
import styles from "./record-table-style-editor.module.css";

/** Edit exact provider label/color associations in the same saved config as JSON. */
export function SeriesColorEditor({ config, onChange }: { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const raw = config.seriesColors ?? [];
  const editable = Array.isArray(raw) && raw.length <= 24 && raw.every(entry => entry && typeof entry === "object" && !Array.isArray(entry));
  const entries: Record<string, unknown>[] = editable ? raw : [];
  const update = (next: Record<string, unknown>[]) => {
    const result = { ...config };
    if (next.length) result.seriesColors = next;
    else delete result.seriesColors;
    onChange(result);
  };
  const edit = (index: number, patch: Record<string, unknown>) => update(entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  return <section className={editorStyles.stack} aria-label="Series colors">
    <h3>Series colors</h3>
    <p className={editorStyles.hint}>Match an exact metric label and value. The first matching rule sets the series color; unmatched series retain the chart palette.</p>
    {!editable && <p role="status" className={editorStyles.hint}>Correct series colors in advanced configuration to edit rules.</p>}
    {entries.map((entry, index) => <fieldset key={index} className={styles.rule}>
      <legend>Color rule {index + 1}</legend>
      <label className={editorStyles.field}>Metric label<GammaInput aria-label={`Color rule ${index + 1} label`} maxLength={100} placeholder="direction" value={typeof entry.label === "string" ? entry.label : ""} onChange={event => edit(index, { label: event.target.value })} /></label>
      <label className={editorStyles.field}>Exact value<GammaInput aria-label={`Color rule ${index + 1} value`} maxLength={256} placeholder="inbound" value={typeof entry.value === "string" ? entry.value : ""} onChange={event => edit(index, { value: event.target.value })} /></label>
      <label className={editorStyles.field}>Color<GammaInput aria-label={`Color rule ${index + 1} color`} maxLength={7} placeholder="#00cee2" value={typeof entry.color === "string" ? entry.color : ""} onChange={event => edit(index, { color: event.target.value })} /></label>
      <GammaButton size="sm" variant="quiet" aria-label={`Remove color rule ${index + 1}`} onClick={() => update(entries.filter((_, i) => i !== index))}>Remove color</GammaButton>
    </fieldset>)}
    <GammaButton size="sm" disabled={!editable || entries.length >= 24} onClick={() => update([...entries, { label: "", value: "", color: "#00cee2" }])}>Add series color</GammaButton>
  </section>;
}
