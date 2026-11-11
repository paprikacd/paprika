"use client";

import { RotateCcw } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { GammaInput } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { statusLevels, thresholdHex, type StatusLevel, type StatusMark, type StatusTheme } from "./status";
import { STATUS_WORDS } from "./status-chip";
import editorStyles from "./editor.module.css";
import styles from "./status-chip.module.css";

const LEVEL_OPTIONS = statusLevels.map(level => ({ value: level, label: STATUS_WORDS[level] }));
/** Shown only for a legacy hex-only band, which is kept as authored until the author picks a status. */
const COLOUR_ONLY = "colour-only";

/**
 * Status level plus an optional hue override, shared by threshold bands and record-table mappings. `name` prefixes
 * the accessible names, for example "Threshold 2" gives "Threshold 2 level" and "Threshold 2 hue override".
 * The swatch shows the colour the band draws in `theme`, so an override is visible at a glance and a status
 * colour is shown as its resolved value rather than as a token name.
 * A hex-only mark keeps its hex: it is changed only when the author picks a level or resets a hue.
 */
export function StatusMarkFields({ name, mark, theme, onChange, className = "" }: {
  name: string
  mark: StatusMark
  theme: StatusTheme
  onChange: (mark: StatusMark) => void
  className?: string
}) {
  const drawn = thresholdHex(mark, theme) ?? "#000000";
  const options = mark.status === undefined ? [{ value: COLOUR_ONLY, label: "Colour only" }, ...LEVEL_OPTIONS] : LEVEL_OPTIONS;
  const hueName = mark.color === undefined ? "Status colour" : "Hue override";
  const canReset = mark.color !== undefined && mark.status !== undefined;
  return (
    <div className={`${styles.markFields} ${className}`.trim()} data-status-mark-fields="">
      <label className={editorStyles.field}>Status
        <GammaSelect
          aria-label={`${name} level`}
          value={mark.status ?? COLOUR_ONLY}
          options={options}
          onValueChange={value => onChange({ status: value as StatusLevel, color: mark.color })}
        />
      </label>
      <div className={`${editorStyles.field} ${styles.hue}`} role="group" aria-label={`${name} colour`}>
        <span>{mark.status === undefined ? "Colour" : hueName}</span>
        <span className={styles.hueControls}>
          <span role="img" aria-label={`${name} drawn colour ${drawn}`} className={styles.swatch} style={{ background: drawn }} data-drawn-colour={drawn} />
          <GammaInput
            type="color"
            aria-label={`${name} hue override`}
            value={drawn}
            onChange={event => onChange({ status: mark.status, color: event.target.value })}
          />
          <GammaButton
            type="button"
            variant="quiet"
            size="sm"
            iconOnly
            disabled={!canReset}
            aria-label={`${name} use status colour`}
            title="Use the status colour"
            onClick={() => onChange({ status: mark.status, color: undefined })}
          >
            <RotateCcw size={13} />
          </GammaButton>
        </span>
      </div>
    </div>
  );
}
