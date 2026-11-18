import { Network } from "lucide-react"
import type { DataKind, Provider } from "./schema"
import styles from "./observe-connection.module.css"

export function ObserveQueryBinding({ provider, kind }: { provider?: Provider; kind: DataKind }) {
  if (provider?.transport !== "mcp") return null
  return <div className={styles.binding} aria-label="Paprika Observe query binding">
    <Network size={14} aria-hidden="true" />
    <div>
      <div className={styles.bindingTitle}><strong>Paprika Observe</strong><code>POST /observe/api/query</code></div>
      <p>{provider.type === "postgresql"
        ? "Write read-only SQL with separately bound parameters. Filter time in SQL; a metric projection selects numeric and timestamp columns."
        : provider.type === "shorted" || provider.type === "uptime"
        ? "Choose a JSON read operation. Source period arguments control history; the dashboard time picker does not rewrite them."
        : kind === "metrics"
        ? "The selected provider, time range and query step are bound automatically. Write PromQL as usual."
        : "The selected provider and time range are bound automatically. Write TraceQL as usual."}</p>
    </div>
  </div>
}
