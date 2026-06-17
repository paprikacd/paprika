# Analysis Templates

Analysis templates let you define reusable, parameterized analysis checks and run them continuously in the background for an `Application`.

## Overview

- **`AnalysisTemplate`** — a reusable set of analysis checks.
- **`AnalysisRun`** — a per-application instance that executes a template on a schedule and reports results.
- **`Application`** — references one or more templates via `spec.analysisTemplates` and receives aggregated results in `status.analysisResults`.

## Defining a template

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-success-rate
  namespace: paprika-system
spec:
  args:
    - name: endpoint
      default: http://my-app/health
    - name: threshold
      default: "95"
  checks:
    - type: http
      url: "{{ .args.endpoint }}"
      successThreshold: "{{ .args.threshold }}"
      timeoutSeconds: 5
      requestCount: 10
```

## Referencing a template from an Application

```yaml
spec:
  analysisTemplates:
    - name: http-success-rate
      args:
        endpoint: http://my-app-prod/health
        threshold: "99"
      intervalSeconds: 60
      onFailure:
        action: rollback
```

## Supported check types

The same `AnalysisCheck` type used by canary analysis is reused:

- `http` — probe a URL and compare the success rate against `successThreshold`.
- `podMetrics` — evaluate `errorRate`, `latencyP99`, or `restartRate` against a threshold.

## Placeholder substitution

Check URLs, thresholds, and HTTP headers can use Go template syntax:

- `{{ .args.<name> }}` — value from merged template and reference args.
- `{{ .application }}` — application name.
- `{{ .namespace }}` — application namespace.

## Failure actions

Set `onFailure.action: rollback` to annotate the current release with `paprika.io/rollback-requested` when a background analysis run fails. The action is only taken when the application is `Healthy` or `Degraded` and the current release is `Complete`.

## Status and UI

Results are aggregated in `Application.status.analysisResults` and exposed through the API and UI. Each result includes the template name, phase, pass/fail state, message, and the last checked timestamp.
