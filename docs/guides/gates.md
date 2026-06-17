# Approval Gates

Gates control whether a promotion can proceed to the next stage. Paprika supports automated smoke-test and duration gates, as well as manual approval gates that require a user or API call to approve.

## Gate Types

### Smoke-test gate

Runs an HTTP check against the deployed stage. The gate passes when the endpoint returns a successful status.

```yaml
gates:
  - type: smoke-test
    endpoint: http://my-app-dev/health
    timeout: 30
```

### Duration gate

Waits a fixed number of seconds before allowing promotion. Useful for soak testing.

```yaml
gates:
  - type: duration
    timeout: 300
```

### Manual approval gate

Blocks promotion until a user approves it through the API, CLI, or dashboard.

Define the gate on the `Application`:

```yaml
spec:
  approvalGates:
    - name: qa-approval
      stage: prod
      type: manual
      required: true
```

## Automated Gates on a Stage

Define automated gates directly on a `Stage`:

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
  gates:
    - type: smoke-test
      endpoint: http://my-app-prod/health
      timeout: 60
    - type: duration
      timeout: 600
```

The release controller evaluates these gates after a promotion reaches the verifying phase.

## Manual Approval

### Via the CLI

```sh
paprika gates approve my-app qa-approval -n paprika-system
```

### Via the API

```sh
curl -X POST http://localhost:3000/paprika.v1.PaprikaService/ApproveGate \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "namespace": "paprika-system",
    "gate": "qa-approval"
  }'
```

After approval, the release controller resumes promotion to the next stage.

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
  strategy: Rolling
  syncPolicy: Auto
  approvalGates:
    - name: qa-approval
      stage: prod
      type: manual
      required: true
  stages:
    - name: dev
      ring: 1
      gates:
        - type: smoke-test
          endpoint: http://my-app-dev/health
          timeout: 30
    - name: staging
      ring: 2
      gates:
        - type: duration
          timeout: 300
    - name: prod
      ring: 3
---
apiVersion: pipelines.paprika.io/v1alpha1
kind: Stage
metadata:
  name: my-app-dev
  namespace: paprika-system
spec:
  name: dev
  ring: 1
  templates:
    - my-app-template
  gates:
    - type: smoke-test
      endpoint: http://my-app-dev/health
      timeout: 30
```

## Viewing Gate Status

Check gate status in the application output:

```sh
paprika apps get my-app -n paprika-system
```

Gate table columns: `NAME`, `STAGE`, `STATUS`, `APPROVED BY`. Status values are `Pending`, `Approved`, or `Rejected`.
