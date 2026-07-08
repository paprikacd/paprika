{{/*
Expand the name of the chart.
*/}}
{{- define "paprika.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "paprika.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Namespace for generated references.
Always uses the Helm release namespace.
*/}}
{{- define "paprika.namespaceName" -}}
{{- .Release.Namespace }}
{{- end }}

{{/*
Resource name with proper truncation for Kubernetes 63-character limit.
Takes a dict with:
  - .suffix: Resource name suffix (e.g., "metrics", "webhook")
  - .context: Template context (root context with .Values, .Release, etc.)
Dynamically calculates safe truncation to ensure total name length <= 63 chars.
*/}}
{{- define "paprika.resourceName" -}}
{{- $fullname := include "paprika.fullname" .context }}
{{- $suffix := .suffix }}
{{- $maxLen := sub 62 (len $suffix) | int }}
{{- if gt (len $fullname) $maxLen }}
{{- printf "%s-%s" (trunc $maxLen $fullname | trimSuffix "-") $suffix | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" $fullname $suffix | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
ServiceAccount name to use.
If serviceAccount.enable is false and serviceAccount.name is set, use that name.
Otherwise, use the standard resourceName helper with "controller-manager" suffix.
*/}}
{{- define "paprika.serviceAccountName" -}}
{{- if and (not (.Values.serviceAccount.enable | default true)) .Values.serviceAccount.name }}
{{- .Values.serviceAccount.name }}
{{- else }}
{{- include "paprika.resourceName" (dict "suffix" "controller-manager" "context" .) }}
{{- end }}
{{- end }}

{{/*
Cache environment variables shared across all components.
*/}}
{{- define "paprika.cacheEnv" -}}
{{- if .Values.redis.enabled }}
- name: PAPRIKA_CACHE_BACKEND
  value: "redis"
- name: PAPRIKA_REDIS_ADDR
  value: {{ .Values.redis.addr | quote }}
{{- if .Values.redis.password }}
- name: PAPRIKA_REDIS_PASSWORD
  value: {{ .Values.redis.password | quote }}
{{- end }}
- name: PAPRIKA_REDIS_DB
  value: {{ .Values.redis.db | quote }}
{{- end }}
{{- end }}

{{/*
Audit logging environment variable. When audit is enabled, the API server
records structured JSON audit events for mutating operations to stdout.
*/}}
{{- define "paprika.auditEnv" -}}
{{- if .Values.audit.enabled }}
- name: PAPRIKA_AUDIT_ENABLED
  value: "true"
{{- end }}
{{- end }}

{{/*
Downward API environment variables for resource identification. Always emitted
on every component so traces/metrics/logs can attribute back to the running Pod
without extra configuration.
*/}}
{{- define "paprika.downwardEnv" -}}
- name: PAPRIKA_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: PAPRIKA_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- end }}

{{/*
OpenTelemetry environment variables. Emitted only when otel.enabled is true.
Ref: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
*/}}
{{- define "paprika.otelEnv" -}}
{{- if .Values.otel.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otel.endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: {{ .Values.otel.protocol | quote }}
- name: OTEL_EXPORTER_OTLP_INSECURE
  value: {{ .Values.otel.insecure | quote }}
{{- if .Values.otel.certificatePath }}
- name: OTEL_EXPORTER_OTLP_CERTIFICATE
  value: {{ .Values.otel.certificatePath | quote }}
{{- end }}
{{- if .Values.otel.sampler }}
- name: OTEL_TRACES_SAMPLER
  value: {{ .Values.otel.sampler | quote }}
{{- end }}
{{- if .Values.otel.samplerArg }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .Values.otel.samplerArg | quote }}
{{- end }}
- name: OTEL_PROPAGATORS
  value: {{ .Values.otel.propagators | quote }}
{{- $attrs := list -}}
{{- range $k, $v := .Values.otel.resourceAttributes }}
{{- $attrs = append $attrs (printf "%s=%v" $k $v) }}
{{- end }}
{{- if $attrs }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ join "," $attrs | quote }}
{{- end }}
{{- $hdrs := list -}}
{{- range $k, $v := .Values.otel.headers }}
{{- $hdrs = append $hdrs (printf "%s=%v" $k $v) }}
{{- end }}
{{- if $hdrs }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  value: {{ join "," $hdrs | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels applied to all resources.
Emits only .Values.commonLabels entries, excluding the standard Helm labels
since each resource template adds those individually.
*/}}
{{- define "paprika.commonLabels" -}}
{{- with .Values.commonLabels }}
{{- toYaml . }}
{{- end }}
{{- end }}

{{/*
Extra environment variables (value literals) for a component.
Takes the component's .extraEnv list.
*/}}
{{- define "paprika.extraEnv" -}}
{{- range . }}
{{- if and .name (or (hasKey . "value") (hasKey . "valueFrom")) }}
- name: {{ .name }}
  {{- if hasKey . "value" }}
  value: {{ .value | quote }}
  {{- else }}
  valueFrom:
    {{- toYaml .valueFrom | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Extra environment variable sources (ConfigMapRef/SecretRef) for a component.
Takes the component's .extraEnvFrom list.
*/}}
{{- define "paprika.extraEnvFrom" -}}
{{- range . }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{/*
GitHub Actions token exchange environment shared between manager (monolith) and
api-server deployments.
*/}}
{{- define "paprika.githubActionsTokenExchangeEnv" -}}
{{- if .Values.githubActionsTokenExchange.enabled }}
{{- if not .Values.githubActionsTokenExchange.repository }}
{{- fail "githubActionsTokenExchange.repository is required when githubActionsTokenExchange.enabled=true" }}
{{- end }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ENABLED
  value: "true"
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_AUDIENCE
  value: {{ .Values.githubActionsTokenExchange.audience | quote }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_REPOSITORY
  value: {{ .Values.githubActionsTokenExchange.repository | quote }}
{{- with .Values.githubActionsTokenExchange.environment }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_ENVIRONMENT
  value: {{ . | quote }}
{{- end }}
{{- with .Values.githubActionsTokenExchange.subject }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SUBJECT
  value: {{ . | quote }}
{{- end }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SERVICE_ACCOUNT_NAMESPACE
  value: {{ default .Release.Namespace .Values.githubActionsTokenExchange.serviceAccount.namespace | quote }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_SERVICE_ACCOUNT_NAME
  value: {{ .Values.githubActionsTokenExchange.serviceAccount.name | quote }}
- name: PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_TOKEN_TTL
  value: {{ .Values.githubActionsTokenExchange.tokenTTL | quote }}
{{- end }}
{{- end }}

{{/*
Auth CLI args shared between manager (monolith) and api-server deployments.
*/}}
{{- define "paprika.authArgs" -}}
{{- if .Values.auth.enabled }}
- --auth-enabled=true
{{- if .Values.auth.basic.enabled }}
- --auth-basic-username={{ .Values.auth.basic.username }}
- --auth-basic-password-hash={{ .Values.auth.basic.passwordHash }}
{{- end }}
{{- if .Values.auth.oidc.enabled }}
- --auth-oidc-issuer-url={{ .Values.auth.oidc.issuerURL }}
- --auth-oidc-client-id={{ .Values.auth.oidc.clientID }}
{{- if .Values.auth.oidc.clientSecret }}
- --auth-oidc-client-secret={{ .Values.auth.oidc.clientSecret }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
