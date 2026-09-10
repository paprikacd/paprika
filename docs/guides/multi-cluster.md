# Multi-Cluster Deployments

Paprika can deploy applications to remote Kubernetes clusters. Each `Stage` references a `Cluster` resource that describes how the operator should connect to the target cluster.

## Cluster Modes

The `Cluster` CR supports three connection modes:

| Mode | Use Case |
|------|----------|
| `in-cluster` | The operator runs inside the target cluster and uses its own service account. |
| `direct` | The operator connects to a remote API server using a kubeconfig stored in a Secret. |
| `agent` | The operator connects via a Paprika agent running in the remote cluster. |

## Registering a Cluster

Create a `Cluster` resource:

```yaml
apiVersion: clusters.paprika.io/v1alpha1
kind: Cluster
metadata:
  name: prod-cluster
  namespace: paprika-system
spec:
  displayName: Production
  mode: direct
  server: https://prod-cluster.example.com
  kubeconfigSecretRef:
    name: prod-kubeconfig
    namespace: paprika-system
    key: kubeconfig
  healthCheck:
    interval: 30s
    timeout: 10s
  connectionTimeout: 30s
```

For agent mode:

```yaml
apiVersion: clusters.paprika.io/v1alpha1
kind: Cluster
metadata:
  name: edge-cluster
  namespace: paprika-system
spec:
  displayName: Edge
  mode: agent
  agentAddress: paprika-agent.edge:443
```

## Kubeconfig Secret

For `direct` mode, store a valid kubeconfig in a Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: prod-kubeconfig
  namespace: paprika-system
type: Opaque
stringData:
  kubeconfig: |
    apiVersion: v1
    kind: Config
    clusters:
      - name: prod-cluster
        cluster:
          server: https://prod-cluster.example.com
          certificate-authority-data: <base64-ca>
    users:
      - name: prod-user
        user:
          token: <token>
    contexts:
      - name: prod
        context:
          cluster: prod-cluster
          user: prod-user
    current-context: prod
```

## Permissions the Remote Credential Needs

The user in that kubeconfig is the identity Paprika acts as on the target
cluster, so it needs the permissions for what Paprika does there. Beyond the
access your applications' own manifests require, capacity meters read two more
kinds, both read-only:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paprika-capacity-reader
rules:
  # KubernetesCapacity sums status.allocatable across nodes and container
  # requests across pods. It never writes either, and never reads the node
  # proxy or the eviction subresource.
  - apiGroups: [""]
    resources: ["nodes", "pods"]
    verbs: ["get", "list", "watch"]
```

Bind it to the remote credential's subject with a ClusterRoleBinding. Without
it, a capacity read reports `DATA_STATE_FORBIDDEN` for that cluster rather than
failing the request — the meter goes dark, nothing else does. That state is
distinct from `DATA_STATE_ERROR` on purpose: `FORBIDDEN` means the read reached
the cluster and was refused, which is a grant you can make, while `ERROR` covers
every other way a read fails. Whichever it is, the number beside it is zero:
Paprika never renders a figure it cannot substantiate. Grant exactly these verbs
on exactly these resources; `cluster-admin` is never the fix for a capacity
permission error.

For an in-cluster (`mode: in-cluster`) target the chart-managed manager role
already carries them, so nothing extra is needed.

## Capacity Providers

Where a capacity number comes from is configuration, not code. Two custom
resources describe it:

- **`CapacityProvider`** names an implementation and configures it. The
  implementation is a registry key this build ships, not an arbitrary string —
  an unknown key is rejected at admission.
- **`DataProviderBinding`** attaches a provider to a scope: `Namespace`,
  `Cluster`, `Project` or `Global`.

Two implementations ship today:

| `spec.provider` | Supplies | Reads | Configuration |
| --- | --- | --- | --- |
| `KubernetesCapacity` | `allocatable`, `requested` | Nodes and Pods, core API | none |
| `MetricsServer` | `used` | `metrics.k8s.io` | none |

### What a Default Install Already Has

The chart ships a `KubernetesCapacity` provider bound at `Global` scope in the
release namespace, so allocatable and requested capacity work with nothing to
configure. `used` reports `NOT_CONFIGURED` until you bind a usage provider.
Turn the defaults off with `--set capacity.defaultProvider.enabled=false` if you
would rather manage them yourself.

### Completing the Meter

A scope may have more than one provider bound to it, and that is how a meter is
completed rather than replaced: each provider's readings are merged, and a
successful measurement is never overwritten by another provider's failure or by
its "I don't supply that field". `KubernetesCapacity` gives allocatable and
requested; `MetricsServer` gives used; together they are one meter.

```yaml
apiVersion: providers.paprika.io/v1alpha1
kind: CapacityProvider
metadata:
  name: metrics-server
  namespace: paprika-system
spec:
  provider: MetricsServer
---
apiVersion: providers.paprika.io/v1alpha1
kind: DataProviderBinding
metadata:
  name: metrics-server-global
  namespace: paprika-system
spec:
  providerRef:
    kind: CapacityProvider
    name: metrics-server
  scope:
    kind: Global
```

Binding a *second* provider to one scope is supported. Binding the *same*
provider to one scope twice is rejected — it says nothing the first binding does
not.

### Scope Precedence

Bindings resolve most-specific-first, independently for each provider:

```
Namespace  >  Cluster  >  Project  >  Global
```

So a `Global` binding is a fleet-wide floor, and a `Cluster`-scoped binding for
the same provider overrides it for that cluster alone — you never have to remove
the broad binding to special-case a narrow one.

Two scope levels are guarded, because both can speak for someone else:

- A `Global` binding may only be created in the control plane's own namespace
  (the release namespace, which the deployments pass as `--operator-namespace`).
  It applies to the whole fleet, so a tenant-created one would repoint what
  every other tenant sees.
- A `Namespace` binding may only name the namespace it lives in. `Namespace` is
  the most specific level, so one naming another tenant's namespace would win
  the chain inside it.

`scope.selector` is present in the CRD but not yet honoured, and is rejected at
admission rather than silently ignored. Name the scope with `scope.name`.

### Pointing Capacity at Prometheus Later

A `Prometheus` provider — capacity plus RED signals, over PromQL — is the next
implementation planned, and it is why this is a binding model rather than a
config flag. When it lands, moving one cluster onto it is a `CapacityProvider`
naming it and a `Cluster`-scoped `DataProviderBinding`; the `Global`
`KubernetesCapacity` binding stays where it is and keeps serving every other
cluster. Nothing already bound changes meaning.

Neither shipped implementation takes any configuration, and both reject a
non-empty `spec.config` at admission rather than ignoring it, so a stale or
typo'd config cannot pass unnoticed. Whatever an implementation does accept,
a literal credential is never part of it: token- and password-shaped fields are
refused at admission, at any nesting depth.

## Referencing a Cluster from a Stage

A `Stage` can reference the `Cluster` by name:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Stage
metadata:
  name: my-app-prod
  namespace: paprika-system
spec:
  name: prod
  ring: 3
  templates:
    - my-app-template
  cluster:
    name: prod-cluster
    namespace: paprika-system
    mode: direct
    kubeconfigSecret: prod-kubeconfig
```

The `cluster` block in `ApplicationPromotionStage` supports the same fields and can be used inline in an `Application`.

## Full Example

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: prod-kubeconfig
  namespace: paprika-system
type: Opaque
stringData:
  kubeconfig: |
    apiVersion: v1
    kind: Config
    clusters:
      - name: prod
        cluster:
          server: https://prod.example.com
          certificate-authority-data: LS0t...
    users:
      - name: deployer
        user:
          token: eyJhbG...
    contexts:
      - name: prod
        context:
          cluster: prod
          user: deployer
    current-context: prod
---
apiVersion: clusters.paprika.io/v1alpha1
kind: Cluster
metadata:
  name: prod
  namespace: paprika-system
spec:
  displayName: Production
  mode: direct
  server: https://prod.example.com
  kubeconfigSecretRef:
    name: prod-kubeconfig
    namespace: paprika-system
    key: kubeconfig
---
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.example.com
      name: my-app
      version: 1.2.3
  strategy: Rolling
  syncPolicy: Auto
  stages:
    - name: dev
      ring: 1
    - name: prod
      ring: 2
      cluster:
        name: prod
        namespace: paprika-system
        mode: direct
        kubeconfigSecret: prod-kubeconfig
```

## Cluster Health

The cluster controller periodically health-checks registered clusters. Check status with:

```sh
kubectl get cluster -n paprika-system
```

A cluster in `Unhealthy` phase will block deployments to stages that reference it.
