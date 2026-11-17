"use client";

import { createContext, useContext, type ReactNode } from "react";

const Presentation = createContext<{
  embedded: boolean;
  showAxis: boolean;
  descriptionId?: string;
}>({ embedded: false, showAxis: true });
/** Compact leaf rendering: no nested tooltip, inspector or drilldown actions. */
export function EmbeddedWidgetProvider({
  children,
  showAxis = true,
  descriptionId,
}: {
  children: ReactNode;
  showAxis?: boolean;
  descriptionId?: string;
}) {
  return (
    <Presentation.Provider value={{ embedded: true, showAxis, descriptionId }}>
      {children}
    </Presentation.Provider>
  );
}
export const useWidgetPresentation = () => useContext(Presentation);
export const useEmbeddedWidget = () => useContext(Presentation).embedded;
