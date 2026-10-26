import { BookMarked, CodeXml, Crosshair, Database, Flame, Layers, Route } from "lucide-react";
import type { Provider } from "./schema";
import type { GammaSelectOption } from "./gamma/select";
import styles from "./source-identity.module.css";

export function ProviderIcon({ type }: { type?: string }) {
  const Icon = type === "prometheus" ? Flame : type === "tempo" ? Route : Database;
  return <span className={styles.providerIcon} data-provider-type={type ?? "unknown"} aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>;
}

export function QuerySourceIcon({ kind }: { kind: "saved" | "provider" | "widget" | "series" }) {
  const Icon = kind === "saved" ? BookMarked : kind === "provider" ? CodeXml : kind === "widget" ? Layers : Crosshair;
  return <span className={styles.sourceIcon} data-query-source={kind} aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>;
}

export function providerOption(provider: Provider): GammaSelectOption {
  return {
    value: provider.id,
    label: provider.name,
    accessibleLabel: provider.name,
    description: `${provider.type === "prometheus" ? "Prometheus · metrics" : "Tempo · traces"}${provider.transport === "mcp" ? " · Observe MCP" : ""}`,
    icon: <ProviderIcon type={provider.type} />,
    keywords: [provider.id, provider.type, ...(provider.transport === "mcp" ? ["Observe", "MCP"] : [])],
  };
}
