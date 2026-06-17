# Canary Deployments

Paprika supports progressive canary rollouts by shifting traffic between stable and canary service backends in discrete steps. The operator integrates with Istio VirtualServices or Gateway API HTTPRoutes.

## How It Works

1. A `Stage` defines `canary.steps` as a list of traffic weights (percentages).
2. The operator creates or patches the configured traffic router at each step.
3. After each weight change, the operator waits `intervalSeconds` before advancing.
4. If `analysis` checks are configured, they must pass before the next step.
5. The final step (usually `100`) promotes the canary to full traffic.

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
      metric: errorRate
      threshold: "0.01"
      windowSeconds: 300
    - type: podMetrics
      metric: latencyP99
      threshold: "500"
      windowSeconds: 300
```

Supported metrics: `errorRate`, `latencyP99`, `restartRate`.

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
