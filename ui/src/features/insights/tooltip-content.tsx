import type { ReactNode } from "react";
import styles from "./chart-styles.module.css";
import { TooltipInstructions } from "./tooltip-instructions";

/** Shared semantic frame for metric, record and pipeline observation panels. */
export function TooltipDetail({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.tooltipDetail}>
    <div className={styles.tooltipHeader}><strong className={styles.tooltipTitle}>{title}</strong></div>
    <div className={styles.tooltipDetailBody}>{children}</div>
  </div>;
}
export function TooltipFact({ label, children }: { label: string; children: ReactNode }) {
  return <dl className={styles.tooltipFact}><dt>{label}</dt><dd>{children}</dd></dl>;
}

/** One inset for supporting content, including histories and custom detail views. */
export function TooltipSection({ children }: { children: ReactNode }) {
  return <div className={styles.tooltipSection}>{children}</div>;
}

/** Consistent readable guidance inside every observation shell. */
export function TooltipHint({ children }: { children: ReactNode }) {
  return <div className={`${styles.tooltipFooter} ${styles.tooltipHint}`}>{children}</div>;
}

/** The one pin vocabulary for every observation panel: how to keep it open, and how to close it once pinned. */
export const TOOLTIP_PIN_HINT_OPEN = "Click, tap or press Enter to keep open";
export const TOOLTIP_PIN_HINT_PINNED = "Pinned · select again to close";
export function tooltipPinHint(pinned: boolean) {
  return pinned ? TOOLTIP_PIN_HINT_PINNED : TOOLTIP_PIN_HINT_OPEN;
}
/**
 * The pin hint as a sticky footer line, with the keyboard and touch dismissal guidance beside it, so a long panel keeps
 * both in view. The sticky rule applies to footers that contain the instructions.
 */
export function TooltipPinHint({ pinned }: { pinned: boolean }) {
  return <TooltipHint><span>{tooltipPinHint(pinned)}</span> <TooltipInstructions /></TooltipHint>;
}
