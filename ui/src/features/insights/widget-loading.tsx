"use client";

import { createContext, useContext, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Widget } from "./schema";
import styles from "./charts.module.css";

export type WidgetLoadingFamily = "line" | "bar" | "table" | "matrix" | "topology";
export type WidgetLoadingPhase = "initial" | "refresh";
/** A host may replace the default placeholder, or add a refresh notice. Its output is presentation only: never data. */
export type WidgetLoadingPresentation = (state: { widget: Widget; phase: WidgetLoadingPhase }) => ReactNode;

const LoadingPresentation = createContext<WidgetLoadingPresentation | null>(null);

export function WidgetLoadingProvider({ render, children }: { render: WidgetLoadingPresentation; children: ReactNode }) {
  return <LoadingPresentation.Provider value={render}>{children}</LoadingPresentation.Provider>;
}

export function useWidgetLoadingPresentation(): WidgetLoadingPresentation | null {
  return useContext(LoadingPresentation);
}

// The first matching pattern wins. Shapes only hint at what the widget will draw.
const familyPatterns: readonly (readonly [RegExp, WidgetLoadingFamily])[] = [
  [/heatmap|matrix|placement|wafer|history|grid|calendar/, "matrix"],
  [/topology|network|connection|sankey|movement/, "topology"],
  [/table|traces|waterfall|trace|profile|flame/, "table"],
  [/bar|histogram|contribution|evidence|gauge/, "bar"],
];

/** The placeholder shape for a widget. Plugins and built-ins are matched by their identifiers; everything else is a line. */
export function widgetLoadingFamily(widget: Pick<Widget, "type" | "pluginId">): WidgetLoadingFamily {
  const family = widget.pluginId ?? widget.type;
  return familyPatterns.find(([pattern]) => pattern.test(family))?.[1] ?? "line";
}

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const documentHidden = () => document.hidden;
const serverHidden = () => false;

/** True while the page is in the background. Placeholders stop moving then, and resume when the page is shown. */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, documentHidden, serverHidden);
}

function LoadingShape({ family }: { family: WidgetLoadingFamily }) {
  if (family === "table")
    return <div className={styles.loadingTable}>
      {Array.from({ length: 5 }, (_, row) => <div key={row}>{Array.from({ length: 4 }, (_, cell) => <i key={cell} />)}</div>)}
    </div>;
  if (family === "matrix")
    return <div className={styles.loadingMatrix}>{Array.from({ length: 48 }, (_, cell) => <i key={cell} />)}</div>;
  if (family === "bar")
    return <div className={styles.loadingBars}>
      {[46, 70, 58, 84, 66, 92, 74, 55].map((height, index) => <i key={index} style={{ "--placeholder-height": `${height}%` } as CSSProperties} />)}
    </div>;
  if (family === "topology")
    return <svg className={styles.loadingTopology} viewBox="0 0 560 180" preserveAspectRatio="xMidYMid meet" focusable="false">
      <path d="M80 90H240M280 90H480M280 90V38M280 90V142" />
      <rect x="30" y="68" width="100" height="44" rx="5" />
      <rect x="230" y="68" width="100" height="44" rx="5" />
      <rect x="430" y="68" width="100" height="44" rx="5" />
      <rect x="240" y="12" width="80" height="36" rx="5" />
      <rect x="240" y="132" width="80" height="36" rx="5" />
    </svg>;
  return <svg className={styles.loadingLine} viewBox="0 0 560 180" preserveAspectRatio="none" focusable="false">
    <path className={styles.loadingArea} d="M0 130C40 130 40 105 80 105S120 118 160 118S200 75 240 75S280 88 320 88S360 52 400 52S440 66 480 66S520 36 560 36V180H0Z" />
    <path d="M0 130C40 130 40 105 80 105S120 118 160 118S200 75 240 75S280 88 320 88S360 52 400 52S440 66 480 66S520 36 560 36" />
  </svg>;
}

/** Presentation-only outline of the widget's family. It is hidden from assistive technology and never enters data or inspection. */
export function WidgetLoadingPlaceholder({ widget }: { widget: Pick<Widget, "type" | "pluginId"> }) {
  const hidden = useDocumentHidden();
  const family = widgetLoadingFamily(widget);
  return <div className={styles.loadingPlaceholder} data-loading-family={family} data-loading-motion={hidden ? "paused" : "auto"} aria-hidden="true">
    <LoadingShape family={family} />
  </div>;
}

/**
 * The initial-load slot inside the widget state frame. A host presentation replaces it. Refreshes never reach this
 * slot, because the last result stays visible and only the frame's aria-busy changes.
 */
export function WidgetInitialLoading({ widget }: { widget: Widget }) {
  const presentation = useWidgetLoadingPresentation();
  if (presentation) return <>{presentation({ widget, phase: "initial" })}</>;
  return <>
    <WidgetLoadingPlaceholder widget={widget} />
    <div className={`${styles.state} ${styles.loadingStatus}`} role="status" aria-label="Loading widget">
      <span className={styles.loading} />
      <span>Querying data source…</span>
    </div>
  </>;
}
