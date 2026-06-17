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

## When NOT to Use

- For obvious compile-time or test assertion failures (use normal debugging).
- When the issue is clearly in the UI/CLI client without controller involvement.
