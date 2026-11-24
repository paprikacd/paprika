"use client";

import { useState } from "react";
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
import styles from "./drilldown.module.css";
import optionStyles from "./variable-options.module.css";
import {
  VariableSourceFields,
  sourceFor,
  valuesFromOf,
  type VariableSourceCatalog,
  type VariableValuesFrom,
} from "./variable-source-editor";
import { rewriteVariableReferences, variableReferences } from "./variable-references";

// Loaded on demand from the dashboard manager: the declarations editor stays out of the first view.
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
