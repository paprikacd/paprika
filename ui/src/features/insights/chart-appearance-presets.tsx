"use client";

import type { WidgetOptions } from "./schema";
import type { StylePreset } from "./widget-registry";
import { GammaButton } from "./gamma/button";
import "./lazy-style-boundary.css?editor";
import styles from "./editor.module.css";

/** A small drawing of what the preset looks like. The mark is decorative: the preset name is the label. */
function PresetPreview({ preset }: { preset: StylePreset }) {
  const grid = preset.options.gridX === true;
  return <svg viewBox="0 0 80 30" aria-hidden="true" focusable="false">
    {preset.preview === "value" && <text x="40" y="22" textAnchor="middle" fontSize="18" fontWeight="600" fill="currentColor">42</text>}
    {preset.preview === "cells" && <>
      {[0, 1, 2, 3, 4, 5].map((cell) => <rect key={cell} x={3 + (cell % 3) * 25} y={3 + Math.floor(cell / 3) * 13} width="22" height="10" rx="2" fill="currentColor" opacity={0.25 + cell * 0.12} />)}
    </>}
    {preset.preview === "bars" && <>
      {[16, 10, 22, 13].map((height, index) => <rect key={index} x={8 + index * 18} y={27 - height} width="11" height={height} rx="1.5" fill="currentColor" opacity=".55" />)}
    </>}
    {(preset.preview === "line" || preset.preview === "area" || preset.preview === "sparkline") && <>
      <path d="M2 26H78" className={styles.presetGuide} />
      {grid && <path d="M20 2V26M40 2V26M60 2V26" className={styles.presetGuide} />}
      {preset.preview === "area" && <path d="M2 21L17 15L32 18L47 5L62 10L78 3V26H2Z" fill="currentColor" opacity=".12" />}
      <path d="M2 21L17 15L32 18L47 5L62 10L78 3" fill="none" stroke="currentColor" strokeWidth={preset.options.lineWidth ?? 2} />
    </>}
  </svg>;
}

/** Writes each preset's options. A preset is pressed when every option it sets is already in place. */
export function StylePresetChoices({ presets, options, onChange, title = "Appearance" }: {
  presets: readonly StylePreset[];
  options: WidgetOptions;
  onChange: (options: Partial<WidgetOptions>) => void;
  title?: string;
}) {
  return <section className={styles.appearancePresets} aria-label={title}>
    <h3>{title}</h3>
    <div className={styles.presetChoices}>
      {presets.map(preset => <GammaButton key={preset.id} variant="secondary" className={styles.presetChoice}
        aria-label={preset.name} aria-pressed={Object.entries(preset.options).every(([key, value]) => options[key as keyof WidgetOptions] === value)}
        onClick={() => onChange(preset.options)}>
        <PresetPreview preset={preset} />
        <strong>{preset.name}</strong>
      </GammaButton>)}
    </div>
  </section>;
}
