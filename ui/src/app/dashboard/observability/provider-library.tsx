"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

import type { ObservabilityClient } from "@/app/dashboard/observability/observability-view"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { StatusPill } from "@/components/ui/status-chip"
import {
  DataState,
  type ProviderTypeDetail,
  type ProviderTypeField,
  type ValidateObservabilityProviderResponse,
} from "@/gen/paprika/v1/api_pb"
import { copyToClipboard } from "@/lib/clipboard"
import type { StatusTone } from "@/lib/status-tone"

/**
 * Board 00 — the provider-type library and its onboarding wizard.
 *
 * The library itself is gateway data, so it follows the same degraded-mode
 * contract as the usage board: when `ListObservabilityProviderTypes` answers
 * with a non-OK `DataState`, the board renders the server's
 * `unavailableReason` sentence verbatim instead of an empty grid. An empty
 * library and an unreachable gateway are different statements; the state
 * field keeps them apart.
 *
 * Selecting "Set up" swaps the board's content for the wizard — the page
 * chrome and the boards below stay mounted. The wizard renders the
 * server-authored onboarding steps and config schema, offers an optional
 * probe through `ValidateObservabilityProvider`, and only talks to
 * `CreateObservabilityProvider` when the operator commits.
 */

const counter = new Intl.NumberFormat("en-US")

const fieldLabelClass =
  "font-mono text-kicker uppercase tracking-[0.14em] text-muted-foreground"
const inputClass =
  "w-full border border-rule bg-background px-3 py-2 font-mono text-note placeholder:text-muted-foreground/60 focus:border-foreground/40 focus:outline-none"

export function ProviderLibrary({ client }: { client: ObservabilityClient }) {
  const [selected, setSelected] = useState("")
  const queryClient = useQueryClient()

  const types = useQuery({
    queryKey: ["console", "observability-provider-types"],
    queryFn: async ({ signal }) =>
      client.listObservabilityProviderTypes({}, { signal }),
    staleTime: 300_000,
  })

  const entries = types.data?.types ?? []

  async function handleCreated() {
    // The new CR lands on the api-server's cluster; make the providers
    // board (01) refetch before the library comes back into view.
    await queryClient.invalidateQueries({
      queryKey: ["console", "observability-providers"],
    })
    setSelected("")
  }

  return (
    <Blueprint>
      <BoardHeader
        index="00"
        title="Provider library"
        meta={
          types.data && types.data.state === DataState.OK
            ? `${counter.format(entries.length)} types`
            : undefined
        }
        actions={
          selected ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="font-mono text-kicker uppercase tracking-[0.14em]"
              onClick={() => setSelected("")}
            >
              Back to library
            </Button>
          ) : undefined
        }
      />
      {selected ? (
        <ProviderSetupWizard
          key={selected}
          client={client}
          type={selected}
          onCreated={handleCreated}
        />
      ) : types.isPending ? (
        <p
          role="status"
          aria-live="polite"
          className="px-3.5 py-5 text-reason text-muted-foreground"
        >
          Loading provider types.
        </p>
      ) : types.isError ? (
        <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
          Paprika could not list provider types. Nothing here is missing; it is
          unknown.
        </p>
      ) : types.data && types.data.state !== DataState.OK ? (
        // Degraded-mode contract, same as the usage board: the server
        // declares the surface unavailable and explains why in its own
        // words.
        <div role="status" className="px-3.5 py-5">
          <p className="text-reason text-neutral-800">
            {types.data.unavailableReason ||
              "The provider library is not available on this server."}
          </p>
        </div>
      ) : entries.length === 0 ? (
        <p role="status" className="px-3.5 py-6 text-reason text-muted-foreground">
          No provider types. The observability gateway did not report any.
        </p>
      ) : (
        <ul
          aria-label="Provider library"
          className="grid grid-cols-1 gap-px bg-rule sm:grid-cols-2 xl:grid-cols-3"
        >
          {entries.map((entry) => (
            <li key={entry.type} className="flex flex-col gap-2 bg-card p-3.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-cond text-name font-semibold tracking-[0.02em]">
                  {entry.displayName}
                </h3>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="rounded-[2px] font-mono text-kicker uppercase tracking-[0.14em]"
                  onClick={() => setSelected(entry.type)}
                >
                  Set up
                </Button>
              </div>
              <p className="font-mono text-meta text-muted-foreground">
                {entry.vendor} · {entry.category}
              </p>
              {entry.signals.length === 0 ? (
                <p className="font-mono text-note text-muted-foreground">
                  not reported
                </p>
              ) : (
                <p className="flex flex-wrap gap-1">
                  {entry.signals.map((signal) => (
                    <StatusPill key={signal} tone="unknown" label={signal} />
                  ))}
                </p>
              )}
              <p className="text-reason text-muted-foreground">
                {entry.summary}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Blueprint>
  )
}

function ProviderSetupWizard({
  client,
  type,
  onCreated,
}: {
  client: ObservabilityClient
  type: string
  onCreated: () => void
}) {
  const detail = useQuery({
    queryKey: ["console", "observability-provider-type", type],
    queryFn: async ({ signal }) =>
      client.getObservabilityProviderType({ type }, { signal }),
    staleTime: 300_000,
  })

  return detail.isPending ? (
    <p
      role="status"
      aria-live="polite"
      className="px-3.5 py-5 text-reason text-muted-foreground"
    >
      Loading provider type.
    </p>
  ) : detail.isError ? (
    <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
      Paprika could not describe the provider type. Nothing here is missing;
      it is unknown.
    </p>
  ) : detail.data && detail.data.state !== DataState.OK ? (
    <div role="status" className="px-3.5 py-5">
      <p className="text-reason text-neutral-800">
        {detail.data.unavailableReason ||
          "This provider type is not available on this server."}
      </p>
    </div>
  ) : detail.data?.typeDetail ? (
    <WizardBody
      client={client}
      detail={detail.data.typeDetail}
      onCreated={onCreated}
    />
  ) : null
}

function WizardBody({
  client,
  detail,
  onCreated,
}: {
  client: ObservabilityClient
  detail: ProviderTypeDetail
  onCreated: () => void
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [credential, setCredential] = useState("")
  const [name, setName] = useState(detail.type)
  const [namespace, setNamespace] = useState("observability")
  const [testing, setTesting] = useState(false)
  const [verdict, setVerdict] =
    useState<ValidateObservabilityProviderResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)
  const [actionError, setActionError] = useState("")

  const needsCredential = !!detail.credential && detail.credential.kind !== "none"

  function setValue(key: string, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  function configObject(): Record<string, unknown> {
    const config: Record<string, unknown> = {}
    for (const field of detail.configFields) {
      const value = values[field.key]
      if (field.input === "boolean") {
        config[field.key] = value === true
        continue
      }
      const text = typeof value === "string" ? value.trim() : ""
      if (!text) continue
      if (field.input === "integer") {
        // Numeric knobs (the mock backend's payload shaping) submit as
        // JSON numbers so server-side integer validation applies; a
        // non-integer value is left out so the connector default stands.
        const n = Number(text)
        if (Number.isInteger(n)) config[field.key] = n
        continue
      }
      config[field.key] = field.key === "headers" ? parseHeaders(text) : text
    }
    return config
  }

  function missingRequired(): ProviderTypeField[] {
    return detail.configFields.filter((field) => {
      if (!field.required || field.input === "boolean") return false
      const value = values[field.key]
      return !(typeof value === "string" && value.trim())
    })
  }

  async function handleTest() {
    setActionError("")
    setVerdict(null)
    setTesting(true)
    try {
      setVerdict(
        await client.validateObservabilityProvider({
          type: detail.type,
          configJson: new TextEncoder().encode(JSON.stringify(configObject())),
        }),
      )
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  async function handleCreate() {
    const missing = missingRequired()
    if (missing.length > 0) {
      setActionError(
        `Fill in every required field: ${missing
          .map((field) => field.label)
          .join(", ")}.`,
      )
      return
    }
    setActionError("")
    setCreating(true)
    try {
      await client.createObservabilityProvider({
        name,
        namespace,
        type: detail.type,
        configJson: new TextEncoder().encode(JSON.stringify(configObject())),
        credentialSecretName:
          needsCredential && credential ? `${name}-credentials` : "",
        credentialDocument: needsCredential ? credential : "",
      })
      setCreated(true)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void handleCreate()
      }}
    >
      {/* Header: identity, summary, credential shape. */}
      <div className="border-b border-rule px-3.5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-cond text-name font-semibold tracking-[0.02em]">
            {detail.displayName}
          </h3>
          <StatusPill
            tone="unknown"
            label={credentialKindLabel(detail.credential?.kind)}
          />
        </div>
        <p className="mt-1 text-reason text-muted-foreground">
          {detail.summary}
        </p>
        <p className="mt-1 font-mono text-meta text-muted-foreground">
          {detail.vendor} · {detail.category}
        </p>
      </div>

      {/* Onboarding steps, authored by the gateway. */}
      {detail.steps.length > 0 ? (
        <div className="border-b border-rule px-3.5 py-4">
          <p className={fieldLabelClass}>Setup guide</p>
          <ol className="mt-3 space-y-4">
            {detail.steps.map((step, index) => (
              <li key={`${index}-${step.title}`}>
                <p className="font-cond text-name font-semibold">
                  {index + 1}. {step.title}
                </p>
                <p className="mt-1 text-reason text-muted-foreground">
                  {step.body}
                </p>
                {step.code ? <CodeBlock code={step.code} /> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* Connector config, one input per server-declared field. */}
      <div className="space-y-4 border-b border-rule px-3.5 py-4">
        <p className={fieldLabelClass}>Configuration</p>
        {detail.configFields.map((field) => (
          <ConfigField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}
      </div>

      {/* Identity and credential material. */}
      <div className="space-y-4 border-b border-rule px-3.5 py-4">
        <p className={fieldLabelClass}>Provider</p>
        <div>
          <FieldLabel htmlFor="provider-name" required>
            Provider name
          </FieldLabel>
          <input
            id="provider-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-reason text-muted-foreground">
            Name of the ObservabilityProvider CR. Defaults to the connector
            type.
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="provider-namespace" required>
            Namespace
          </FieldLabel>
          <input
            id="provider-namespace"
            type="text"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-reason text-muted-foreground">
            Namespace hosting the CR and the credential Secret.
          </p>
        </div>
        {needsCredential ? (
          <div>
            <FieldLabel htmlFor="provider-credential">
              Credential document
            </FieldLabel>
            <textarea
              id="provider-credential"
              rows={5}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              className={inputClass}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-reason text-muted-foreground">
              {detail.credential?.help}
            </p>
            <p className="mt-1 font-mono text-meta text-muted-foreground">
              Write-only: the document is sent to the server and never echoed
              back.
            </p>
          </div>
        ) : null}
      </div>

      {/* Offline config validation; connectivity requires an approved provider. */}
      <div className="px-3.5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest()}
            disabled={testing || creating || created}
          >
            {testing ? "Validating configuration..." : "Validate configuration"}
          </Button>
          <Button type="submit" disabled={testing || creating || created}>
            {creating ? "Creating provider..." : "Create provider"}
          </Button>
        </div>

        {testing ? (
          <p
            role="status"
            className="mt-3 text-reason text-muted-foreground"
          >
            Validating configuration.
          </p>
        ) : null}

        {verdict && !testing ? (
          verdict.state !== DataState.OK ? (
            <div role="status" className="mt-3">
              <p className="text-reason text-neutral-800">
                {verdict.unavailableReason ||
                  "The observability gateway could not validate this configuration."}
              </p>
            </div>
          ) : (
            // This verdict describes syntax only. No backend request is made.
            <div role="status" className="mt-3">
              <StatusPill
                tone={connectorStateTone(verdict.connectorState)}
                label={verdict.connectorState || "Unknown"}
              />
              {verdict.reason ? (
                <p className="mt-1 text-reason text-muted-foreground">
                  {verdict.reason}
                </p>
              ) : null}
            </div>
          )
        ) : null}

        {actionError ? (
          <p role="alert" className="mt-3 text-reason text-muted-foreground">
            {actionError}
          </p>
        ) : null}

        {created ? (
          <div
            role="status"
            className="mt-3 border border-status-healthy-line bg-status-healthy-fill px-3.5 py-3"
          >
            <p className="font-cond text-name font-semibold">Provider created</p>
            <p className="mt-0.5 font-mono text-meta text-muted-foreground">
              {namespace}/{name}
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="mt-2 rounded-[2px] font-mono text-kicker uppercase tracking-[0.14em]"
              onClick={onCreated}
            >
              View providers
            </Button>
          </div>
        ) : null}
      </div>
    </form>
  )
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: ProviderTypeField
  value: string | boolean | undefined
  onChange: (value: string | boolean) => void
}) {
  const id = `provider-field-${field.key}`
  return (
    <div>
      {field.input === "boolean" ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          <label htmlFor={id} className={fieldLabelClass}>
            {field.label}
          </label>
        </div>
      ) : field.input === "text" ? (
        <>
          <FieldLabel htmlFor={id} required={field.required}>
            {field.label}
          </FieldLabel>
          <textarea
            id={id}
            rows={4}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder || undefined}
            aria-required={field.required || undefined}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </>
      ) : field.input === "integer" ? (
        <>
          <FieldLabel htmlFor={id} required={field.required}>
            {field.label}
          </FieldLabel>
          <input
            id={id}
            type="number"
            step={1}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder || undefined}
            aria-required={field.required || undefined}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </>
      ) : (
        <>
          <FieldLabel htmlFor={id} required={field.required}>
            {field.label}
          </FieldLabel>
          <input
            id={id}
            type={field.secret ? "password" : "text"}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder || undefined}
            aria-required={field.required || undefined}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </>
      )}
      {field.help ? (
        <p className="mt-1 text-reason text-muted-foreground">{field.help}</p>
      ) : null}
    </div>
  )
}

function FieldLabel({
  htmlFor,
  required = false,
  children,
}: {
  htmlFor: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <label htmlFor={htmlFor} className={fieldLabelClass}>
        {children}
      </label>
      {required ? (
        <span className="font-mono text-meta text-muted-foreground">
          (required)
        </span>
      ) : null}
    </div>
  )
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await copyToClipboard(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the snippet is still on screen.
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between border border-rule border-b-0 bg-inset px-3.5 py-1">
        <span aria-hidden className="font-mono text-meta text-muted-foreground">
          ·
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="font-mono text-kicker uppercase tracking-[0.14em]"
          onClick={() => void handleCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto border border-rule bg-inset px-3.5 py-2.5 font-mono text-meta whitespace-pre">
        {code}
      </pre>
    </div>
  )
}

function credentialKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "aws-keys":
      return "AWS access keys"
    case "gcp-service-account":
      return "Google service account"
    case "none":
      return "No credentials"
    default:
      return kind ? kind : "Unknown"
  }
}

/**
 * Probe verdicts arrive in the connector's own vocabulary, so the mapping is
 * an explicit switch: a state word the console has never seen lands on
 * `unknown`, never on a guessed tone.
 */
function connectorStateTone(state: string): StatusTone {
  switch (state) {
    case "OK":
      return "healthy"
    case "Forbidden":
      return "degraded"
    case "NotConfigured":
    case "NotAvailable":
      return "pending"
    case "Error":
      return "failed"
    default:
      return "unknown"
  }
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(":")
    if (at === -1) continue
    const name = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (name) headers[name] = value
  }
  return headers
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
