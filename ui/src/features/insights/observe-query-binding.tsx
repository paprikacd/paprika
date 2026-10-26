import { Network } from "lucide-react"
import type { DataKind, Provider } from "./schema"
import styles from "./observe-connection.module.css"

export function ObserveQueryBinding({ provider, kind }: { provider?: Provider; kind: DataKind }) {
  if (provider?.transport !== "mcp") return null
  return <div className={styles.binding} aria-label="Observe MCP query binding">
    <Network size={14} aria-hidden="true" />
    <div>
      <div className={styles.bindingTitle}><strong>Paprika Observe MCP</strong><code>{kind === "metrics" ? "query_metrics" : "query_traces"}</code></div>
      <p>{kind === "metrics"
        ? "The selected provider, time range and query step are bound automatically. Write PromQL as usual."
        : "The selected provider and time range are bound automatically. Write TraceQL as usual."}</p>
    </div>
  </div>
}
