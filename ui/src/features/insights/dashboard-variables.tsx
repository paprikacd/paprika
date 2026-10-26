"use client";

import { useId, useState } from "react";
import { Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { GammaInput } from "./gamma/input";
import { GammaSwitch } from "./gamma/switch";
import { GammaSelect } from "./gamma/select";
import {
  dashboardSchema,
  MAX_DASHBOARD_VARIABLES,
  MAX_VARIABLE_OPTIONS,
  MAX_VARIABLE_VALUE_LENGTH,
  type Dashboard,
  type DashboardVariable,
} from "./schema";
import { resolveDashboardVariables, type VariableValues } from "./drilldown";
import styles from "./drilldown.module.css";
import optionStyles from "./variable-options.module.css";

export interface DashboardVariablesEditorProps {
  dashboard: Dashboard;
  onApply: (dashboard: Dashboard) => void;
}

export function DashboardVariablesEditor(props: DashboardVariablesEditorProps) {
  return <VariablesEditor key={props.dashboard.id} {...props} />;
}

function VariablesEditor({
  dashboard,
  onApply,
}: DashboardVariablesEditorProps) {
  const source = JSON.stringify(dashboard.variables ?? []);
  const [state, setState] = useState(() => ({
    source,
    draft: dashboard.variables ?? [],
  }));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const draft = state.draft;
  const serialized = JSON.stringify(draft);
  // Adopt a successfully applied draft once the parent has published it. Other
  // external edits remain explicit, so a refresh cannot erase local typing.
  if (source !== state.source && source === serialized)
    setState({ source, draft });
  const stale = source !== state.source && source !== serialized;
  const dirty = source !== serialized;
  function edit(next: DashboardVariable[]) {
    setState((previous) => ({ ...previous, draft: next }));
    setError("");
    setSaved(false);
  }
  function patch(index: number, value: DashboardVariable) {
    edit(
      draft.map((variable, current) => (current === index ? value : variable)),
    );
  }
  function apply() {
    if (stale) return;
    const next = { ...dashboard };
    if (draft.length) next.variables = draft;
    else delete next.variables;
    const checked = dashboardSchema.safeParse(next);
    if (!checked.success) {
      setError(
        checked.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" · "),
      );
      return;
    }
    onApply(checked.data);
    setError("");
    setSaved(true);
  }
  return (
    <section
      className={styles.editor}
      aria-label="Dashboard variable declarations"
    >
      <div className={styles.sectionHeading}>
        <SlidersHorizontal size={15} aria-hidden="true" />
        <h3>Dashboard variables</h3>
        <span>
          {draft.length}/{MAX_DASHBOARD_VARIABLES}
        </span>
      </div>
      <p className={styles.help}>
        Declare values that people or dashboard links can set. Use{" "}
        <code>{"{{service}}"}</code> in a query as a complete string value,
        without surrounding quotes.
      </p>
      {!draft.length && (
        <p className={styles.help}>
          No variables yet. Add a variable such as <code>service</code> to
          filter this dashboard.
        </p>
      )}
      {draft.map((variable, index) => (
        <fieldset className={styles.card} key={index}>
          <legend>Variable {index + 1}</legend>
          <div className={styles.bindingTop}>
            <label className={styles.field}>
              <span>Variable name</span>
              <GammaInput
                aria-label={`Variable ${index + 1} name`}
                value={variable.name}
                maxLength={64}
                placeholder="service"
                onChange={(event) =>
                  patch(index, { ...variable, name: event.target.value })
                }
              />
            </label>
            <GammaButton iconOnly
              variant="ghost"
              size="sm"
              aria-label={`Remove variable ${index + 1}`}
              onClick={() =>
                edit(draft.filter((_, current) => current !== index))
              }
            >
              <Trash2 size={14} aria-hidden="true" />
            </GammaButton>
          </div>
          <label className={styles.field}>
            <span>
              Display label <small>Optional</small>
            </span>
            <GammaInput
              aria-label={`Variable ${index + 1} display label`}
              value={variable.label ?? ""}
              maxLength={80}
              placeholder="Service"
              onChange={(event) => {
                const next = { ...variable };
                if (event.target.value) next.label = event.target.value;
                else delete next.label;
                patch(index, next);
              }}
            />
          </label>
          <label className={styles.field}>
            <span>Control</span>
            <GammaSelect
              aria-label={`Variable ${index + 1} control`}
              value={variable.options ? "dropdown" : "text"}
              options={[{ value: "text", label: "Text input" }, { value: "dropdown", label: "Dropdown" }]}
              onValueChange={(control) => {
                if (control === (variable.options ? "dropdown" : "text")) return;
                const next = { ...variable };
                if (control === "dropdown") next.options = [variable.defaultValue ?? ""];
                else delete next.options;
                patch(index, next);
              }}
            />
          </label>
          {variable.options && <fieldset className={optionStyles.options}>
            <legend>Dropdown choices</legend>
            <p className={styles.help}>Selecting a choice refreshes the connected widgets. Dashboard links can also supply another value.</p>
            {variable.options.map((option, optionIndex) => <div className={optionStyles.row} key={optionIndex}>
              <GammaInput
                aria-label={`Variable ${index + 1} option ${optionIndex + 1}`}
                value={option}
                maxLength={MAX_VARIABLE_VALUE_LENGTH}
                placeholder="Service name"
                onChange={(event) => patch(index, { ...variable, options: variable.options!.map((value, current) => current === optionIndex ? event.target.value : value) })}
              />
              <GammaButton iconOnly variant="ghost" size="sm" disabled={variable.options!.length === 1}
                aria-label={`Remove variable ${index + 1} option ${optionIndex + 1}`}
                onClick={() => patch(index, { ...variable, options: variable.options!.filter((_, current) => current !== optionIndex) })}>
                <Trash2 size={14} aria-hidden="true" />
              </GammaButton>
            </div>)}
            <GammaButton size="sm" disabled={variable.options.length >= MAX_VARIABLE_OPTIONS}
              onClick={() => patch(index, { ...variable, options: [...variable.options!, ""] })}>
              <Plus size={13} aria-hidden="true" /> Add choice
            </GammaButton>
          </fieldset>}
          <GammaSwitch
            label="Use a default value"
            description="Used when a dashboard link or viewer does not supply a value."
            checked={variable.defaultValue !== undefined}
            onChange={(checked) => {
              const next = { ...variable };
              if (checked) next.defaultValue = "";
              else delete next.defaultValue;
              patch(index, next);
            }}
          />
          {variable.defaultValue !== undefined && (
            <label className={styles.field}>
              <span>Default value</span>
              <GammaInput
                aria-label={`Variable ${index + 1} default value`}
                value={variable.defaultValue}
                maxLength={MAX_VARIABLE_VALUE_LENGTH}
                placeholder="An empty string is a valid default"
                onChange={(event) =>
                  patch(index, {
                    ...variable,
                    defaultValue: event.target.value,
                  })
                }
              />
            </label>
          )}
        </fieldset>
      ))}
      {stale && (
        <div className={styles.notice} role="alert">
          <p>
            These variable declarations changed elsewhere. Reload them before
            applying your edits.
          </p>
          <GammaButton
            size="sm"
            onClick={() => {
              setState({ source, draft: dashboard.variables ?? [] });
              setError("");
              setSaved(false);
            }}
          >
            Reload variables
          </GammaButton>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <GammaButton
          size="sm"
          disabled={draft.length >= MAX_DASHBOARD_VARIABLES || stale}
          onClick={() => {
            let index = 1;
            while (
              draft.some((variable) => variable.name === `variable_${index}`)
            )
              index++;
            edit([...draft, { name: `variable_${index}` }]);
          }}
        >
          <Plus size={13} aria-hidden="true" /> Add variable
        </GammaButton>
        <GammaButton
          size="sm"
          variant="primary"
          disabled={!dirty || stale}
          onClick={apply}
        >
          Apply variables
        </GammaButton>
      </div>
      {saved && (
        <p className={styles.help} role="status">
          Variable declarations applied. Save the dashboard to keep them.
        </p>
      )}
      <p className={styles.help}>
        Names use letters, numbers and underscores, starting with a letter or
        underscore. Renaming or removing a variable does not rewrite queries or
        incoming links.
      </p>
    </section>
  );
}

export interface VariableBarProps {
  dashboard: Dashboard;
  values: VariableValues;
  onApply: (values: VariableValues) => void;
}

export function VariableBar(props: VariableBarProps) {
  if (!props.dashboard.variables?.length) return null;
  // Declarations reset the editor, but value changes keep dropdown triggers
  // mounted so selecting a filter preserves keyboard focus.
  const revision = JSON.stringify([
    props.dashboard.id,
    props.dashboard.variables,
  ]);
  return <VariableBarDraft key={revision} {...props} />;
}

function VariableBarDraft({ dashboard, values, onApply }: VariableBarProps) {
  const id = useId();
  const initial = resolveDashboardVariables(dashboard, values);
  const source = JSON.stringify(Object.entries(initial).sort(([a], [b]) => a.localeCompare(b)));
  const [state, setState] = useState<{ source: string; draft: VariableValues; pendingSource?: string }>(() => ({ source, draft: initial }));
  if (source !== state.source) setState({ source, draft: source === state.pendingSource ? state.draft : initial });
  const draft = state.draft;
  function setDraft(next: VariableValues | ((previous: VariableValues) => VariableValues)) {
    setState((previous) => ({ ...previous, draft: typeof next === "function" ? next(previous.draft) : next }));
  }
  const [error, setError] = useState("");
  const dirty = (dashboard.variables ?? []).some(
    ({ name }) => draft[name] !== initial[name],
  );
  const hasTextInputs = dashboard.variables?.some((variable) => !variable.options);
  function apply(next: VariableValues) {
    try {
      onApply(resolveDashboardVariables(dashboard, next));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the variable values");
    }
  }
  return (
    <form
      noValidate
      className={styles.variableBar}
      aria-label="Dashboard variables"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        apply(draft);
      }}
    >
      <div className={styles.barFields}>
        {dashboard.variables?.map((variable) => (
          <label
            className={styles.barField}
            key={variable.name}
            htmlFor={`${id}-${variable.name}`}
          >
            <span title={variable.name}>{variable.label || variable.name}</span>
            {variable.options ? <VariableDropdown
              variable={variable}
              id={`${id}-${variable.name}`}
              value={draft[variable.name]}
              onChange={(value) => {
                const next = { ...initial, [variable.name]: value };
                setState((previous) => ({
                  ...previous,
                  draft: { ...previous.draft, [variable.name]: value },
                  pendingSource: JSON.stringify(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))),
                }));
                apply(next);
              }}
            /> : <GammaInput
              id={`${id}-${variable.name}`}
              size="sm"
              value={draft[variable.name] ?? ""}
              maxLength={MAX_VARIABLE_VALUE_LENGTH}
              placeholder="Set a value"
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  [variable.name]: event.target.value,
                }));
                setError("");
              }}
            />}
          </label>
        ))}
      </div>
      {hasTextInputs && <div className={styles.barActions}>
        <GammaButton
          type="submit"
          size="sm"
          variant="primary"
          disabled={!dirty}
        >
          Apply values
        </GammaButton>
        {dirty && (
          <GammaButton
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(initial);
              setError("");
            }}
          >
            Reset values
          </GammaButton>
        )}
      </div>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </form>
  );
}

/** Keep externally supplied values visible without altering the saved choices. */
function VariableDropdown({ variable, value, id, onChange }: {
  variable: DashboardVariable; value?: string; id: string; onChange: (value: string) => void;
}) {
  const choices = [...variable.options!];
  if (value !== undefined && !choices.includes(value)) choices.push(value);
  const selected = value === undefined ? -1 : choices.indexOf(value);
  return <GammaSelect
    id={id}
    size="sm"
    aria-label={variable.label || variable.name}
    value={selected < 0 ? "" : String(selected)}
    placeholder="Choose a value"
    searchable={choices.length > 8}
    options={choices.map((choice, index) => ({
      value: String(index), label: choice || "Empty value",
      description: index >= variable.options!.length ? "Value from dashboard link" : undefined,
    }))}
    onValueChange={(index) => { if (Number(index) !== selected) onChange(choices[Number(index)]); }}
  />;
}
