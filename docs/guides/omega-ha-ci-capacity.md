# Optional dedicated CI capacity on omega-ha

This is a prepared, disabled addition. It has not provisioned a node or qualified
a larger workload. `terraform/omega_ha_ci.tf` defaults `vke_ci_enabled` to false.
Enabling it requires a reviewed saved plan and approval for the incremental spend.

## Exact scope

The addition is one standalone `vultr_kubernetes_node_pools.omega_ha_ci[0]`
attached to the existing Sydney HA cluster
`40ee226a-9fd0-43fc-9571-e4a44668098d`. It does not edit the cluster's inline core
pool, the core-large/search pools, the Kubernetes version, OIDC, DNS or storage.

| Setting | Prepared value |
| --- | --- |
| Plan | `vc2-4c-8gb`: 4 vCPU, 8192 MB RAM, 160 GB local SSD |
| Pool label / tag | `cuttlefish-ci` / `tf-vke-cuttlefish-ci` |
| Quantity / minimum / maximum | 1 / 1 / 1 |
| Autoscaler | false |
| Node label | `cuttlefish.dev/role=ci` |
| Node taint | `dedicated=cuttlefish-ci:NoSchedule` |
| Destruction protection | `prevent_destroy = true` |

The label reserves a scheduling role, not physical CPU hardware: `vc2` is Vultr's
shared-CPU Cloud Compute family. The fixed node continues to incur charges when
Cuttlefish runner Jobs scale to zero. No new load balancer or persistent cache is
included. Existing Cuttlefish workers keep their current placement.

## Price and availability

At **2026-10-25 21:35:52 UTC**, anonymous reads of the official
[plans API](https://api.vultr.com/v2/plans?per_page=500) and
[Sydney availability API](https://api.vultr.com/v2/regions/syd/availability?type=vc2)
reported this exact plan available in Sydney at **US$0.055/hour** and a listed
**US$40/month** base price (about US$1.32/day). The plans response contained all
139 entries with no next page. Sydney had no price override for this plan.

Availability is a point-in-time observation, not a reservation. Recheck it before
the reviewed plan is used. Taxes, additional bandwidth/storage and account-specific
adjustments are excluded. Vultr bills in
[USD](https://docs.vultr.com/support/platform/billing/does-vultr-support-local-currency-invoicing);
VKE worker nodes use their
[selected instance rates](https://docs.vultr.com/support/products/vke/how-much-does-the-vultr-kubernetes-engine-cost).

## Provider 2.31.2 limitations

Keep the locked provider versions and existing checksums unchanged. The lock
includes official Darwin ARM64 and Linux AMD64 package hashes, generated with
`terraform providers lock -platform=darwin_arm64 -platform=linux_amd64` without
an upgrade. This lets both local validation and Linux CI use a read-only lock.
Review against the pinned
[node-pool schema](https://raw.githubusercontent.com/vultr/terraform-provider-vultr/v2.31.2/vultr/vke.go)
and [create/update implementation](https://raw.githubusercontent.com/vultr/terraform-provider-vultr/v2.31.2/vultr/resource_vultr_kubernetes_nodepools.go).

* The provider creates the pool, waits for `active`, then adds labels and taints
  through separate API calls. The taint is **not guaranteed at first node join**.
  Unrelated eligible Pods can schedule during that interval. `NoSchedule` does
  not evict them afterward. Do not describe the Terraform create as an atomic
  isolation boundary. Keep CI admission disabled until both provider and actual
  Kubernetes labels/taints are verified and a complete inventory proves that
  only reviewed system/DaemonSet workloads occupy the node. Any unexpected
  workload blocks the canary; do not automatically evict it or add `NoExecute`.
  If isolation from first join is required, this pinned-provider path is not
  sufficient without a separately reviewed provisioning mechanism.
* `cluster_id` is ForceNew. Region, VPC and HA control-plane changes on the parent
  cluster can also force replacement. Do not rename/move resource addresses or
  alter the parent cluster in the capacity plan.
* Pool `plan` and `label` are not marked ForceNew, but this provider's update
  request does not send either field. Changing those HCL values is not a supported
  resize/rename procedure. Keep this pool's shape fixed; prepare a separate
  migration if another size is needed.
* Label/taint updates delete and recreate their changed entries. They are not
  an atomic placement transition. With autoscaling disabled, any pool update
  also sends the configured node quantity. This preparation permits one create,
  not an update to any existing pool.
* Turning the opt-in back off after creation proposes destruction and is blocked
  by `prevent_destroy`. Removing the whole resource block removes that Terraform
  guard. Teardown needs an explicit idle/drain and state-aware review; disabling
  runner Jobs alone does not stop node billing.

The resource precondition additionally rejects another cluster ID, region, label
or a non-HA cluster. It does not replace state recovery or a whole-plan review.

## Recover and prove the baseline before enabling

The [26 October recovery record](omega-ha-terraform-recovery.md) documents the
completed canonical no-change baseline and the unapplied single-create plan for
this exact addition. The procedure below remains the gate for future changes.

The canonical state and exact existing input values must be recovered by the
infrastructure owner first. Preserve its lineage and current resource identities.
The old migration backup that still contained the retired `omega` cluster is not
a usable current baseline. Do not initialize empty state against this module,
silence drift with `ignore_changes`, or use `-target` to conceal unrelated changes.

1. With `vke_ci_enabled=false`, reconcile the recovered state to current live
   resources and obtain a normal refreshed, whole-module no-change plan.
   Refresh-only convergence alone is insufficient: the configuration must agree
   with the recovered live state too. Preserve state/backups and plan evidence
   securely because they may contain credentials and kubeconfig material.
2. Prepare a separate saved plan with only `vke_ci_enabled=true` changed. Inspect
   its JSON with a local projection: the only non-no-op managed-resource action
   must be `create` for `vultr_kubernetes_node_pools.omega_ha_ci[0]`, with the exact
   known cluster ID and settings above. Reject unknown target identity, imports,
   replacements, deletions and any existing-resource update. Compare the saved
   plan's source commit, provider lock, state lineage/serial and input hashes to
   the reviewed baseline. A mocked test plan is not live evidence.
3. Present that concrete plan and cost for approval. No `terraform apply` is
   included in this preparation. If the state or inputs change after review,
   regenerate and review the plan rather than applying a stale one.

An ambiguous creation outcome must be reconciled against the actual provider
pool ID and state before another create is attempted. A new pool can exist even
if a later label/taint call fails. Import, if needed, must bind the exact reviewed
cluster and pool IDs using the provider's two-ID import contract.

## Admission and larger-workload qualification after an authorized create

Require provider pool `active`, exact pool/node IDs, Kubernetes node UID and
hostname, Ready state, Linux/amd64, and the expected pool-managed label and taint.
Read all node Pods with bounded complete-list validation, including native
restartable init containers when summing requests. Account for DaemonSets,
system-reserved capacity, memory/disk availability, pressure and any pre-existing
workload before calculating usable headroom. A 4-vCPU/8-GB SKU is not itself a
resource-fit proof or a host-pressure readiness proof.

Prepare a separate Cuttlefish profile for one worker, one lease and one task.
Use required affinity to the CI label plus the reviewed actual node identity,
and only the exact `dedicated=cuttlefish-ci:NoSchedule` toleration. A toleration
alone does not keep CI off shared nodes. Do not reuse a stale node UID/name after
provider replacement, add broad tolerations, or loosen the existing pool policy.

A proposed first target is a real **2-CPU / 4-GiB task**, with explicit DinD
overhead, agent and system requests. Its final request/limit and host-pressure
floors need their own render, fresh fit and real Job API-server dry-run. Keep
admission disabled if any check fails. The prior 500m/1536Mi same-node benchmark
does not qualify this new envelope.

The initial reviewed arithmetic is a 2-CPU/4352Mi DinD parent (including the
4096Mi task and 256Mi daemon allowance), plus agent requests of 100m/128Mi and
limits of 250m/512Mi. With native init-sidecar accounting, the Pod requests
2100m/4480Mi and has limits of 2250m/4864Mi. The task and Docker daemon share the
parent's CPU cap. Current comparable nodes expose 3800m/~7.554Gi allocatable,
but system components with incomplete requests mean actual measurements are
essential. Initially require more than 7Gi available node memory before launch,
after system Pods settle, to preserve a 2.25Gi warning reserve at the full
4.75Gi Pod cap. If the actual node cannot meet that gate, reduce task memory or
review a larger-memory plan; do not silently lower the reserve. This is a
conditional design, not proof that the new node can admit the workload.

Verify actual inner CPU/memory limits, meaningful Go/npm outputs and tests,
cache reuse, pressure/OOM/restarts, clean retirement, native/MCP health and
retained attribution. Preserve the existing dependency proxy and all seven
retained PVC/PV identities and four Secret identities. No new cache claim or
cross-node/cross-architecture performance claim follows just from creating a node.

## Offline validation

Use Terraform 1.14.6 or a compatible release with provider mocking (1.7+).
Both test files mock **all five providers** and every run uses `command = plan`.
`omega_ha_ci.tftest.hcl` verifies default-off, exact enabled capacity and
label/taint, and rejection of wrong cluster/region. `provider_inputs.tftest.hcl`
checks unset credential defaults, scoped-token and legacy-key inputs, and the
recovered GitHub description/homepage and DNS destinations. No real API
credentials are required and no cloud operations are performed by these tests.

Mocks do not validate remote authentication. Real operations need a scoped
`cloudflare_api_token` in the protected input file, or the legacy
`cloudflare_api_key` plus email, never both. The provider configuration supplies
email only for the legacy key mode. Cloudflare 4.52.8 rejects email together with
an API token; do not restore that conflict by setting email unconditionally.
Null credential defaults do not mean unauthenticated live access is supported.

Run the same helper used by CI's **Terraform offline plans** job:

```sh
bash hack/test-terraform.sh
```

The helper copies only `main.tf`, `omega_ha.tf`, `omega_ha_ci.tf`, the provider
lock and the two named test files into a temporary directory. It runs format
checks, backend-disabled initialization with the read-only lockfile, validation
and all seven mocked plans. Terraform receives an empty inherited environment,
an isolated home and CLI configuration, and no state, variable files,
kubeconfigs, ambient `TF_VAR_*`/CLI overrides or cloud credentials. The helper
removes only its own temporary directory on exit. CI pins Terraform 1.14.6 and
disables the setup action's executable wrapper.

Provider installation uses public registry downloads. Database/UI tests do not
apply to this additive Terraform input; actual saved-plan review and post-create placement,
resource and workload checks cover the infrastructure boundary.
