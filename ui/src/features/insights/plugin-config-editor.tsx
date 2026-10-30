"use client";

import { useId } from "react";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { GammaSwitch } from "./gamma/switch";
import type { WidgetDefinition } from "./widget-registry";
import styles from "./editor.module.css";
import { RecordTableStyleEditor } from "./plugins/record-table-style-editor";
import { MetricAnnotationEditor } from "./plugins/metric-annotation-editor";
import { SeriesColorEditor } from "./plugins/series-color-editor";
import type { QueryFields } from "./query-connections";

/** Keep raw JSON and guided fields on the same draft; invalid JSON stays editable. */
export function PluginConfigEditor({ definition, value, onChange, queryFields }: {
  definition?: WidgetDefinition;
  value: string;
  onChange: (value: string) => void;
  queryFields?: QueryFields;
}) {
  const listId = useId();
  let config: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      config = parsed as Record<string, unknown>;
  } catch { /* The advanced input retains the invalid draft for correction. */ }
  const fields = definition?.configFields ?? [];
  const update = (key: string, next: string | number | boolean | undefined) => {
    if (!config) return;
    const result = { ...config };
    if (next === undefined) delete result[key];
    else result[key] = next;
    onChange(JSON.stringify(result, null, 2));
  };
  return <div className={styles.stack}>
    {fields.length > 0 && <section aria-label="Visualization settings" className={styles.stack}>
      <h3>Visualization settings</h3>
      {!config && <p role="status" className={styles.hint}>Correct the configuration JSON to use these controls.</p>}
      {fields.some(field => field.recordColumn) && <p className={styles.hint}>{queryFields?.recordColumns
        ? `Available result fields: ${queryFields.recordColumns.slice(0, 6).map(column => `${column.name} (${column.type})`).join(", ")}${queryFields.recordColumns.length > 6 ? ` · ${queryFields.recordColumns.length - 6} more in suggestions` : ""}${queryFields.partial ? " · limited result" : ""}.`
        : "Result field suggestions appear after the widget loads. You can also enter a field name directly."}</p>}
      {fields.map(field => {
        // Legacy maps display their grid and labels; the compact glow view
        // hides them unless explicitly enabled. Reflect the renderer default.
        const fallback = definition?.id === "connection-map" && (field.key === "showGrid" || field.key === "showCoordinates")
          ? config?.display !== "density"
          : definition?.defaultConfig?.[field.key];
        const current = config?.[field.key] ?? (field.kind === "select" || field.kind === "boolean" ? fallback : undefined);
        if (field.kind === "boolean") return <fieldset disabled={!config} key={field.key} className={styles.pluginToggle}>
          <GammaSwitch label={field.label} description={field.help} checked={current === true} onChange={next => update(field.key, next)} />
        </fieldset>;
        const columns = queryFields?.recordColumns;
        const matches = columns?.filter(column => field.recordColumn !== "number" || column.type === "number") ?? [];
        const chosen = typeof current === "string" && current ? columns?.find(column => column.name === current) : undefined;
        return <label className={styles.field} key={field.key}>
          {field.label}
          {field.kind === "select" ? <GammaSelect
            aria-label={field.label} disabled={!config}
            value={typeof current === "string" ? current : ""}
            options={[...(field.options ?? [])]}
            onValueChange={next => update(field.key, next)}
          /> : <GammaInput
            aria-label={field.label} disabled={!config} type={field.kind === "number" ? "number" : "text"}
            list={field.recordColumn && columns ? `${listId}-${field.key}` : undefined}
            value={typeof current === "string" || typeof current === "number" ? current : ""}
            placeholder={field.placeholder ?? (typeof fallback === "string" || typeof fallback === "number" ? `Default: ${fallback}` : undefined)} min={field.min} max={field.max} step={field.step}
            onChange={event => {
              const next = event.target.value;
              update(field.key, next === "" ? undefined : field.kind === "number" ? Number(next) : next);
            }}
          />}
          {field.recordColumn && columns && <datalist id={`${listId}-${field.key}`}>{matches.map(column => <option key={column.name} value={column.name}>{column.type}</option>)}</datalist>}
          {field.help && <span className={styles.hint}>{field.help}</span>}
          {field.recordColumn && columns && typeof current === "string" && current && !chosen && !queryFields?.partial && <span className={styles.hint}>The current result has no “{current}” field.</span>}
          {field.recordColumn === "number" && chosen && chosen.type !== "number" && <span className={styles.hint}>“{chosen.name}” is {chosen.type}; choose a numeric field.</span>}
        </label>;
      })}
    </section>}
    {definition?.id === "record-table" && config && <RecordTableStyleEditor config={config} onChange={next => onChange(JSON.stringify(next, null, 2))} />}
    {(definition?.id === "stacked-timeseries" || definition?.id === "directional-traffic") && config && <SeriesColorEditor config={config} onChange={next => onChange(JSON.stringify(next, null, 2))} />}
    {definition?.id === "stacked-timeseries" && config && <MetricAnnotationEditor config={config} onChange={next => onChange(JSON.stringify(next, null, 2))} />}
    <details open={fields.length === 0}>
      <summary>Advanced configuration</summary>
      <label className={styles.field}>
        Plugin configuration
        <GammaTextarea aria-label="Plugin configuration" className={styles.codeInput}
          rows={6} value={value} onChange={event => onChange(event.target.value)} />
      </label>
    </details>
  </div>;
}
