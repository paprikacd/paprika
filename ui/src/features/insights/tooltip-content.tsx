import type { ReactNode } from "react";
import styles from "./chart-styles.module.css";

/** Shared semantic frame for metric, record and pipeline observation panels. */
export function TooltipDetail({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.tooltipDetail}>
    <div className={styles.tooltipHeader}><strong className={styles.tooltipTitle}>{title}</strong></div>
    <div className={styles.tooltipDetailBody}>{children}</div>
  </div>;
}
export function TooltipFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.tooltipFact}><span>{label}</span><strong>{children}</strong></div>;
}

/** Consistent readable guidance inside every observation shell. */
export function TooltipHint({ children }: { children: ReactNode }) {
  return <div className={`${styles.tooltipFooter} ${styles.tooltipHint}`}>{children}</div>;
}
