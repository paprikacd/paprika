import type {
  Dashboard,
  SavedQuery,
  SavedQueryBinding,
  SavedQueryEntry,
} from "./schema";
import { GammaSelect, type GammaSelectOption } from "./gamma/select";
import { savedQueryOption } from "./saved-query-presentation";
import { GammaInput } from "./gamma/input";
import { GammaButton } from "./gamma/button";
import styles from "./explorer.module.css";
import { suggestParameterConnection, type ConnectionContext } from "./query-connections";
import { GraphLabelPicker, SuggestedConnection } from "./query-connection-controls";

export function SavedQueryPicker({
  queries,
  providerId,
  kind,
  value = "",
  onChange,
  disabled,
  label = "Saved query",
  emptyMessage = "No compatible saved queries. Create one in Explore.",
}: {
  queries: SavedQueryEntry[];
  providerId?: string;
  kind: "metrics" | "traces" | "records";
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  emptyMessage?: string | null;
}) {
  const compatible = queries.filter(
    (query) =>
      query.kind === kind && (!providerId || query.providerId === providerId),
  );
  const options: GammaSelectOption[] = compatible.map(savedQueryOption);
  if (value && !compatible.some((query) => query.id === value))
    options.unshift({
      value,
      label: "Unavailable saved query",
      description: "Choose an available query to reconnect this widget.",
      keywords: [],
    });
  return (
    <div className={styles.field}>
      <span>{label}</span>
      <GammaSelect
        aria-label={label}
        value={value}
        options={options}
        onValueChange={onChange}
        disabled={disabled}
        searchable
        placeholder="Choose a saved query"
      />
      {!compatible.length && emptyMessage && (
        <p className={styles.hint}>
          {emptyMessage}
        </p>
      )}
    </div>
  );
}

export function SavedQueryBindingEditor({
  query,
  bindings = [],
  variables = [],
  onChange,
  allowObservation = false,
  disabled = false,
  values,
  fields,
  parentBindings,
}: {
  query: SavedQuery;
  bindings?: SavedQueryBinding[];
  variables?: Dashboard["variables"];
  onChange: (bindings: SavedQueryBinding[]) => void;
  allowObservation?: boolean;
  disabled?: boolean;
  values?: ConnectionContext["values"];
  fields?: ConnectionContext["fields"];
  parentBindings?: ConnectionContext["parentBindings"];
}) {
  function update(parameter: string, next?: SavedQueryBinding) {
    const remaining = bindings.filter(
      (binding) => binding.parameter !== parameter,
    );
    onChange(next ? [...remaining, next] : remaining);
  }
  const extra = bindings.filter(
    (binding) =>
      !query.parameters?.some(
        (parameter) => parameter.name === binding.parameter,
      ),
  );
  const suggestions = (query.parameters ?? []).filter((parameter) => !bindings.some((binding) => binding.parameter === parameter.name)).map((parameter) => ({ parameter, suggestion: suggestParameterConnection(parameter, { variables, values, fields, parentBindings, allowObservation }) }));
  const requiredSuggestions = suggestions.filter(({ parameter, suggestion }) => parameter.defaultValue === undefined && suggestion);
  return (
    <fieldset className={styles.bindingEditor} disabled={disabled}>
      <legend>Parameter bindings</legend>
      {requiredSuggestions.length > 0 && <>
        <GammaButton size="sm" disabled={disabled} onClick={() => onChange([...bindings, ...requiredSuggestions.map(({ suggestion }) => suggestion!.binding)])}>
          Connect {requiredSuggestions.length} matching {requiredSuggestions.length === 1 ? "parameter" : "parameters"}
        </GammaButton>
        <p className={styles.hint}>Uses matching graph connections, labels or dashboard variables. Your existing mappings and saved defaults stay in place.</p>
      </>}
      {!query.parameters?.length && (
        <p className={styles.hint}>This query has no parameters.</p>
      )}
      {query.parameters?.map((parameter) => {
        const binding = bindings.find(
          (item) => item.parameter === parameter.name,
        );
        const mode =
          binding?.source === "field"
            ? binding.field
            : (binding?.source ?? "default");
        const suggestion = suggestions.find((item) => item.parameter.name === parameter.name)?.suggestion;
        const options = [
          {
            value: "default",
            label:
              parameter.defaultValue === undefined
                ? "Choose a value"
                : "Saved default",
          },
          { value: "variable", label: "Dashboard variable" },
          { value: "constant", label: "Fixed value" },
          ...(allowObservation
            ? [
                { value: "label", label: "Observation label" },
                ...(parameter.type === "number"
                  ? [
                      { value: "value", label: "Observation value" },
                      { value: "timestamp", label: "Observation timestamp" },
                    ]
                  : [{ value: "series", label: "Observation series" }]),
              ]
            : []),
        ];
        if (!options.some((option) => option.value === mode))
          options.push({ value: mode, label: "Unavailable binding source" });
        const variableOptions = variables.map((variable) => ({
          value: variable.name,
          label: variable.label || variable.name,
          description: variable.name,
        }));
        if (
          binding?.source === "variable" &&
          !variables.some((variable) => variable.name === binding.variable)
        )
          variableOptions.unshift({
            value: binding.variable,
            label: `${binding.variable || "Choose a variable"} (unavailable)`,
            description: "Declare this variable in Dashboard settings.",
          });
        return (
          <div className={styles.binding} key={parameter.name}>
            <div className={styles.bindingTitle}>
              <strong>{parameter.label || parameter.name}</strong>
              <code>{parameter.name}</code>
              <span>{parameter.type}</span>
            </div>
            <div className={styles.twoColumns}>
              <label className={styles.field}>
                Value from
                <GammaSelect
                  aria-label={`Value for ${parameter.name} from`}
                  value={mode}
                  disabled={disabled}
                  options={options}
                  onValueChange={(source) => {
                    if (source === "default") update(parameter.name);
                    else if (source === "variable")
                      update(parameter.name, {
                        parameter: parameter.name,
                        source,
                        variable:
                          variables.find(
                            (variable) => variable.name === parameter.name,
                          )?.name ??
                          variables[0]?.name ??
                          "",
                      });
                    else if (source === "constant")
                      update(parameter.name, {
                        parameter: parameter.name,
                        source,
                        value:
                          parameter.defaultValue ??
                          (parameter.type === "number" ? 0 : ""),
                      });
                    else if (source === "label")
                      update(parameter.name, {
                        parameter: parameter.name,
                        source,
                        label: parameter.name,
                      });
                    else if (
                      source === "value" ||
                      source === "timestamp" ||
                      source === "series"
                    )
                      update(parameter.name, {
                        parameter: parameter.name,
                        source: "field",
                        field: source,
                      });
                  }}
                />
              </label>
              {binding?.source === "variable" && (
                <label className={styles.field}>
                  Dashboard variable
                  <GammaSelect
                    aria-label={`Dashboard variable for ${parameter.name}`}
                    value={binding.variable}
                    options={variableOptions}
                    disabled={disabled}
                    onValueChange={(variable) =>
                      update(parameter.name, { ...binding, variable })
                    }
                    searchable
                  />
                </label>
              )}
              {binding?.source === "constant" && (
                <label className={styles.field}>
                  Fixed value
                  <GammaInput
                    aria-label={`Fixed value for ${parameter.name}`}
                    inputMode={
                      parameter.type === "number" ? "decimal" : undefined
                    }
                    maxLength={1024}
                    value={String(binding.value)}
                    onChange={(event) => {
                      const text = event.target.value;
                      const value =
                        parameter.type === "number" &&
                        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(
                          text,
                        ) &&
                        Number.isFinite(Number(text))
                          ? Number(text)
                          : text;
                      update(parameter.name, { ...binding, value });
                    }}
                  />
                </label>
              )}
              {binding?.source === "label" && (
                <label className={styles.field}>
                  Label name
                  <GraphLabelPicker
                    label={`Observation label for ${parameter.name}`}
                    value={binding.label}
                    fields={fields}
                    disabled={disabled}
                    onChange={(label) =>
                      update(parameter.name, {
                        ...binding,
                        label,
                      })
                    }
                  />
                </label>
              )}
            </div>
            {suggestion && <SuggestedConnection suggestion={suggestion} disabled={disabled} onUse={() => update(parameter.name, suggestion.binding)} />}
            {!binding && (
              <p className={styles.hint}>
                {parameter.defaultValue === undefined ? (
                  "Required: bind this parameter before running the query."
                ) : (
                  <>
                    Saved default:{" "}
                    <code>{JSON.stringify(parameter.defaultValue)}</code>
                  </>
                )}
              </p>
            )}
            {binding?.source === "variable" &&
              !variables.some(
                (variable) => variable.name === binding.variable,
              ) && (
                <p className={styles.error}>
                  This dashboard variable is unavailable. Declare it in
                  Dashboard settings or choose another value.
                </p>
              )}
            {binding?.source === "field" && binding.field === "timestamp" && (
              <p className={styles.hint}>
                Unix seconds from the selected observation, including fractional
                seconds.
              </p>
            )}
            {binding?.source === "label" && (
              <p className={styles.hint}>
                Uses the exact label on the selected observation. A missing
                label shows an error without running a query.
              </p>
            )}
          </div>
        );
      })}
      {extra.map((binding) => (
        <div key={binding.parameter} className={styles.binding}>
          <p className={styles.error}>
            Parameter “{binding.parameter}” no longer exists in this saved
            query.
          </p>
          <GammaButton size="sm" onClick={() => update(binding.parameter)}>
            Remove obsolete binding
          </GammaButton>
        </div>
      ))}
    </fieldset>
  );
}
