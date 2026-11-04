"use client";

import { useId } from "react";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { GammaSwitch } from "./gamma/switch";
import {
  effectiveFieldBinding,
  type WidgetConfigField,
  type WidgetDefinition,
  type WidgetFieldBinding,
  type WidgetInputIssue,
  type WidgetRecordType,
} from "./widget-registry";
import type { QueryResult, Widget } from "./schema";
import styles from "./editor.module.css";
import { RecordTableStyleEditor } from "./plugins/record-table-style-editor";
import { MetricAnnotationEditor } from "./plugins/metric-annotation-editor";
import { SeriesColorEditor } from "./plugins/series-color-editor";
import type { QueryFields } from "./query-connections";

/** A result column as the editor sees it. Units exist only when the loaded result itself is available. */
interface EditorColumn { key: string; type: string; unit?: string }

const typeNoun: Record<WidgetRecordType, string> = { number: "numeric", string: "text", boolean: "boolean", timestamp: "timestamp" };
const kindsOf = (types: readonly WidgetRecordType[]) => types.map((type) => typeNoun[type]).join(" or ");
const acceptedUnitsOf = (binding: WidgetFieldBinding) => binding.acceptedUnits ?? (binding.unit ? [binding.unit] : []);

/** Suggestions come from the loaded result when the host has one, otherwise from the query snapshot's names and types. */
function editorColumns(result: QueryResult | undefined, queryFields: QueryFields | undefined): EditorColumn[] | undefined {
  if (result?.records) return result.records.columns.map((column) => ({ key: column.key, type: column.type, unit: column.unit }));
  return queryFields?.recordColumns?.map((column) => ({ key: column.name, type: column.type }));
}

function bindingRequirement(binding: WidgetFieldBinding) {
  const units = acceptedUnitsOf(binding);
  return `Requires a ${kindsOf(binding.types)} field${units.length ? ` in ${units.join(" or ")}` : ""}.`;
}

/** Explains why a mapping cannot be used. Column checks wait for known columns, and unit checks wait for a loaded result. */
function mappingMessages({ field, binding, entered, chosen, columns, partial, unitsKnown }: {
  field: WidgetConfigField;
  binding: WidgetFieldBinding;
  entered: unknown;
  chosen?: EditorColumn;
  columns?: EditorColumn[];
  partial: boolean;
  unitsKnown: boolean;
}): string[] {
  const messages: string[] = [];
  const name = typeof entered === "string" ? entered : "";
  if (!name && field.binding && !binding.optional) messages.push("Choose a source field.");
  if (name && columns && !chosen && !partial) messages.push(`The current result has no “${name}” field.`);
  // All four types mean any column, so only a narrower binding can mismatch by type.
  if (chosen && binding.types.length < 4 && !binding.types.includes(chosen.type as WidgetRecordType))
    messages.push(`“${chosen.key}” is ${chosen.type}; choose a ${kindsOf(binding.types)} field.`);
  const units = acceptedUnitsOf(binding);
  if (chosen && unitsKnown && units.length && !units.includes(chosen.unit ?? ""))
    messages.push(`“${chosen.key}” uses ${chosen.unit || "no unit"}; choose a field in ${units.join(" or ")}.`);
  return messages;
}

const issueMessageLimit = 200;
const isIssue = (value: unknown): value is WidgetInputIssue =>
  typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string";

/**
 * Runs the renderer's own data check here, not through widgetInputIssues, which replaces a thrown message with
 * generic text. A thrown message reaches the author, bounded to 200 characters. A return that is not a list of
 * issues becomes one issue, so a malformed check can neither pass silently nor break the editor.
 */
function rendererIssues(definition: WidgetDefinition | undefined, result: QueryResult, config: Record<string, unknown>): readonly WidgetInputIssue[] {
  if (!definition?.validateInput) return [];
  let returned: unknown;
  try {
    returned = definition.validateInput(result, config as Widget["config"]);
  } catch (error) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    return [{ message: message.slice(0, issueMessageLimit) || "The loaded result could not be checked for this widget." }];
  }
  return Array.isArray(returned) && returned.every(isIssue) ? returned : [{ message: "Validation returned an unexpected value" }];
}

/** Keep raw JSON and guided fields on the same draft; invalid JSON stays editable. */
export function PluginConfigEditor({ definition, value, onChange, queryFields, result }: {
  definition?: WidgetDefinition;
  value: string;
  onChange: (value: string) => void;
  queryFields?: QueryFields;
  /** The loaded result, when the host has one. It supplies column units and the renderer's own data checks. */
  result?: QueryResult;
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
    const draft = { ...config };
    if (next === undefined) delete draft[key];
    else draft[key] = next;
    onChange(JSON.stringify(draft, null, 2));
  };
  const columns = editorColumns(result, queryFields);
  const partial = !!(result?.truncated || result?.records?.truncated) || !!queryFields?.partial;
  const issues = result && config ? rendererIssues(definition, result, config) : [];
  return <div className={styles.stack}>
    {fields.length > 0 && <section aria-label="Visualization settings" className={styles.stack}>
      <h3>Visualization settings</h3>
      {!config && <p role="status" className={styles.hint}>Correct the configuration JSON to use these controls.</p>}
      {fields.some(field => field.recordColumn || field.binding) && <p className={styles.hint}>{columns
        ? `Available result fields: ${columns.slice(0, 6).map(column => `${column.key} (${column.type})`).join(", ")}${columns.length > 6 ? ` · ${columns.length - 6} more in suggestions` : ""}${partial ? " · limited result" : ""}.`
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
        // A binding maps a text or number input to a result column. A select chooses from its own options.
        const binding = field.kind === "select" ? undefined : effectiveFieldBinding(field);
        const chosen = typeof current === "string" && current ? columns?.find(column => column.key === current) : undefined;
        const matches = binding ? (columns ?? []).filter(column => binding.types.includes(column.type as WidgetRecordType)) : [];
        const messages = binding ? mappingMessages({ field, binding, entered: current, chosen, columns, partial, unitsKnown: !!result?.records }) : [];
        return <label className={styles.field} key={field.key}>
          {field.label}
          {field.kind === "select" ? <GammaSelect
            aria-label={field.label} disabled={!config}
            value={typeof current === "string" ? current : ""}
            options={[...(field.options ?? [])]}
            onValueChange={next => update(field.key, next)}
          /> : <GammaInput
            aria-label={field.label} disabled={!config} type={field.kind === "number" ? "number" : "text"}
            list={binding && columns ? `${listId}-${field.key}` : undefined}
            value={typeof current === "string" || typeof current === "number" ? current : ""}
            placeholder={field.placeholder ?? (typeof fallback === "string" || typeof fallback === "number" ? `Default: ${fallback}` : undefined)} min={field.min} max={field.max} step={field.step}
            onChange={event => {
              const next = event.target.value;
              update(field.key, next === "" ? undefined : field.kind === "number" ? Number(next) : next);
            }}
          />}
          {binding && columns && <datalist id={`${listId}-${field.key}`}>{matches.map(column => <option key={column.key} value={column.key}>{column.type}</option>)}</datalist>}
          {field.help && <span className={styles.hint}>{field.help}</span>}
          {field.binding && binding && <span className={styles.hint}>{bindingRequirement(field.binding)}</span>}
          {messages.map(message => <span key={message} className={styles.hint}>{message}</span>)}
        </label>;
      })}
    </section>}
    {/* Issues sit outside the field section, so a plugin without guided fields still shows its check. */}
    {issues.length > 0 && <div role="status" aria-live="polite">
      <ul className={styles.hint} aria-label="Configuration issues">
        {issues.map((issue, index) => <li key={`${index}:${issue.message}`}>{issue.message}</li>)}
      </ul>
    </div>}
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
