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
/**
 * Option value for "no status": the mark keeps only its hue. It is never written as a status. It appears only when
 * a colour exists, so picking it cannot leave a band without a mark.
 */
const COLOUR_ONLY = "colour-only";

/**
 * Status level plus an optional hue override, shared by threshold bands and record-table mappings. `name` prefixes
 * the visible and accessible labels: "Threshold 2" shows "Threshold 2 status" and "Threshold 2 colour". The swatch
 * shows the colour the mark draws in `theme`. Choosing a level, colour only or a reset changes only that field.
 */
export function StatusMarkFields({ name, mark, theme, onChange, className = "" }: {
  name: string
  mark: StatusMark
  theme: StatusTheme
  onChange: (mark: StatusMark) => void
  className?: string
}) {
  const drawn = thresholdHex(mark, theme) ?? "#000000";
  const hasColour = mark.color !== undefined;
  const options = hasColour || mark.status === undefined
    ? [{ value: COLOUR_ONLY, label: "Colour only" }, ...LEVEL_OPTIONS]
    : LEVEL_OPTIONS;
  const canReset = hasColour && mark.status !== undefined;
  const statusLabel = `${name} status`, colourLabel = `${name} colour`;
  return (
    <div className={`${styles.markFields} ${className}`.trim()} data-status-mark-fields="">
      <label className={editorStyles.field}>{statusLabel}
        <GammaSelect
          aria-label={statusLabel}
          value={mark.status ?? COLOUR_ONLY}
          options={options}
          onValueChange={value => {
            if (value === COLOUR_ONLY) {
              if (hasColour) onChange({ color: mark.color });
              return;
            }
            onChange({ status: value as StatusLevel, color: mark.color });
          }}
        />
      </label>
      <div className={`${editorStyles.field} ${styles.hue}`}>
        <span>{colourLabel}</span>
        <span className={styles.hueControls}>
          <span role="img" aria-label={`${name} drawn colour ${drawn}`} className={styles.swatch} style={{ background: drawn }} data-drawn-colour={drawn} />
          <GammaInput
            type="color"
            aria-label={colourLabel}
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
