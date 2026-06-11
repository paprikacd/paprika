# Getting Started with paprika

This guide walks through deploying paprika on a Kubernetes cluster, creating an Application CR, and understanding what happens under the hood.

## Prerequisites

- Kubernetes cluster (v1.29+)
- [cert-manager](https://cert-manager.io/docs/installation/) installed (webhook certificates)
- `kubectl` configured for your cluster
- Docker (for building the operator image)

## Installation

### Option 1: Deploy from Source

```sh
git clone https://github.com/benebsworth/paprika.git
cd paprika

# Install CRDs
make install

# Build and push the operator image to your registry
export IMG=ghcr.io/YOUR_USER/paprika:latest
make docker-build docker-push IMG=$IMG

# Deploy the operator
make deploy IMG=$IMG

# Verify
kubectl get pods -n paprika-system
```

### Option 2: Deploy via Helm

```sh
# Generate Helm chart
make helm-generate

# Install via Helm
helm install paprika charts/chart --namespace paprika-system --create-namespace
```

### Option 3: Single YAML Bundle

```sh
make build-installer IMG=ghcr.io/YOUR_USER/paprika:latest
kubectl apply -f dist/install.yaml
```

## Creating Your First Application

An `Application` is the top-level resource that models your entire deployment. Minimal example:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.bitnami.com/bitnami
      name: nginx
      version: 18.2.2
  stages:
    - name: dev
      ring: 1
  strategy: Rolling
  syncPolicy: Auto
```

```sh
kubectl apply -f application.yaml
```

### What Happens

When you create the Application, paprika's controllers automatically:

1. **Template Created** — A `Template` resource is created from the `source` field
2. **Stage Created** — A `Stage` resource is created for each entry in `stages`
3. **Release Created** — A `Release` is created to promote the rendered manifests
4. **Manifests Rendered** — The Helm chart is rendered using the Helm SDK
5. **Manifests Applied** — Rendered resources are applied to the cluster
6. **Health Verified** — The operator monitors resource health

Check status:

```sh
kubectl get application my-app -n paprika-system -o yaml
```

The `status.phase` field shows the current state: `Pending` → `Promoting` → `Healthy` or `Degraded`.

## Understanding the CRDs

### Application

The Application resource ties everything together:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
spec:
  # Template source (Helm, Git, or S3)
  source:
    type: helm
    chart:
      path: /charts/my-app       # Local chart path
      # OR
      repo: https://charts.example.com
      name: my-app
      version: 1.0.0

  # Environment stages
  stages:
    - name: dev
      ring: 1
      canary:                     # Optional canary config
        steps:
          - weight: 10
          - weight: 50
          - weight: 100
        intervalSeconds: 60

  # Deployment strategy
  strategy: Rolling               # Rolling or Canary
  syncPolicy: Auto                # Auto or Manual

  # Parameters passed as Helm values
  parameters:
    replicaCount: "3"
    image.tag: "latest"

  # Optional approval gates
  approvalGates:
    - name: qa-approval
      description: "QA sign-off required for production"
```

### Template

A Template resource represents a source of Kubernetes manifests:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Template
metadata:
  name: my-app-template
spec:
  type: helm                    # helm, git, or s3
  chart:
    path: /charts/my-app
    # namespace: my-namespace   # Optional: override namespace
```

### Stage

A Stage represents an environment (dev, staging, production):

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Stage
metadata:
  name: my-app-dev
spec:
  name: dev
  ring: 1
  templates:
    - my-app-template
  cluster:                      # Optional: multi-cluster support
    name: dev-cluster
    kubeconfigSecret: dev-kubeconfig
  canary:
    steps:
      - weight: 10
      - weight: 50
    intervalSeconds: 30
  trafficRouter:                # Optional: traffic routing
    provider: Istio
    istio:
      host: my-app.example.com
      gateways:
        - istio-system/main-gateway
```

### Release

A Release manages the lifecycle of a single promotion:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Release
metadata:
  name: my-app-dev-release
spec:
  target: my-app-dev            # Target stage
  pipeline: my-app-pipeline     # Optional: pipeline reference
  parameters:
    replicaCount: "3"
```

The Release progresses through phases:
`Pending` → `Promoting` → `Verifying` / `Canarying` → `Complete` / `Failed`

## Multi-Cluster Deployment

Each Stage can reference a different cluster via a kubeconfig secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dev-kubeconfig
  namespace: paprika-system
type: Opaque
stringData:
  kubeconfig: |
    apiVersion: v1
    kind: Config
    clusters:
      - name: dev-cluster
        cluster:
          server: https://dev-cluster.example.com
    users:
      - name: dev-user
        user:
          token: <token>
    contexts:
      - context:
          cluster: dev-cluster
          user: dev-user
```

Then reference it in the Stage:

```yaml
spec:
  cluster:
    name: dev-cluster
    kubeconfigSecret: dev-kubeconfig
```

## Canary Deployments

Canary deployments require Istio or Gateway API installed on the cluster:

```yaml
spec:
  stages:
    - name: production
      ring: 1
      canary:
        steps:
          - weight: 5            # Send 5% traffic to canary
          - weight: 25           # Then 25%
          - weight: 50           # Then 50%
          - weight: 100          # Then 100% (promote)
        intervalSeconds: 120     # Wait 2 min between steps
      trafficRouter:
        provider: Istio
        istio:
          host: app.example.com
```

The operator manages traffic weights automatically through the canary lifecycle, with step interval throttling to prevent watch-event-driven fast-forward.

## Monitoring

### Operator Logs

```sh
kubectl logs -n paprika-system deployment/paprika-controller-manager -c manager -f
```

### Prometheus Metrics

The operator exposes metrics on port 8443:

```sh
kubectl port-forward -n paprika-system deployment/paprika-controller-manager 8443:8443
# Then: curl -k https://localhost:8443/metrics
```

Key metrics:
- `paprika_reconcile_total` — Reconciliation count by controller and result
- `paprika_reconcile_duration_seconds` — Reconciliation duration histogram
- `paprika_release_phase_total` — Release phase transitions
- `paprika_application_phase_total` — Application phase transitions
- `paprika_pipeline_phase_total` — Pipeline phase transitions
- `paprika_resource_sync_total` — Synced/out-of-sync resource counts

## Cleanup

```sh
# Delete your application
kubectl delete application my-app

# Uninstall the operator
make undeploy

# Or via Helm
helm uninstall paprika --namespace paprika-system

# Remove CRDs
make uninstall
```

## Next Steps

- Read the [architecture overview](README.md#architecture) to understand the system design
- Check [PRODUCTION_ROADMAP.md](../PRODUCTION_ROADMAP.md) for upcoming features
- Review the `config/samples/` directory for more examples
- Explore the [API types](../api/pipelines/v1alpha1/) for all available fields
- See the [design docs](superpowers/specs/) for detailed design decisions
