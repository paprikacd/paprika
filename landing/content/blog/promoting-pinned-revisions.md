# Promoting a tested Git revision across Kubernetes environments

Staging has passed its checks. Production is about to deploy. The question
to answer is precise: which revision will production receive?

Resolving a moving branch again can select a commit that staging has never
run. Paprika's Git promotion flow selects the exact revision from a completed
upstream Release. Each environment keeps its own Application and deployment
settings, while the source revision connects the chain. The
[environment promotion guide](../../../docs/guides/environment-promotion.md)
defines this behaviour and provides the complete manifest.

## Give each environment its own Application

A dev-to-production chain uses separate Applications for dev, staging and
production. Their records live on the management cluster. Each Application
selects its workload target through its Stage; that target can be a different
namespace or cluster.

This separation makes two decisions explicit:

| Configuration | Question it answers |
| --- | --- |
| `spec.trigger` | Where does the next deployment candidate come from? |
| `spec.syncPolicy` | Can the selected candidate deploy automatically? |

For the common three-environment flow, dev uses a `GitOps` trigger and
automatic sync. Staging uses `Promotion` and automatic sync. Production uses
`Promotion` and manual sync. A `Manual` trigger has a different meaning:
source-driven candidate selection on a sync request. It does not express an
approval bound to staging's release.

Here is an illustrative fragment of a production Application spec. It needs
the source and Stage configuration from your complete Application:

```yaml
spec:
  trigger:
    type: Promotion
    from:
      name: checkout
      namespace: pipeline-stg
  syncPolicy: Manual
```

`from.namespace` identifies the upstream Application's management namespace,
not a namespace on a remote target cluster. See the
[trigger rules](../../../docs/guides/environment-promotion.md#choose-a-trigger-for-each-environment)
before adapting this fragment.

## Pin source identity and preserve target configuration

In Git promotion, upstream and downstream Applications resolve to the same
repository. The downstream render uses the completed upstream Release's
commit SHA. Its own chart path, values, parameters and target namespace still
apply. A new push to the repository cannot, by itself, supply a new candidate
to a Promotion Application.

This is useful when dev runs one replica and production runs several, or
when environments have different ingress and secret references. Those
differences remain declared in the target Application. They are not copied
from the upstream environment.

Keep the selected commit reachable in the repository. A pinned identifier
does not help a later render if the repository can no longer serve the
commit. Review all environment-specific paths at that revision, too: a
commit that contains the dev chart path must also contain the path production
will render. These are prerequisites in the
[complete example](../../../docs/guides/environment-promotion.md#complete-example).

## Put checks on the environment they actually test

Promotion has a before-and-after boundary. `trigger.tests` runs a verification
Pipeline against the upstream environment before the downstream Release is
admitted. The Pipeline record belongs to the downstream Application's
namespace, but its Jobs execute on the management cluster in the operator's
configured execution namespace.

A test must therefore reach the upstream endpoint from that execution
location. A remote cluster's internal service DNS name is not generally
reachable there. Choose an endpoint with the intended network path, or use
a target-side hook when a check needs to run inside the workload cluster.
The [verification guide](../../../docs/guides/environment-promotion.md#tests-before-promotion-and-verification-after-deployment)
describes both placements.

Checks of the newly deployed target belong in `stages[].gates` or the
appropriate target-side verification flow. Testing dev successfully cannot
establish that production's ingress, credentials or dependencies work.

For source-based verification, explicitly fetch and check out
`PAPRIKA_PROMOTION_REVISION` in a container with the required tools. The
workflow engine does not automatically check out `tests.sources`. A test
that silently uses a default branch would undo the revision discipline you
are trying to establish.

## Review the candidate before approving it

Read promotion status on the production Application. This command assumes
the names from the example chain:

```sh
kubectl -n pipeline-prod get application checkout -o json | jq '{
  acceptedRelease: .status.releaseRef,
  promotion: .status.promotion,
  conditions: .status.conditions
}'
```

Review the upstream Application and Release identities, the selected Git
revision, the verification Pipeline and its results. Production approval is
bound to the candidate's upstream Release UID. A generic sync request does
not approve an unreviewed upstream version.

Changing the candidate or its deployment and verification settings can
invalidate that approval. While a candidate waits or fails verification, the
accepted downstream release remains in place. Failed verification is latched;
an explicit candidate retry follows the documented retry flow and requires
fresh approval where manual sync applies. Use the
[approval and retry instructions](../../../docs/guides/environment-promotion.md)
for the exact annotations and status checks.

## Pin container images as well

A Git SHA identifies source content. It does not make a mutable container
tag immutable. Two environments rendering the same chart revision can still
pull different image bytes if the chart uses a tag that has moved.

For reproducible application images, commit digest-pinned references into
the promoted source or deliberately manage explicit per-environment image
parameters. Git promotion does not automatically transfer an image built by
`spec.build` or a declared Pipeline artifact. The
[configuration boundary](../../../docs/guides/environment-promotion.md#keep-environment-configuration-explicit)
is part of the contract, not an implementation detail to infer away.

## Verify the deployed target

After admission, inspect the new Release, target resources and fresh health
and sync observations. The selected SHA establishes what was rendered;
the target's observations establish what happened after deployment.

Start with the [complete promotion manifest](../../../config/samples/pipelines_v1alpha1_environment_promotion.yaml),
adapt its repository, paths, clusters and endpoints, and follow the
[environment promotion guide](../../../docs/guides/environment-promotion.md)
on a test installation. Keep the revision, environment settings, verification
result and approved candidate together when reviewing each promotion.
