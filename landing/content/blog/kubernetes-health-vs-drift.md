# Kubernetes health and drift answer different questions

A Deployment can have every requested replica available and still differ from
the manifest in Git. It can also match that manifest exactly while its pods
fail to become ready. These observations call for different investigations.

Paprika keeps resource health and desired-state comparison separate. Health
assesses the live object's conditions and workload state. Sync compares the
rendered desired resources with the live objects. Reading both helps you
decide whether to investigate the workload, its configuration, or the
controller observing it. The distinction is visible in the
[resource health implementation](../../../internal/health/resources.go) and
the [drift guide](../../../docs/guides/drift-and-prune.md).

## Read the two signals together

Consider these illustrative observations; they are not live fleet data:

| Resource health | Sync observation | A useful next question |
| --- | --- | --- |
| Healthy | Synced | Do application checks and telemetry also show the expected behaviour? |
| Healthy | OutOfSync | Which declared field changed, and was that change intentional? |
| Progressing or Degraded | Synced | Why has the workload not reached its requested state? |
| Unknown or Missing | Any or unavailable | Can Paprika observe the resource, and does the object exist on the intended target? |

For example, suppose Git declares three replicas. Someone changes the live
Deployment to two, and both are available. A resource-health check against
the live replica request can pass while a comparison with Git reports a
difference. Conversely, a Deployment whose requested replica count and image
match Git may still have unavailable pods. Reapplying an identical manifest
does not explain an image-pull error or an application startup failure.

Health has a scope, too. Paprika's built-in rules use replica counts and
conditions for workloads; for resources such as ConfigMaps, existence is the
available health signal. A healthy ConfigMap cannot establish that its
contents are correct for the application. Inspect configured application
checks and service telemetry when those are relevant to the failure.

## Start with the Application and its observation

Read the Application before changing it. This example assumes an Application
named `checkout` in the management namespace `delivery`; substitute names
from your installation:

```sh
kubectl config current-context
kubectl -n delivery get application checkout -o json | jq '{
  generation: .metadata.generation,
  observedGeneration: .status.observedGeneration,
  release: .status.releaseRef,
  health: .status.health,
  resourceHealth: .status.resourceHealth,
  outOfSync: .status.outOfSync,
  resources: .status.resources,
  observation: .status.deploymentObservation,
  conditions: .status.conditions
}'
```

The [Application status model](../../../api/pipelines/v1alpha1/application_types.go)
records these fields independently. Check whether the controller has observed
the current generation and whether its deployment observation refers to the
release you are investigating. An old result describes an earlier observation.
If the controller is falling behind, investigate that before treating its
displayed state as current.

Then follow the affected resource. Confirm its target cluster and namespace,
inspect its events and conditions, and compare the changed field with the
rendered release. For a remote target, the Application record remains on the
management cluster; the workload inspection needs the corresponding target
context. The [multi-cluster guide](../../../docs/guides/multi-cluster.md)
explains those connections.

## Compare declared intent, not raw YAML text

Kubernetes adds fields while admitting and reconciling objects, so a raw text
diff contains more than user configuration changes. Paprika's comparison is
desired-centric: declared fields must match, while extra live defaults are
not automatically drift. The engine also normalises supported cases such as
equivalent resource quantities and omitted defaults.

An object identity includes its API version and kind as well as namespace
and name. A core `Service` and a Knative `Service` with the same name are
different resources. The [drift guide](../../../docs/guides/drift-and-prune.md)
documents this comparison and the `Synced`, `OutOfSync`, `Missing` and
`Pruned` classifications.

If a difference is intentional, decide where its authority belongs. Update
the declared configuration when it should become the desired state. Review
an appropriate ignore rule when another controller owns that field. If the
live change was accidental, investigate why it happened before choosing
remediation. This avoids repeatedly fighting a legitimate controller.

## Review pruning separately

The `Pruned` diff classification describes a live object absent from the
desired set; the label alone is not proof that deletion already happened.
Inspect `status.prunableResources` before enabling cleanup:

```sh
kubectl -n delivery get application checkout -o json \
  | jq '.status.prunableResources'
```

Pruning is opt-in through `syncOptions.prune`. Eligibility also depends on
management labels, ownership, protection annotations and allowed kinds.
Generated children with owners are excluded, and an individual object can
carry `paprika.io/prune: "false"`. Follow the
[pruning rules](../../../docs/guides/drift-and-prune.md#pruning) rather than
assuming every object outside the current chart should disappear.

## Alert on persistent drift and observation lag

`paprika_out_of_sync` and `paprika_prunable` are gauges of current resource
counts. `paprika_prune_total` is a counter of prune activity. They describe
different things: resources needing attention, candidates for cleanup, and
deletions performed. The [metrics reference](../../../docs/guides/metrics.md)
lists their labels and control-plane health signals.

For an illustrative Prometheus alert, this expression selects nonzero drift
for the example Application:

```promql
paprika_out_of_sync{namespace="delivery", app="checkout"} > 0
```

Choose the alert's `for` duration around your reconciliation cadence and
acceptable rollout time. Monitor reconciliation freshness as well: an absent
scrape or stalled controller cannot confirm that a workload is in sync.

For a first investigation, keep the [drift and prune guide](../../../docs/guides/drift-and-prune.md)
beside the [metrics reference](../../../docs/guides/metrics.md). They provide
the resource classifications and exact instruments needed to turn the two
signals into an actionable diagnosis.
