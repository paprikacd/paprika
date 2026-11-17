// Package catalog is the provider-type library for the observability
// gateway: one TypeInfo entry per backend the gateway can connect to,
// carrying the display metadata, config-field schema, credential shape,
// onboarding walkthrough and probe shape that the console library browser,
// the MCP describe tool and the onboarding wizard all render from.
//
// The package is pure metadata: it imports only the connector vocabulary
// (provider-type names and signal constants), never the connectors
// themselves, so it builds independently of connector packages landing on
// their own schedules. Strings are operator-facing and fixed — no backend
// output or credential detail ever flows into this data, so every entry is
// safe to serialize to the React console as-is.
//
// The library is authored once in the catalog variable below and exposed
// sorted by Vendor, then DisplayName — the deterministic order the library
// view renders.
package catalog

import (
	"cmp"
	"slices"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// TypeInfo is the full library entry for one provider type: everything a
// library browser, a describe tool or an onboarding wizard needs to present
// and configure the backend, in one JSON-friendly document.
type TypeInfo struct {
	Type         string             `json:"type"`
	DisplayName  string             `json:"displayName"`
	Vendor       string             `json:"vendor"`
	Category     string             `json:"category"`
	Signals      []connector.Signal `json:"signals"`
	Summary      string             `json:"summary"`
	Description  string             `json:"description"`
	ConfigFields []Field            `json:"configFields"`
	Credential   CredentialInfo     `json:"credential"`
	Steps        []Step             `json:"steps"`
	Probe        Probe              `json:"probe"`
}

// Field is one config-document key rendered as a form input. Key is the
// connector's config key; Secret marks inputs the wizard renders as
// password fields and never echoes back.
type Field struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Input       string `json:"input"`
	Required    bool   `json:"required"`
	Placeholder string `json:"placeholder,omitempty"`
	Help        string `json:"help"`
	Secret      bool   `json:"secret"`
}

// CredentialInfo describes the credential document a provider type accepts:
// the kind selector and a fixed explanation of what the document is and
// where it lives — a Secret the operator creates, referenced by the CR's
// credentialsSecretRef.
type CredentialInfo struct {
	Kind string `json:"kind"`
	Help string `json:"help"`
}

// Step is one onboarding walkthrough entry: a short instruction and,
// where the action is a command or document, a copyable snippet.
type Step struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Code  string `json:"code,omitempty"`
}

// Probe is the health-check query shape: the cheapest read the gateway runs
// against a configured provider to prove it is reachable and authorized.
type Probe struct {
	Signal connector.Signal `json:"signal"`
	Note   string           `json:"note"`
}

// TypeSummary is the light projection of a TypeInfo for the library list
// view: identity and one-sentence pitch only, no config schema or
// walkthrough. The wire shape is deliberately a subset of TypeInfo's keys.
type TypeSummary struct {
	Type        string             `json:"type"`
	DisplayName string             `json:"displayName"`
	Vendor      string             `json:"vendor"`
	Category    string             `json:"category"`
	Signals     []connector.Signal `json:"signals"`
	Summary     string             `json:"summary"`
}

// Vendor vocabulary for the library view.
const (
	vendorAWS         = "AWS"
	vendorGoogleCloud = "Google Cloud"
	vendorOpenSource  = "Open source"
	vendorPaprika     = "Paprika"
	vendorVultr       = "Vultr"
)

// Category vocabulary for the library view.
const (
	categoryLogs        = "logs"
	categoryMetrics     = "metrics"
	categoryTraces      = "traces"
	categoryAudit       = "audit"
	categoryTest        = "test"
	categoryApplication = "application"
)

// Credential kinds, shared by every entry's CredentialInfo.Kind.
//
//nolint:gosec // G101 false positive: a credential-kind selector vocabulary, not a credential (same as mcp.ObservabilityTokenAudience).
const (
	credentialKindNone              = "none"
	credentialKindAWSKeys           = "aws-keys"
	credentialKindGCPServiceAccount = "gcp-service-account"
	credentialKindVultrAPIKey       = "vultr-api-key"
)

// noCredential is the credential shape of the four endpoint-based
// open-source connectors: anonymous by default, with the OPTIONAL
// credentialsSecretRef convention on top — a document containing
// "user:password" selects HTTP Basic, anything else a Bearer token.
var noCredential = CredentialInfo{
	Kind: credentialKindNone,
	Help: "No credential is required by default. Setting credentialsSecretRef is optional: a document containing user:password is sent as HTTP Basic auth, anything else as an Authorization: Bearer token. Label that Secret observability.paprika.io/credentials=true: the gateway reads no other Secret.",
}

// gcpServiceAccountCredential is the credential shape of the three Google
// Cloud connectors — the same document restriction the cluster provider
// applies — with Workload Identity as the keyless GKE alternative.
var gcpServiceAccountCredential = CredentialInfo{
	Kind: credentialKindGCPServiceAccount,
	Help: "A Google credential JSON — service_account, external_account or impersonated_service_account — stored as the credentials key (the default) of a Secret you create, referenced by credentialsSecretRef. Label that Secret observability.paprika.io/credentials=true: the gateway reads no other Secret. On GKE, omit credentialsSecretRef and attach Workload Identity to the gateway's service account instead.",
}

// vultrAPICredential is the credential shape of the Vultr connector: a raw
// API key, sent as an Authorization: Bearer token — the same credential
// document the Vultr cluster provider accepts.
var vultrAPICredential = CredentialInfo{
	Kind: credentialKindVultrAPIKey,
	Help: "A raw Vultr API key, stored as the credentials key (the default) of a Secret you create, referenced by credentialsSecretRef. Label that Secret observability.paprika.io/credentials=true: the gateway reads no other Secret. The key is sent as an Authorization: Bearer token to the Vultr v2 API.",
}

// awsKeysCredential is the credential shape of the four AWS connectors: the
// snake_case JSON document the EKS cluster provider already accepts, with
// the ambient SDK chain (IRSA, IMDS) as the keyless EKS alternative.
var awsKeysCredential = CredentialInfo{
	Kind: credentialKindAWSKeys,
	Help: "A JSON document with snake_case keys access_key_id, secret_access_key and optional session_token — the same document shape the EKS cluster provider accepts — stored as the credentials key (the default) of a Secret you create, referenced by credentialsSecretRef. On EKS, omit credentialsSecretRef and let the ambient SDK chain supply credentials instead. Label that Secret observability.paprika.io/credentials=true: the gateway reads no other Secret.",
}

// insecureSkipTLSField is the TLS opt-in shared by every connector whose
// endpoint may be a self-signed in-cluster backend.
func insecureSkipTLSField() Field {
	return Field{
		Key:   "insecureSkipTLS",
		Label: "Skip TLS verification",
		Input: "boolean",
		Help:  "Accept self-signed certificates. Never enable this for public endpoints.",
	}
}

// httpConfigFields is the config schema shared by the four endpoint-based
// open-source connectors: a required endpoint plus the two optional
// request-shaping keys.
func httpConfigFields(placeholder string) []Field {
	return []Field{
		{
			Key:         "endpoint",
			Label:       "Endpoint",
			Input:       "string",
			Required:    true,
			Placeholder: placeholder,
			Help:        "Absolute http(s) URL of the backend.",
		},
		{
			Key:   "headers",
			Label: "Headers",
			Input: "text",
			Help:  "One Name: value per line, applied to every backend request — use it for multi-tenant headers such as X-Scope-OrgID.",
		},
		insecureSkipTLSField(),
	}
}

// gcpConfigFields is the config schema shared by the three Google Cloud
// connectors: an optional project override, an optional endpoint override
// (private proxies and fakes only — the vendor endpoint is the default) and
// the TLS opt-in.
func gcpConfigFields(endpointHelp string) []Field {
	return []Field{
		{
			Key:   "projectId",
			Label: "Project ID",
			Input: "string",
			Help:  "Defaults to the project named by the credential.",
		},
		{
			Key:   "endpoint",
			Label: "Endpoint",
			Input: "string",
			Help:  endpointHelp,
		},
		insecureSkipTLSField(),
	}
}

// awsConfigFields is the config schema shared by the four AWS connectors: a
// required region, the connector's one required selector (logGroup or
// namespace; nil for backends scoped by region alone), an optional endpoint
// override and the TLS opt-in.
func awsConfigFields(selector *Field) []Field {
	fields := []Field{{
		Key:         "region",
		Label:       "Region",
		Input:       "string",
		Required:    true,
		Placeholder: "us-east-1",
		Help:        "AWS region the backend resource lives in.",
	}}
	if selector != nil {
		fields = append(fields, *selector)
	}
	return append(fields,
		Field{
			Key:   "endpoint",
			Label: "Endpoint",
			Input: "string",
			Help:  "Optional. Set only for VPC endpoints or in-cluster emulators; the AWS service endpoint is derived from the region otherwise.",
		},
		insecureSkipTLSField(),
	)
}

// intField is one optional integer config key rendered as a number input —
// the shape every mock tuning knob uses.
func intField(key, label, help string) Field {
	return Field{
		Key:   key,
		Label: label,
		Input: "integer",
		Help:  help,
	}
}

// awsIdentitySteps is the credential-issuing walkthrough shared by every
// AWS connector: create the dedicated user, attach the per-connector policy
// authored in the first step, mint access keys, or skip all of it on EKS
// with IRSA.
func awsIdentitySteps(policyName string) []Step {
	return []Step{
		{
			Title: "Create the user and attach the policy",
			Body:  "One IAM user per consumer keeps revocation scoped to the gateway.",
			Code: "aws iam create-user --user-name paprika-observe\n" +
				"aws iam put-user-policy --user-name paprika-observe \\\n" +
				"  --policy-name " + policyName + " --policy-document file://policy.json",
		},
		{
			Title: "Create access keys",
			Body:  "The command's JSON output uses exactly the snake_case keys of the credential document; store it as the credentials key of the Secret referenced by credentialsSecretRef.",
			Code:  "aws iam create-access-key --user-name paprika-observe",
		},
		{
			Title: "On EKS, use IRSA instead",
			Body:  "Annotate the gateway's service account with the IAM role and create the provider with no credentialsSecretRef — the SDK chain then supplies short-lived role credentials.",
			Code: "kubectl annotate serviceaccount <gateway-sa> -n <ns> \\\n" +
				"  eks.amazonaws.com/role-arn=arn:aws:iam::<ACCOUNT_ID>:role/paprika-observe",
		},
	}
}

// applyStep is the closing walkthrough entry: apply the provider manifest
// and confirm the provider reports a healthy state.
func applyStep(yaml string) Step {
	return Step{
		Title: "Apply the provider",
		Body:  "Apply the manifest below; the provider is ready once its state reports OK.",
		Code:  yaml,
	}
}

// catalog is the authoritative provider-type library, authored once at
// build time. All and Summaries project it; nothing mutates it at runtime.
var catalog = []TypeInfo{
	shortedProvider(),
	uptimeProvider(),
	postgresqlProvider(),
	{
		Type:         connector.ProviderAWSCloudTrail,
		DisplayName:  "AWS CloudTrail",
		Vendor:       vendorAWS,
		Category:     categoryAudit,
		Signals:      []connector.Signal{connector.SignalLogs},
		Summary:      "Read AWS CloudTrail audit events with the native lookup.",
		Description:  "Reads audit events from AWS CloudTrail using an access-key credential or the ambient SDK chain (IRSA on EKS). The Query argument is a comma-separated Key=Value lookup list, e.g. EventName=RunInstances,EventCategory=Activity, and may be empty for all events.",
		ConfigFields: awsConfigFields(nil),
		Credential:   awsKeysCredential,
		Steps: append(append([]Step{{
			Title: "Create a least-privilege policy",
			Body:  "The gateway needs one read action. Create the policy below scoped to the account whose trail events it will read.",
			Code: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cloudtrail:LookupEvents"],
      "Resource": "*"
    }
  ]
}`,
		}}, awsIdentitySteps("paprika-observe-trail")...),
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: cloudtrail
  namespace: paprika-e2e
spec:
  type: aws-cloudtrail
  config:
    region: us-east-1
  credentialsSecretRef:
    name: cloudtrail-credentials`)),
		Probe: Probe{
			Signal: connector.SignalLogs,
			Note:   "A LookupEvents call with maxResults 1 against the configured region.",
		},
	},
	{
		Type:         connector.ProviderAWSXRay,
		DisplayName:  "AWS X-Ray",
		Vendor:       vendorAWS,
		Category:     categoryTraces,
		Signals:      []connector.Signal{connector.SignalTraces},
		Summary:      "Read AWS X-Ray trace summaries and fetch traces by ID.",
		Description:  "Reads trace summaries and traces from AWS X-Ray using an access-key credential or the ambient SDK chain (IRSA on EKS). The Query argument is an X-Ray filter expression and may be empty for all traces; a trace ID instead fetches one trace.",
		ConfigFields: awsConfigFields(nil),
		Credential:   awsKeysCredential,
		Steps: append(append([]Step{{
			Title: "Create a least-privilege policy",
			Body:  "The gateway needs two read actions. Create the policy below scoped to the account whose traces it will read.",
			Code: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
      "Resource": "*"
    }
  ]
}`,
		}}, awsIdentitySteps("paprika-observe-xray")...),
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: xray
  namespace: paprika-e2e
spec:
  type: aws-xray
  config:
    region: us-east-1
  credentialsSecretRef:
    name: xray-credentials`)),
		Probe: Probe{
			Signal: connector.SignalTraces,
			Note:   "A GetTraceSummaries call over a one-minute window, limited to one trace.",
		},
	},
	{
		Type:        connector.ProviderAWSCloudWatchLogs,
		DisplayName: "Amazon CloudWatch Logs",
		Vendor:      vendorAWS,
		Category:    categoryLogs,
		Signals:     []connector.Signal{connector.SignalLogs},
		Summary:     "Read Amazon CloudWatch Logs streams with the native filter pattern.",
		Description: "Reads log events from one Amazon CloudWatch Logs log group using an access-key credential or the ambient SDK chain (IRSA on EKS). The Query argument is the CloudWatch filter pattern and may be empty.",
		ConfigFields: awsConfigFields(&Field{
			Key:      "logGroup",
			Label:    "Log group",
			Input:    "string",
			Required: true,
			Help:     "Name of the CloudWatch Logs log group to query.",
		}),
		Credential: awsKeysCredential,
		Steps: append(append([]Step{{
			Title: "Create a least-privilege policy",
			Body:  "The gateway needs two read actions on exactly one log group. Create the policy below scoped to that log group's ARN.",
			Code: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"],
      "Resource": "arn:aws:logs:<REGION>:<ACCOUNT_ID>:log-group:<LOG_GROUP>"
    }
  ]
}`,
		}}, awsIdentitySteps("paprika-observe-logs")...),
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: cloudwatch-logs
  namespace: paprika-e2e
spec:
  type: aws-cloudwatch-logs
  config:
    region: us-east-1
    logGroup: /aws/eks/production
  credentialsSecretRef:
    name: cloudwatch-logs-credentials`)),
		Probe: Probe{
			Signal: connector.SignalLogs,
			Note:   "A FilterLogEvents call limited to one event on the configured log group.",
		},
	},
	{
		Type:        connector.ProviderAWSCloudWatchMetrics,
		DisplayName: "Amazon CloudWatch Metrics",
		Vendor:      vendorAWS,
		Category:    categoryMetrics,
		Signals:     []connector.Signal{connector.SignalMetrics},
		Summary:     "Read Amazon CloudWatch metrics with the native statistics API.",
		Description: "Reads metric statistics from one Amazon CloudWatch namespace using an access-key credential or the ambient SDK chain (IRSA on EKS). The Query argument is the metric name; the period derives from the query window.",
		ConfigFields: awsConfigFields(&Field{
			Key:         "namespace",
			Label:       "Metric namespace",
			Input:       "string",
			Required:    true,
			Placeholder: "AWS/ECS",
			Help:        "CloudWatch metric namespace, for example AWS/ECS.",
		}),
		Credential: awsKeysCredential,
		Steps: append(append([]Step{{
			Title: "Create a least-privilege policy",
			Body:  "The gateway needs two read actions. Create the policy below; CloudWatch does not support resource-level permissions for these actions, so the resource is *.",
			Code: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:ListMetrics", "cloudwatch:GetMetricStatistics"],
      "Resource": "*"
    }
  ]
}`,
		}}, awsIdentitySteps("paprika-observe-metrics")...),
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: cloudwatch-metrics
  namespace: paprika-e2e
spec:
  type: aws-cloudwatch-metrics
  config:
    region: us-east-1
    namespace: AWS/ECS
  credentialsSecretRef:
    name: cloudwatch-metrics-credentials`)),
		Probe: Probe{
			Signal: connector.SignalMetrics,
			Note:   "A ListMetrics call for the configured namespace.",
		},
	},
	{
		Type:         connector.ProviderGCPCloudLogging,
		DisplayName:  "Google Cloud Logging",
		Vendor:       vendorGoogleCloud,
		Category:     categoryLogs,
		Signals:      []connector.Signal{connector.SignalLogs},
		Summary:      "Read Google Cloud Logging entries — application, audit, and platform logs — with the native filter language.",
		Description:  "Reads entries from Google Cloud Logging — application, audit, and platform logs — using a Google service-account credential or GKE Workload Identity. The Query argument is the advanced logs filter, e.g. logName=\"projects/<p>/logs/cloudaudit.googleapis.com%2Factivity\". Admin Activity audit logs are readable with logging.viewer; Data Access requires logging.privateLogViewer.",
		ConfigFields: gcpConfigFields("Only for private proxies or fakes — defaults to logging.googleapis.com."),
		Credential:   gcpServiceAccountCredential,
		Steps:        gcpReadOnlySteps("cloud-logging", connector.ProviderGCPCloudLogging, "logging.logEntries.list, logging.logMetrics.list"),
		Probe: Probe{
			Signal: connector.SignalLogs,
			Note:   "An entries.list call with pageSize 1 against the configured project.",
		},
	},
	{
		Type:         connector.ProviderGCPCloudMonitoring,
		DisplayName:  "Google Cloud Monitoring",
		Vendor:       vendorGoogleCloud,
		Category:     categoryMetrics,
		Signals:      []connector.Signal{connector.SignalMetrics},
		Summary:      "Read Google Cloud Monitoring time series with the native filter language.",
		Description:  "Reads time series from Google Cloud Monitoring using a Google service-account credential or GKE Workload Identity. The Query argument is the timeSeries filter, e.g. metric.type=\"custom.googleapis.com/...\".",
		ConfigFields: gcpConfigFields("Only for private proxies or fakes — defaults to monitoring.googleapis.com."),
		Credential:   gcpServiceAccountCredential,
		Steps:        gcpReadOnlySteps("cloud-monitoring", connector.ProviderGCPCloudMonitoring, "monitoring.metricDescriptors.list, monitoring.timeSeries.list"),
		Probe: Probe{
			Signal: connector.SignalMetrics,
			Note:   "A metricDescriptors.list call with pageSize 1 for the configured project.",
		},
	},
	{
		Type:         connector.ProviderGCPCloudTrace,
		DisplayName:  "Google Cloud Trace",
		Vendor:       vendorGoogleCloud,
		Category:     categoryTraces,
		Signals:      []connector.Signal{connector.SignalTraces},
		Summary:      "Read Google Cloud Trace — list traces with a filter or fetch one trace by ID.",
		Description:  "Reads traces from Google Cloud Trace using a Google service-account credential or GKE Workload Identity. The Query argument is the optional list filter; a trace ID instead fetches one trace.",
		ConfigFields: gcpConfigFields("Only for private proxies or fakes — defaults to cloudtrace.googleapis.com."),
		Credential:   gcpServiceAccountCredential,
		Steps:        gcpReadOnlySteps("cloud-trace", connector.ProviderGCPCloudTrace, "cloudtrace.traces.get, cloudtrace.traces.list"),
		Probe: Probe{
			Signal: connector.SignalTraces,
			Note:   "A traces.list call with pageSize 1 for the configured project.",
		},
	},
	{
		Type:         connector.ProviderLoki,
		DisplayName:  "Grafana Loki",
		Vendor:       vendorOpenSource,
		Category:     categoryLogs,
		Signals:      []connector.Signal{connector.SignalLogs},
		Summary:      "Query Grafana Loki log stores with LogQL.",
		Description:  "Targets Grafana Loki, or any LogQL-speaking backend such as Mimir. The Query argument is a LogQL expression; results come back newest first. Multi-tenant Loki needs the X-Scope-OrgID header — set it in the headers field.",
		ConfigFields: httpConfigFields("http://loki-gateway.monitoring:3100"),
		Credential:   noCredential,
		Steps: []Step{
			{
				Title: "Have the endpoint URL ready",
				Body:  "Any LogQL-speaking backend works: Loki itself, or Mimir with its Loki-compatible API. Copy the absolute http(s) URL of the query endpoint.",
			},
			{
				Title: "Register the provider",
				Body:  "Annotate the backend's Service with observability.paprika.io/discover=true and the gateway materializes the provider, or apply the manifest below by hand.",
				Code: `apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: loki
  namespace: paprika-e2e
spec:
  type: loki
  config:
    endpoint: http://loki-gateway.monitoring:3100`,
			},
			{
				Title: "Add credentials and tenancy headers only if needed",
				Body:  "In-cluster endpoints are usually anonymous and need nothing further. Multi-tenant Loki needs the X-Scope-OrgID header — set it in the headers field, one Name: value per line, not in the endpoint. Protected endpoints take a Secret referenced by credentialsSecretRef: a user:password document selects HTTP Basic, anything else a Bearer token.",
			},
		},
		Probe: Probe{
			Signal: connector.SignalLogs,
			Note:   "A one-line LogQL read via /loki/api/v1/query_range — proves reachability and that the tenancy headers are accepted.",
		},
	},
	{
		Type:         connector.ProviderTempo,
		DisplayName:  "Grafana Tempo",
		Vendor:       vendorOpenSource,
		Category:     categoryTraces,
		Signals:      []connector.Signal{connector.SignalTraces},
		Summary:      "Search Grafana Tempo traces with TraceQL or fetch one trace by ID.",
		Description:  "Targets Grafana Tempo's query API. The Query argument is a TraceQL search expression; a trace ID instead fetches one trace directly.",
		ConfigFields: httpConfigFields("http://tempo-query-frontend.tracing:3200"),
		Credential:   noCredential,
		Steps: []Step{
			{
				Title: "Have the endpoint URL ready",
				Body:  "Point the config at the Tempo query frontend's absolute http(s) URL; the distributor port serves ingest, not queries.",
			},
			{
				Title: "Register the provider",
				Body:  "Annotate the query frontend's Service with observability.paprika.io/discover=true and the gateway materializes the provider, or apply the manifest below by hand.",
				Code: `apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: tempo
  namespace: paprika-e2e
spec:
  type: tempo
  config:
    endpoint: http://tempo-query-frontend.tracing:3200`,
			},
			{
				Title: "Add credentials only if the endpoint requires them",
				Body:  "In-cluster endpoints are usually anonymous and need nothing further. For a protected endpoint, put the token in a Secret and reference it with credentialsSecretRef: a user:password document selects HTTP Basic, anything else a Bearer token.",
			},
		},
		Probe: Probe{
			Signal: connector.SignalTraces,
			Note:   "A TraceQL search for the newest trace via /api/search, limited to one result.",
		},
	},
	{
		Type:         connector.ProviderOTLP,
		DisplayName:  "OTLP",
		Vendor:       vendorOpenSource,
		Category:     categoryLogs,
		Signals:      []connector.Signal{connector.SignalLogs, connector.SignalMetrics, connector.SignalTraces},
		Summary:      "Retrieve logs, metrics, and traces from any OTLP/HTTP endpoint.",
		Description:  "Generic OTLP/HTTP retrieval proxy: the gateway GETs the /v1/logs, /v1/metrics or /v1/traces path on the endpoint, passing trace_id, start, end and limit through when set. Works against any OTLP/HTTP-compatible collector or backend.",
		ConfigFields: httpConfigFields("http://otel-collector.observability:4318"),
		Credential:   noCredential,
		Steps: []Step{
			{
				Title: "Have the endpoint URL ready",
				Body:  "Point the config at any OTLP/HTTP endpoint — an OpenTelemetry Collector's 4318 port, or a backend that serves the OTLP retrieval paths.",
			},
			{
				Title: "Register the provider",
				Body:  "Annotate the collector's Service with observability.paprika.io/discover=true and the gateway materializes the provider, or apply the manifest below by hand.",
				Code: `apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: otlp
  namespace: paprika-e2e
spec:
  type: otlp
  config:
    endpoint: http://otel-collector.observability:4318`,
			},
			{
				Title: "No per-signal configuration exists",
				Body:  "All three signals share the one endpoint; the signal being queried selects the /v1/logs, /v1/metrics or /v1/traces path.",
			},
		},
		Probe: Probe{
			Signal: connector.SignalLogs,
			Note:   "A GET of /v1/logs with limit 1 (likewise /v1/metrics or /v1/traces) against the configured endpoint.",
		},
	},
	{
		Type:         connector.ProviderPrometheus,
		DisplayName:  "Prometheus",
		Vendor:       vendorOpenSource,
		Category:     categoryMetrics,
		Signals:      []connector.Signal{connector.SignalMetrics},
		Summary:      "Query Prometheus-compatible metrics endpoints with PromQL.",
		Description:  "Targets any Prometheus-compatible query API — kube-prometheus-stack, VictoriaMetrics, Mimir and Grafana Cloud included. The Query argument is PromQL; a range window (start and end) selects a range query, otherwise an instant query runs.",
		ConfigFields: httpConfigFields("http://kube-prometheus-stack-prometheus.monitoring:9090"),
		Credential:   noCredential,
		Steps: []Step{
			{
				Title: "Have the endpoint URL ready",
				Body:  "Any Prometheus-compatible backend works: kube-prometheus-stack, VictoriaMetrics, Mimir and Grafana Cloud all expose one. Copy the absolute http(s) URL of the query endpoint.",
			},
			{
				Title: "Register the provider",
				Body:  "Annotate the backend's Service with observability.paprika.io/discover=true and the gateway materializes the provider, or apply the manifest below by hand.",
				Code: `apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: prometheus
  namespace: paprika-e2e
spec:
  type: prometheus
  config:
    endpoint: http://kube-prometheus-stack-prometheus.monitoring:9090`,
			},
			{
				Title: "Add credentials only if the endpoint requires them",
				Body:  "In-cluster endpoints are usually anonymous and need nothing further. For a protected endpoint, put the token in a Secret and reference it with credentialsSecretRef: a user:password document selects HTTP Basic, anything else a Bearer token.",
			},
		},
		Probe: Probe{
			Signal: connector.SignalMetrics,
			Note:   "An instant query for up against /api/v1/query — the cheapest read that proves the endpoint evaluates PromQL.",
		},
	},
	{
		Type:        connector.ProviderVultrMonitoring,
		DisplayName: "Vultr Monitoring",
		Vendor:      vendorVultr,
		Category:    categoryMetrics,
		Signals:     []connector.Signal{connector.SignalMetrics},
		Summary:     "Read Vultr account and per-instance bandwidth metrics through the v2 API.",
		Description: "Reads Vultr bandwidth metrics using a Vultr API key credential. The Query argument is a metric name: account_bandwidth returns account-level previous/current/projected period totals with overage; instance_bandwidth_incoming_bytes and instance_bandwidth_outgoing_bytes fan out across every cloud-compute instance and return one daily-point series per instance tagged by instance ID and label. The backend serves the current billing period — no time range is sent.",
		ConfigFields: []Field{
			{
				Key:   "endpoint",
				Label: "Endpoint",
				Input: "string",
				Help:  "Optional. Set only for in-cluster emulators or proxies; the Vultr v2 API is the default.",
			},
			insecureSkipTLSField(),
		},
		Credential: vultrAPICredential,
		Steps: []Step{
			{
				Title: "Create a read-only API key",
				Body:  "The gateway needs one Vultr API key with read access to account and instance bandwidth. Create it at my.vultr.com under Account → API, then store it in a Secret.",
				Code: `kubectl create secret generic vultr-monitoring-credentials \
  --namespace=paprika-e2e \
  --from-literal=credentials="<your vultr api key>"
kubectl label secret vultr-monitoring-credentials \
  --namespace=paprika-e2e observability.paprika.io/credentials=true`,
			},
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: vultr-monitoring
  namespace: paprika-e2e
spec:
  type: vultr-monitoring
  credentialsSecretRef:
    name: vultr-monitoring-credentials`),
		},
		Probe: Probe{
			Signal: connector.SignalMetrics,
			Note:   "An empty query runs the account bandwidth endpoint — the cheapest read the v2 API offers.",
		},
	},
	{
		Type:        connector.ProviderMock,
		DisplayName: "Mock (synthetic test backend)",
		Vendor:      vendorPaprika,
		Category:    categoryTest,
		Signals:     []connector.Signal{connector.SignalMetrics, connector.SignalLogs, connector.SignalTraces},
		Summary:     "In-process synthetic backend that answers every signal without network egress — for load tests, demos and onboarding practice.",
		Description: "The mock connector generates deterministic data in each backend's native wire shape (Prometheus matrix, Loki streams, Tempo-style trace summaries) so the gateway's query, usage and MCP paths can be exercised at scale without deploying a real observability stack. Payload size, latency and a stable error subset are all tunable from the config document; identical queries with the same seed return identical data.",
		ConfigFields: []Field{
			intField("series", "Metric series", "Series generated per metrics query (default 16)."),
			intField("pointsPerSeries", "Points per series", "Samples per series across the queried range (default 32)."),
			intField("labelsPerSeries", "Labels per series", "Label cardinality per series (default 3)."),
			intField("logEntries", "Log entries", "Entries generated per logs query (default 100)."),
			intField("traces", "Traces", "Trace summaries generated per traces query (default 4)."),
			intField("spansPerTrace", "Spans per trace", "Upper bound for synthesized span durations (default 8)."),
			intField("latencyMs", "Latency (ms)", "Synthetic backend latency honored before answering (default 0)."),
			intField("failEvery", "Fail every Nth query", "Deterministically fail a stable subset of distinct queries — 2 marks every second distinct query string failed (default 0, never)."),
			intField("seed", "Seed", "Base seed for the deterministic generator (default 0)."),
		},
		Credential: noCredential,
		Steps: []Step{
			{
				Title: "No backend to deploy",
				Body:  "The mock answers from inside the gateway process: no endpoint, no credential, no egress. An empty config already serves all three signals with small payloads — apply the provider and query it.",
			},
			{
				Title: "Tune the payload shape",
				Body:  "Every knob is optional and bounded; the config below makes each metrics query return a 200-series matrix with 64 points per series and adds a 25ms synthetic latency.",
				Code: `config:
  series: 200
  pointsPerSeries: 64
  labelsPerSeries: 4
  latencyMs: 25`,
			},
			applyStep(`apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: mock-demo
  namespace: observability
spec:
  type: mock
  config:
    series: 200
    pointsPerSeries: 64
    latencyMs: 25`),
		},
		Probe: Probe{
			Signal: connector.SignalMetrics,
			Note:   "Any query returns synthetic data — the probe needs nothing but the type.",
		},
	},
}

// All returns the full provider-type library — every TypeInfo, sorted by
// Vendor then DisplayName, the deterministic order the library view
// renders. The returned slice is a copy; callers may not mutate it.
func All() []TypeInfo {
	all := slices.Clone(catalog)
	slices.SortFunc(all, func(a, b TypeInfo) int {
		return cmp.Or(
			cmp.Compare(a.Vendor, b.Vendor),
			cmp.Compare(a.DisplayName, b.DisplayName),
		)
	})
	return all
}

// Get returns the TypeInfo for one provider type (connector.Provider*),
// reporting false for a type the library does not cover.
func Get(providerType string) (TypeInfo, bool) {
	for i := range catalog {
		if catalog[i].Type == providerType {
			return catalog[i], true
		}
	}
	return TypeInfo{}, false
}

// Summaries returns the light projection of the library for the list view,
// in the same Vendor-then-DisplayName order as All.
func Summaries() []TypeSummary {
	all := All()
	summaries := make([]TypeSummary, 0, len(all))
	for i := range all {
		summaries = append(summaries, TypeSummary{
			Type:        all[i].Type,
			DisplayName: all[i].DisplayName,
			Vendor:      all[i].Vendor,
			Category:    all[i].Category,
			Signals:     all[i].Signals,
			Summary:     all[i].Summary,
		})
	}
	return summaries
}

// gcpReadOnlySteps keeps onboarding free of key-export instructions and
// overbroad viewer-role assumptions. Identity and permission changes remain
// explicit operator decisions; these catalog reads never execute commands.
func gcpReadOnlySteps(name, providerType, permissions string) []Step {
	return []Step{
		{Title: "Choose the workload identity", Body: "Use a dedicated Kubernetes ServiceAccount with direct Workload Identity Federation on GKE. Reuse an existing authorized identity where appropriate; create identities or grant access only after exact principal and project approval."},
		{Title: "Approve read permissions", Body: "Request only these permissions in the configured data project: " + permissions + ". A custom reader role avoids unrelated writes. Cloud Trace User also grants task and scope mutations; it is broader than trace retrieval requires. Private audit logs and additional projects require separate approval."},
		{Title: "Keep credentials out of clients", Body: "With workload identity, omit credentialsSecretRef. Never paste keys or tokens into MCP calls. Existing non-GKE credentials must use the administrator's secure Secret-reference workflow; this setup does not export keys."},
		applyStep("apiVersion: observability.paprika.io/v1alpha1\nkind: ObservabilityProvider\nmetadata:\n  name: " + name + "\n  namespace: <approved-provider-namespace>\nspec:\n  type: " + providerType + "\n  config:\n    projectId: <approved-data-project>"),
	}
}
