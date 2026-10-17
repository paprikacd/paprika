# Getting Started with paprika

This guide walks through deploying Paprika on your Kubernetes cluster and creating an Application. Start on a non-production cluster. Check the target context before every install or apply command.

## Install the CLI

The release installer supports Darwin (macOS) and Linux on `amd64` and `arm64`:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh
```

It downloads the archive from the canonical GitHub release and verifies its
checksum before installation. Audit the
[latest published checksums](https://github.com/paprikacd/paprika/releases/latest/download/checksums.txt).
For a reproducible install, pin `PAPRIKA_VERSION`; the corresponding checksum
file uses this exact URL pattern:

`https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt`

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_VERSION=vX.Y.Z sh
```

The installer does not invoke `sudo`. It chooses a writable directory on your
`PATH` when possible and falls back to `~/.local/bin` with an exact `PATH` note.
Set `PAPRIKA_INSTALL_DIR` to choose a different writable destination:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_INSTALL_DIR="$HOME/.local/bin" sh
```

Homebrew is not yet supported. For a source install, clone the repository and
build the CLI directly:

```sh
git clone https://github.com/paprikacd/paprika.git
cd paprika
go build -o ./bin/paprika ./cmd/paprika
```

For the project-hosted API only, log in and inspect its status. For your own installation, use your server address and configured authentication:

```sh
paprika login --server https://paprika.benebsworth.com
paprika status
```

## Prerequisites

- Kubernetes cluster (v1.29+ recommended)
- `kubectl` configured for your cluster, plus Helm, Docker, and Go 1.26+
- Registry credentials that let you push an image and let the cluster pull it
- [cert-manager](https://cert-manager.io/docs/installation/) only when enabling admission webhooks

## Install the operator

The in-repository Helm chart defaults to a placeholder `controller` image. Build and
push an explicit image tag to a registry your cluster can access, then pass that
same tag to the chart. These commands change the cluster selected by your current
`kubectl` context:

```sh
git clone https://github.com/paprikacd/paprika.git
cd paprika
kubectl config current-context

# Replace these placeholders with your registry and immutable tag.
make docker-build docker-push IMG=YOUR_REGISTRY/paprika:YOUR_TAG
make helm-deploy IMG=YOUR_REGISTRY/paprika:YOUR_TAG
kubectl get pods -n paprika-system
```

The chart installs Paprika CRDs. Its default webhooks and cert-manager integration
are disabled; enable both only after installing cert-manager and reviewing the
[chart values](../charts/chart/values.yaml). For a local controller development
loop instead, follow [CONTRIBUTING.md](../CONTRIBUTING.md) and check the active
Kubernetes context first.

## Creating Your First Application

An `Application` is the top-level resource that models a deployment. This example uses a Helm chart source; verify the chart name and version still exist before applying it:

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
kubectl config current-context
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

Inspect `status.phase`, conditions, and the related Release. A healthy result depends on the source, cluster access, and workload health; an accepted manifest alone does not confirm deployment.

For the complete Paprika-managed DeepHost example, including Git source
resolution, chart rendering, cluster-scoped RBAC, health-gated promotion, and
the DeepHost runtime/request path, see the [DeepHost Integration guide](guides/deephost.md).

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

  # Optional sync options
  syncOptions:
    prune: true                   # Garbage-collect stale resources after apply
    # pruneClusterScopedKinds:    # Cluster-scoped kinds eligible for pruning
    #   - ClusterRole
    #   - ClusterRoleBinding

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
- `paprika_out_of_sync{app, namespace}` — Current out-of-sync resource count (gauge). Alert on > 0 for > 5 minutes.
- `paprika_prunable{app, namespace}` — Current prunable resource count (gauge). Alert on > 0 for > 10 minutes.
- `paprika_prune_total{app, namespace, kind}` — Resources pruned per apply (counter). Alert on unexpected spikes.
- `paprika_reconcile_total{controller, result}` — Reconciliation count
- `paprika_reconcile_duration_seconds` — Reconciliation duration histogram
- `paprika_release_phase_total` — Release phase transitions
- `paprika_application_phase_total` — Application phase transitions
- `paprika_pipeline_phase_total` — Pipeline phase transitions

The metrics endpoint is HTTP on port 8443 (not HTTPS):

```sh
kubectl port-forward -n paprika-system svc/paprika-controller-manager-metrics-service 8443:8443
curl -s http://localhost:8443/metrics | grep paprika_out_of_sync
```

For a complete metric reference and alerting rules, see the
[Metrics and Alerting guide](guides/metrics.md).

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

- Read the [architecture overview](../README.md#architecture) to understand the system design
- Review the `config/samples/` directory for more examples
- Explore the [API types](../api/pipelines/v1alpha1/) for all available fields
- See the [design docs](superpowers/specs/) for detailed design decisions
- Learn about [drift detection and pruning](guides/drift-and-prune.md)
- Set up [metrics and alerting](guides/metrics.md)
- Read the [operations guide](guides/operations.md) for build, deploy, and debug workflows
