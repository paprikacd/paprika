import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Network, RefreshCw } from "lucide-react"
import type { InsightsClient, ObserveConnection } from "./client"
import type { Provider } from "./schema"
import { GammaButton } from "./gamma/button"
import { GammaDisclosure } from "./gamma/disclosure"
import styles from "./observe-connection.module.css"

const failure = (error: unknown) => error instanceof Error ? error.message : "Paprika Observe is unavailable. Try refreshing the connection."

export function ObserveConnectionCard({ client, onProvidersChange }: {
  client: InsightsClient
  onProvidersChange: (providers: Provider[]) => void
}) {
  const [state, setState] = useState<{ connection?: ObserveConnection; error?: string; providerError?: string; loading: boolean }>({ loading: true })
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!client.observeConnection) return
    const controller = new AbortController()
    request.current = controller
    client.observeConnection(controller.signal).then(connection => {
      if (!controller.signal.aborted) setState({ connection, loading: false })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ error: failure(error), loading: false })
    })
    return () => { request.current?.abort() }
  }, [client])

  async function refresh() {
    if (!client.observeConnection || state.loading) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setState(previous => ({ ...previous, error: undefined, providerError: undefined, loading: true }))
    const [connection, providers] = await Promise.allSettled([
      client.observeConnection(controller.signal), client.providers(controller.signal),
    ])
    if (controller.signal.aborted) return
    setState({
      ...(connection.status === "fulfilled" ? { connection: connection.value } : { error: failure(connection.reason) }),
      ...(providers.status === "rejected" ? { providerError: failure(providers.reason) } : {}),
      loading: false,
    })
    if (providers.status === "fulfilled") onProvidersChange(providers.value)
  }

  // Custom embedded hosts can continue supplying standalone providers only.
  if (!client.observeConnection) return null
  const { connection, error, providerError, loading } = state
  const connected = !loading && connection?.connected && !error
  const status = loading ? "Checking connection…" : error ? "Connection unavailable" : !connection?.configured ? "Not configured" : connected ? "Connected" : "Connection unavailable"
  return <section className={styles.card} aria-label="Paprika Observe MCP" aria-busy={loading}>
    <div className={styles.heading}>
      <span className={styles.mark}><Network size={18} aria-hidden="true" /></span>
      <div><h3>Paprika Observe MCP</h3><p>Metrics and traces from your shared providers</p></div>
    </div>
    <p className={styles.status} data-connected={connected || undefined} role="status">
      {connected && <CheckCircle2 size={14} aria-hidden="true" />}{status}
      {connected && <span>· {connection.providerCount} {connection.providerCount === 1 ? "provider" : "providers"} discovered</span>}
    </p>
    <p className={styles.description}>Uses your current Paprika session and Observability permissions. Choose a provider below, then build a query for your dashboard.</p>
    {!loading && !error && !connection?.configured && <p className={styles.description}>Ask your operator to enable the Paprika Observe connection for Insights.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {providerError && <p className={styles.error} role="alert">Providers could not be refreshed. {providerError}</p>}
    {connected && !connection.providerCount && <p className={styles.description}>No compatible providers were found. Add a Prometheus or Tempo provider in Observability, then refresh this connection.</p>}
    {connected && <GammaDisclosure title="Discovered MCP tools" meta={String(connection.tools.length)}>
      <ul className={styles.tools}>
        {connection.tools.map(tool => <li key={tool.name}><code>{tool.name}</code><p>{tool.description}</p></li>)}
      </ul>
      {connection.protocolVersion && <p className={styles.protocol}>Protocol {connection.protocolVersion}</p>}
    </GammaDisclosure>}
    <div className={styles.actions}>
      <GammaButton size="sm" loading={loading} disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />Refresh connection and providers</GammaButton>
      <Link href="/dashboard/observability/" className={styles.manage}>Manage Observe providers</Link>
    </div>
  </section>
}
