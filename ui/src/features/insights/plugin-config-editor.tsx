"use client";

import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { GammaSwitch } from "./gamma/switch";
import type { WidgetDefinition } from "./widget-registry";
import styles from "./editor.module.css";

/** Keep raw JSON and guided fields on the same draft; invalid JSON stays editable. */
export function PluginConfigEditor({ definition, value, onChange }: {
  definition?: WidgetDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
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
      {fields.map(field => {
        const fallback = definition?.defaultConfig?.[field.key];
        const current = config?.[field.key] ?? (field.kind === "select" || field.kind === "boolean" ? fallback : undefined);
        if (field.kind === "boolean") return <fieldset disabled={!config} key={field.key} className={styles.pluginToggle}>
          <GammaSwitch label={field.label} description={field.help} checked={current === true} onChange={next => update(field.key, next)} />
        </fieldset>;
        return <label className={styles.field} key={field.key}>
          {field.label}
          {field.kind === "select" ? <GammaSelect
            aria-label={field.label} disabled={!config}
            value={typeof current === "string" ? current : ""}
            options={[...(field.options ?? [])]}
            onValueChange={next => update(field.key, next)}
          /> : <GammaInput
            aria-label={field.label} disabled={!config} type={field.kind === "number" ? "number" : "text"}
            value={typeof current === "string" || typeof current === "number" ? current : ""}
            placeholder={field.placeholder ?? (typeof fallback === "string" || typeof fallback === "number" ? `Default: ${fallback}` : undefined)} min={field.min} max={field.max} step={field.step}
            onChange={event => {
              const next = event.target.value;
              update(field.key, next === "" ? undefined : field.kind === "number" ? Number(next) : next);
            }}
          />}
          {field.help && <span className={styles.hint}>{field.help}</span>}
        </label>;
      })}
    </section>}
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
