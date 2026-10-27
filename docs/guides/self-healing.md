# Self-healing and recovery

An Application can repair resource drift and request a rollback when its health
checks fail. Configure these actions under `spec.selfHeal`; they still obey
management policies, sync windows, the release state, and the cooldown between
self-heal actions.

## Require repeated health failures before rollback

Use `healthFailureThreshold` to prevent one transient probe failure from
triggering an automatic rollback. The field accepts integers from 1 through 10
and defaults to 1, preserving the existing behavior for Applications that omit
it. It only affects `autoRevertOnHealthFailure`; it does not delay health status
updates or change the probe timeout.

For example, add this configuration to an Application's spec:

```yaml
selfHeal:
  autoRevertOnHealthFailure: true
  healthFailureThreshold: 3
  cooldown: 5m
healthChecks:
  - name: service-ready
    expression: http.statusCode == 200 && http.bodyJson.ok == true
    interval: 30s
    httpProbe:
      url: http://service.default.svc.cluster.local:8080/readyz
      method: GET
      timeout: 5
```

With a threshold of 3, at least one currently degraded check must have three
consecutive failed observations before Paprika requests a health rollback.
Failures from different checks are counted separately: one failed observation
from each of three checks does not satisfy the threshold. A transient timeout
followed by a healthy observation resets the affected check's count.

Only a newly executed check increments its count. Reusing its cached result on
another reconciliation does not count as another failure. The count is stored
in Application status so a controller restart can retain valid evidence.
Healthy, Unknown, or Progressing results reset the count, as does a change to
that check's configuration. If the gap between failed observations exceeds
twice the check interval, the next failure starts a new count of 1. For the
30-second interval above, a gap greater than 60 seconds breaks the streak.
The rollback decision also requires the latest result to be fresh under the
check's normal cache rules, with matching configuration. Missing or stale
evidence cannot satisfy a threshold above 1.

Health remains visible immediately. The first failed probe can mark the
Application Degraded while the controller waits for enough consecutive
observations to act. The cooldown limits how often an action is requested; it
does not require repeated failures and is not a substitute for the threshold.

## Inspect the current evidence

Read the Application's configured checks, results, recent failed observations,
and self-heal condition together:

```sh
kubectl --kubeconfig <kubeconfig> -n <namespace> get application <app> -o json \
  | jq '{
      selfHeal: .spec.selfHeal,
      phase: .status.phase,
      health: .status.health,
      healthChecks: .status.healthChecks,
      conditions: [.status.conditions[]? |
        select(.type == "SelfHealed" or .type == "ReleaseRetriesExhausted")]
    }'
```

Use each check's `checkedAt`, `status`, `consecutiveFailures`, `reason`,
`configurationHash`, and `recentFailures` to distinguish a current failure from
historical evidence. The consecutive count is capped at 10; `recentFailures`
is a separate history and does not determine whether the threshold is met.
A rollback request and an automatic resync request are mutually exclusive for
a release. The controller waits for the pending action instead of queuing a
competing action.

## Recover a held release

A release held after rollback or retry exhaustion needs a new source revision
or an explicit operator retry. Paprika continues observing live resource
health and drift while it holds the release. These observations do not clear
the retry-exhausted latch or silently restart deployment, and the held phase
can remain RolledBack even when the running resources are healthy.

Inspect the failed checks, release conditions, and running workload before
retrying. If the failure was transient or its cause is resolved, request a
manual sync on the Application. Confirm the target context immediately before
the write:

```sh
kubectl --kubeconfig <kubeconfig> config current-context
kubectl --kubeconfig <kubeconfig> -n <namespace> annotate application <app> \
  paprika.io/sync="$(date +%s)" \
  paprika.io/manual-sync="$(date +%s)" --overwrite
```

An Application manual sync clears the current release's old rollback request
and automatic retry counter as it requests a resync. Annotating
`paprika.io/resync` directly on the Release does not perform that reset.
After the write, inspect the Application and its referenced Release, and wait
for the rollout and health checks to settle:

```sh
kubectl --kubeconfig <kubeconfig> -n <namespace> get application <app> -o yaml
kubectl --kubeconfig <kubeconfig> -n <namespace> get releases.pipelines.paprika.io <release> -o yaml
```

Confirm the expected release is active, health checks are fresh, resources are
healthy, and `status.outOfSync` is zero before considering recovery complete.
