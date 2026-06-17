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
