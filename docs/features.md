# Paprika Feature Overview

Paprika is a Kubernetes-native application delivery platform that combines continuous delivery, progressive rollouts, multi-cluster management, and observability into a single operator. This page indexes the available feature guides.

## Core Concepts

| Feature | Description | Guide |
|---------|-------------|-------|
| **Application CRD** | Top-level resource that models a deployable application, its source, stages, sync policy, and health checks. | [Getting Started](getting-started.md) |
| **Template Sources** | Render manifests from Helm charts, Git repositories, S3 objects, or OCI images. | [Getting Started](getting-started.md), [API Reference](api.md) |
| **Pipelines** | CI-style workflows defined as Kubernetes Jobs with steps, dependencies, artifacts, and retries. | [Pipeline Guide](guides/pipelines.md) |
| **Stages** | Environment definitions (dev, staging, production) with ring numbers, cluster refs, canary config, and gates. | [Getting Started](getting-started.md), [Canary Guide](guides/canary.md) |
| **Releases** | Promotion lifecycle through stages with verification and rollback support. | [Getting Started](getting-started.md) |

## Progressive Delivery

| Feature | Description | Guide |
|---------|-------------|-------|
| **Canary** | Weighted traffic shifting with configurable steps, intervals, and automated analysis. | [Canary Guide](guides/canary.md) |
| **Multi-cluster** | Deploy to remote clusters via kubeconfig secrets, agents, or in-cluster mode. | [Multi-cluster Guide](guides/multi-cluster.md) |
| **Gates** | Automated smoke-test and duration gates plus manual approval gates. | [Gates Guide](guides/gates.md) |
| **Health Checks** | CEL-based and HTTP-probe health evaluations for applications and resources. | [Getting Started](getting-started.md) |
| **DeepHost delivery** | Git-sourced Helm delivery of a Kubernetes hosting platform with staged promotion, router health checks, rollback, and shared Envoy integration. | [DeepHost Integration](guides/deephost.md) |

## Drift and Lifecycle

| Feature | Description | Guide |
|---------|-------------|-------|
| **Drift Detection** | Label-selector diff engine comparing desired manifests against live state with API-group-aware resource keys and Kubernetes-default omission. | [Drift and Prune](guides/drift-and-prune.md) |
| **Pruning** | Opt-in garbage collection of stale resources after apply, with prune protection annotations and cluster-scoped kind allowlists. | [Drift and Prune](guides/drift-and-prune.md) |
| **Prune Preview** | `status.prunableResources` lists what would be pruned before enabling prune. | [Drift and Prune](guides/drift-and-prune.md) |

## Observability

| Feature | Description | Guide |
|---------|-------------|-------|
| **Drift Metrics** | `paprika_out_of_sync` and `paprika_prunable` gauges updated on every diff evaluation. | [Metrics and Alerting](guides/metrics.md) |
| **Prune Metrics** | `paprika_prune_total` counter per application and kind. | [Metrics and Alerting](guides/metrics.md) |
| **OTel Metrics** | Render, git, auth, SSE, and event metrics via OpenTelemetry with Prometheus export. | [Metrics and Alerting](guides/metrics.md) |

## Interfaces

| Feature | Description | Guide |
|---------|-------------|-------|
| **Dashboard** | Built-in web UI served on port `3000` with live SSE updates. | [Dashboard Guide](frontend.md) |
| **CLI** | Cobra-based `paprika` CLI for listing resources, syncing apps, and approving gates. | [CLI Guide](cli.md) |
| **API** | Connect-RPC service `paprika.v1.PaprikaService` for programmatic access. | [API Reference](api.md) |

## Security

| Feature | Description | Guide |
|---------|-------------|-------|
| **Auth** | Basic auth and OIDC bearer token authentication on the API/UI. | [Auth Guide](guides/auth.md) |

## Next Steps

- New to Paprika? Start with [Getting Started](getting-started.md).
- Want to automate deployments? Read the [CLI](cli.md) or [API](api.md) guides.
- Need progressive delivery? See [Canary](guides/canary.md) and [Gates](guides/gates.md).
- Running across clusters? See [Multi-cluster](guides/multi-cluster.md).
- Delivering DeepHost? See [DeepHost Integration](guides/deephost.md).
- Managing drift and stale resources? See [Drift and Prune](guides/drift-and-prune.md).
- Setting up monitoring? See [Metrics and Alerting](guides/metrics.md).
- Building and deploying Paprika itself? See [Operations](guides/operations.md).
