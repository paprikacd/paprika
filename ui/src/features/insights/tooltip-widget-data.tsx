"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { DataKind, QueryResult } from "./schema";

const ParentData = createContext<{
  result: QueryResult;
  kind: DataKind;
} | null>(null);

/** Shares the host's fetched result. Opening a tooltip never refreshes this data. */
export function TooltipWidgetDataProvider({
  result,
  kind,
  children,
}: {
  result: QueryResult;
  kind: DataKind;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ result, kind }), [result, kind]);
  return <ParentData.Provider value={value}>{children}</ParentData.Provider>;
}

export const useTooltipWidgetData = () => useContext(ParentData);
