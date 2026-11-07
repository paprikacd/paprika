# Install Paprika and deploy your first Application

Install the Kubernetes operator, create an Application, then follow its Release
and workload health. Use a non-production cluster for this first run. The
examples use the Helm release `paprika` in the `paprika-system` namespace.

The CLI is optional for this walkthrough: `kubectl` is enough to create and
inspect the Application. Installing the CLI alone does not install the operator.

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

For that source build, invoke `./bin/paprika` or add its directory to `PATH`
before using the commands below.

For the project-hosted API only, log in and inspect its status. For your own installation, use your server address and configured authentication:

```sh
paprika login --server https://paprika.benebsworth.com
paprika status
```

## Prerequisites

- Kubernetes cluster (v1.29+ recommended)
- `kubectl` configured for that cluster and Helm with OCI support
- Cluster access to pull the operator and demo workload images
- [cert-manager](https://cert-manager.io/docs/installation/) only when enabling admission webhooks

## Install the operator

Choose a published release or build the current source. The source documentation
tracks `master`; newer features can require a newer operator than a pinned release.

### Install a published release

This example pins the [0.4.7 release](https://github.com/paprikacd/paprika/releases/tag/v0.4.7)
and uses its published OCI chart and server image. That server image supports
`linux/amd64` nodes; the CLI's separate `arm64` downloads do not imply an ARM
server image. This route does not require local Go, Docker, or a registry push.

Set the image repository explicitly: the chart's source default is the
placeholder `controller`, including in this release. Keep the chart version and
server image version together.

```sh
kubectl config current-context
helm install paprika oci://ghcr.io/paprikacd/charts/paprika \
  --version 0.4.7 \
  --namespace paprika-system \
  --create-namespace \
  --set manager.image.repository=ghcr.io/paprikacd/paprika \
  --set manager.image.tag=0.4.7 \
  --wait --timeout 5m
kubectl get pods -n paprika-system
```

### Build and install the current source

Use this route when evaluating changes on `master`. It additionally requires
Git, Make, Go 1.26+, Docker, and a registry that you can push to and your cluster
can pull from. Build an image for the cluster's node architecture and pass the
same image tag to the chart.

```sh
git clone https://github.com/paprikacd/paprika.git
cd paprika
kubectl config current-context

# Replace these placeholders with your registry and immutable tag.
make docker-build docker-push IMG=YOUR_REGISTRY/paprika:YOUR_TAG
make helm-deploy IMG=YOUR_REGISTRY/paprika:YOUR_TAG
kubectl get pods -n paprika-system
```

When your build machine and cluster use different architectures, set
`DOCKER_DEFAULT_PLATFORM` for the build, for example
`DOCKER_DEFAULT_PLATFORM=linux/amd64 make docker-build docker-push IMG=YOUR_REGISTRY/paprika:YOUR_TAG`
for an amd64 cluster.

Both routes use the chart's default single-pod configuration and install Paprika
CRDs. Its default webhooks and cert-manager integration
are disabled; enable both only after installing cert-manager and reviewing the
[chart values](../charts/chart/values.yaml). For a local controller development
loop instead, follow [CONTRIBUTING.md](../CONTRIBUTING.md) and check the active
Kubernetes context first.

## Creating Your First Application

An `Application` is the top-level resource that models a deployment. Save this
manifest as `application.yaml`. It uses the demo Helm chart bundled inside
Paprika's operator image, with one replica and a rolling deployment. The chart
path is inside the container, not a directory on your laptop.

The demo workload uses `nginxinc/nginx-unprivileged:alpine`. Your cluster must be
able to pull that image. The bundled chart avoids depending on an old external
Helm chart version for the first walkthrough.

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
      path: /charts/demo-app
  stages:
    - name: dev
      ring: 1
  strategy: Rolling
  syncPolicy: Auto
  parameters:
    replicaCount: "1"
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
kubectl get releases,stages,templates -n paprika-system
kubectl get deployments,services -n paprika-system \
  -l app.paprika.io/name=my-app
```

Inspect `status.phase`, conditions, and the related Release. Health describes
the observed workload; sync describes whether live resources match the rendered
desired state. An accepted manifest alone does not confirm deployment. If the
Application is not progressing, inspect its conditions and the operator logs
before applying another change.

### Open the console

For the default single-pod installation above, forward the local API/UI service:

```sh
kubectl -n paprika-system port-forward \
  svc/paprika-manager-api-service 3000:3000
```

Open [the local console](http://localhost:3000) and inspect `my-app`. Keep the
port-forward running while using it. The default install has no public ingress;
configure [authentication](guides/auth.md) before exposing the API or console to
other networks. Insights and the Observe gateway have separate setup guides and
are not enabled by this operator-only walkthrough.

For the complete Paprika-managed DeepHost example, including Git source
resolution, chart rendering, cluster-scoped RBAC, health-gated promotion, and
the DeepHost runtime/request path, see the [DeepHost Integration guide](guides/deephost.md).

## Understanding the CRDs

The Application controller creates the supporting records for the first
walkthrough; you do not need to create each one separately.

| Resource | What it records |
| --- | --- |
| `Application` | Source, delivery settings, target stages, and observed application state. |
| `Template` | The source used to render Kubernetes manifests. |
| `Stage` | A deployment target, strategy, and configured verification or approval gates. |
| `Release` | A particular delivery attempt and its progress through apply and verification. |
| `Pipeline` | Optional container steps run as Kubernetes Jobs. |

Use the [feature and concept guide](features.md) for the wider resource model
and the [API types](../api/pipelines/v1alpha1/) for field definitions. For
separate environment Applications that promote one tested Git commit, follow
the [environment promotion guide](guides/environment-promotion.md).

## Multi-Cluster Deployment

The first example deploys to the operator's cluster. To deploy elsewhere,
register a target and choose the appropriate direct or satellite connection.
The [multi-cluster guide](guides/multi-cluster.md) covers credentials, target
selection, permissions, and the distinction between observed inventory and
managed deployments.

## Canary Deployments

Configure traffic routing before changing the first example to `Canary`.
Paprika supports standalone Stage traffic routers for Istio and Gateway API,
or charts that render the injected `canaryWeight` into their routing resources.
Application inline stages do not accept `trafficRouter`.

Canary steps are integer percentages, such as `[5, 25, 50, 100]`. The
[canary guide](guides/canary.md) contains the supported resource shapes, step
timing, analysis checks, and rollback settings. Use those examples with a
chart and traffic backend that implement the intended weight changes.

## Monitoring

### Operator Logs

```sh
kubectl logs -n paprika-system deployment/paprika-controller-manager -c manager -f
```

### Prometheus Metrics

The controller metrics port defaults to `8443`. Transport and access depend on
the installed chart values: `metrics.secure: true` is the default and uses HTTPS
with authentication and authorization; `metrics.secure: false` explicitly
selects HTTP. A port-forward does not bypass metrics authorization.

Key metrics:
- `paprika_out_of_sync{app, namespace}` — Current out-of-sync resource count (gauge). Alert on > 0 for > 5 minutes.
- `paprika_prunable{app, namespace}` — Current prunable resource count (gauge). Alert on > 0 for > 10 minutes.
- `paprika_prune_total{app, namespace, kind}` — Resources pruned per apply (counter). Alert on unexpected spikes.
- `paprika_reconcile_total{controller, result}` — Reconciliation count
- `paprika_reconcile_duration_seconds` — Reconciliation duration histogram
- `paprika_release_phase_total` — Release phase transitions
- `paprika_application_phase_total` — Application phase transitions
- `paprika_pipeline_phase_total` — Pipeline phase transitions

For transport-specific scraping guidance, the metric reference, and alerting rules, see the
[Metrics and Alerting guide](guides/metrics.md).

## Cleanup

Delete the test Application while its operator and target credentials are still
available. Use background cascading so Release cleanup can finish with its
Stage routing intact:

```sh
kubectl config current-context
kubectl delete application my-app -n paprika-system \
  --cascade=background --wait=true --timeout=120s
kubectl get releases -n paprika-system
```

Wait for this Application's Releases and deployed workloads to be removed.
If deletion times out, inspect its finalizers and operator logs before
uninstalling the controller. When the release is no longer managing any
Applications you want to keep, remove the operator installed by this guide:

```sh
kubectl config current-context
helm uninstall paprika --namespace paprika-system
```

The chart retains its CRDs. Removing a CRD deletes its custom resources across
the cluster, so CRD removal is a separate cluster-wide teardown step, not part
of deleting this demo.

## Next Steps

- Read the [architecture overview](../README.md#architecture) to understand the system design
- Review the [sample manifests](../config/samples/) for more examples
- Explore the [API types](../api/pipelines/v1alpha1/) for all available fields
- Configure [environment promotion](guides/environment-promotion.md) or [Pipeline steps](guides/pipelines.md)
- [Install the Paprika plugin in Codex or Claude](guides/mcp-plugin.md) to inspect app health, debug failures, and manage delivery from chat
- Learn about [drift detection and pruning](guides/drift-and-prune.md)
- Set up [metrics and alerting](guides/metrics.md)
- Connect [Paprika Observe](../plugins/paprika-observe/README.md) and explore [dashboard examples](guides/dashboard-repository-examples.md)
- Read the [operations guide](guides/operations.md) for build, deploy, and debug workflows
