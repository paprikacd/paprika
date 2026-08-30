# DeepHost Integration and E2E Flow

This guide documents the working integration between Paprika and DeepHost.
Paprika owns delivery of the DeepHost Helm chart; DeepHost owns application
hosting after its chart is applied. The integration is deliberately split so
Paprika can provide GitOps, staged promotion, drift detection, health checks,
and rollback while DeepHost provides App, Build, Release, Domain, routing, and
runtime behavior.

## Ownership Boundary

| Layer | Resource location | Owner | Function |
| --- | --- | --- | --- |
| Paprika control plane | `paprika-e2e` | Helm release `paprika-e2e` | Source resolution, Helm rendering, manifest application, health, drift, and promotion. |
| DeepHost platform | `deephost` | Paprika `Application/deephost` | Control plane, operator, router, Hydra, Redis, MinIO, and DeepHost CRDs. |
| Shared ingress | `envoy-gateway-system` | Cluster platform | Gateway, TLS listener, and load balancer. |

The bootstrap manifest is
`deephost/deploy/paprika/deephost.yaml`. It points Paprika at
`https://github.com/castlemilk/deephost.git`, path `charts/deephost`, revision
`main`, and target namespace `deephost`. Its stage is `vke-apps`, ring `2`,
with automatic promotion and a router health probe at
`http://deephost-router.deephost.svc.cluster.local/healthz`.

After bootstrap, do not run direct Helm or raw `kubectl apply` against the
DeepHost workloads. Push source changes and let Paprika create and promote the
next Release.

## Paprika Components in This Flow

- The controller-manager watches the Application and owns Release lifecycle.
- The repo-server resolves the Git source and makes chart rendering available.
- The API server and webhook receiver are independent Paprika services and do
  not serve DeepHost application traffic.
- The Paprika manager ServiceAccount is cluster-scoped because the rendered
  DeepHost chart contains CRDs, Namespaces, ClusterRoles, and
  ClusterRoleBindings.

Kubernetes RBAC escalation checks require the Paprika manager role to hold a
superset of every permission it applies. The chart therefore grants the
manager permissions for:

- DeepHost CRDs and Namespaces.
- ClusterRoles and ClusterRoleBindings.
- DeepHost `deephost.io` resources and status subresources.
- Pods, pod logs, events, services, Jobs, and related platform resources.
- Gateway/Ingress, cert-manager, Istio, and Knative resources used by the
  target chart.

If the role can patch a ClusterRole but does not hold the permissions contained
in that ClusterRole, the API server rejects the apply with
`attempting to grant RBAC permissions not currently held`.

## DeepHost Components

The chart installs the DeepHost control plane, operator, router, and Hydra.
The control plane creates App and Build CRs from CLI requests. The operator
turns Builds into builder Jobs, successful Builds into Releases, and Domains
into HTTPRoutes and Certificates. The router discovers hostnames from
`App.spec.domains` and chooses ready Releases with positive traffic weight.
Hydra is a shared artifact runtime with a bounded LRU cache. Redis handles
transient queue/coordination state and S3 or MinIO stores immutable artifacts.

The VKE onboarding baseline runs one replica of each DeepHost component,
Deployment-mode Hydra, one in-cluster Redis, and chart-managed MinIO. A larger
production overlay can use AWS S3, Knative Hydra, persistent Redis, and higher
replica counts.

At the time this guide was verified, the four Paprika workloads were all ready
on:

```text
ghcr.io/paprikacd/paprika@sha256:d445d50a775f5ba5313178f6139de34b82f32fa88d012440ca5948805eb6ef6e
```

Use the live Deployment image fields rather than copying this digest for a
future rollout.

## Source-to-Release Flow

1. A commit changes the DeepHost chart or its Application values.
2. Paprika polls the Git source and computes a new source identity.
3. The Application controller creates a Release and resolves the chart.
4. The repo-server renders the chart with the Application values.
5. Governance checks run before promotion.
6. The Release controller applies namespace and cluster resources. This
   includes the DeepHost CRDs, RBAC, Deployments, Services, gateway ConfigMap,
   and ReferenceGrant.
7. Paprika promotes the stage and waits for the configured health probe.
8. A successful Release becomes the active Application release. A render,
   apply, or health failure follows `onFailure.action: rollback`.

The rendered DeepHost resources then reconcile independently. Paprika owns
delivery of the platform; the DeepHost operator owns the behavior of the
platform's CRs.

## Application Request Flow

1. Cloudflare DNS resolves the host to the shared Envoy Gateway.
2. Envoy redirects HTTP to HTTPS, except exact ACME HTTP-01 paths.
3. Envoy selects a valid wildcard or per-domain certificate and forwards the
   hostname HTTPRoute to the DeepHost router.
4. The router reads App domains and Release readiness/weights.
5. Hydra serves the selected immutable artifact, loading it from S3/MinIO on
   cache miss.
6. The response returns through the router and Envoy.

## VKE Verification

Always confirm the context before a mutation:

```sh
kubectl config current-context
kubectl -n paprika-e2e get application deephost
kubectl -n paprika-e2e get releases.pipelines.paprika.io
kubectl -n paprika-e2e get deployment
kubectl -n deephost get pods,app,build,release,domain,httproute
```

Expected state is `Application/deephost` phase `Healthy`, health `Healthy`,
and `synced=true`. Verify the public path with:

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.deephost.benebsworth.com
curl -sS -o /dev/null -w '%{http_code}\n' -L --max-redirs 0 http://www.deephost.benebsworth.com
```

The expected codes are `200` for HTTPS and `301` for HTTP. Inspect individual
resource statuses before interpreting a historical `outOfSync` count; a
pruned target Namespace entry may remain while the current Release is
complete and all rendered resources are synchronized.

The current VKE baseline uses Deployment-mode Hydra. Knative Serving is not
installed in that cluster, so the VKE landing page is not currently a live
Knative scale-to-zero workload. The local DeepHost Knative E2E does prove the
landing artifact's warm, scale-to-zero, wake, and multi-app behavior. Installing
Knative in VKE is a separate shared-cluster infrastructure change; changing
`hydra.mode` alone is not sufficient.

## Terminal Release Recovery

A failed Release can exhaust its automatic retry budget. Fix the source, chart,
or Paprika manager RBAC first. Then request an explicit retry:

```sh
kubectl config current-context
kubectl -n paprika-e2e annotate application deephost \
  paprika.io/sync="$(date +%s)" \
  paprika.io/manual-sync="$(date +%s)" --overwrite
```

Watch the controller and confirm the replacement reaches `Complete`:

```sh
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m
kubectl -n paprika-e2e get application deephost
kubectl -n paprika-e2e get releases.pipelines.paprika.io
```

Never solve a target ClusterRole escalation error by adding an unrelated
cluster-admin binding. Extend the chart-managed manager role with the exact
target permissions, render/lint the chart, upgrade Paprika, check
`kubectl auth can-i`, and retry.

## Local DeepHost E2E

The DeepHost repository's `task e2e` is a separate local integration suite. It
uses `kind-deephost`, local images, MinIO, ephemeral Redis, and
`gateway.provider: none`; it does not exercise the VKE Paprika ownership
boundary. It deploys the actual `apps/landing` fixture and the optional
`task e2e:knative` script verifies that landing artifact through warm serving,
scale-to-zero, wake-up, and post-wake multi-app routing. The optional
`task e2e:gitnext` script covers Git-source builds. The full test matrix is
documented in `deephost/docs/e2e.md`.
