# VKE HA control plane: migration plan for `omega`

Status: **plan, not executed** (2026-09-28). Nothing in this document has been applied.

## Why this is a migration and not a flag flip

The `omega` cluster (`7997fb87-6982-4cf1-a693-8cfee32d9668`, syd, v1.36.1+2) runs with
`ha_controlplanes = false`. Its single apiserver flaps (TLS handshake timeouts, 10-33 s
`kubectl` calls, one multi-hour hard outage on 2026-09-08). Those flaps cause most Greenveil
release and rollback failures. The data plane keeps serving while it happens, because pods do
not need the apiserver.

HA cannot be switched on for the existing cluster:

| Evidence | Result |
|---|---|
| `terraform plan -target=vultr_kubernetes.omega` with `ha_controlplanes = true` (vultr provider 2.31.2), run from a scratch copy of the state | `vultr_kubernetes.omega must be replaced`, `ha_controlplanes = false -> true # forces replacement`, `Plan: 1 to add, 0 to change, 1 to destroy` |
| Provider schema (`vultr/vke.go`, v2.31.2 **and** latest v2.32.0) | `"ha_controlplanes": { Optional, Default: false, ForceNew: true }` |
| Provider update path (`resourceVultrKubernetesUpdate`) | sends only `label` and `oidc` |
| Vultr API (`govultr` `ClusterReqUpdate`) | `PATCH /v2/kubernetes/clusters/{id}` accepts only `label` and `oidc`. HA is set only on `POST` (create) |
| Vultr docs, "Enable High Availability" | Console, API and CLI paths are all **create** flows (`--high-avail` on `kubernetes create`, `"ha_controlplanes": true` on `POST`). The Terraform tab says to "set `ha_controlplanes = true` on the existing cluster". Because the attribute is ForceNew, doing that **destroys and recreates the cluster**. |

**Do not apply `ha_controlplanes = true` to `vultr_kubernetes.omega`.** A replace would destroy
every tenant (Greenveil api, web, worker and Meilisearch, plus cuttlefish, brandbrain, dns,
deephost, telesis, babybub, flaggr, carbon, tautau and Paprika itself). It would issue a new
endpoint and CA, and new LoadBalancer IPs. The `Retain` PVs would survive as detached Vultr
block volumes but lose their bindings.

Also note an existing drift: master's `main.tf` declares the `core` pool with
`auto_scaler = true`, but Vultr reports `auto_scaler = false` (min = max = 4). Any untargeted
apply turns the autoscaler back on (pinned, so it should be a no-op in practice). Reconcile
this before the next broad apply.

## Shape of the replacement

Build a new HA cluster **side by side**. Move tenants onto it one at a time. Then delete
`omega`. Keep the worker shape as it is today:

| Pool | Plan | Count | Taint / role |
|---|---|---|---|
| `core` | vc2-2c-4gb | 4 | small tenants |
| `core-large` | vc2-4c-8gb | 2 | greenveil-api and other heavy tenants |
| `greenveil-search` | vc2-6c-16gb | 1 | `dedicated=search:NoSchedule`, Meilisearch |

Terraform: add a second resource (`vultr_kubernetes.omega_ha`, label `omega-ha`,
`ha_controlplanes = true`, same OIDC settings, same version or v1.36.2+1). Add its
`vultr_kubernetes_node_pools` for `core-large` and `greenveil-search`, and its own kubeconfig
output. Do **not** rename or edit `vultr_kubernetes.omega` until the final phase. Every
intermediate apply must be `-target`ed to the new resources, and the plan must show
`0 to destroy`.

## Phases

### 0. Prerequisites (no production impact)

- Confirm the HA price in the Vultr console's create dialog. See the cost section below.
- Confirm no `deploy-paprika` run is in progress. Freeze Greenveil releases for the window.
- Take a Meilisearch snapshot/dump of the serving generation to GCS, so the index can be
  restored without depending on the old volume.
- Back up the Paprika control namespace (`docs/guides/disaster-recovery.md`), cnpg
  `babybub-api-db`, and cuttlefish/dns/brandbrain Postgres volumes (`pg_dump`, plus a Vultr
  block snapshot where one exists).

### 1. Create `omega-ha` (additive only)

- Run a targeted apply of the new cluster and its pools. Write `omega-ha.kubeconfig` next to
  `omega.kubeconfig`.
- Install the platform layer in the same order as `deploy-vke.yml`: cert-manager, envoy
  gateway, knative/kourier, istio, cnpg, calico tiers, and the Paprika controller and server
  with its OIDC RBAC (`github-actions-deployer-rbac.yaml`).
- Check the control plane before going further: 30 consecutive
  `kubectl get --raw /readyz` returning `ok` in under 1 s over 15 minutes.

### 2. Move stateless Greenveil planes (web, worker, api)

- Recreate the Greenveil secrets in `omega-ha` (`scripts/bootstrap_paprika_secrets.sh` with
  `KUBECONFIG` pointed at the new file).
- Apply `deploy/paprika` (the Application objects) into `omega-ha`. For this phase, point the
  API at the **old** Meilisearch through a temporary Service or ExternalName, or just move
  search first (phase 3).
- **Tunnel cutover without a DNS change:** a Cloudflare Tunnel accepts many connectors that
  share one token. Start `greenveil-cloudflared` in `omega-ha` with the same
  `greenveil-cloudflare-tunnel-token`. Cloudflare then spreads requests across connectors in
  both clusters, and each connector resolves `*.greenveil.svc.cluster.local` inside its own
  cluster. That gives a live canary. Watch `search-probe`, `/healthz` and a real
  `GetProduct`. Then scale the old cloudflared to 0 (disable its Application first so
  auto-sync does not fight you). Rollback: scale the old cloudflared back up.
- Pub/Sub push (`origin-worker-vke.greenveil.ai`) uses the same tunnel, so it moves with the
  same step.

### 3. Meilisearch (the 160Gi Retain PV)

Pick one option:

1. **Re-attach the same block volume (fastest, no copy).** Vultr block storage is regional,
   not per-cluster. Scale the old `greenveil-meilisearch` StatefulSet to 0 and wait for the
   CSI detach, which takes volume `pvc-c6d15a0cb04b49e2` off node
   `greenveil-search-3c24aa8b6b60`. In `omega-ha`, create a static PV with
   `csi.driver: block.csi.vultr.com` and `volumeHandle` set to the Vultr block ID,
   `persistentVolumeReclaimPolicy: Retain`, and `storageClassName: vultr-block-storage-retain`.
   Pre-bind it with `claimRef` to `greenveil/greenveil-meilisearch`. The committed
   `greenveil-meilisearch-pvc.yaml` then binds to it through `volumeName` unchanged, as long
   as the static PV keeps the name `pvc-c6d15a0cb04b49e2`. Search is down from scale-0 until
   the new pod is Ready (minutes). **Validate this on a throwaway 1Gi volume first.** A
   cross-cluster CSI attach is the one unproven step in this plan.
2. **Restore from the phase-0 snapshot/dump** onto a fresh volume in `omega-ha`. This avoids
   downtime (old search keeps serving until the tunnel moves) but costs +160Gi of storage
   during the overlap, and the restore takes time to import.
3. **Rebuild with a release** (`deploy-paprika.yml -f force_reindex=true` against the new
   cluster): a 6-8 h corpus build. Use this only if 1 and 2 fail.

Check the serving key (`manage_meili_keys.sh serving`) and run `make search-probe` from the
greenveil repo before moving the tunnel.

### 4. Other tenants

Each tenant has its own Application and needs the same treatment: secrets, Application, and
data. Stateful ones need care:

- **cuttlefish** (Postgres PV + backups + prometheus). Only 3 cuttlefish PVCs are bound. The other `cuttlefish-controlplane-release-{db-backups,prometheus}`
  Retain PVs are orphaned duplicates. Clean
  them up **before** migrating.
- **brandbrain** (`brandbrain-api-db-data`)
- **dns** (`dns-control-data`, `data-dns-mail-0`)
- **babybub** (cnpg)
- **deephost** (minio, redis, prometheus)

Use `pg_dump`/restore or the same static-PV re-attach as in phase 3.

- **LoadBalancer IPs change.** Envoy gateway (`104.156.233.70`) and kourier (`149.28.166.65`)
  get new IPs in `omega-ha`. Every DNS record pointing at them must be updated, and the TTL
  lowered beforehand.

### 5. Re-point automation, then retire `omega`

- Greenveil: update the `PAPRIKA_KUBECONFIG_B64` secret and the local
  `~/projects/paprika/terraform/omega.kubeconfig` references in skills and docs. Run one full
  `deploy-paprika.yml` against `omega-ha`.
- Paprika `deploy-vke.yml`: point it at the new cluster.
- After a soak of at least 7 days, `terraform state rm` and then delete `omega` through the
  Vultr API. Delete its now-orphaned Retain volumes only after each tenant has confirmed its
  data.
- Rename `omega_ha` to `omega` in Terraform with a `moved {}` block, not a destroy.

## Cost delta

Current `omega` spend (Vultr API, 2026-09-28):

| Item | Monthly |
|---|---|
| core 4 x vc2-2c-4gb @ $20 | $80 |
| core-large 2 x vc2-4c-8gb @ $40 | $80 |
| greenveil-search 1 x vc2-6c-16gb @ $80 | $80 |
| Control plane (non-HA) | $0 |
| **Workers** | **$240** |
| Block storage | 26 volumes / 398 GB. 15 volumes (150 GB) are attached to no instance, most of them orphaned cuttlefish Retain PVs |
| LoadBalancers | 2 |

The pool `search` (vc2-4c-8gb) is `closed` with 0 nodes and costs nothing.

- **Steady-state delta: the HA control-plane fee only.** Third-party pricing summaries put it
  at **about $40-50 per month per cluster**. I could not verify this on vultr.com (the
  pricing pages return 403 to non-browser clients), so confirm it in the console create
  dialog before committing. The standard control plane is free. Worker cost does not change.
- **One-off overlap during migration:** a second copy of the workers at $240/mo pro-rata,
  hourly. That is about $55 for a 1-week overlap, or about $8 per day. Add 2 x LoadBalancer
  for the overlap (about $10/mo each, pro-rata). If Meilisearch uses option 2, add 160 GB of
  block storage for the overlap.
- **Offset:** the 15 unattached volumes (150 GB, mostly orphaned cuttlefish PVs)
  cost about the same as a 160 GB overlap volume. Delete them after checking each one.

## Cheaper stop-gaps if the migration is deferred

- Open a Vultr support ticket for control-plane instability on
  `7997fb87-6982-4cf1-a693-8cfee32d9668`. Nothing in the API restarts a control plane.
- Upgrading the cluster to v1.36.2+1 rebuilds the control plane, but it also rolls every
  worker. Schedule it; do not do it mid-release.
- Cut apiserver load. The Paprika `dns` Application reconcile loop (about 295
  reconciles/2 min, against 4/2 min for every other app) accounts for most of the
  `applications/status` PUTs.
- Release tooling already retries control-plane reads (greenveil #432, `secret_value` 5x30s).
  Extending that pattern is cheap insurance.
