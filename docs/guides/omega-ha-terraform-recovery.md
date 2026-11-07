# omega-ha Terraform recovery — 26 October 2026

The canonical local state and variables were missing from
`~/projects/paprika/terraform`. Recovery is complete. A normal refreshed plan
from that directory returned exit code **0**, with all eight resources and all
outputs unchanged. No remote infrastructure operation was applied.

The user has explicitly ruled out new nodes. This change is limited to state
recovery, credential inputs, preserved repository metadata and regression tests.
Larger Cuttlefish jobs must use existing omega-ha capacity. No new pool, node
quantity increase, instance resize or autoscaler-bound increase is included.

## Recovered ownership

The verified pre-teardown backup had serial 80 and lineage
`5acbe95c-acfe-0743-4e0b-d5f9ca2c6de4`. The migration runbook recorded a later
serial 82, but that original file was not found. The recovery preserves the known
lineage and is a new, documented continuation of the backup; it does not pretend
to be the missing original serial 82. The recovered canonical serial is **85**.
If another state copy appears, reconcile ownership before using either copy.

| Binding | Verified live identity |
| --- | --- |
| `vultr_kubernetes.omega_ha` | `40ee226a-9fd0-43fc-9571-e4a44668098d` |
| Inline `core` pool | `1266440a-5f5a-4f82-81be-530fab5dcb3a` |
| `vultr_kubernetes_node_pools.omega_ha_core_large` | `c9676421-64c2-4686-b818-df2315e87bb3` |
| `vultr_kubernetes_node_pools.omega_ha_search` | `7ce336b3-530b-4931-8303-b30dd7e99d87` |
| `github_repository.paprika` | `paprikacd/paprika` |
| `github_repository_pages.paprika` | repository `1266253401` |
| `cloudflare_record.paprika` | `6866879f3afa54ced6498defce8e8286` |
| `cloudflare_record.demo_paprika` | `da801f6c62d22a5a88e26406f46256fa` |
| `local_file.omega_ha_kubeconfig` | `./omega-ha.kubeconfig`, mode `0600` |

The inline core pool is part of the cluster binding, not a ninth independent
resource. Its `tf-vke-default` tag identifies it to the pinned provider.

## Recovery performed

1. Copied the old backup and unchanged configuration into a private candidate
   directory, retaining the original backup. Terraform 1.14.6 and the checked-in
   provider lock were used; no provider upgrade was performed.
2. Read the live Vultr cluster/pools and confirmed exact IDs, region, HA, OIDC
   and quantities. The retired `omega` cluster returned HTTP 404.
3. Removed only the five already-retired state bindings documented by the
   October 6 migration: old cluster, old core-large/search pools, old kubeconfig
   and the old deployer-RBAC helper. These were state operations, not deletions
   of live resources.
4. Reviewed and applied a saved **refresh-only** plan to the isolated candidate.
   It had no resource actions, stable surviving cloud IDs and only expected
   obsolete-output removals/current-value updates.
5. A normal plan found two configuration/local-file differences. The current
   GitHub description and homepage are now explicitly preserved in `main.tf`.
   The old local kubeconfig was replaced with exactly the bytes returned by
   Vultr, using a separately guarded saved plan whose only action was that
   local file. The restored file authenticated to the expected cluster UID.
6. Added an optional sensitive `cloudflare_api_token` input so the existing
   scoped DNS token can be used instead of recreating a Global API key. Legacy
   key/email remains supported; email is supplied only in that mode. Actual
   provider validation accepts either mode separately and rejects combining
   them. Protected variables were recovered locally, not committed.
7. A full normal refreshed candidate plan passed with no changes. The state,
   variables and kubeconfig were installed into the canonical directory using
   exclusive creation, without overwriting another state. A second full normal
   plan from that canonical directory also passed with no changes.

## Canonical files and verification

The local `terraform/terraform.tfstate`, `terraform/terraform.tfvars` and
`terraform/omega-ha.kubeconfig` are mode `0600` and ignored by Git. An identical
protected backup is `terraform/terraform.tfstate.recovered-20261026`. Recovery
inputs, raw plans and logs are retained under
`~/.local/state/paprika/terraform-recovery-20261026/` (private directory).
These files can contain credentials: do not attach them to a PR or upload them
as CI artifacts. This is local recovery, not a migration to a remote backend.

The canonical directory must contain the matching recovered `main.tf` from this
change. Its description/homepage and scoped-token wiring are required for the
recorded no-change result. The existing `omega_ha.tf` and locked provider
versions remain unchanged. Official Linux AMD64 package hashes were added to
the provider lock alongside the existing Darwin ARM64 hashes for read-only CI
initialization; all prior checksums are retained. Do not revert the canonical
source while retaining new credential inputs and expect the old source to
produce the same result.

Run from the canonical directory, with no ambient Terraform argument/variable
overrides. Unset unrelated inherited Cloudflare credentials, since the pinned
provider can fall back to them even when corresponding HCL inputs are null:

```sh
cd ~/projects/paprika/terraform
env -u CLOUDFLARE_API_KEY -u CLOUDFLARE_API_TOKEN \
  -u CLOUDFLARE_API_USER_SERVICE_KEY -u CLOUDFLARE_EMAIL \
  terraform plan -input=false -detailed-exitcode
```

Exit 0 means no changes, 1 means an error, and 2 means a plan with changes.
Do not substitute `-target`, `-refresh=false` or a refresh-only plan for this
whole-module baseline check. Review any new drift; do not apply it merely to
recover a no-change result or hide it with `ignore_changes`.

## Recorded plan boundaries

| Plan | Result | Saved-plan SHA-256 |
| --- | --- | --- |
| Existing-only source after withdrawal | Exit 0; eight resources and every output no-op; state unchanged | `a41808b690008d818a4528338490a13918cd1ebdb592bc0117732345426aa250` |
| Canonical recovered baseline | Exit 0; eight resources and every output no-op | `ed55cf56f58d05c58939d058ecf1a427d1e85a6b747f22e4ce5b115b1451a14c` |
| Withdrawn CI proposal, disabled | Historical exit 0; same no-op result | `2c0b17d3577eb07dda3331d2eeb88c3f4a127b613333d3f1aa42cd7c1b877df7` |
| Withdrawn CI proposal, enabled | Historical exit 2; one pool create; **not approved and never applied** | `946425c9804757999a9c6f08a209a5c73a082a0eb3edb9cd06980ed34c0e7b21` |

These historical plans were regenerated after adding the official Linux AMD64
checksums required by CI. They bind provider lock SHA-256
`89d2e9cf3421245ce404d4c393e7aefc0b4a147e1177e9ab23b0b9ba35f6fcfe`.
Only five `h1` entries were added; every provider version, constraint and
previous checksum was retained. The initial Linux validation failure and the
earlier successful Mac-only plan evidence remain in the private recovery log.

The create plan is **withdrawn, not approved and must not be applied**. Its hashes
remain here only to identify historical evidence. The proposed CI resource,
enable flag, provisioning tests and capacity runbook have been removed. No CI
node or pool was created, and this proposal owns no separate state. Both saved
create-plan variants have been moved out of their active paths into the private
`withdrawn-new-node-plans/` archive, preserving their bytes and hashes with a
withdrawal receipt. The private planning helper now rejects both former capacity
modes and accepts only canonical or existing-only plans, requiring zero changes.

## Offline recovery regression tests

Run the same helper used by CI's **Terraform offline plans** job:

```sh
bash hack/test-terraform.sh
```

The helper copies only `main.tf`, `omega_ha.tf`, the provider lock and
`tests/provider_inputs.tftest.hcl` into its own temporary directory. It checks
formatting, initializes public locked providers with the backend disabled,
validates configuration and runs four plan-only tests with all five providers
mocked. It excludes state, tfvars, kubeconfigs and inherited cloud credentials
or Terraform argument overrides, and removes only its own directory on exit.
CI pins Terraform 1.14.6 and disables the setup action's executable wrapper.

The tests cover default/scoped-token/legacy-key inputs, preserved GitHub metadata
and DNS destinations, and the existing Sydney HA topology: four core nodes,
two core-large nodes and one search node, unchanged plans/autoscaler bounds and
the search pool's exact taint. These are configuration regressions, not evidence
of live node fit or a live no-change plan. Mocks do not verify authentication;
the real Cloudflare provider owns credential validation. Database/UI tests do
not apply to this Terraform recovery; the full normal plan verifies its live
infrastructure boundary.
