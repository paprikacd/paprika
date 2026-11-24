"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { GammaInput } from "./gamma/input";
import { GammaSwitch } from "./gamma/switch";
import { lockBodyScroll } from "./gamma/scroll-lock";
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
import { singleValueText, sameVariableValue, formatVariableValue, type VariableValue } from "./variable-values";
import { GammaMultiSelect } from "./gamma/multi-select";
import styles from "./drilldown.module.css";
import optionStyles from "./variable-options.module.css";
import { SearchCombobox, type SearchComboboxOption } from "./gamma/search-combobox";
import {
  VariableSourceFields,
  sourceFor,
  valuesFromOf,
  type VariableSourceCatalog,
  type VariableValuesFrom,
} from "./variable-source-editor";
import {
  useVariableOptions,
  type VariableOptionsSnapshot,
  type VariableRange,
  type VariableValueLoaders,
} from "./variable-options";

export interface DashboardVariablesEditorProps {
  dashboard: Dashboard;
  onApply: (dashboard: Dashboard) => void;
  /** Providers, label names, saved queries and the value loaders the source fields read. Without it, sources are not offered. */
  catalog?: VariableSourceCatalog;
}

export function DashboardVariablesEditor(props: DashboardVariablesEditorProps) {
  return <VariablesEditor key={props.dashboard.id} {...props} />;
}

const VALUES_FROM: { value: VariableValuesFrom; label: string }[] = [
  { value: "text", label: "Free text" },
  { value: "typed", label: "Typed list" },
  { value: "labelValues", label: "Provider label values" },
  { value: "savedQuery", label: "Saved query column" },
];

function VariablesEditor({
  dashboard,
  onApply,
  catalog,
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
            <span>Values from</span>
            <GammaSelect
              aria-label={`Variable ${index + 1} values from`}
              value={valuesFromOf(variable)}
              options={VALUES_FROM.map((item) => ({ value: item.value, label: item.label }))}
              onValueChange={(choice) => {
                const from = choice as VariableValuesFrom;
                if (from === valuesFromOf(variable)) return;
                const next = { ...variable };
                delete next.source;
                if (from === "text") delete next.options;
                else if (from === "typed") next.options = variable.options ?? [singleValueText(variable.defaultValue) ?? ""];
                else next.source = sourceFor(from);
                patch(index, next);
              }}
            />
          </label>
          {(valuesFromOf(variable) === "labelValues" || valuesFromOf(variable) === "savedQuery") && (catalog
            ? <VariableSourceFields
                index={index}
                variable={variable}
                defaults={Object.fromEntries(draft.flatMap((other, otherIndex) => other.name && other.defaultValue !== undefined && otherIndex !== index ? [[other.name, other.defaultValue]] : []))}
                catalog={catalog}
                onChange={(next) => patch(index, next)}
              />
            : <p className={styles.help} role="status">Values from a source are unavailable here. The fallback choices still apply.</p>)}
          {variable.options && <fieldset className={optionStyles.options}>
            <legend>{variable.source ? "Fallback choices" : "Dropdown choices"}</legend>
            <p className={styles.help}>{variable.source
              ? "Shown when the source cannot load values. Choices are never silently replaced."
              : "Selecting a choice refreshes the connected widgets. Dashboard links can also supply another value."}</p>
            {variable.options.map((option, optionIndex) => <div className={optionStyles.row} key={optionIndex}>
              <GammaInput
                aria-label={`Variable ${index + 1} option ${optionIndex + 1}`}
                value={option}
                maxLength={MAX_VARIABLE_VALUE_LENGTH}
                placeholder="Service name"
                onChange={(event) => patch(index, { ...variable, options: variable.options!.map((value, current) => current === optionIndex ? event.target.value : value) })}
              />
              <GammaButton iconOnly variant="ghost" size="sm" disabled={variable.options!.length === 1 && !variable.source}
                aria-label={`Remove variable ${index + 1} option ${optionIndex + 1}`}
                onClick={() => {
                  // A sourced variable with its last fallback choice drops the list rather than leaving an empty one.
                  if (variable.options!.length === 1) { const next = { ...variable }; delete next.options; patch(index, next); return; }
                  patch(index, { ...variable, options: variable.options!.filter((_, current) => current !== optionIndex) });
                }}>
                <Trash2 size={14} aria-hidden="true" />
              </GammaButton>
            </div>)}
            <GammaButton size="sm" disabled={variable.options.length >= MAX_VARIABLE_OPTIONS}
              onClick={() => patch(index, { ...variable, options: [...variable.options!, ""] })}>
              <Plus size={13} aria-hidden="true" /> Add choice
            </GammaButton>
          </fieldset>}
          {valuesFromOf(variable) !== "text" && !variable.options && variable.source && <div className={optionStyles.options}>
            <GammaButton size="sm" onClick={() => patch(index, { ...variable, options: [singleValueText(variable.defaultValue) ?? ""] })}>
              <Plus size={13} aria-hidden="true" /> Add fallback choices
            </GammaButton>
          </div>}
          <GammaSwitch
            label="Allow several values"
            description="Viewers pick one or more values, and queries receive them as a list."
            checked={Boolean(variable.multi)}
            onChange={(checked) => {
              const next = { ...variable };
              if (checked) next.multi = true;
              else {
                delete next.multi;
                delete next.allowAll;
                if (Array.isArray(next.defaultValue)) delete next.defaultValue;
              }
              patch(index, next);
            }}
          />
          {variable.multi && <GammaSwitch
            label="Include All"
            description="Adds an All choice. After =~ it matches every value; in a SQL array it binds NULL."
            checked={Boolean(variable.allowAll)}
            onChange={(checked) => {
              const next = { ...variable };
              if (checked) next.allowAll = true;
              else delete next.allowAll;
              if (!checked && Array.isArray(next.defaultValue) && next.defaultValue.length === 0) delete next.defaultValue;
              patch(index, next);
            }}
          />}
          <GammaSwitch
            label="Use a default value"
            description="Used when a dashboard link or viewer does not supply a value."
            checked={variable.defaultValue !== undefined}
            onChange={(checked) => {
              const next = { ...variable };
              if (checked) next.defaultValue = variable.multi ? (variable.allowAll ? [] : [variable.options?.[0] ?? ""]) : "";
              else delete next.defaultValue;
              patch(index, next);
            }}
          />
          {variable.multi && Array.isArray(variable.defaultValue) && variable.options && <GammaMultiSelect
            aria-label={`Variable ${index + 1} default values`}
            values={variable.defaultValue}
            allowAll={Boolean(variable.allowAll)}
            options={variable.options.map((choice) => ({ value: choice, label: choice || "Empty value" }))}
            onValuesChange={(next) => patch(index, { ...variable, defaultValue: next })}
          />}
          {variable.defaultValue !== undefined && !Array.isArray(variable.defaultValue) && (
            <label className={styles.field}>
              <span>Default value</span>
              <GammaInput
                aria-label={`Variable ${index + 1} default value`}
                value={singleValueText(variable.defaultValue) ?? ""}
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
          Update variables
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
  /** `sheet` stacks the fields full width inside the phone variables sheet. */
  layout?: "bar" | "sheet";
  /** Reports whether an unapplied text draft exists. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Loads values for variables with a source. Without them, sourced variables report that values are unavailable. */
  loaders?: VariableValueLoaders;
  /** The dashboard's current view range in seconds, which label values and saved queries cover. */
  range?: VariableRange;
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

function VariableBarDraft({ dashboard, values, onApply, loaders, range, layout = "bar", onDirtyChange }: VariableBarProps) {
  const id = useId();
  const initial = resolveDashboardVariables(dashboard, values);
  const source = JSON.stringify(Object.entries(initial).sort(([a], [b]) => a.localeCompare(b)));
  const [draft, setDraft] = useState<VariableValues>(initial);
  // Set by our own dropdown change: its values are already in the draft when the parent publishes them.
  const publishing = useRef<string | undefined>(undefined);
  const adopted = useRef(source);
  // Adopt externally changed values once the change has committed. A layout effect runs before paint,
  // so the stale draft is never shown.
  useLayoutEffect(() => {
    if (adopted.current === source) return;
    adopted.current = source;
    if (source !== publishing.current) setDraft(initial);
    publishing.current = undefined;
  }, [source, initial]);
  const [error, setError] = useState("");
  const options = useVariableOptions({
    variables: dashboard.variables ?? [],
    values: initial,
    range: range ?? { start: 0, end: 0 },
    loaders,
  });
  const dirty = (dashboard.variables ?? []).some(
    ({ name }) => !sameChoice(draft[name], initial[name]),
  );
  // A typed value stages until Update view, and so does a sourced variable that accepts typing beside its list.
  const hasTextInputs = dashboard.variables?.some((variable) => !variable.options || Boolean(variable.source));
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange]);
  function apply(next: VariableValues) {
    try {
      onApply(resolveDashboardVariables(dashboard, next));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the variable values");
    }
  }
  // Inside the sheet the dialog is already named "Dashboard variables", so the form is not named a second time.
  const sheet = layout === "sheet";
  function choose(name: string, value: VariableValue) {
    const next = { ...initial, [name]: value };
    publishing.current = JSON.stringify(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    setDraft((previous) => ({ ...previous, [name]: value }));
    apply(next);
  }
  return (
    <form
      noValidate
      className={styles.variableBar}
      data-layout={sheet ? "sheet" : undefined}
      aria-label={sheet ? undefined : "Dashboard variables"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        apply(draft);
      }}
    >
      <div className={styles.barFields}>
        {dashboard.variables?.map((variable) => {
          const fieldId = `${id}-${variable.name}`;
          if (variable.source) {
            return <VariableSourceField
              key={variable.name}
              variable={variable}
              parentLabel={(name) => {
                const parent = dashboard.variables?.find((item) => item.name === name);
                return parent?.label || name;
              }}
              id={fieldId}
              value={draft[variable.name]}
              snapshot={options.snapshot(variable.name)}
              onActivate={() => options.activate(variable.name)}
              onRetry={() => options.retry(variable.name)}
              onChoose={(value) => choose(variable.name, value)}
              onType={(value) => {
                setDraft((previous) => ({ ...previous, [variable.name]: value }));
                setError("");
              }}
            />;
          }
          return <label
            className={styles.barField}
            key={variable.name}
            htmlFor={fieldId}
          >
            <span title={variable.name}>{variable.label || variable.name}</span>
            {variable.options ? <VariableDropdown
              variable={variable}
              id={fieldId}
              value={draft[variable.name]}
              onChange={(value) => choose(variable.name, value)}
            /> : <GammaInput
              id={fieldId}
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
          </label>;
        })}
      </div>
      {hasTextInputs && <div className={styles.barActions}>
        <GammaButton
          type="submit"
          size="sm"
          variant="primary"
          disabled={!dirty}
        >
          Update view
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

/** Two equal choices, or two unset ones. A list compares by its items and order. */
function sameChoice(left: VariableValue | undefined, right: VariableValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameVariableValue(left, right);
}

/** Keep externally supplied values visible without altering the saved choices. */
function VariableDropdown({ variable, value, id, onChange }: {
  variable: DashboardVariable; value?: VariableValue; id: string; onChange: (value: VariableValue) => void;
}) {
  if (variable.multi) {
    const picked = value === undefined ? [] : Array.isArray(value) ? value : [value];
    return <GammaMultiSelect
      id={id}
      size="sm"
      aria-label={variable.label || variable.name}
      values={picked}
      allowAll={Boolean(variable.allowAll)}
      options={variable.options!.map((choice) => ({ value: choice, label: choice || "Empty value" }))}
      onValuesChange={(next) => onChange(next)}
    />;
  }
  const text = singleValueText(value);
  const choices = [...variable.options!];
  if (text !== undefined && !choices.includes(text)) choices.push(text);
  const selected = text === undefined ? -1 : choices.indexOf(text);
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

/**
 * The phone toolbar's variables control: a summary chip that opens the variables sheet. The bar inside the sheet
 * stays mounted while the sheet is closed, so an unapplied text draft survives closing it.
 */
export function PhoneVariables({ dashboard, values, onApply, loaders, range }: VariableBarProps) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  if (!dashboard.variables?.length) return null;
  const resolved = resolveDashboardVariables(dashboard, values);
  const shownValues = dashboard.variables.map(({ name }) => {
    const value = resolved[name];
    return value === undefined ? "Empty value" : formatVariableValue(value) || "Empty value";
  });
  const summary = shownValues.join(" · ");
  // Screen readers get each variable's label with its value, so the names are not read as one list of unlabelled values.
  const accessibleSummary = dashboard.variables.map(({ name, label }, index) => `${label || name} ${shownValues[index]}`).join(", ");
  return (
    <>
      <VariableSummaryButton
        buttonRef={chip}
        summary={summary}
        accessibleSummary={accessibleSummary}
        dirty={dirty}
        expanded={open}
        onOpen={() => setOpen(true)}
      />
      <VariableSheet open={open} onClose={() => setOpen(false)} returnFocus={chip}>
        <VariableBar
          dashboard={dashboard}
          values={values}
          onApply={onApply}
          loaders={loaders}
          range={range}
          layout="sheet"
          onDirtyChange={setDirty}
        />
      </VariableSheet>
    </>
  );
}

/** The chip shows the values in use. Its accessible name also says when a draft is not applied yet. */
export function VariableSummaryButton({ buttonRef, summary, accessibleSummary, dirty, expanded, onOpen }: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  summary: string;
  accessibleSummary: string;
  dirty: boolean;
  expanded: boolean;
  onOpen: () => void;
}) {
  return (
    <GammaButton
      ref={buttonRef}
      size="sm"
      variant="secondary"
      className={styles.variableSummary}
      aria-label={`Dashboard variables: ${accessibleSummary}${dirty ? ", unapplied changes" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <SlidersHorizontal size={14} aria-hidden="true" />
      <span className={styles.variableSummaryText} aria-hidden="true">{summary}</span>
      {dirty && <span className={styles.variableDirty} aria-hidden="true" />}
    </GammaButton>
  );
}

/**
 * A native modal bottom sheet. It is always mounted, so its children keep their state while it is closed. Escape,
 * Done and a backdrop tap close it, and focus returns to the chip that opened it.
 */
export function VariableSheet({ open, onClose, returnFocus, children }: {
  open: boolean;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      if (element.open) {
        element.close();
        returnFocus.current?.focus({ preventScroll: true });
      }
      return;
    }
    element.showModal();
    const unlock = lockBodyScroll();
    const first = element.querySelector<HTMLElement>("form [role='combobox'], form input") ?? element.querySelector<HTMLElement>("button");
    first?.focus({ preventScroll: true });
    return unlock;
  }, [open, returnFocus]);
  return (
    <dialog
      ref={dialog}
      className={styles.variableSheet}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the dialog element itself is on the backdrop; the sheet body covers the rest.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.sheetBody}>
        <div className={styles.sheetHeader}>
          <h2 id={titleId}>Dashboard variables</h2>
          <GammaButton size="sm" variant="primary" onClick={onClose}>Done</GammaButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/**
 * A variable whose values come from a source. Free text is accepted when there are no saved choices,
 * and a dropdown applies its selection at once. Failures keep the saved choices and offer a retry.
 */
/** The error class or message for a failed source, bounded so it fits beside the field. */
function shortSourceError(error: string | undefined): string {
  const text = (error ?? "").trim();
  if (!text) return "the source did not answer";
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function VariableSourceField({ variable, parentLabel, id, value, snapshot, onActivate, onRetry, onChoose, onType }: {
  variable: DashboardVariable;
  parentLabel: (name: string) => string;
  id: string;
  value?: VariableValue;
  snapshot: VariableOptionsSnapshot | undefined;
  onActivate: () => void;
  onRetry: () => void;
  onChoose: (value: VariableValue) => void;
  onType: (value: string) => void;
}) {
  const label = variable.label || variable.name;
  const freeText = !variable.options;
  const state = snapshot?.state ?? "idle";
  const known = state === "ready" || state === "empty";
  const fallback = state === "failed" && variable.options;
  const choices: SearchComboboxOption[] = [];
  if (state === "ready") {
    for (const item of snapshot!.values) choices.push({ value: item, label: item || "Empty value" });
  } else if (fallback) {
    for (const item of variable.options!) choices.push({ value: item, label: item || "Empty value", description: "Saved choice" });
  }
  const text = singleValueText(value);
  if (text !== undefined && !choices.some((choice) => choice.value === text))
    choices.push({ value: text, label: text || "Empty value", description: known ? "Not in current values" : undefined });
  // Values a viewer picks from the loaded list or the saved fallback apply at once; anything typed stages until Update view.
  const listed = new Set(state === "ready" ? snapshot!.values : fallback ? variable.options! : []);
  const emptyMessage = state === "needs_variable"
    ? `Set ${parentLabel(snapshot!.parent!)} to load values`
    : state === "failed" || state === "invalid" ? "Could not load values" : "No values in this time range";
  let status = "";
  let retryable = false;
  if (state === "needs_variable") status = `Set ${parentLabel(snapshot!.parent!)} to load values`;
  else if (state === "empty") status = "No values in this time range";
  else if (state === "invalid") status = `Could not load values: ${shortSourceError(snapshot!.error)}. Fix the source in the editor.`;
  else if (state === "failed") {
    status = `Could not load values: ${shortSourceError(snapshot!.error)}`;
    retryable = true;
  }
  else if (state === "ready" && snapshot!.truncated) status = `First ${snapshot!.values.length} values; type to enter another`;
  if (variable.multi) return <div className={styles.barField}>
    <label htmlFor={id}>
      <span title={variable.name}>{label}</span>
    </label>
    {/* Several values are picked from the list only; typed values are not offered for a multi-value variable. */}
    <GammaMultiSelect
      id={id}
      aria-label={label}
      values={Array.isArray(value) ? value : []}
      allowAll={Boolean(variable.allowAll)}
      options={choices.map((choice) => ({ value: choice.value, label: choice.label, description: choice.description }))}
      onOpen={onActivate}
      onValuesChange={(next) => onChoose(next)}
    />
    {status && <p
      className={styles.help}
      role={state === "failed" || state === "invalid" ? "alert" : "status"}
    >
      {status}
      {retryable && <>
        {" "}
        <GammaButton size="sm" onClick={onRetry}>Retry</GammaButton>
      </>}
    </p>}
  </div>;
  return <div className={styles.barField}>
    <label htmlFor={id}>
      <span title={variable.name}>{label}</span>
    </label>
    <SearchCombobox
      id={id}
      aria-label={label}
      options={choices}
      value={text ?? null}
      clearable={false}
      placeholder={freeText ? "Set a value" : "Choose a value"}
      filter={state === "ready" || Boolean(fallback)}
      loading={state === "loading"}
      loadingMessage="Loading values…"
      emptyMessage={emptyMessage}
      onOpenChange={(open) => { if (open) onActivate() }}
      onValueChange={(next) => { if (next === null) return; if (listed.has(next)) onChoose(next); else onType(next) }}
      onQueryInput={onType}
    />
    {status && <p
      className={styles.help}
      role={state === "failed" || state === "invalid" ? "alert" : "status"}
    >
      {status}
      {retryable && <>
        {" "}
        <GammaButton size="sm" onClick={onRetry}>Retry</GammaButton>
      </>}
    </p>}
  </div>;
}
