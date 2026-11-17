"use client";

import type { WidgetOptions } from "./schema";
import { GammaButton } from "./gamma/button";
import styles from "./editor.module.css";

// These write ordinary presentation options; no hidden preset state or query changes.
const presets = [
  { name: "Clean line", options: { display: "line", lineWidth: 2, fillOpacity: 0.12, showGrid: true, gridX: false, showLegend: true } },
  { name: "Soft area", options: { display: "area", lineWidth: 2, fillOpacity: 0.12, showGrid: true, gridX: false, showLegend: true } },
  { name: "Compare", options: { display: "line", lineWidth: 1.5, fillOpacity: 0.12, showGrid: true, gridX: true, showLegend: true } },
] satisfies { name: string; options: Partial<WidgetOptions> }[];

export function ChartAppearancePresets({ options, onChange }: { options: WidgetOptions; onChange: (options: Partial<WidgetOptions>) => void }) {
  return <section className={styles.appearancePresets} aria-label="Chart appearance">
    <h3>Chart appearance</h3>
    <div className={styles.presetChoices}>
      {presets.map(preset => <GammaButton key={preset.name} variant="secondary" className={styles.presetChoice}
        aria-label={preset.name} aria-pressed={Object.entries(preset.options).every(([key, value]) => options[key as keyof WidgetOptions] === value)}
        onClick={() => onChange(preset.options)}>
        <svg viewBox="0 0 80 30" aria-hidden="true" focusable="false">
          <path d="M2 26H78" className={styles.presetGuide} />
          {preset.options.gridX && <path d="M20 2V26M40 2V26M60 2V26" className={styles.presetGuide} />}
          {preset.options.display === "area" && <path d="M2 21L17 15L32 18L47 5L62 10L78 3V26H2Z" fill="currentColor" opacity=".12" />}
          <path d="M2 21L17 15L32 18L47 5L62 10L78 3" fill="none" stroke="currentColor" strokeWidth={preset.options.lineWidth} />
        </svg>
        <strong>{preset.name}</strong>
      </GammaButton>)}
    </div>
  </section>;
}
