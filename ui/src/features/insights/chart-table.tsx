import type { ComponentProps } from "react";
import styles from "./chart-table.module.css";

/** Shared table anatomy for metric, trace and record renderers. Each renderer
 * retains ownership of sorting, selection and exact observation semantics. */
export function ChartTable({ density = "comfortable", className = "", ...props }: ComponentProps<"table"> & { density?: "compact" | "comfortable" }) {
  return <table {...props} className={`${styles.table} ${className}`} data-chart-table="" data-density={density} />;
}
