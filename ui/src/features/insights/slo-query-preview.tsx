"use client";

import "./lazy-style-boundary.css?editor";
import styles from "./editor.module.css";
import { compileSloQuery, SloConfigError, validateSloConfig, type SloConfig } from "./slo";

/**
 * The PromQL an slo-summary widget runs, shown read only. The text is compiled from the authored config, which the
 * widget runs at run time; the editor that owns the config keeps the stored query equal to this text.
 */
export function SloQueryPreview({ config }: { config: string }) {
  const { code, compiled } = compileSloConfigText(config);
  return (
    <section aria-label="Compiled query" className={styles.stack}>
      <h3>Compiled query</h3>
      {compiled === undefined ? (
        <p role="status">The objective is invalid ({code || "invalid_config"}). Correct the configuration to compile the query.</p>
      ) : (
        <>
          <p className={styles.hint}>Generated from the objective. Edit the objective, period or selectors in the configuration; this text is not editable.</p>
          <pre aria-label="Generated PromQL" data-slo-query tabIndex={0}>{compiled}</pre>
        </>
      )}
    </section>
  );
}

/**
 * The compiled PromQL for an objective config, or the error code when it is invalid. Both come from the same validator
 * the widget runs, so the editor and the widget cannot disagree.
 */
export function compileSloConfigText(config: string): { code?: string; compiled?: string } {
  return compileConfig(parseConfig(config));
}

/** The compile error code, or the compiled text when the config is valid. Both come from the same validator the widget runs. */
function compileConfig(parsed: SloConfig | undefined): { code?: string; compiled?: string } {
  if (parsed === undefined) return { code: "invalid_config" };
  const code = validateSloConfig(parsed);
  if (code) return { code };
  try {
    return { compiled: compileSloQuery(parsed) };
  } catch (error) {
    return { code: error instanceof SloConfigError ? error.message : "invalid_config" };
  }
}

function parseConfig(config: string): SloConfig | undefined {
  try {
    const value: unknown = JSON.parse(config);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as SloConfig) : undefined;
  } catch {
    return undefined;
  }
}
