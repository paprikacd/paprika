import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ObservabilityClient } from "@/app/dashboard/observability/observability-view"
import { ObservabilityView } from "@/app/dashboard/observability/observability-view"
import { DataState } from "@/gen/paprika/v1/api_pb"

const LIBRARY_NOT_CONFIGURED =
  "observability gateway is not configured; enable it to see the provider library"

const AWS_KEYS_HELP =
  "A JSON document with snake_case keys access_key_id, secret_access_key and optional session_token."

const CREDENTIAL_DOC = JSON.stringify({
  access_key_id: "AKIAIOSFODNN7EXAMPLE",
  secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
})

function summary(overrides: Record<string, unknown> = {}) {
  return {
    type: "aws-cloudwatch-logs",
    displayName: "Amazon CloudWatch Logs",
    vendor: "AWS",
    category: "logs",
    signals: ["logs"],
    summary: "Read Amazon CloudWatch Logs streams with the native filter pattern.",
    ...overrides,
  }
}

// The real catalog order: AWS, then Google Cloud, then the open-source
// backends. The console renders the server's order untouched.
function library() {
  return [
    summary({
      type: "aws-cloudtrail",
      displayName: "AWS CloudTrail",
      category: "audit",
      signals: ["audit"],
      summary: "Read AWS CloudTrail management events as an audit trail.",
    }),
    summary({
      type: "aws-xray",
      displayName: "AWS X-Ray",
      category: "traces",
      signals: ["traces"],
      summary: "Read AWS X-Ray trace summaries and fetch traces by ID.",
    }),
    summary(),
    summary({
      type: "aws-cloudwatch-metrics",
      displayName: "Amazon CloudWatch Metrics",
      category: "metrics",
      signals: ["metrics"],
      summary: "Read Amazon CloudWatch metrics with the native statistics API.",
    }),
    summary({
      type: "gcp-cloudlogging",
      displayName: "Google Cloud Logging",
      vendor: "Google Cloud",
      summary: "Read Google Cloud Logging entries.",
    }),
    summary({
      type: "gcp-cloudmonitoring",
      displayName: "Google Cloud Monitoring",
      vendor: "Google Cloud",
      category: "metrics",
      signals: ["metrics"],
      summary: "Read Google Cloud Monitoring metrics.",
    }),
    summary({
      type: "gcp-cloudtrace",
      displayName: "Google Cloud Trace",
      vendor: "Google Cloud",
      category: "traces",
      signals: ["traces"],
      summary: "Read Google Cloud Trace spans.",
    }),
    summary({
      type: "loki",
      displayName: "Grafana Loki",
      vendor: "Open source",
      summary: "Query logs through the Loki HTTP API.",
    }),
    summary({
      type: "tempo",
      displayName: "Grafana Tempo",
      vendor: "Open source",
      category: "traces",
      signals: ["traces"],
      summary: "Query traces through the Tempo HTTP API.",
    }),
    summary({
      type: "otlp",
      displayName: "OTLP / Jaeger",
      vendor: "Open source",
      category: "traces",
      signals: ["traces"],
      summary: "Query traces from any OTLP-compatible backend.",
    }),
    summary({
      type: "prometheus",
      displayName: "Prometheus",
      vendor: "Open source",
      category: "metrics",
      signals: ["metrics"],
      summary: "Query metrics with PromQL through the HTTP API.",
    }),
  ]
}

function field(overrides: Record<string, unknown> = {}) {
  return {
    key: "",
    label: "",
    input: "string",
    required: false,
    placeholder: "",
    help: "",
    secret: false,
    ...overrides,
  }
}

function cloudWatchLogsDetail() {
  return {
    type: "aws-cloudwatch-logs",
    displayName: "Amazon CloudWatch Logs",
    vendor: "AWS",
    category: "logs",
    signals: ["logs"],
    summary: "Read Amazon CloudWatch Logs streams with the native filter pattern.",
    description: "Reads log events from one log group.",
    configFields: [
      field({
        key: "region",
        label: "Region",
        required: true,
        placeholder: "us-east-1",
        help: "AWS region the backend resource lives in.",
      }),
      field({
        key: "logGroup",
        label: "Log group",
        required: true,
        help: "Name of the CloudWatch Logs log group to query.",
      }),
      field({
        key: "endpoint",
        label: "Endpoint",
        help: "Optional endpoint override.",
      }),
      field({
        key: "insecureSkipTLS",
        label: "Skip TLS verification",
        input: "boolean",
        help: "Accept self-signed certificates.",
      }),
    ],
    credential: { kind: "aws-keys", help: AWS_KEYS_HELP },
    steps: [
      {
        title: "Create a least-privilege policy",
        body: "The gateway needs two read actions on exactly one log group.",
        code: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"],
      "Resource": "*"
    }
  ]
}`,
      },
      {
        title: "Create the user and attach the policy",
        body: "One IAM user per consumer keeps revocation scoped.",
        code: "aws iam create-user --user-name paprika-observe",
      },
      {
        title: "Apply the provider manifest",
        body: "kubectl apply the manifest below.",
        code: "apiVersion: observability.paprika.io/v1alpha1\nkind: ObservabilityProvider",
      },
    ],
    probe: {
      signal: "logs",
      note: "A FilterLogEvents call limited to one event.",
    },
  }
}

function lokiDetail() {
  return {
    type: "loki",
    displayName: "Grafana Loki",
    vendor: "Open source",
    category: "logs",
    signals: ["logs"],
    summary: "Query logs through the Loki HTTP API.",
    description: "Reads log entries from Loki.",
    configFields: [
      field({
        key: "endpoint",
        label: "Endpoint",
        required: true,
        placeholder: "http://loki.observability:3100",
        help: "Absolute http(s) URL of the backend.",
      }),
      field({
        key: "headers",
        label: "Headers",
        input: "text",
        help: "One Name: value per line.",
      }),
      field({
        key: "insecureSkipTLS",
        label: "Skip TLS verification",
        input: "boolean",
        help: "Accept self-signed certificates.",
      }),
    ],
    credential: { kind: "none", help: "No credential is required by default." },
    steps: [
      {
        title: "Point the gateway at Loki",
        body: "kubectl apply the manifest below.",
        code: "apiVersion: observability.paprika.io/v1alpha1\nkind: ObservabilityProvider",
      },
    ],
    probe: { signal: "logs", note: "A labels query." },
  }
}

interface ClientOverrides {
  types?: unknown[]
  typesState?: DataState
  typesUnavailableReason?: string
  details?: Record<string, unknown>
  validateResult?: {
    state: DataState
    unavailableReason: string
    connectorState: string
    reason: string
  }
}

function client(overrides: ClientOverrides = {}) {
  const details = overrides.details ?? {}
  return {
    listObservabilityProviders: vi.fn(async () => ({
      items: [],
      total: BigInt(0),
      indexGeneration: BigInt(1),
    })),
    getObservabilityUsage: vi.fn(async () => ({
      state: DataState.OK,
      unavailableReason: "",
      observedAtUnixMs: BigInt(0),
      tools: [],
    })),
    listObservabilityProviderTypes: vi.fn(async () => ({
      state: overrides.typesState ?? DataState.OK,
      unavailableReason: overrides.typesUnavailableReason ?? "",
      types: overrides.types ?? library(),
    })),
    getObservabilityProviderType: vi.fn(
      async (req: { type: string }) => ({
        state: DataState.OK,
        unavailableReason: "",
        typeDetail: details[req.type],
      }),
    ),
    validateObservabilityProvider: vi.fn(
      async (req: {
        type: string
        configJson: Uint8Array
        credentials: string
      }) =>
        overrides.validateResult ?? {
          state: DataState.OK,
          unavailableReason: "",
          connectorState: "OK",
          reason: `probe of ${req.type} returned one event.`,
        },
    ),
    createObservabilityProvider: vi.fn(
      async (req: {
        name: string
        namespace: string
        type: string
        configJson: Uint8Array
        credentialSecretName: string
        credentialDocument: string
      }) => ({ name: req.name, namespace: req.namespace }),
    ),
  }
}

type FakeClient = ReturnType<typeof client>

function renderView(fake: FakeClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ObservabilityView client={fake as unknown as ObservabilityClient} />
    </QueryClientProvider>,
  )
}

async function openWizard(user: ReturnType<typeof userEvent.setup>) {
  const list = await screen.findByRole("list", { name: "Provider library" })
  const card = cardOf(list, "Amazon CloudWatch Logs")
  await user.click(within(card).getByRole("button", { name: "Set up" }))
  return card
}

// happy-dom does not compute listitem accessible names, so cards are
// located by their display-name heading and stepped up to the <li>.
function cardOf(list: HTMLElement, name: string | RegExp): HTMLElement {
  const heading = within(list).getByRole("heading", { name })
  const card = heading.closest("li")
  if (!card) throw new Error(`no library card for ${String(name)}`)
  return card as HTMLElement
}

describe("ProviderLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders one card per provider type the gateway reports", async () => {
    renderView(client())

    const list = await screen.findByRole("list", { name: "Provider library" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(11)
    expect(screen.getByText("11 types")).toBeInTheDocument()

    const card = cardOf(list, "Amazon CloudWatch Logs")
    expect(within(card).getByText("AWS · logs")).toBeInTheDocument()
    expect(within(card).getByText("logs")).toHaveAttribute(
      "data-tone",
      "unknown",
    )
    expect(
      within(card).getByText(/Read Amazon CloudWatch Logs streams/),
    ).toBeInTheDocument()
    expect(
      within(list).getAllByRole("button", { name: "Set up" }),
    ).toHaveLength(11)
  })

  it("renders the server's sentence instead of cards when the gateway is not wired in", async () => {
    renderView(
      client({
        typesState: DataState.NOT_CONFIGURED,
        typesUnavailableReason: LIBRARY_NOT_CONFIGURED,
      }),
    )

    expect(await screen.findByText(LIBRARY_NOT_CONFIGURED)).toBeInTheDocument()
    expect(
      screen.queryByRole("list", { name: "Provider library" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("11 types")).not.toBeInTheDocument()

    // The providers board does not depend on the gateway and still renders.
    expect(
      screen.getByText(/No observability providers\./),
    ).toBeInTheDocument()
  })

  it("walks through the onboarding steps and the config form", async () => {
    const user = userEvent.setup()
    const fake = client({ details: { "aws-cloudwatch-logs": cloudWatchLogsDetail() } })
    renderView(fake)

    await openWizard(user)

    // Server-authored steps, including a copyable code block.
    expect(
      await screen.findByText(/Create a least-privilege policy/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Create the user and attach the policy/)).toBeInTheDocument()
    expect(screen.getByText(/2012-10-17/)).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0)

    // Header: display name, summary, credential shape.
    expect(screen.getByText("AWS access keys")).toBeInTheDocument()

    // Config form fields for the connector's schema.
    expect(screen.getByLabelText("Region")).toBeInTheDocument()
    expect(screen.getByLabelText("Log group")).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", { name: "Skip TLS verification" }),
    ).toBeInTheDocument()

    // Identity defaults: name slugs from the type, namespace is fixed.
    expect(screen.getByLabelText("Provider name")).toHaveValue(
      "aws-cloudwatch-logs",
    )
    expect(screen.getByLabelText("Namespace")).toHaveValue("observability")
    expect(screen.getByLabelText("Credential document")).toBeInTheDocument()
    expect(screen.getByText(AWS_KEYS_HELP)).toBeInTheDocument()

    expect(fake.getObservabilityProviderType).toHaveBeenCalledWith(
      { type: "aws-cloudwatch-logs" },
      expect.anything(),
    )
  })

  it("maps a Forbidden probe verdict onto the degraded pill and the reason", async () => {
    const user = userEvent.setup()
    const fake = client({
      details: { "aws-cloudwatch-logs": cloudWatchLogsDetail() },
      validateResult: {
        state: DataState.OK,
        unavailableReason: "",
        connectorState: "Forbidden",
        reason: "the credential was refused by the backend",
      },
    })
    renderView(fake)

    await openWizard(user)
    await user.type(await screen.findByLabelText("Region"), "us-east-1")
    await user.type(screen.getByLabelText("Log group"), "/aws/eks/production")
    fireEvent.change(screen.getByLabelText("Credential document"), {
      target: { value: CREDENTIAL_DOC },
    })
    await user.click(screen.getByRole("button", { name: "Test connection" }))

    // A refused credential is still DATA_STATE_OK on the wire; the refusal
    // travels in connectorState and reason.
    expect(await screen.findByText("Forbidden")).toHaveAttribute(
      "data-tone",
      "degraded",
    )
    expect(
      screen.getByText("the credential was refused by the backend"),
    ).toBeInTheDocument()

    const req = fake.validateObservabilityProvider.mock.calls[0][0]
    expect(req.type).toBe("aws-cloudwatch-logs")
    expect(req.credentials).toBe(CREDENTIAL_DOC)
    expect(JSON.parse(new TextDecoder().decode(req.configJson))).toEqual({
      region: "us-east-1",
      logGroup: "/aws/eks/production",
      insecureSkipTLS: false,
    })
  })

  it("creates the provider with the encoded config, credential and default secret name", async () => {
    const user = userEvent.setup()
    const fake = client({ details: { "aws-cloudwatch-logs": cloudWatchLogsDetail() } })
    renderView(fake)

    await openWizard(user)
    await user.type(await screen.findByLabelText("Region"), "us-east-1")
    await user.type(screen.getByLabelText("Log group"), "/aws/eks/production")
    fireEvent.change(screen.getByLabelText("Credential document"), {
      target: { value: CREDENTIAL_DOC },
    })
    await user.click(screen.getByRole("button", { name: "Create provider" }))

    expect(await screen.findByText("Provider created")).toBeInTheDocument()

    const req = fake.createObservabilityProvider.mock.calls[0][0]
    expect(req.type).toBe("aws-cloudwatch-logs")
    expect(req.name).toBe("aws-cloudwatch-logs")
    expect(req.namespace).toBe("observability")
    expect(JSON.parse(new TextDecoder().decode(req.configJson))).toEqual({
      region: "us-east-1",
      logGroup: "/aws/eks/production",
      insecureSkipTLS: false,
    })
    expect(req.credentialDocument).toBe(CREDENTIAL_DOC)
    expect(req.credentialSecretName).toBe("aws-cloudwatch-logs-credentials")

    // "View providers" returns to the library and refreshes the providers
    // board so the new CR shows up.
    await user.click(screen.getByRole("button", { name: "View providers" }))
    expect(
      await screen.findByRole("list", { name: "Provider library" }),
    ).toBeInTheDocument()
    expect(fake.listObservabilityProviders.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("parses the headers textarea into an object at submit time", async () => {
    const user = userEvent.setup()
    const fake = client({ details: { loki: lokiDetail() } })
    renderView(fake)

    const list = await screen.findByRole("list", { name: "Provider library" })
    const card = cardOf(list, "Grafana Loki")
    await user.click(within(card).getByRole("button", { name: "Set up" }))

    await user.type(
      await screen.findByLabelText("Endpoint"),
      "http://loki.observability:3100",
    )
    fireEvent.change(screen.getByLabelText("Headers"), {
      target: {
        value: "X-Scope-OrgID: tenant-a\n\nX-Custom: keep: this: literal",
      },
    })
    await user.click(screen.getByRole("button", { name: "Create provider" }))

    expect(await screen.findByText("Provider created")).toBeInTheDocument()
    const req = fake.createObservabilityProvider.mock.calls[0][0]
    expect(JSON.parse(new TextDecoder().decode(req.configJson))).toEqual({
      endpoint: "http://loki.observability:3100",
      headers: {
        "X-Scope-OrgID": "tenant-a",
        "X-Custom": "keep: this: literal",
      },
      insecureSkipTLS: false,
    })
    // kind "none": no credential material, no secret name.
    expect(req.credentialDocument).toBe("")
    expect(req.credentialSecretName).toBe("")
  })

  it("returns to the library without creating anything", async () => {
    const user = userEvent.setup()
    const fake = client({ details: { "aws-cloudwatch-logs": cloudWatchLogsDetail() } })
    renderView(fake)

    await openWizard(user)
    expect(
      await screen.findByText(/Create a least-privilege policy/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("list", { name: "Provider library" }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Back to library" }))

    expect(
      await screen.findByRole("list", { name: "Provider library" }),
    ).toBeInTheDocument()
    expect(fake.createObservabilityProvider).not.toHaveBeenCalled()
    expect(fake.validateObservabilityProvider).not.toHaveBeenCalled()
  })
})
