"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Widget } from "./schema";

export type WidgetLoadingPresentation = (state: {
  widget: Widget;
  phase: "initial" | "refresh";
}) => ReactNode;

const LoadingContext = createContext<WidgetLoadingPresentation | null>(null);

/** Host-owned presentation only: loading never becomes a query result or schema field. */
export function WidgetLoadingProvider({ render, children }: {
  render: WidgetLoadingPresentation;
  children: ReactNode;
}) {
  return <LoadingContext.Provider value={render}>{children}</LoadingContext.Provider>;
}

export const useWidgetLoadingPresentation = () => useContext(LoadingContext);
