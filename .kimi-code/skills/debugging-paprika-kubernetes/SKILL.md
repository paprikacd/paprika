---
name: debugging-paprika-kubernetes
description: Use when Paprika controllers or Kubernetes resources behave silently, e2e tests hang with empty status, or status updates appear to succeed but never reflect in the cluster.
---

# Debugging Paprika on Kubernetes

## Overview

Silent controller failures are the norm in Paprika: a reconcile can return no error yet never write the status you expect. Trust state over logs.

## When to Use

- A controller pod is running but its CR has an empty or stale `status`
- `paprika apply` times out waiting for a terminal phase
- A Pipeline's Jobs finish but the Pipeline phase never updates
- Controller logs show no recent reconcile entries for a resource
- A resource seems "stuck" after the first reconcile (finalizer added, then nothing)

## Core Pattern: State First, Logs Second

1. **Read the actual object state** (`kubectl get <cr> -o yaml`) before reading logs.
2. **Check every status field**, not just `phase`: `observedGeneration`, `conditions`, `releaseRef`, `pipelineRef`.
3. **Verify the child resources** the controller should have created (Release, Stage, ConfigMap snapshot, Jobs).
4. **Look for reconcile loops**: stable `metadata.resourceVersion` with repeated webhook defaulting/validation logs means the controller is updating something without changing status.
5. **Force a reconcile** with a no-op annotation change and watch what changes.

## Quick Reference

| Symptom | Likely Cause | Quick Check |
|---|---|---|
| Empty phase, no errors in logs | Status patch helper produces empty diff | Inspect `patch*Status` for `MergeFrom(modified.DeepCopy())` |
| Controller "hangs" after first reconcile | Worker spinning on empty patch or requeue loop | Check `resourceVersion` is unchanged, webhook logs repeat |
| Release/Stage exists but release never promotes | Release controller blocked on status update | Patch release status manually and watch next reconcile |
| Pipeline Jobs done, Pipeline phase empty | Pipeline status patch helper broken | Same `MergeFrom` check |
| Apply server returns success but app has no `releaseRef` | Apply server status update conflicted | Check apply server logs and retry logic |

## Common Mistakes

- **Assuming "no error" means "status written"**. `Status().Patch` can succeed with an empty patch and change nothing.
- **Using `MergeFrom` on an already-mutated object**. The base must capture the object *before* status changes.
- **Ignoring work-queue backoff**. A single conflict error can back off reconciles for minutes; e2e timeouts follow.
- **Trusting the controller's cached object** after another component (apply server, webhook, another controller) updates status.

## Example: Empty Status Patch

Bad pattern that silently drops status updates:

```go
patch := client.MergeFromWithOptions(app.DeepCopy(), client.MergeFromWithOptimisticLock{})
app.Status.Phase = "Healthy"
return r.Status().Patch(ctx, app, patch)
```

Because `app.DeepCopy()` already contains `"Healthy"`, the patch diff is empty.

Good pattern: fetch fresh, apply desired status, and update:

```go
desiredStatus := app.Status.DeepCopy()
return retry.RetryOnConflict(retry.DefaultRetry, func() error {
    var fresh paprikav1.Application
    if err := r.Get(ctx, key, &fresh); err != nil {
        return err
    }
    fresh.Status = *desiredStatus
    fresh.Status.ObservedGeneration = fresh.Generation
    return r.Status().Update(ctx, &fresh)
})
```

## Diagnostic Moves

1. **Manual status patch**: `kubectl patch <cr> <name> --subresource=status --type=merge -p '{"status":{"phase":"Promoting"}}'`. If the controller then proceeds, the status patch path is the bottleneck.
2. **Annotate to requeue**: `kubectl annotate <cr> <name> debug=paprika` forces a reconcile without changing spec.
3. **Check controller workers**: `kubectl logs -n paprika-system deployment/paprika-controller-manager | grep Reconciler` shows which controllers are active.
4. **Look for webhook loops**: repeated `Defaulting for ...` / `Validation for ... upon update` logs with unchanged `resourceVersion` indicate a controller is calling `Update` repeatedly.

## E2E / Helm Debugging Checklist

Use this before claiming an e2e failure is a flake or a controller bug.

1. **Can the chart render at all?**
   - `helm lint ./charts/chart`
   - `helm template` with the same `--set` values the e2e uses
   - Look for missing-template errors (e.g., `no template "paprika.cacheEnv"`)

2. **Does the chart actually create the workload the test expects?**
   - Check `kind: Deployment` / `kind: StatefulSet` output for the chosen `deploymentMode`
   - Controller-manager Deployment must exist when `manager.enabled=true` and sharding is off
   - `api-server` Deployment only renders when `deploymentMode=split`
   - Verify labels match the e2e selectors (e.g., `app.kubernetes.io/component=api-server`)

3. **Are the right images being set on the right components?**
   - `manager.image.*` for monolith / operator mode
   - `apiServer.image.*` for split-mode API server
   - `webhookReceiver.image.*` / `repoServer.image.*` if those components are enabled

4. **Do optional components honor their `enabled` flags?**
   - Webhook-receiver, repo-server, agent, redis should be skipped when disabled

5. **Are required helpers defined?**
   - `paprika.cacheEnv`
   - `paprika.authArgs`
   - `paprika.serviceAccountName`

6. **For webhook "connection refused" errors**
   - Check manager pod is ready and the webhook server is listening (`:9443`)
   - Check `kubectl get endpoints -n paprika-system webhook-service`
   - Look for manager container restarts in `kubectl describe pod`
   - Check cert-manager injected CA bundles in `ValidatingWebhookConfiguration` / `MutatingWebhookConfiguration`
   - Webhook failures during startup bootstrap can indicate the Service endpoints are not ready yet

7. **For API-server port-forward failures**
   - Confirm the API-server Deployment exists and is ready
   - Confirm the test selector matches the chart labels
   - Confirm the Service targets port `3000` and the pod exposes it
   - Verify `mode=api` is passed and the container starts the API server

8. **General pre-e2e validation**
   - `make lint` (Go + golangci-lint config)
   - `make test` (unit tests)
   - `helm lint ./charts/chart`
   - Then run `make test-e2e`

## When NOT to Use

- For obvious compile-time or test assertion failures (use normal debugging).
- When the issue is clearly in the UI/CLI client without controller involvement.
