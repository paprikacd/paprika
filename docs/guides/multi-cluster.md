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
