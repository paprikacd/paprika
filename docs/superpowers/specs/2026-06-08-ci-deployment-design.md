# CI/CD and Deployment Architecture

**Date:** 2026-06-08
**Status:** Draft
**Author:** AI Agent

## 1. Overview

This spec describes the CI/CD pipeline and dual-mode deployment architecture for the
Paprika Kubernetes operator. The operator serves as both a full K8s operator on GKE
and a lightweight API server on Cloud Run, sharing a single codebase and container
image.

### Goals

- Automate build, test, and publish on every push to `main`
- Deploy the full operator to a GKE dev cluster from `main` pushes
- Deploy the API-server mode to Cloud Run from `main` pushes
- Release on tag push (GitHub Release + production deployments)
- Use GHCR as the sole container registry
- Generate a Helm chart for flexible deployment

## 2. Dual-Mode Binary

A single binary and Docker image supports two modes selected via `--mode`:

| Mode       | Flag                   | Components                              | Target      |
|------------|------------------------|-----------------------------------------|-------------|
| `operator` | `--mode=operator`      | controllers, webhooks, API, UI, metrics | GKE         |
| `api`      | `--mode=api`           | API (connect-go), UI                    | Cloud Run   |

### 2.1 `operator` Mode (Default)

Unchanged from the current behavior:
- Full controller-runtime manager with all 5 controllers (Pipeline, Stage, Release,
  Template, Artifact)
- Webhook server (when configured)
- Metrics server
- Health probes
- UI + connect-go API server on `:3000`
- Leader election

### 2.2 `api` Mode

Lightweight mode that only starts the connect-go API server and UI dashboard:
- No controller-runtime manager (no controller watches, leader election, webhooks, metrics)
- No liveness/readiness probes on separate ports (probing uses the `/healthz` endpoint on `:3000`)
- Connects to an external K8s cluster
- Only the UI HTTP server on `:3000` with connect-go handler
- Exposes a simple `/healthz` endpoint on the same port for Cloud Run health checking

### 2.3 Flag Changes

The `--mode` flag is added to `cmd/main.go`. In `api` mode, most existing flags
are ignored (metrics, webhooks, leader election). New flags for remote K8s access:
- `--mode` — `operator` (default) or `api`
- `--k8s-api-server` — K8s API server URL (api mode only, optional)
- `--k8s-token-file` — path to service account token (api mode only, optional)

### 2.4 K8s Client Resolution (api mode)

```
if --k8s-api-server is set:
    use provided API server URL + token from --k8s-token-file
                             or fall back to in-cluster SA token mount
else:
    use controller-runtime in-cluster config (works on GKE with Workload Identity)
```

On Cloud Run the preferred path is: omit `--k8s-api-server`, let the binary use
in-cluster config (`rest.InClusterConfig()` reads `KUBERNETES_SERVICE_HOST` env
var, set by the deploy workflow in §4.4). Cloud Run does not set this var by
default — the deploy workflow discovers the GKE endpoint via `gcloud container
clusters describe` and injects it as an env var. When the CI-deployed env var
approach doesn't apply, `--k8s-api-server` provides an explicit override.

### 2.5 Ownership & Testing

- `cmd/main.go`: add `--mode` flag + conditional startup path
- `internal/api/server.go`: unchanged (already uses `client.Reader` interface)
- `internal/api/uihandler.go`: unchanged
- Tests: add `TestApiMode` unit test that starts the API server with a fake K8s
  client. E2e: port-forward test already covers the UI + API.

## 3. Container Registry: GHCR

All images are published to `ghcr.io/benebsworth/paprika`.

Tagging convention:
- `ghcr.io/benebsworth/paprika:latest` — latest build from `main`
- `ghcr.io/benebsworth/paprika:sha-<commit>` — per-commit (for traceability)
- `ghcr.io/benebsworth/paprika:<semver>` — tagged releases (e.g., `v0.1.0`)

The `Makefile` default `IMG` is updated to `ghcr.io/benebsworth/paprika:latest`.

## 4. GitHub Actions Pipelines

### 4.1 Existing PR/CI Workflows (unchanged)

Three workflows already exist and run on `push` and `pull_request`:
- `lint.yml` — golangci-lint
- `test.yml` — unit tests (with coverage)
- `test-e2e.yml` — e2e tests on Kind

These provide CI gating for PRs. Branch protection rules on `main` require these
to pass before merge.

### 4.2 `build-push.yml` — Build & Publish (push to main)

On every push to `main`. Branch protection ensures CI passed before merge, so
this workflow can assume the code is tested.

```yaml
name: Build & Push
on:
  push:
    branches: [main]
jobs:
  build-and-push:
    permissions:
      contents: read
      packages: write    # needed for GHCR push
    steps:
      - checkout
      - setup Go
      - setup Docker Buildx
      - login to GHCR (via GITHUB_TOKEN)
      - docker buildx build --push \
          --tag ghcr.io/benebsworth/paprika:latest \
          --tag ghcr.io/benebsworth/paprika:sha-${{ github.sha }} \
          .
```

### 4.3 `deploy-gke.yml` — Deploy to GKE Dev

After `build-push.yml` succeeds on `main`. Includes `workflow_dispatch` for
manual retry.

```yaml
name: Deploy GKE Dev
on:
  workflow_run:
    workflows: [Build & Push]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}
concurrency: deploy-gke-dev
jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    steps:
      - auth to GCP via Workload Identity Federation
      - setup gcloud + kubectl
      - get GKE dev cluster credentials
      - helm upgrade paprika-dev ./charts/chart \
          --set image.repository=ghcr.io/benebsworth/paprika \
          --set image.tag=sha-${{ github.sha }} \
          --set mode=operator
```

The `concurrency: deploy-gke-dev` prevents overlapping deployments (queues them).

### 4.4 `deploy-cloudrun.yml` — Deploy to Cloud Run Dev

After `build-push.yml` succeeds on `main`. The Cloud Run service authenticates to
the GKE cluster via Workload Identity — the binary's `api` mode uses in-cluster
config, which the Cloud Run runtime SA resolves to the GKE cluster through a
pre-configured Workload Identity binding.

The GKE API endpoint is discovered at deploy time via `gcloud container clusters
describe`, then passed to Cloud Run as an environment variable. The binary reads
it on startup.

```yaml
name: Deploy Cloud Run Dev
on:
  workflow_run:
    workflows: [Build & Push]
    types: [completed]
    branches: [main]
  workflow_dispatch: {}
concurrency: deploy-cloudrun-dev
jobs:
  deploy:
    steps:
      - auth to GCP
      - id: gke-info
        run: |
          ENDPOINT=$(gcloud container clusters describe $GKE_CLUSTER_NAME \
            --zone $GKE_CLUSTER_ZONE --project $GKE_CLUSTER_PROJECT \
            --format 'value(endpoint)')
          echo "endpoint=https://${ENDPOINT}:443" >> $GITHUB_OUTPUT
      - run: gcloud run deploy paprika-api \
          --image=ghcr.io/benebsworth/paprika:sha-${{ github.sha }} \
          --args="--mode=api" \
          --set-env-vars="KUBERNETES_SERVICE_HOST=${{ steps.gke-info.outputs.endpoint }}" \
          --region=${{ vars.CLOUDRUN_REGION }} \
          --service-account=${{ vars.CLOUDRUN_SA }}
```

### 4.5 `release.yml` — Tagged Release

On tag push (`v*`). Builds, publishes, creates a GitHub Release with the
`dist/install.yaml` artifact, then deploys to both GKE prod and Cloud Run prod.

```yaml
name: Release
on:
  push:
    tags: [v*]
concurrency: release
jobs:
  release:
    permissions:
      contents: write
      packages: write
    steps:
      - checkout
      - build + push image with semver tag
      - run: make build-installer IMG=ghcr.io/benebsworth/paprika:${{ github.ref_name }}
      - create GitHub Release with dist/install.yaml artifact
      - deploy operator to GKE prod (helm upgrade with semver tag)
      - deploy api mode to Cloud Run prod
```

### 4.6 Required GitHub Variables & Secrets

| Name                          | Used By               | Purpose                          |
|-------------------------------|-----------------------|----------------------------------|
| `GCP_WIF_PROVIDER` (secret)   | deploy-gke, cloudrun  | Workload Identity Federation     |
| `GCP_SERVICE_ACCOUNT` (secret)| deploy-gke, cloudrun  | GCP SA to impersonate            |
| `GKE_CLUSTER_NAME` (var)      | deploy-gke            | GKE cluster name                 |
| `GKE_CLUSTER_ZONE` (var)      | deploy-gke            | GKE cluster zone/region          |
| `GKE_CLUSTER_PROJECT` (var)   | deploy-gke            | GCP project ID for GKE           |
| `CLOUDRUN_REGION` (var)       | deploy-cloudrun       | Cloud Run region                 |
| `CLOUDRUN_SA` (var)           | deploy-cloudrun       | Cloud Run runtime SA email       |

### 4.7 Rollback Strategy

| Scenario              | Method                                                                 |
|-----------------------|------------------------------------------------------------------------|
| Bad GKE deploy        | `helm rollback paprika-dev` — reverts to previous revision             |
| Bad Cloud Run deploy  | `gcloud run revisions list` → `gcloud run traffic --to-revision=<prev>`|
| Bad image publish     | SHA-tagged images are immutable; point deploy workflows at a known-good SHA |
| Critical production   | `helm rollback` + Cloud Run traffic split. Hotfix via PR → main.       |

Deploy workflows pin images by commit SHA, not `latest`, so any deployment is
fully reproducible. A bad `latest` tag never reaches production automatically
without a corresponding SHA deploy.

## 5. Helm Chart

Generated via `kubebuilder edit --plugins=helm/v2-alpha --output-dir=charts`.

Custom `values.yaml` additions:

```yaml
# Deployment mode: "operator" or "api"
mode: operator

# For api mode: remote K8s cluster connection
remoteCluster:
  apiServer: ""
  tokenFile: ""

image:
  repository: ghcr.io/benebsworth/paprika
  tag: latest
  pullPolicy: Always
```

In `operator` mode, the chart deploys the full deployment (controllers, ServiceAccount,
CRBs, metrics Service, etc.). In `api` mode, only a minimal Deployment + Service for the
API server.

**Important:** After initial generation, `charts/chart/values.yaml` and
`charts/chart/manager/manager.yaml` must be manually edited to add the `mode`,
`remoteCluster` fields, and conditional template logic. A `--force` re-generation will
overwrite these, so we back them up first.

## 6. GKE Deployment

### 6.1 Infrastructure Prerequisites

- GKE cluster (autopilot or standard) with Workload Identity enabled
- GHCR is public so any cluster can pull without credentials
- IAM: GitHub Actions SA can deploy via Workload Identity Federation

### 6.2 Helm Values (operator mode)

```yaml
mode: operator
image:
  repository: ghcr.io/benebsworth/paprika
  tag: sha-<commit>
```

The Helm chart deploys:
- Namespace (paprika-system)
- CRDs (via pre-install hook or separate `kubectl apply`)
- ServiceAccount, ClusterRole, ClusterRoleBinding
- Deployment (with controller manager)
- Service (metrics)
- (future) Webhook configuration

### 6.3 Manual Deploy (dev)

```bash
make deploy IMG=ghcr.io/benebsworth/paprika:sha-<commit>
```

## 7. Cloud Run Deployment

### 7.1 Infrastructure Prerequisites

- Cloud Run service
- Workload Identity: Cloud Run SA → GKE SA binding
  - The Cloud Run service account needs `roles/container.developer` on the
    GKE cluster to list/get CRDs
- VPC connector or direct access to GKE control plane (depends on network config)

### 7.2 How Cloud Run Authenticates to GKE

1. Cloud Run runs with a dedicated service account
   (`paprika-cloudrun@PROJECT.iam.gserviceaccount.com`)
2. This SA has a Workload Identity binding to a GCP-managed K8s SA in the GKE
   cluster with `get,list,watch` permissions on the 5 CRD types
3. The binary's `api` mode runs on Cloud Run. K8s client resolution order:
   a. If `--k8s-api-server` is set, use that URL with the in-cluster SA token
   b. Otherwise, use `rest.InClusterConfig()` which reads the Workload Identity-
      mounted proxy token and resolves via `KUBERNETES_SERVICE_HOST`
4. GKE authenticates the workload identity token against the mapped SA
5. The operator's existing ClusterRole grants access to all CRD types

### 7.3 Resource Limits

Cloud Run container: 1 vCPU, 256Mi memory (API server is lightweight).
No GPU, no HTTP/2 needed for the connect-go API.

### 7.4 Cloud Run Service YAML

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: paprika-api
spec:
  template:
    spec:
      containers:
        - image: ghcr.io/benebsworth/paprika:latest
          args:
            - --mode=api
          ports:
            - containerPort: 3000
          resources:
            limits:
              cpu: "1"
              memory: 256Mi
      serviceAccountName: paprika-cloudrun
```

This is committed at `config/cloudrun/service.yaml`.

## 8. Makefile Changes

```makefile
# Default image target
IMG ?= ghcr.io/benebsworth/paprika:latest

# Helm chart output
HELM_OUTPUT_DIR ?= charts

# Add targets:
helm-generate:  ## Generate Helm chart from Kustomize
	@echo "Backing up custom Helm values..."
	@if [ -f $(HELM_OUTPUT_DIR)/chart/values.yaml ]; then \
	  cp $(HELM_OUTPUT_DIR)/chart/values.yaml /tmp/helm-values-backup.yaml; \
	fi
	kubebuilder edit --plugins=helm/v2-alpha --output-dir=$(HELM_OUTPUT_DIR) --force
	@echo "Restoring custom Helm values..."
	@if [ -f /tmp/helm-values-backup.yaml ]; then \
	  cp /tmp/helm-values-backup.yaml $(HELM_OUTPUT_DIR)/chart/values.yaml; \
	fi
```

## 9. Implementation Order

1. Add `--mode` flag and `api` mode code path to `cmd/main.go`
2. Generate Helm chart with `kubebuilder edit --plugins=helm/v2-alpha`
3. Customize Helm chart values.yaml for mode + remoteCluster
4. Create CI workflow (`build-push.yml`)
5. Create deploy workflows (`deploy-gke.yml`, `deploy-cloudrun.yml`)
6. Create release workflow (`release.yml`)
7. Apply Makefile changes (IMG default + helm-generate target)
8. Add Cloud Run service YAML (`config/cloudrun/service.yaml`)
9. Update README with deployment instructions
10. End-to-end verification: push to main → CI → deploy

## 10. Security Considerations

- **No static keys**: All GCP auth via Workload Identity Federation
- **GHCR auth**: GitHub's `GITHUB_TOKEN` has `packages: write` permission,
  scoped to the repository
- **Cloud Run → GKE**: Workload Identity maps Cloud Run SA to GKE SA,
  no long-lived tokens or static kubeconfigs. The GKE API endpoint is injected
  via `KUBERNETES_SERVICE_HOST` environment variable (set by deploy workflow).
  The `--k8s-token-file` fallback path uses an in-cluster SA token mounted by
  Cloud Run (GKE Workload Identity proxy).
- **CRD management**: CRDs are installed via `kubectl apply -f config/crd/bases`
  in the deploy workflow, separate from Helm. This avoids Helm's CRD deletion
  behavior and keeps CRD lifecycle explicit.
- **Cloud Run ↔ GKE networking**: Cloud Run uses `--vpc-connector` to reach the
  GKE control plane private endpoint when the cluster is private, or direct
  HTTPS access for public-endpoint clusters. The deploy workflow configures
  this based on the cluster type.
- **Image pinning**: SHA-tagged images ensure reproducible deployments; `latest`
  is never auto-deployed to production
- **Concurrency gates**: Deploy workflows use `concurrency` to prevent overlapping
  deployments that could cause partial state
