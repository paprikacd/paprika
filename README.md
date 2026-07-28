# paprika

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go)](https://go.dev)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/paprikacd/paprika/actions/workflows/ci.yml/badge.svg)](https://github.com/paprikacd/paprika/actions/workflows/ci.yml)
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

| Kind | Group | Purpose |
|------|-------|---------|
| `Application` | pipelines.paprika.io | Top-level resource, owns template + pipeline + stages + releases |
| `ApplicationSet` | pipelines.paprika.io | Templated set of Applications |
| `Pipeline` | pipelines.paprika.io | DAG build/test/deploy steps as Kubernetes Jobs |
| `Stage` | pipelines.paprika.io | Environment definition with cluster ref, canary config, gates |
| `Release` | pipelines.paprika.io | Promotion of rendered manifests through a stage lifecycle |
| `Template` | pipelines.paprika.io | Source configuration (Helm/Git/S3/OCI/inline) for rendering manifests |
| `Artifact` | pipelines.paprika.io | Build artifact reference (OCI) with verification |
| `AnalysisTemplate` | pipelines.paprika.io | Reusable analysis checks for canary verification |
| `AnalysisRun` | pipelines.paprika.io | Instance of an AnalysisTemplate executing for an Application |
| `ConftestPolicy` | pipelines.paprika.io | User-authored Rego policy evaluated before promotion |
| `NotificationConfig` | pipelines.paprika.io | Event-driven notifications (Slack/email/webhook) |
| `Cluster` | clusters.paprika.io | Registered target cluster with health checks |
| `AppProject` | core.paprika.io | Tenant boundaries / quotas / RBAC |
| `Repository` | core.paprika.io | Named Git / Helm / OCI source config |
| `Policy` | policy.paprika.io | Cluster-scoped CEL governance policy |
| `FeatureFlag` | featureflags.paprika.io | Feature flag definition with targeting rules |
| `FeatureFlagBinding` | featureflags.paprika.io | Binding flags to workloads |
| `Rollout` | rollouts.paprika.io | Advanced deployment strategies (canary, blue-green, A/B, mirror) |

## Quickstart

### Prerequisites

- Go 1.25+, Docker, kubectl
- Access to a Kubernetes cluster (v1.29+ recommended)
- [cert-manager](https://cert-manager.io/docs/installation/) installed on the cluster (for webhook certificates)

### Build & Deploy

```sh
# Clone the repository
git clone https://github.com/paprikacd/paprika.git
cd paprika

# Install CRDs
make install

# Build and deploy the operator
make docker-build docker-push IMG=ghcr.io/paprikacd/paprika:latest
make deploy IMG=ghcr.io/paprikacd/paprika:latest

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
make build-installer IMG=ghcr.io/paprikacd/paprika:<tag>
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
| CI | PR; push to `master` | Runs Go race tests, Go lint, UI checks, fleet browser/scale gates, generated-code drift, Helm checks, and Kind deployment integration in eight parallel lanes. After every lane passes on `master`, publishes a `linux/amd64` image with `latest` and `sha-<commit>` discovery tags and exposes its digest. |
| Deploy VKE | Reusable call after CI publish; typed repository dispatch | CI automatically promotes its published digest through the reusable workflow. Manual requests run default-branch workflow code and require a full `ghcr.io/paprikacd/paprika@sha256:<64 lowercase hex>` reference. |
| Deploy GKE Dev | Typed repository dispatch | Deploys only an explicitly supplied full Paprika GHCR digest. |
| Deploy Cloud Run Dev | Typed repository dispatch | Deploys only an explicitly supplied full Paprika GHCR digest. |
| E2E Tests | Nightly; manual | Builds local images and runs the full end-to-end suite on Kind. |
| Publish Helm Chart | Chart changes on `master`; typed repository dispatch | Lints, renders, packages, and publishes the Helm chart to GHCR. |
| Deploy Landing to GitHub Pages | Landing changes on `master`; typed repository dispatch | Publishes the landing site from trusted default-branch workflow code. |
| Release | `v*` tag push | Runs GoReleaser and publishes the versioned Helm chart. |

Privileged manual requests use repository dispatch so GitHub loads workflow code from the default
branch. Supply an immutable image digest or a safe semantic chart version:

```sh
IMAGE_REF='ghcr.io/paprikacd/paprika@sha256:<64-lowercase-hex>'
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-vke -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-gke -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-cloudrun -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=publish-helm -f 'client_payload[version]=0.1.0'
gh api repos/paprikacd/paprika/dispatches --method POST -f event_type=publish-pages
```

CI cancels superseded pull-request runs. For `master`, the running workflow/ref-group member is
never cancelled; GitHub retains only the newest pending run and may replace an older pending run.
The VKE token exchange independently requires the allowed event, exact
`refs/heads/master` ref, trusted caller `workflow_ref`, and the reusable VKE
`job_workflow_ref` before minting a Kubernetes credential. The GitHub `vke-production`
environment policy is configured and verified with custom branch policies enabled, protected
branches disabled, and exactly one allowed branch policy: `master` of type `branch`.

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
