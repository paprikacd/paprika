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
Auth CLI args shared between manager (monolith) and api-server deployments.
*/}}
{{- define "paprika.authArgs" -}}
{{- if .Values.auth.enabled }}
- --auth-enabled=true
{{- if .Values.auth.basic.enabled }}
- --auth-basic-username={{ .Values.auth.basic.username }}
{{- if .Values.auth.basic.passwordHash }}
- --auth-basic-password-hash={{ .Values.auth.basic.passwordHash }}
{{- else if .Values.auth.basic.password }}
- --auth-basic-password={{ .Values.auth.basic.password }}
{{- end }}
{{- end }}
{{- if .Values.auth.oidc.enabled }}
- --auth-oidc-issuer-url={{ .Values.auth.oidc.issuerURL }}
- --auth-oidc-client-id={{ .Values.auth.oidc.clientID }}
{{- if .Values.auth.oidc.clientSecret }}
- --auth-oidc-client-secret={{ .Values.auth.oidc.clientSecret }}
{{- end }}
{{- end }}
{{- if .Values.auth.allowUnauthenticated }}
- --auth-allow-unauthenticated=true
{{- end }}
{{- end }}
{{- end }}
