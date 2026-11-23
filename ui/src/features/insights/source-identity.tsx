import { Activity, BookMarked, ChartNoAxesCombined, CodeXml, Crosshair, Database, FlaskConical, Flame, Layers, Route } from "lucide-react";
import type { CSSProperties } from "react";
import type { Provider, ProviderState } from "./schema";
import type { GammaSelectOption } from "./gamma/select";
import styles from "./source-identity.module.css";

const providerTypeLabels: Record<string, string> = {
  prometheus: "Prometheus",
  tempo: "Tempo",
  postgresql: "PostgreSQL",
  shorted: "Shorted",
  uptime: "Uptime",
  mock: "Synthetic",
};
/** A type without a label shows its raw type string, never "undefined". */
export function providerTypeLabel(type: string): string {
  return providerTypeLabels[type] ?? type;
}

/** Fixed Insights wording for each closed probe state. The gateway's reason text is never shown. */
export const providerStatePhrases: Record<ProviderState, string> = {
  OK: "Last check: OK",
  NotConfigured: "Last check: not configured",
  NotAvailable: "Last check: unavailable",
  Error: "Last check: failed",
  Forbidden: "Last check: access denied",
};

export function ProviderIcon({ type }: { type?: string }) {
  const Icon = type === "prometheus" ? Flame : type === "tempo" ? Route : type === "shorted" ? ChartNoAxesCombined : type === "uptime" ? Activity : type === "mock" ? FlaskConical : Database;
  return <span className={styles.providerIcon} data-provider-type={type ?? "unknown"} aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>;
}

export function ProviderStateMarker({ state }: { state: ProviderState }) {
  return <span className={styles.stateMarker} data-provider-state={state} data-tone={state === "Error" ? "danger" : state === "OK" ? undefined : "warning"}>{providerStatePhrases[state]}</span>;
}

export function QuerySourceIcon({ kind }: { kind: "saved" | "provider" | "widget" | "series" }) {
  const Icon = kind === "saved" ? BookMarked : kind === "provider" ? CodeXml : kind === "widget" ? Layers : Crosshair;
  return <span className={styles.sourceIcon} data-query-source={kind} aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>;
}

// Inline rather than a module class, so the separator adds nothing to the Insights CSS budget.
const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

export function providerOption(provider: Provider): GammaSelectOption {
  // A non-OK state is marked but never disables the option: the verdict can be up to a probe interval old.
  const attention = provider.state && provider.state !== "OK" ? provider.state : undefined
  return {
    value: provider.id,
    label: provider.name,
    accessibleLabel: provider.name,
    // The state phrase lives only in details, so the option's accessible description carries it once.
    description: `${providerTypeLabel(provider.type)} · ${provider.capabilities.join(", ")}${provider.transport === "mcp" ? " · Observe MCP" : ""}`,
    // Details render as one grid row. The separator is visually hidden but stays in the text, so the option's
    // accessible description reads "... · Last check: failed".
    ...(attention ? { details: <span><span style={visuallyHidden}>{" · "}</span><ProviderStateMarker state={attention} /></span> } : {}),
    icon: <ProviderIcon type={provider.type} />,
    keywords: [provider.id, provider.type, ...(provider.transport === "mcp" ? ["Observe", "MCP"] : [])],
  };
}
