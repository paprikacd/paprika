"use client";

import {
  lazy,
  Suspense,
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
import { rewriteVariableReferences, variableReferences } from "./variable-references";
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

/**
 * A card keeps its key across edits, so removing one card leaves the inputs below it in place. `original` is the name
 * the variable had when it was last applied, so a rename is visible and its references can follow it.
 */
interface VariableCard {
  key: string;
  original?: string;
}
let variableCardSeed = 0;
const newCard = (original?: string): VariableCard => ({ key: `variable-card-${++variableCardSeed}`, original });

function VariablesEditor({
  dashboard,
  onApply,
  catalog,
}: DashboardVariablesEditorProps) {
  const source = JSON.stringify(dashboard.variables ?? []);
  const [state, setState] = useState(() => ({
    source,
    draft: dashboard.variables ?? [],
    cards: (dashboard.variables ?? []).map((variable) => newCard(variable.name)),
  }));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [renameReferences, setRenameReferences] = useState(true);
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const draft = state.draft;
  const cards = state.cards;
  const serialized = JSON.stringify(draft);
  // Adopt a successfully applied draft once the parent has published it. Other
  // external edits remain explicit, so a refresh cannot erase local typing.
  if (source !== state.source && source === serialized)
    setState({ source, draft, cards });
  const stale = source !== state.source && source !== serialized;
  const dirty = source !== serialized;
  function edit(next: DashboardVariable[], nextCards?: VariableCard[]) {
    setState((previous) => ({ ...previous, draft: next, cards: nextCards ?? previous.cards }));
    setError("");
    setSaved(false);
    setPendingRemoval(undefined);
  }
  function patch(index: number, value: DashboardVariable) {
    edit(
      draft.map((variable, current) => (current === index ? value : variable)),
    );
  }
  function remove(index: number) {
    edit(
      draft.filter((_, current) => current !== index),
      cards.filter((_, current) => current !== index),
    );
  }
  /** Widgets that read the variable as it was last applied. A variable not yet applied has no readers. */
  function readers(card: VariableCard | undefined) {
    if (card?.original === undefined) return [];
    return variableReferences(dashboard, card.original).flatMap((use) => (use.kind === "widget" ? [use.widgetTitle] : []));
  }
  function apply() {
    if (stale) return;
    const renames: Record<string, string> = {};
    if (renameReferences)
      cards.forEach((card, index) => {
        const name = draft[index]?.name;
        if (card.original !== undefined && name && name !== card.original) renames[card.original] = name;
      });
    const next = { ...dashboard };
    if (draft.length) next.variables = draft;
    else delete next.variables;
    const checked = dashboardSchema.safeParse(rewriteVariableReferences(next, renames));
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
    setState((previous) => ({ ...previous, cards: previous.cards.map((card, index) => ({ key: card.key, original: draft[index]?.name })) }));
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
      {draft.map((variable, index) => {
        const card = cards[index];
        const readerTitles = readers(card);
        const renamed = card?.original !== undefined && card.original !== variable.name && readerTitles.length > 0;
        return (
        <fieldset className={styles.card} key={card?.key ?? index}>
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
              onClick={() => {
                if (readerTitles.length) setPendingRemoval(card.key);
                else remove(index);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
            </GammaButton>
          </div>
          <p className={styles.help} role="status">
            {readerTitles.length === 0
              ? "Not used yet"
              : `Used by ${readerTitles.length} ${readerTitles.length === 1 ? "widget" : "widgets"}: ${readerTitles.slice(0, 3).join(", ")}${readerTitles.length > 3 ? ` and ${readerTitles.length - 3} more` : ""}`}
          </p>
          {renamed && (
            <GammaSwitch
              label="Rename references too"
              description="Update this dashboard's queries and bindings to the new name."
              checked={renameReferences}
              onChange={setRenameReferences}
            />
          )}
          {pendingRemoval === card?.key && (
            <div className={styles.notice} role="alert">
              <p>{`Removing ${variable.name || "this variable"} leaves {{${card?.original ?? variable.name}}} in ${readerTitles.length === 1 ? "one widget" : `${readerTitles.length} widgets`}. Remove it anyway?`}</p>
              <div className={styles.actions}>
                <GammaButton size="sm" variant="secondary" onClick={() => remove(index)}>Remove variable</GammaButton>
                <GammaButton size="sm" variant="quiet" onClick={() => setPendingRemoval(undefined)}>Keep</GammaButton>
              </div>
            </div>
          )}
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
                else if (from === "typed") next.options = variable.options ?? [variable.defaultValue ?? ""];
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
            <GammaButton size="sm" onClick={() => patch(index, { ...variable, options: [variable.defaultValue ?? ""] })}>
              <Plus size={13} aria-hidden="true" /> Add fallback choices
            </GammaButton>
          </div>}
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
        );
      })}
      {stale && (
        <div className={styles.notice} role="alert">
          <p>
            These variable declarations changed elsewhere. Reload them before
            applying your edits.
          </p>
          <GammaButton
            size="sm"
            onClick={() => {
              setState({ source, draft: dashboard.variables ?? [], cards: (dashboard.variables ?? []).map((variable) => newCard(variable.name)) });
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
            edit([...draft, { name: `variable_${index}` }], [...cards, newCard()]);
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
        underscore. Renaming updates this dashboard&apos;s queries and bindings. Links from other dashboards keep the old name.
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
  /** Set only while the dashboard is being edited. It adds a Filter action that declares a variable inline. */
  onDeclareVariable?: (variable: DashboardVariable) => void;
}

// Loaded on demand: the declaration form stays out of the first view.
const VariableQuickCreate = lazy(() => import("./variable-quick-create"));

export function VariableBar(props: VariableBarProps) {
  if (!props.dashboard.variables?.length && !props.onDeclareVariable) return null;
  // Declarations reset the editor, but value changes keep dropdown triggers
  // mounted so selecting a filter preserves keyboard focus.
  const revision = JSON.stringify([
    props.dashboard.id,
    props.dashboard.variables,
  ]);
  return <VariableBarDraft key={revision} {...props} />;
}

function VariableBarDraft({ dashboard, values, onApply, loaders, range, layout = "bar", onDirtyChange, onDeclareVariable }: VariableBarProps) {
  const id = useId();
  const [declaring, setDeclaring] = useState(false);
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
    ({ name }) => draft[name] !== initial[name],
  );
  // Filtered means the applied view differs from the dashboard's defaults. It is shown as a status, not as a value.
  const filtered = (dashboard.variables ?? []).some(
    ({ name, defaultValue }) => initial[name] !== defaultValue,
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
  function choose(name: string, value: string) {
    const next = { ...initial, [name]: value };
    publishing.current = JSON.stringify(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    setDraft((previous) => ({ ...previous, [name]: value }));
    apply(next);
  }
  return (
    <>
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
      {(hasTextInputs || filtered || onDeclareVariable) && <div className={styles.barActions}>
        {hasTextInputs && <GammaButton
          type="submit"
          size="sm"
          variant={dirty ? "primary" : "quiet"}
          disabled={!dirty}
        >
          Update view
        </GammaButton>}
        {hasTextInputs && dirty && (
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
        {filtered && <span role="status" className="inline-flex items-center rounded-full bg-[var(--gamma-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--gamma-accent)]">Filtered</span>}
        {filtered && <GammaButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(resolveDashboardVariables(dashboard, {}));
            apply({});
          }}
        >
          Reset filters
        </GammaButton>}
        {onDeclareVariable && <GammaButton type="button" size="sm" variant="quiet" onClick={() => setDeclaring(true)}>
          <Plus size={13} aria-hidden="true" /> Filter
        </GammaButton>}
      </div>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </form>
    {declaring && onDeclareVariable && <Suspense fallback={null}>
      <VariableQuickCreate
        existing={(dashboard.variables ?? []).map((variable) => variable.name)}
        onCreate={(variable) => {
          onDeclareVariable(variable);
          setDeclaring(false);
        }}
        onCancel={() => setDeclaring(false)}
      />
    </Suspense>}
    </>
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
  const shownValues = dashboard.variables.map(({ name }) => resolved[name] || "Empty value");
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
  value?: string;
  snapshot: VariableOptionsSnapshot | undefined;
  onActivate: () => void;
  onRetry: () => void;
  onChoose: (value: string) => void;
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
  if (value !== undefined && !choices.some((choice) => choice.value === value))
    choices.push({ value, label: value || "Empty value", description: known ? "Not in current values" : undefined });
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
  return <div className={styles.barField}>
    <label htmlFor={id}>
      <span title={variable.name}>{label}</span>
    </label>
    <SearchCombobox
      id={id}
      aria-label={label}
      options={choices}
      value={value ?? null}
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
