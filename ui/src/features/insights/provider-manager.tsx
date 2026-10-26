import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Plus, Trash2, X } from "lucide-react"
import { ProviderIcon } from "./source-identity"
import type { InsightsClient, ProviderConfig } from "./client"
import type { Provider } from "./schema"
import { GammaButton } from "./gamma/button"
import { GammaInput, GammaTextarea } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import styles from "./editor.module.css"

const envName = /^PAPRIKA_PROVIDER_[A-Z0-9_]+$/
export function validateProviderConfig(
  config: ProviderConfig,
): string | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(config.id))
    return "Use a provider ID of up to 80 letters, digits, hyphens or underscores."
  if (!config.name.trim() || config.name.trim().length > 120)
    return "Enter a provider name of up to 120 characters."
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    return "Enter the provider’s complete HTTP or HTTPS URL."
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    return "Use an HTTP or HTTPS URL without credentials, query parameters or fragments."
  if (config.bearerTokenEnv && !envName.test(config.bearerTokenEnv))
    return "Credential environment variables must start with PAPRIKA_PROVIDER_ and use uppercase letters, digits or underscores."
  for (const [header, env] of Object.entries(config.headersEnv ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
      return "Enter valid HTTP header names."
    if (!envName.test(env))
      return "Header environment variables must start with PAPRIKA_PROVIDER_."
  }
}
function readHeaders(source: string): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  for (const line of source.split("\n").filter((line) => line.trim())) {
    const separator = line.indexOf(":")
    if (separator < 1)
      throw new Error(
        "Use one Header-Name: PAPRIKA_PROVIDER_VARIABLE per line.",
      )
    const name = line.slice(0, separator).trim(),
      env = line.slice(separator + 1).trim()
    if (
      Object.keys(headers).some(
        (key) => key.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("Each HTTP header can be configured once.")
    headers[name] = env
  }
  return headers
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Provider request failed."

export function ProviderManager({
  client,
  providers,
  onChange,
  example = false,
  onClose,
}: {
  client: InsightsClient
  providers: Provider[]
  onChange: (providers: Provider[]) => void
  example?: boolean
  onClose?: () => void
}) {
  const hasSharedProviders = providers.some((provider) => provider.source === "observability")
  const [configs, setConfigs] = useState<ProviderConfig[]>()
  const [draft, setDraft] = useState<ProviderConfig | null>(null)
  const [headers, setHeaders] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [remove, setRemove] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    if (!example)
      client
        .providerConfigs(controller.signal)
        .then((items) => {
          if (!controller.signal.aborted) setConfigs(items)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(cause))
        })
    return () => {
      alive.current = false
      controller.abort()
    }
  }, [client, example])
  function edit(config: ProviderConfig) {
    setDraft({ ...config })
    setHeaders(
      Object.entries(config.headersEnv ?? {})
        .map(([header, env]) => `${header}: ${env}`)
        .join("\n"),
    )
    setError("")
    setMessage("")
    setRemove(null)
  }
  async function refresh() {
    const [next, publicProviders] = await Promise.all([
      client.providerConfigs(),
      client.providers(),
    ])
    if (alive.current) {
      setConfigs(next)
      onChange(publicProviders)
    }
  }
  async function save() {
    if (!draft || busy) return
    let candidate: ProviderConfig
    try {
      candidate = {
        ...draft,
        name: draft.name.trim(),
        url: draft.url.trim(),
        bearerTokenEnv: draft.bearerTokenEnv?.trim() || undefined,
        headersEnv: readHeaders(headers),
      }
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    const invalid = validateProviderConfig(candidate)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy("save")
    setError("")
    setMessage("")
    try {
      await client.saveProvider(candidate)
      if (alive.current) {
        setDraft(null)
        setMessage(
          "Provider saved. Test its connection before running queries.",
        )
      }
      await refresh()
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
    } finally {
      if (alive.current) setBusy("")
    }
  }
  async function test(id: string) {
    setBusy(`test:${id}`)
    setError("")
    setMessage("")
    try {
      const result = await client.testProvider(id)
      if (alive.current) {
        if (result.ok)
          setMessage(
            `${providers.find((item) => item.id === id)?.name ?? id}: ${result.message} (${result.durationMs} ms)`,
          )
        else setError(result.message || "Connection failed.")
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
    } finally {
      if (alive.current) setBusy("")
    }
  }
  async function deleteProvider(config: ProviderConfig) {
    setBusy(`delete:${config.id}`)
    setError("")
    setMessage("")
    try {
      await client.removeProvider(config.id, config.etag)
      if (alive.current) {
        setRemove(null)
        setMessage(
          "Provider removed. Existing widgets and tooltip queries retain their provider ID until you choose another source.",
        )
      }
      await refresh()
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
    } finally {
      if (alive.current) setBusy("")
    }
  }
  return (
    <section className={styles.editor} aria-label="Data sources">
      <div className={styles.heading}>
        <div>
          <h2>Data sources</h2>
        </div>
        {onClose && (
          <GammaButton
            variant="quiet" size="sm"
            iconOnly
            onClick={onClose}
            aria-label="Close data sources"
          >
            <X size={18} />
          </GammaButton>
        )}
      </div>
      <p className={styles.hint}>
        Connect a metrics or trace backend once, then use it across dashboards.
      </p>
      {example && (
        <p className={styles.notice}>
          Example data is local. Switch to connected mode to manage real
          providers.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className={styles.success} role="status">
          <CheckCircle2 size={15} />
          {message}
        </p>
      )}
      {!example && !configs && !error && (
        <p className={styles.hint} role="status">
          Loading provider configuration…
        </p>
      )}
      <div className={styles.providerList}>
        {providers.map((provider) => {
          const shared = provider.source === "observability"
          const config = shared ? undefined : configs?.find((item) => item.id === provider.id)
          return (
            <article className={styles.provider} key={provider.id}>
              <div className={styles.providerTitle}>
                <ProviderIcon type={provider.type} />
                <div>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.type === "prometheus"
                      ? "Prometheus · metrics"
                      : "Tempo · traces"}{" "}
                    · {shared ? "Shared with Observability MCP" : config?.managed ? "Managed" : "Provisioned"}
                  </small>
                </div>
              </div>
              <code>{shared ? provider.providerRef ?? provider.name : provider.id}</code>
              {config && <p className={styles.providerURL}>{config.url}</p>}
              {!example && (
                <div className={styles.row}>
                  <GammaButton
                    variant="secondary"
                    loading={busy === `test:${provider.id}`}
                    disabled={!!busy}
                    onClick={() => test(provider.id)}
                  >
                    {busy === `test:${provider.id}`
                      ? "Testing…"
                      : "Test connection"}
                  </GammaButton>
                  {config?.managed && (
                    <>
                      <GammaButton
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() => edit(config)}
                      >
                        Edit
                      </GammaButton>
                      <GammaButton
                        variant="quiet" size="sm"
                        iconOnly
                        disabled={!!busy}
                        aria-label={`Remove ${provider.name}`}
                        onClick={() => setRemove(provider.id)}
                      >
                        <Trash2 size={14} />
                      </GammaButton>
                    </>
                  )}
                </div>
              )}
              {shared && (
                <p className={styles.hint}>
                  Uses your Observability access and credentials. <Link className={styles.providerManageLink} href="/dashboard/observability/">Manage in Observability</Link>
                </p>
              )}
              {config && !config.managed && (
                <p className={styles.hint}>
                  Provisioned by your operator. Update the service configuration
                  to change this source.
                </p>
              )}
              {remove === provider.id && config?.managed && (
                <div className={styles.notice}>
                  Widgets and tooltip queries using this source will need a new provider.
                  <div className={styles.row}>
                    <GammaButton
                      variant="danger"
                      disabled={!!busy}
                      onClick={() => deleteProvider(config)}
                    >
                      Remove provider
                    </GammaButton>
                    <GammaButton
                      variant="secondary"
                      disabled={!!busy}
                      onClick={() => setRemove(null)}
                    >
                      Cancel removal
                    </GammaButton>
                  </div>
                </div>
              )}
            </article>
          )
        })}
        {!providers.length && (
          <p className={styles.notice}>No data sources connected yet.</p>
        )}
      </div>
      {!example && configs && !draft && (
        <GammaButton
          variant="primary"
          disabled={!!busy}
          onClick={() =>
            edit({ id: "", name: "", type: "prometheus", url: "" })
          }
        >
          <Plus size={14} /> {hasSharedProviders ? "Add standalone data source" : "Add data source"}
        </GammaButton>
      )}
      {draft && (
        <form
          noValidate
          className={styles.providerForm}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <h3>{draft.etag ? "Edit data source" : "New data source"}</h3>
          <label className={styles.field}>
            Provider ID
            <GammaInput
              value={draft.id}
              disabled={!!draft.etag || !!busy}
              maxLength={80}
              placeholder="production-metrics"
              onChange={(event) =>
                setDraft({ ...draft, id: event.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            Name
            <GammaInput
              disabled={!!busy}
              value={draft.name}
              maxLength={120}
              placeholder="Production Prometheus"
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            Provider type
            <GammaSelect
              aria-label="Provider type"
              disabled={!!busy}
              value={draft.type}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  type: value as ProviderConfig["type"],
                })
              }
              options={[
                {
                  value: "prometheus",
                  label: "Prometheus",
                  icon: <ProviderIcon type="prometheus" />,
                  description: "Time-series metrics",
                },
                {
                  value: "tempo",
                  label: "Tempo",
                  icon: <ProviderIcon type="tempo" />,
                  description: "Distributed traces",
                },
              ]}
            />
          </label>
          <label className={styles.field}>
            Endpoint URL
            <GammaInput
              disabled={!!busy}
              type="url"
              value={draft.url}
              placeholder="http://prometheus.monitoring.svc:9090"
              onChange={(event) =>
                setDraft({ ...draft, url: event.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            Bearer token environment variable
            <GammaInput
              disabled={!!busy}
              value={draft.bearerTokenEnv ?? ""}
              autoComplete="off"
              placeholder="PAPRIKA_PROVIDER_PROMETHEUS_TOKEN"
              onChange={(event) =>
                setDraft({ ...draft, bearerTokenEnv: event.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            Header environment variables
            <GammaTextarea
              aria-label="Header environment variables"
              disabled={!!busy}
              rows={3}
              spellCheck={false}
              value={headers}
              placeholder="X-Scope-OrgID: PAPRIKA_PROVIDER_TENANT"
              onChange={(event) => setHeaders(event.target.value)}
            />
          </label>
          <p className={styles.hint}>
            Enter variable names, never secret values. Your operator must define
            PAPRIKA_PROVIDER_* variables on the Insights service.
          </p>
          <div className={styles.row}>
            <GammaButton
              variant="primary"
              disabled={!!busy}
              loading={busy === "save"}
              type="submit"
            >
              {busy === "save" ? "Saving…" : "Save data source"}
            </GammaButton>
            <GammaButton
              variant="secondary"
              disabled={!!busy}
              type="button"
              onClick={() => setDraft(null)}
            >
              Cancel
            </GammaButton>
          </div>
        </form>
      )}
    </section>
  )
}
