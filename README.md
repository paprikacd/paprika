# paprika

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go)](https://go.dev)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/benebsworth/paprika/actions/workflows/test.yml/badge.svg)](https://github.com/benebsworth/paprika/actions/workflows/test.yml)
[![Lint](https://github.com/benebsworth/paprika/actions/workflows/lint.yml/badge.svg)](https://github.com/benebsworth/paprika/actions/workflows/lint.yml)
[![Go Report Card](https://goreportcard.com/badge/github.com/benebsworth/paprika)](https://goreportcard.com/report/github.com/benebsworth/paprika)

**paprika** is a Kubernetes-native application delivery platform that consolidates CI/CD pipelines, progressive delivery, traffic routing, and multi-cluster management into a single operator. It replaces the need for separate ArgoCD, Argo Rollouts, and Argo Workflows deployments with a unified, controller-driven approach.

Built with the [Kubebuilder](https://book.kubebuilder.io) framework, paprika extends Kubernetes with Custom Resource Definitions (CRDs) that model the entire application lifecycle in familiar Kubernetes YAML.

## Features

- **Unified Application CRD** — Define your application, its source, pipelines, stages, and releases in a single manifest
- **Progressive Delivery** — Canary and rolling deployments with configurable step weights and interval throttling
- **Pluggable Traffic Router** — Built-in support for Istio (VirtualService) and Gateway API (HTTPRoute) traffic splitting
- **Multi-Source Support** — Helm charts (local or remote), Git repositories, and S3 buckets as template sources
- **Multi-Cluster Deployments** — Stage-level cluster references with kubeconfig-based authentication
- **Health Evaluation** — CEL-based health checks with a library of built-in resource health rules
- **Change Detection** — Diff engine with label-selector scoping to detect and report drift
- **Approval Gates** — Manual approval gates that pause promotion between stages
- **Pipeline Workflows** — Sequential step execution (build, test, deploy) with Kubernetes Job backing
- **Dashboard UI** — Next.js dashboard with real-time application, release, and resource status
- **Prometheus Metrics** — Controller-runtime metrics for reconciliation duration, phase transitions, and resource counts

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │          paprika Application         │
                    │  (single manifest for everything)    │
                    └──────────┬──────────────────────────┘
                               │
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
         ┌──────────┐   ┌──────────┐   ┌──────────────┐
         │ Template │   │ Pipeline │   │ Stage(s)     │
         │ (source) │   │ (steps)  │   │ (env + ring) │
         └──────────┘   └──────────┘   └──────┬───────┘
                                              │
                                     ┌────────▼────────┐
                                     │    Release       │
                                     │ (reconcile +     │
                                     │  promote)        │
                                     └────────┬────────┘
                                              │
                    ┌─────────────────────────┼────────────┐
                    ▼                         ▼            ▼
            ┌────────────┐          ┌──────────────┐ ┌──────────┐
            │  Traffic   │          │  Apply       │ │  Verify  │
            │  Router    │          │  Manifests   │ │  Health  │
            │ (Istio/GA) │          │              │ │  (CEL)   │
            └────────────┘          └──────────────┘ └──────────┘
```

### CRDs

| Kind | Purpose |
|------|---------|
| `Application` | Top-level resource, owns template + pipeline + stages + releases |
| `Template` | Source configuration (Helm/Git/S3) for rendering manifests |
| `Pipeline` | Sequential build/test/deploy steps as Kubernetes Jobs |
| `Stage` | Environment definition with cluster ref, canary config, gates |
| `Release` | Promotion of rendered manifests through a stage lifecycle |
| `Artifact` | Build artifact reference (image, binary) |

## Quickstart

### Prerequisites

- Go 1.25+, Docker, kubectl
- Access to a Kubernetes cluster (v1.29+ recommended)
- [cert-manager](https://cert-manager.io/docs/installation/) installed on the cluster (for webhook certificates)

### Build & Deploy

```sh
# Clone the repository
git clone https://github.com/benebsworth/paprika.git
cd paprika

# Install CRDs
make install

# Build and deploy the operator
make docker-build docker-push IMG=ghcr.io/benebsworth/paprika:latest
make deploy IMG=ghcr.io/benebsworth/paprika:latest

# Verify the operator is running
kubectl get pods -n paprika-system
```

### Deploy a Sample Application

```sh
kubectl apply -f config/samples/
```

This creates an `Application` resource that deploys a demo Helm chart, creating a Template, Stage, and Release automatically.

### Run Locally

```sh
# Run the operator on your host (uses current kubeconfig context)
ENABLE_WEBHOOKS=false make run
```

### Run Tests

```sh
# Unit tests (Kubernetes envtest)
make test

# Lint
make lint

# E2E tests (creates an isolated Kind cluster)
make test-e2e
```

## Project Distribution

### Single YAML Bundle

```sh
make build-installer IMG=ghcr.io/benebsworth/paprika:<tag>
# Generates dist/install.yaml — apply with:
kubectl apply -f dist/install.yaml
```

### Helm Chart

```sh
# Generate Helm chart from Kustomize manifests
make helm-generate

# Deploy via Helm
helm install paprika charts/chart --namespace paprika-system --create-namespace
```

## Development

### Project Structure

```
api/pipelines/v1alpha1/       CRD type definitions
cmd/main.go                   Entrypoint (operator + API server modes)
internal/controller/          Reconciliation controllers
internal/webhook/             Admission webhooks
engine/                       Template rendering, diff computation, workflow
traffic/                      Traffic router implementations (Istio, Gateway API)
health/                       CEL health evaluation, resource health checks
source/                       Git/S3 source resolution
gates/                        Approval gate execution
analysis/                     Canary analysis
charts/                       Helm charts (demo app, operator chart)
ui/                           Next.js dashboard
config/                       Kustomize manifests for deployment
docs/                         Design docs, plans, guides
```

### Key Commands

```sh
make help              # Show all available targets
make manifests         # Regenerate CRDs + RBAC from kubebuilder markers
make generate          # Regenerate DeepCopy methods
make test              # Run unit tests
make lint              # Run linter
make run               # Run operator locally (no webhooks)
make deploy            # Deploy to current cluster
make docker-build      # Build Docker image
make build-installer   # Build single-file YAML bundle
```

### Workflows

This project uses [GitHub Actions](.github/workflows/) for CI/CD:

| Workflow | Trigger | Description |
|----------|---------|-------------|
| Lint | push, PR | golangci-lint |
| Tests | push, PR | Unit tests with coverage |
| E2E | push, PR | End-to-end tests on Kind |
| Build & Push | push to main | Build and push image to GHCR |
| Deploy GKE Dev | after Build & Push | Deploy to GKE dev cluster |
| Release | tag push (v*) | Build, release, deploy to production |

## Roadmap

See [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md) for the production readiness plan,
including scaling the diff engine, adding source caching, splitting the monolith, and
multi-tenancy support.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

Report vulnerabilities to benebsworth@gmail.com. See [SECURITY.md](SECURITY.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
