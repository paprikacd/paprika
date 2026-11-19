"use client";

import { useEffect, useRef, useState } from "react";
import { GammaButton } from "./gamma/button";
import { GammaDisclosure } from "./gamma/disclosure";
import { GammaInput } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { compileSloConfigText, SloQueryPreview } from "./slo-query-preview";
import { SLO_PERIODS, validateSloConfig, type SloErrorCode } from "./slo";
import { SLO_DEFAULT_CONFIG } from "./plugins/slo-summary";
import styles from "./editor.module.css";

/** The plain words for each config error. The raw code stays out of the author's view. */
const ERROR_TEXT: Record<SloErrorCode, string> = {
  invalid_config: "The objective is not a configuration object.",
  unknown_key: "The objective has a field this editor does not support.",
  invalid_objective: "Use a percent from 50 to 99.9999 with at most four decimal places.",
  invalid_period: "Choose a period of 1, 7, 28 or 30 days.",
  invalid_selector: "Use a metric name with optional label matchers, such as http_requests_total{code=~\"5..\"}.",
  good_bad_exclusive: "Set either a bad or a good selector, not both.",
  invalid_burn_alerts: "Choose a burn preset: multiwindow, page or none.",
  invalid_group_by: "Use a label name that is not an SLO label.",
  invalid_max_rows: "Use a row count that the series limit allows for this preset and grouping.",
  query_too_long: "The generated query is too long. Shorten the selectors.",
};

/** Shown when neither failures selector is set; the exclusive-selector text would wrongly suggest both are filled. */
const MISSING_SELECTOR_TEXT = "Enter the failures selector: a metric name with optional label matchers.";

const PERIOD_OPTIONS = SLO_PERIODS.map(period => ({ value: period, label: `${period} window` }));
const BURN_OPTIONS = [
  { value: "multiwindow", label: "Multiwindow (1h/5m, 6h/30m, 1d/2h, 3d/6h)" },
  { value: "page", label: "Page only (1h/5m, 6h/30m)" },
  { value: "none", label: "None" },
];
const SOURCE_OPTIONS = [
  { value: "bad", label: "Bad requests" },
  { value: "good", label: "Good requests" },
];

type Config = Record<string, unknown>;

function parse(config: string): Config | undefined {
  try {
    const value: unknown = JSON.parse(config);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Config) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The source of an slo-summary widget: the objective, its period, the counter selectors and the grouping. Every change
 * rewrites the authored config, which the widget compiles and runs. The generated PromQL sits in a read-only disclosure.
 */
export function SloSourceEditor({ config, onConfig, onQuery }: {
  config: string;
  onConfig: (config: string) => void;
  onQuery: (query: string) => void;
}) {
  // The stored query follows the config whether or not the disclosure is open, so a saved widget never carries stale text.
  const { compiled } = compileSloConfigText(config);
  const latestQuery = useRef(onQuery);
  useEffect(() => {
    latestQuery.current = onQuery;
  });
  useEffect(() => {
    if (compiled !== undefined) latestQuery.current(compiled);
  }, [compiled]);
  const parsed = parse(config);
  if (!parsed) {
    return (
      <section aria-label="SLO source" className={styles.stack}>
        <p role="alert">The objective configuration is not valid JSON. Reset it to the default objective to edit it here.</p>
        <GammaButton size="sm" variant="quiet" onClick={() => onConfig(JSON.stringify(SLO_DEFAULT_CONFIG, null, 2))}>Reset to default objective</GammaButton>
      </section>
    );
  }
  const error = validateSloConfig(parsed);
  // An empty value is dropped, except for the failures selector being edited, which must survive so the source
  // choice holds while the selector is still blank.
  const write = (patch: Config, keepEmpty?: string) => {
    const next: Config = { ...parsed, ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || (next[key] === "" && key !== keepEmpty)) delete next[key];
    }
    onConfig(JSON.stringify(next, null, 2));
  };
  const source = parsed.good !== undefined ? "good" : "bad";
  const selector = typeof parsed[source] === "string" ? (parsed[source] as string) : "";
  const groupBy = typeof parsed.groupBy === "string" ? parsed.groupBy : "";
  const objective = typeof parsed.objective === "number" ? parsed.objective : undefined;

  return (
    <section aria-label="SLO source" className={styles.stack} data-slo-source>
      <ObjectiveField objective={objective} onCommit={value => write({ objective: value })} />
      <label className={styles.field}>
        <span>Period</span>
        <GammaSelect
          aria-label="SLO period"
          value={typeof parsed.period === "string" ? parsed.period : "30d"}
          options={PERIOD_OPTIONS}
          onValueChange={period => write({ period })}
        />
      </label>
      <label className={styles.field}>
        <span>Total requests selector</span>
        <GammaInput aria-label="Total requests selector" value={typeof parsed.total === "string" ? parsed.total : ""} onChange={event => write({ total: event.target.value })} />
      </label>
      <div className={styles.field}>
        <span>Failures counted as</span>
        <GammaSelect
          aria-label="Failures source"
          value={source}
          options={SOURCE_OPTIONS}
          onValueChange={next => write(next === "good" ? { good: selector, bad: undefined } : { bad: selector, good: undefined }, next)}
        />
        <GammaInput aria-label={source === "good" ? "Good requests selector" : "Bad requests selector"} value={selector} onChange={event => write({ [source]: event.target.value }, source)} />
      </div>
      <label className={styles.field}>
        <span>Burn alerts</span>
        <GammaSelect
          aria-label="Burn alerts"
          value={typeof parsed.burnAlerts === "string" ? parsed.burnAlerts : "multiwindow"}
          options={BURN_OPTIONS}
          onValueChange={burnAlerts => write({ burnAlerts })}
        />
      </label>
      <label className={styles.field}>
        <span>Group by label (services)</span>
        <GammaInput aria-label="Group by label" placeholder="none" value={groupBy} onChange={event => write(event.target.value === "" ? { groupBy: "", maxRows: undefined } : { groupBy: event.target.value })} />
      </label>
      {groupBy && (
        <label className={styles.field}>
          <span>Rows shown</span>
          <GammaInput
            aria-label="Rows shown"
            type="number"
            min={1}
            max={12}
            value={typeof parsed.maxRows === "number" ? String(parsed.maxRows) : "6"}
            onChange={event => {
              const value = Number(event.target.value);
              if (Number.isInteger(value)) write({ maxRows: value });
            }}
          />
        </label>
      )}
      <p className={styles.hint}>Label suggestions for the selectors are deferred; type the selectors as they appear in your metrics.</p>
      {error && <p role="alert" className={styles.hint}>{error === "good_bad_exclusive" && selector === "" ? MISSING_SELECTOR_TEXT : ERROR_TEXT[error]}</p>}
      <GammaDisclosure title="Generated query" meta="read only">
        <SloQueryPreview config={config} />
      </GammaDisclosure>
    </section>
  );
}

/**
 * The objective is typed as text, so a partial entry such as "99." is kept while it is typed. Only a finite number commits.
 */
function ObjectiveField({ objective, onCommit }: { objective: number | undefined; onCommit: (value: number) => void }) {
  const [typed, setTyped] = useState<string | undefined>(undefined);
  // The typed text is shown while it still reads as the committed objective; any other change shows the objective.
  const text = typed !== undefined && typed.trim() !== "" && Number(typed) === objective ? typed : objective === undefined ? "" : String(objective);
  return (
    <label className={styles.field}>
      <span>Objective (%)</span>
      <GammaInput
        aria-label="Objective percent"
        inputMode="decimal"
        value={text}
        onChange={event => {
          setTyped(event.target.value);
          const value = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(value)) onCommit(value);
        }}
      />
    </label>
  );
}
