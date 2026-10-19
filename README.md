# paprika

[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go)](https://go.dev)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/paprikacd/paprika/actions/workflows/ci.yml/badge.svg)](https://github.com/paprikacd/paprika/actions/workflows/ci.yml)

**paprika** is an Apache 2.0 Kubernetes operator for application delivery. It models sources, pipelines, stages, and releases with Kubernetes resources and supports health checks and progressive rollout strategies. The project is early-stage; evaluate it on a non-production cluster before depending on it for critical workloads.

Built with the [Kubebuilder](https://book.kubebuilder.io) framework, paprika extends Kubernetes with Custom Resource Definitions (CRDs) that model the entire application lifecycle in familiar Kubernetes YAML.

## Start here

- [Self-host Paprika and create a first Application](docs/getting-started.md)
- [Browse the feature guide](docs/features.md)
- [Ask a question, report a bug, or suggest a feature](https://github.com/paprikacd/paprika/issues/new/choose)
- [Contribute code, tests, documentation, or examples](CONTRIBUTING.md)
- [Report security issues privately](SECURITY.md) and read the [Code of Conduct](CODE_OF_CONDUCT.md)
- [Visit the project landing page](https://paprikacd.github.io/paprika/)

## Features

- **Unified Application CRD** — Define your application, its source, pipelines, stages, and releases in a single manifest
- **Progressive Delivery** — Canary and rolling deployments with configurable step weights and interval throttling
- **Pluggable Traffic Router** — Built-in support for Istio (VirtualService) and Gateway API (HTTPRoute) traffic splitting
- **Multi-Source Support** — Helm charts (local or remote), Git repositories, and S3 buckets as template sources
- **Multi-Cluster Orchestration** — Outbound satellites automatically onboard cluster state, merge shared applications across placements, and complement Stage-level deployment targets; [onboarding guide](docs/guides/multi-cluster.md)
- **Health Evaluation** — CEL-based health checks with a library of built-in resource health rules
- **Drift Detection** — API-group-aware diff engine with label-selector scoping, null-value handling, and generated-child exclusion
- **Garbage Collection** — Opt-in pruning of stale resources after apply, with protection annotations and cluster-scoped kind allowlists
- **Drift Metrics** — `paprika_out_of_sync` and `paprika_prunable` gauges for real-time drift observability
- **Approval Gates** — Manual approval gates that pause promotion between stages
- **Pipeline Workflows** — Sequential step execution (build, test, deploy) with Kubernetes Job backing
- **Dashboard UI** — Next.js dashboard with real-time application, release, and resource status
- **Codex and Claude plugin** — Inspect app health, debug failures, and manage delivery through authenticated MCP tools; [installation and usage guide](docs/guides/mcp-plugin.md)
- **Prometheus Metrics** — Controller-runtime and OTel metrics for reconciliation, phase transitions, drift, and prune activity

## CLI Quickstart

To inspect the hosted Paprika API with the CLI, install the latest release and authenticate. For a self-hosted operator, follow the [getting started guide](docs/getting-started.md) and use your own server address:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh
```

The installer may create `~/.local/bin`; if it does, apply the printed `PATH` export in your shell
before continuing:

```sh
paprika login --server https://paprika.benebsworth.com
paprika status
```

The installer supports macOS and Linux on amd64 and arm64. To audit a pinned release before
installing it, download its exact checksum asset, following the
[`vX.Y.Z/checksums.txt`](https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt)
pattern.

Contributors who have cloned the repository can install the CLI from source instead:

```sh
go install ./cmd/paprika
# Or, with Task v3 installed:
task install
```

Source installs write to `GOBIN` when it is set, or to Go's default bin directory otherwise. Ensure
that Go bin directory is on `PATH` before invoking `paprika`.

## Codex and Claude plugin

Install the Paprika plugin to inspect your fleet, investigate app health and drift,
read workload logs, and request delivery actions from Codex or Claude. Supporting
hosts also provide an interactive fleet console and app mentions through MCP Apps
and OpenAI MCP Extensions.

The [plugin guide](docs/guides/mcp-plugin.md) covers installation into Codex and
Claude, OAuth sign-in, example prompts, permissions, and troubleshooting. The
plugin package is in [`plugins/paprika/`](plugins/paprika/).

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

### DeepHost Integration

Paprika can deliver DeepHost as a Git-sourced Helm Application. The Paprika
Application fetches and renders `charts/deephost`, promotes it through a VKE
stage, verifies the DeepHost router health endpoint, and rolls back failed
releases. DeepHost then reconciles its own App, Build, Release, and Domain CRs
and serves traffic through the shared Envoy Gateway.

See [`docs/guides/deephost.md`](docs/guides/deephost.md) for the ownership
boundary, RBAC requirements, VKE verification, recovery procedure, and the
relationship to DeepHost's local E2E suite.

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

- Go 1.26+, Docker, kubectl, Helm
- Access to a Kubernetes cluster (v1.29+ recommended)
- [cert-manager](https://cert-manager.io/docs/installation/) if you enable admission webhooks

### Build & Deploy

```sh
# Clone the repository
git clone https://github.com/paprikacd/paprika.git
cd paprika
kubectl config current-context

# Build and push an image to a registry your cluster can pull from
make docker-build docker-push IMG=YOUR_REGISTRY/paprika:YOUR_TAG

# Install the chart with that image
make helm-deploy IMG=YOUR_REGISTRY/paprika:YOUR_TAG

# Verify the operator is running
kubectl get pods -n paprika-system
```

### Deploy a Sample Application

```sh
kubectl apply -f your-application.yaml
```

Use the complete example and status checks in the [getting started guide](docs/getting-started.md); the repository sample Application is a scaffold, not a ready-to-deploy demo.

### Run Locally

```sh
# Run the operator on your host (uses current kubeconfig context)
ENABLE_WEBHOOKS=false make run
```

### Run Tests

```sh
# Unit tests (Kubernetes envtest)
task test

# Go and UI lint
task lint

# E2E tests (creates an isolated Kind cluster)
task test:e2e
```

These contributor shortcuts require [Task v3](https://taskfile.dev/). The underlying Make
targets remain supported and are the source of truth for existing project automation.

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
task --list             # Show everyday contributor tasks
task build              # Build the CLI to bin/paprika
task build:all          # Build the CLI, embedded UI, and server
task generate           # Regenerate project code
task test               # Run unit tests
task test:race          # Run unit tests with the race detector
task lint               # Run Go and UI linters
task check              # Run generation, tests, and linters
task ui:dev             # Run the UI development server
task docker:build       # Build the default Docker image
```

Task is a thin interface over the existing Make and npm workflows. `make help` still lists the
complete automation surface, including operator deployment and release-oriented commands.

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
