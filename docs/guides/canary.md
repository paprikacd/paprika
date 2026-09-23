# Canary Deployments

Paprika supports progressive canary rollouts by shifting traffic between stable and canary service backends in discrete steps. The operator integrates with Istio VirtualServices or Gateway API HTTPRoutes.

## How It Works

1. A `Stage` defines `canary.steps` as a list of traffic weights (percentages).
2. The operator shifts weight at each step — either by patching the configured
   traffic router, or by re-rendering the chart with the injected
   `canaryWeight` parameter (see "Chart-rendered weights" below).
3. Step N waits **N × `intervalSeconds`** after the previous step was applied
   — soaks get longer as traffic increases. A leading `0` step reproduces a
   "stage behind 0% traffic" soak: fallback serves 100% while the candidate
   converges.
4. If `analysis` checks are configured, they must all pass before the next
   step; a failure marks the release `Failed` and (with
   `analysis.rollbackOnFail: true` or `onFailure.action: rollback`) restores
   the previous release's manifest snapshot.
5. Each step is also gated on the rendered workloads converging
   (`progressDeadlineSeconds`) — an unpullable image or crashloop blocks
   advance and eventually fails the release.
6. The final step (usually `100`) promotes the canary to full traffic.

## Canary Configuration

A canary config is defined on an `Application` (default) or on an individual `Stage` (override):

```yaml
canary:
  steps:
    - 10
    - 25
    - 50
    - 100
  intervalSeconds: 120
  analysis:
    intervalSeconds: 30
    rollbackOnFail: true
    checks:
      - type: http
        url: http://my-app-canary/status
        successThreshold: "99"
        timeoutSeconds: 5
        requestCount: 10
```

- `steps` — traffic weight percentages applied in order.
- `intervalSeconds` — minimum wait between steps; prevents watch-event-driven fast-forward.
- `analysis` — optional automated checks that run during the canary.

## Traffic Routers

### Istio VirtualService

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
  canary:
    steps:
      - 10
      - 50
      - 100
    intervalSeconds: 120
  trafficRouter:
    provider: istio
    istio:
      virtualService: my-app-vs
      routes:
        - primary
      hosts:
        - my-app.example.com
      stableService: my-app-stable
      canaryService: my-app-canary
```

### Gateway API HTTPRoute

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
  canary:
    steps:
      - 5
      - 25
      - 50
      - 100
    intervalSeconds: 60
  trafficRouter:
    provider: gateway-api
    gatewayApi:
      httpRoute: my-app-route
      stableService: my-app-stable
      canaryService: my-app-canary
```

If `stableService` or `canaryService` are omitted, the operator derives names from the release.

### Chart-rendered weights (no `trafficRouter`)

`ApplicationPromotionStage` (the inline `spec.stages[]` on `Application`)
cannot express `trafficRouter` — that field only exists on standalone Stage
CRs. For Application-managed apps, render the weight into the chart instead:
during canary steps Paprika injects `features.canary.enabled=true` and
`canaryWeight=<step>` into the template render. If the chart maps
`canaryWeight` into its HTTPRoute (or Service/ingress) backend weights, the
entire ramp works with no router config. Gate the template on
`features.canary.enabled` — the final promotion render omits it, so the
steady-state render must produce `100/0`. See the flaggr-api chart for a
working example (`deploy/kubernetes/chart/templates/httproute.yaml`).

## Release Identity — what spawns a Release

A release's identity is `sourceHash + sourceRevision + stage name + merged
parameters`. Only changes to those inputs spawn a new release:

- Chart/source **content** changes spawn a release. Git source hashes are
  `<commit>:<dirHash>` and only the content segment is compared — commits
  outside the watched path do NOT churn releases.
- Parameter changes (e.g. an `image.digest` bump) spawn a release.
- Stage spec changes (steps, checks, intervals) do NOT — the materialized
  Stage CR updates in place and the next release picks them up.
- Reverting parameters to a previous combination collides with that older
  release's name: it is adopted and resynced (a fresh canary of the old
  release — self-heal semantics, not an instant switch).

## Analysis Checks

Analysis checks validate canary health before advancing to the next weight.

### HTTP checks

```yaml
analysis:
  checks:
    - type: http
      url: http://my-app-canary/metrics
      method: GET
      httpHeaders:
        Accept: application/json
      successThreshold: "95"
      timeoutSeconds: 5
      requestCount: 20
```

### Pod metric checks

```yaml
analysis:
  checks:
    - type: podMetrics
      metric: restartRate
      podSelector: app.kubernetes.io/name=my-api,app.kubernetes.io/component=api
      threshold: "3"
      windowSeconds: 300
    - type: podMetrics
      metric: errorRate
      podSelector: app.kubernetes.io/name=my-api,app.kubernetes.io/component=api
      threshold: "0.01"
      windowSeconds: 300
```

- `podSelector` (label selector) is **required** — pods are listed in the
  namespace of the resource under analysis (release/rollout/analysisrun),
  not the operator namespace. Target the candidate pods specifically.
- Supported metrics: `errorRate`, `restartRate`. `latencyP99` is declared
  but has no metrics backend — it **fails closed** rather than silently
  passing, as do a missing `podSelector` and a selector matching zero pods.
- A `restartRate` check is a cheap way to catch crashlooping candidates
  that still answer HTTP health checks between restarts.

### Results and observability

Each analysis cycle persists a `CanaryAnalysis` status condition on the
Release (e.g. `4/4 checks passed; failed: name: reason`), emits a
`CanaryAnalysis` Kubernetes event (Warning on failure), and increments
`paprika_analysis_check_total{release, namespace, check_type, result}`.
Check `kubectl describe release <name>` / `.status.conditions` after a
rollout to audit what actually ran.

## Full Example

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
      repo: https://charts.example.com
      name: my-app
      version: 1.2.3
  strategy: Canary
  syncPolicy: Auto
  parameters:
    image.tag: v1.2.3
  stages:
    - name: dev
      ring: 1
    - name: staging
      ring: 2
    - name: prod
      ring: 3
      canary:
        steps:
          - 10
          - 50
          - 100
        intervalSeconds: 180
        analysis:
          intervalSeconds: 30
          rollbackOnFail: true
          checks:
            - type: http
              url: http://my-app-canary/health
              successThreshold: "99"
              timeoutSeconds: 5
              requestCount: 10
---
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
  trafficRouter:
    provider: istio
    istio:
      virtualService: my-app-vs
      stableService: my-app-stable
      canaryService: my-app-canary
```

Apply and watch:

```sh
kubectl apply -f canary-app.yaml
kubectl get application my-app -n paprika-system -w
```

The `status.canaryWeight` and `status.canaryStepIndex` fields show the current rollout state.

## Rollback

Annotate a non-terminal release to roll it back (the application needs
`onFailure.action: rollback` — or trigger automatically via
`analysis.rollbackOnFail`):

```sh
kubectl -n <ns> annotate releases.pipelines.paprika.io <release> \
  paprika.io/rollback-requested="$(date +%s)" --overwrite
```

What happens:

1. The controller picks the newest `Complete` release, else the newest
   non-`Failed` release **including `Superseded`** — a superseded
   release's `status.renderedManifestSnapshot` is its steady-state
   render, which is exactly what gets restored.
2. That snapshot is re-applied (traffic returns to its steady state).
3. The rolled-back release is marked `RolledBack` with
   `status.rolledBackTo` set, and its automatic retry budget is spent —
   the application cannot adopt and auto-resync it (which would
   resurrect the very canary being stopped).
4. The application parks in `ReleaseRetriesExhausted` / `RolledBack`,
   still polling the source and watching release identity: a new commit
   or a parameter change starts a fresh release flow. A spec change that
   produces a different release identity is never held back by the cap.
5. `paprika.io/manual-sync` on the Application bypasses and resets the
   retry cap for deliberate operator retries.

Always qualify the resource: `releases.pipelines.paprika.io` — a bare
`kubectl get release` may resolve to a different CRD on clusters with
multiple release kinds installed.
