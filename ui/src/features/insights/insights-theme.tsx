"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { GammaSelect } from "./gamma/select";

export type InsightsTheme = "system" | "light" | "dark";
export const INSIGHTS_THEME_KEY = "paprika-insights-theme";
const themeEvent = "paprika-insights-theme-change";
let unavailableStoragePreference: InsightsTheme = "system";

function storedTheme(): InsightsTheme {
  try {
    const value = window.localStorage.getItem(INSIGHTS_THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return unavailableStoragePreference;
  }
}
function subscribeTheme(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(themeEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(themeEvent, listener);
  };
}
function setTheme(value: InsightsTheme) {
  unavailableStoragePreference = value;
  try { window.localStorage.setItem(INSIGHTS_THEME_KEY, value); } catch { /* A session preference still works when storage is blocked. */ }
  window.dispatchEvent(new Event(themeEvent));
}
function subscribeSystem(listener: () => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}
const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
const serverTheme = (): InsightsTheme => "system";
const serverDark = () => false;

/** Appearance is a browser preference, never part of a saved dashboard. */
export function useInsightsTheme() {
  const theme = useSyncExternalStore(subscribeTheme, storedTheme, serverTheme);
  const dark = useSyncExternalStore(subscribeSystem, systemDark, serverDark);
  return { theme, resolvedTheme: theme === "system" ? (dark ? "dark" : "light") : theme, setTheme };
}

export function InsightsThemeControl({ value, onChange, className }: { value: InsightsTheme; onChange: (theme: InsightsTheme) => void; className?: string }) {
  return <GammaSelect aria-label="Dashboard appearance" title={`Dashboard appearance: ${value}`} className={className} size="sm" value={value}
    onValueChange={(next) => onChange(next as InsightsTheme)} options={[
      { value: "light", label: "Light", icon: <Sun size={14} aria-hidden="true" /> },
      { value: "dark", label: "Dark", icon: <Moon size={14} aria-hidden="true" /> },
      { value: "system", label: "System", icon: <Monitor size={14} aria-hidden="true" /> },
    ]} />;
}
