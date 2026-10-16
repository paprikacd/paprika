# VKE HA control plane: migration plan for `omega`

Status: **complete** (migrated 2026-09-28; `omega` gone 2026-09-28/29; teardown cleanup 2026-10-06). See the [Runbook log](#runbook-log-2026-09-28) and [Post-migration](#post-migration-omega-deleted-early-and-teardown-2026-10-06) at the end.

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

## Runbook log (2026-09-28)

Executed by an agent on explicit approval ("just proceed with it"). Times are UTC.
Backups and working files: `/Volumes/gamma-systems-2/paprika-vke-ha-migration/20260928T104714Z/`.

### Phase 0 — prerequisites

- 10:44 No `deploy-paprika` run in progress. Baseline: `api.greenveil.ai/healthz` ok (upstream
  `origin-vke`), `make search-probe` ok (generation `sha-babb015cc346`), `app.greenveil.ai`
  200 `server: cloudflare` (no `x-vercel-id`), worker push unauthenticated POST → 401.
- Serving index `greenveil_products_sha-babb015cc346` = **4,107,366 docs** (Meili DB 84 GB,
  78 GB used of the 160Gi volume; the previous generation `sha-09459ba1d18d` is also present).
- Backed up to gamma: the local tfstate (`terraform.tfstate.pre-omega-ha`), every tenant
  namespace's secrets/configmaps/Applications/PVCs/services/routes (`k8s/`), cluster-scoped
  objects, helm values of every release (`helm/`), and `pg_dumpall` of cuttlefish (21 MB gz),
  brandbrain (512 MB gz) and babybub (2.5 MB gz), each md5-verified and ending in
  `dump complete`. Streaming `kubectl exec … | gzip` was cut twice by apiserver resets, so the
  dumps were written inside the pod and `kubectl cp`'d with an md5 retry loop.

### Phase 1 — `omega-ha` created

- Terraform: `terraform/omega_ha.tf` (new file; `omega` untouched). Run from the worktree
  against the canonical local state with `-state=…/terraform/terraform.tfstate` and
  `-var-file=…/terraform/terraform.tfvars`. Targeted plan: **4 to add, 0 to change, 0 to
  destroy**. Applied 10:59–11:06.
- Cluster **`40ee226a-9fd0-43fc-9571-e4a44668098d`** (`omega-ha`, syd, **v1.36.5+1** — v1.36.1+2
  is no longer offered), Vultr reports `ha_controlplanes=true`. Pools: core 4× vc2-2c-4gb,
  core-large 2× vc2-4c-8gb (`c9676421-…`), greenveil-search 1× vc2-6c-16gb with
  `dedicated=search:NoSchedule` (`7ce336b3-…`). Kubeconfig:
  `~/projects/paprika/terraform/omega-ha.kubeconfig`.
- Platform: envoy gateway v1.4.0, cert-manager v1.20.3, cnpg chart 0.29.0 (same values as
  omega), metrics-server v0.8.1, the servicemonitor/prometheusrule CRDs, ClusterIssuers
  (+ ACME account and Cloudflare token secrets copied), GatewayClass `eg`, Gateway `paprika`
  (TLS secrets + ReferenceGrants copied, so no re-issuance was needed), Paprika chart 0.2.3
  from commit `8e258f48` with the live helm values, AppProjects, and the deployer RBAC.
  Calico is built into VKE. New gateway LB: **139.180.161.184**.
- readyz soak #1 (during bootstrap): 30/30 `ok`, 11 over 1 s. A fresh TLS handshake from the
  operator Mac costs 0.5–1.0 s against **both** clusters, so the "<1 s" bar measures this
  network, not the apiserver.

### Phase 3 — Meilisearch: `/export`, not re-attach

- Re-attach was validated on a throwaway 1Gi Retain volume: written on omega → static PV
  (`csi.driver: block.csi.vultr.com`, `volumeHandle: <vultr block id>`, `claimRef`) mounted
  and appended on omega-ha → mounted back on omega with both lines intact. Cross-cluster
  attach works in both directions.
- For search the plan chose **Meilisearch `POST /export`** (v1.16+) instead: the old volume
  stays attached and serving, the copy is built beside it, and rollback is a no-op. Re-attach
  would have taken search down from scale-0 until the new pod was Ready.
  - Fresh 160Gi Retain PVC in omega-ha (the committed PVC pins `volumeName` to the old PV, so
    it was not applied here).
  - Temporary `LoadBalancer` `greenveil/meili-migration-import` (149.28.183.205) with the
    Vultr firewall annotation limited to the old search node's IPv4 (45.63.24.231/32:7700).
    Verified: old pod gets 200, the operator Mac is refused.
  - The target received a **scoped, 24 h-expiring** key (`omega-ha-migration-import`), so the
    master key never crossed the wire.
  - 11:26 export task 3088 enqueued on omega (serving index only, `overrideSettings: true`).
    The source side finished in ~2 min; the target then indexes the queued payloads.
  - Serving key recreated on the target with the same UID
    (`5a76f9a6-…`). Same master key ⇒ same key value; the sha256 matches
    `greenveil-meilisearch-search-key`.
- The API refuses to start until the generation sentinel doc (`__greenveil_generation__`) is
  present, so the new API pods crash-loop until the index is complete. That is the intended
  guard.
- 11:58 Target idle: **4,107,366 docs** (same as source), settings md5 `76c88426…` identical,
  generation sentinel identical, 0 failed tasks. Import LB and import key deleted.
  Wall time ~32 min (source side ~2 min; target indexing ~30 min on vc2-6c-16gb, peak ~3 cores
  and 8.5 GiB). Only the serving generation was copied. The previous generation
  (`sha-09459ba1d18d`) is **not** on omega-ha; the next release builds or adopts generations
  as usual.

### Phase 2 — Greenveil planes, tunnel cutover (no DNS change)

- Secrets copied from omega (`kcopy.sh`: `kubectl get -o json | jq del(server metadata) |
  kubectl apply --server-side`). Applications applied from `origin/main:deploy/paprika/*`
  (except the PVC). api/web/worker/meili images `sha-babb015cc346`, matching omega.
- New API: `probe_search_synthetic.sh http://127.0.0.1:<port-forward>` → all PASS
  (generation `sha-babb015cc346`). New web: `/`, `/robots.txt`, `/search?q=` → 200.
- Trap: `greenveil-web` went `RolledBack` on first sync (health probe ran before the pods were
  Ready, and self-heal parked it). It re-releases only on a source change. Because omega-ha
  served no traffic yet, the Application was deleted and re-applied, and it came up `Healthy`.
  **Deleting a Paprika Application cascades to its workloads. Never do this on a cluster
  that serves traffic.**
- 12:06:43 `greenveil-cloudflared` Application applied on omega-ha, same tunnel token → 4 new
  connectors (syd06/syd08). Canary soak 12:07–12:13: 4/4 `search-probe` ok, 20/20 web 200,
  0 cloudflared `ERR` in either cluster, and omega-ha served real `GetProduct` traffic.
- **12:15:59 cutover:** omega's `greenveil-cloudflared` Application paused
  (`syncPolicy: Manual`, `selfHeal.autoSyncOnDrift/autoRevertOnHealthFailure: false`, original
  saved to `paused/`), its Deployment scaled 2 → 0. Old api/web/worker/meili stay running,
  warm but idle. Afterwards: search-probe ok, `/healthz` upstream `origin-vke`,
  `app.greenveil.ai` 200 `server: cloudflare` with no `x-vercel-id`, worker unauthenticated
  POST → 401, omega's API sees only kubelet probes.
- Pub/Sub verified: a replayed completed `scan-process` envelope (idempotency key
  `scan-process:abcaebc7-…`) published to `truelabel-scan-jobs` reached the omega-ha worker
  through the tunnel, passed Google OIDC, and was acked as `duplicate_completed`
  (`truelabel_data_worker_receipt_claims_total{status="duplicate_completed"} 1` on the
  omega-ha worker). A first attempt without `requested_at` / `attributes.scan_job_id` was
  rejected as a decode error (400) and dead-letters to `truelabel-scan-jobs-dlq`. It is
  harmless and can be purged.
- **Rollback (Greenveil):** `kubectl --kubeconfig omega.kubeconfig -n greenveil scale
  deploy/greenveil-cloudflared --replicas=2`, restore the Application's `syncPolicy`/`selfHeal`
  from `paused/greenveil-greenveil-cloudflared.app.json`, then scale omega-ha's cloudflared
  to 0.

### Phase 4 — other tenants (per-tenant log)

Tooling (all in the gamma run dir): `tenant-prep.sh` (copy secrets and save the Application),
`pause-old.sh` (omega Application → `Manual` with self-heal off, then scale to 0; `resume`
undoes both), `move-pv.sh` (flip the omega PV to `Retain`, wait until no live pod uses it and
the VolumeAttachment is gone, then create a same-named static PV and PVC on omega-ha),
`cf-set.py` / `vercel-set.py` (repoint the recorded A records; `--rollback` repoints to
104.156.233.70), and `sweep.sh` (public health of every tenant).

Prerequisites copied from omega (none come from a chart):
- ClusterRoles/bindings `oidc-cluster-admin`, `paprika-e2e-delegate-extra`,
  `paprika-networkpolicy-cluster-read`, `telesis-posture-reader`; every RoleBinding that grants
  to a `paprika-e2e` ServiceAccount (plus its Role); SA `paprika-e2e/cuttlefish-deployer`; SA,
  Role, binding and token secret `brandbrain/brandbrain-deploy-verifier` (**new token**: CI
  secrets built from the old token must be refreshed).
- **All tenant NetworkPolicies, and telesis-sandboxes' ResourceQuota.** The controller's
  Roles only allow *updating* named objects that already exist on omega. Without them the
  release fails with `cannot create resource "networkpolicies"` and parks as
  `Degraded`/`RolledBack` (this hit telesis and brandbrain).
- **GCP Workload Identity Federation.** telesis, brandbrain and cuttlefish exchange KSA tokens
  through pool `vke-omega` / provider `omega` in `uptime-485903`, `brandbrain-486909` and
  `cuttlefish-d16cd`. The providers pin omega's SA signing key inline (`jwksJson`, issuer
  `https://kubernetes.default.svc`), and omega-ha signs with a different key, so pods failed
  with `invalid_grant`. Fix: `gcloud iam workload-identity-pools providers update-oidc omega
  --jwk-json-path=<omega + omega-ha keys>`. Both clusters are now trusted (kids `9Ojy…` and
  `or2M…`). Remove omega's key at teardown. The provider setup lives in
  `scripts/bootstrap-vke-gcp-wif.sh`, which rebuilds the JWKS from ONE kubeconfig; running it
  against omega would drop omega-ha's key.

| Tenant | Data move | Public change | Down (UTC) | Notes |
|---|---|---|---|---|
| demo-app | none | none (internal) | — | omega copy paused 11:45 |
| telesis | none (Neon) | CF `api` (proxied), `origin`, `origin-vke` → 139.180.161.184 | 12:58:39–12:59:05, 12:59:32–12:59:48 | The edge worker's `ORIGIN_URL` is `origin-vke.telesis.dev` and Workers honour the 60 s TTL: the old copy was paused before that expired, rolled back twice by guard. The scheduler takes a PG advisory lock, so overlap was safe. The final pause 13:01:45 was clean. |
| carbon | 1Gi block re-attach | CF `carbon` (proxied) | 13:03:37–13:08:51, then intermittent until ~13:11 while CF edges converged | |
| tautau | 1Gi block re-attach | CF `api.tautau.xyz` (TTL 60) | 13:11:48–13:12:52 (+≤60 s DNS) | A chained `;` switched DNS before the volume move finished. Fixed with `&&`. |
| cuttlefish | 3 block re-attaches (PG 20Gi, backups, prometheus) | Vercel `api`, `origin-vke` | 13:13:48–13:19:05 | DB 131 MB / 49 tables verified; omega db-backup CronJob suspended |
| babybub | CNPG `Cluster` copied (not in chart), `pg_dump -Fc` → `pg_restore --clean --no-owner --role=babybub` | Vercel `api`, `origin-vke` | 13:32:50–13:34:10 | Row counts identical |
| brandbrain | fresh VFS PVC + DB Deployment/Service/init CM (out of band on omega), `pg_dump -Fc` → restore | Vercel `api`, `origin-vke` | 13:48:10–14:06:15 (**failed attempt**: the new release was blocked by the NetworkPolicy RBAC, so the old app was restored) and 14:15:46–14:22:26 | Final: 63 tables, exact row counts identical. Old DB scaled to 0, VFS volume kept. |
| flaggr | none (external PG) | CF `api.flaggr.dev` (proxied, edge `API_ORIGIN=https://origin-vke.flaggr.dev`), `origin-vke` | **none** | The omega-ha canary (steps 0/1/10/50/100, ~20–30 min each, `autoPromote: false`) had to reach 100% first; below that, `/` is weighted to the Vercel fallback. DNS switched at 15:28, old copy paused at 15:38 after the TTLs. 30/30 × 200. The omega-ha Release still waits for the manual promote at 100%. |
| telesis-agent (not Paprika) | none | none | — | Deployment, SA, secrets and WIF ConfigMap copied; omega copy scaled to 0 at 14:58 |
| deephost + dns | 5 block re-attaches (minio 20Gi, redis 10Gi, prometheus 5Gi, dns-control 1Gi, dns-mail 10Gi) | CF `deephost`, `console.deephost`, `grafana`, `snapshot.deephost`, `dns` → 139.180.161.184. Glue `ns1` → 45.77.235.78, `ns2` → 45.32.191.96. `mail.deephost` A ×3 → new core-node IPs. Vultr PTR for those 3 IPs → `mail.deephost.benebsworth.com` | 14:29–~14:48 (console/apps), `live.benebsworth.com` until 14:56 | See the notes below |

**deephost / dns specifics.**
- Platform: knative-serving v1.17.1 + net-kourier v1.17.0 (the kourier LB IP changes; no
  public DNS pointed at the old one) and istio 1.24.2 (base, istiod, gateway with ClusterIP; the
  gateway chart needs `--skip-schema-validation` for the saved values). The knative ConfigMaps
  and the `kourier-system/allow-deephost-grafana` ReferenceGrant were copied. The deephost CRDs
  and three ClusterRoles/bindings were copied.
- deephost custom resources (9 apps, 7 domains, 24 builds, 19 releases) were copied **before**
  the operator started, and each `.status` was restored with `kubectl patch
  --subresource=status`, so the operator saw finished builds and did not rebuild. The
  operator-created Certificates and `dh-*` HTTPRoutes were copied too, along with their TLS
  secrets, so there was no ACME re-issuance.
- **`quay.io/minio/minio@sha256:1dce27…` now returns 401** (MinIO no longer publishes public
  images; Docker Hub `minio/minio` is 401 too). omega had it only in node caches. It was
  exported from omega node `core-af3e2b873b5e` (`ctr -n k8s.io images export --platform
  linux/amd64`) and imported on all four omega-ha core nodes (`ctr images import --platform
  linux/amd64`). The tar is on gamma (`minio-image.tar`, md5 `5ae08076…`). **Any new node
  cannot pull it.** Mirror it to a registry you control, or move off it. `minio/mc` (bucket-init
  Job) is unpullable as well. That Job only creates buckets that already exist, so it stays
  `ImagePullBackOff`, which is harmless.
- redis's Vultr block was still attached at the provider level to an omega node after its
  VolumeAttachment was gone (`FailedPrecondition` on attach). Fixed with `POST
  /v2/blocks/<id>/detach`. `move-pv.sh` checks VolumeAttachments, **not** Vultr's
  `attached_to_instance`. Check both.
- dns publishes authoritative DNS (53/udp+tcp) and SMTP/submission/POP3S through
  `externalIPs` = three **core node** IPs, pinned in the Application's inline `valuesFile`
  (`externalIPService.addresses`, `mail.externalAddresses`). omega-ha's copy uses core nodes
  `45.77.235.78`, `45.32.191.96` and `45.77.238.25`. Node IPs change if Vultr replaces a node.
  The omega `dns-authority` StatefulSet was left running on its in-memory snapshot as a
  fallback while resolver caches expired.
- The hosting engine owns `live.benebsworth.com @ A` and refused `UpdateRecord`. It
  re-resolves `apps.deephost.benebsworth.com` every 60 s but will not apply a *completely
  different* address set without a human: `hosting.v1.HostingService/ConfirmGatewayAddresses
  {"addresses":["139.180.161.184"]}` (the same set `GetHostingStatus.gatewayPendingAddresses`
  showed) was confirmed at 14:56 → 1 site re-queued, and all three new authorities answered the
  new IP at 14:56:30.
- The dns Application on omega-ha shows `RolledBack` (its first health probe beat the pods).
  The workloads and Services are correct. It re-releases on the next source change (the
  Application pins a git SHA).

### Phase 5 — automation re-pointed (15:00)

- skunkworq/greenviel: **`PAPRIKA_KUBECONFIG_B64`** = omega-ha admin kubeconfig. It takes
  precedence in `deploy-paprika.yml`. The legacy `PAPRIKA_KUBECONFIG` (omega) is untouched.
  Rollback: `gh secret delete PAPRIKA_KUBECONFIG_B64 -R skunkworq/greenviel`.
- skunkworq/cuttlefish: `PAPRIKA_KUBECONFIG_B64` = SA-token kubeconfig for
  `paprika-e2e/cuttlefish-deployer` (the same identity its last run logged; a token Secret was
  created on omega-ha). Resource-name-scoped permissions verified.
- skunkworq/brandbrain: `PAPRIKA_KUBECONFIG_B64` = SA-token kubeconfig for
  `brandbrain/brandbrain-deploy-verifier` (verified get deployments / patch Application).
- skunkworq/uptime (and flaggr after its cutover): `PAPRIKA_KUBECONFIG_B64` = omega-ha admin
  kubeconfig. The old secrets are unreadable. No RoleBinding on omega granted these repos
  anything, so admin is the likely old identity. **Review.**
- paprikacd/paprika vars `VKE_CLUSTER_ENDPOINT` / `VKE_CLUSTER_CA_B64` → omega-ha (old
  values saved on gamma). `VKE_AUTODEPLOY_ENABLED` is still `false`.
- CF `paprika` / `paprika-demo` (proxied) → 139.180.161.184 at 14:58. `var.paprika_lb_ip`
  default updated. A targeted plan over those records plus all `omega_ha` resources =
  **No changes**.
- **Not done on purpose:** the plan's "run one full deploy-paprika.yml against omega-ha".
  Since the serving build (`babb015cc346`), main has ~24k lines of unreleased code, including
  migration `060_search_query_daily` and the #486 `BUF_TOKEN` preflight (no Buf token exists
  yet). Shipping that inside an infra cutover mixes two risks. Leave it for the next normal
  release.

**Incident, cuttlefish on omega un-paused itself (found 15:40).** cuttlefish's own CI
(`deploy-vke.yml` applies its Application with `PAPRIKA_KUBECONFIG_B64`, which still pointed
at omega until 15:00) re-applied the Application at ~13:47, resetting `syncPolicy: Auto` and
self-heal. omega's Paprika then re-released: alertmanager, grafana, exporters and spans ran
again, and `postgres-0` and `prometheus` sat in `ContainerCreating`. Vultr refused to attach
volumes that omega-ha holds, and that single-attach rule is what prevented split-brain. Fixed
by re-pausing (Manual, scale 0, db-backup CronJob suspended). omega-ha's cuttlefish was
unaffected (api 200, PG Running). **Lesson: re-point every tenant's CI credentials *before*
pausing that tenant on the old cluster, or its CI will un-pause it.** All 15 omega
Applications were audited at 15:41: every tenant is `Manual` and no Release is in flight.

**Greenveil on omega is frozen as a warm rollback.** api/web/data-worker/meilisearch
Applications are `Manual` with self-heal off, but still running at `sha-babb015cc346` against
the old Meili generation. Otherwise the next release would roll them to a generation old Meili
lacks and they would crash-loop. cloudflared stays at 0. The old `dns-authority` was scaled to
0 at 15:40, after the glue TTLs.

### HA verification

- Vultr: `ha_controlplanes=true`. The `kubernetes` Service has **3 apiserver endpoints**
  (10.19.128.3/.4/.5) and 3 apiserver identity leases. omega has 1.
- readyz soak #2 (14:59–15:16, 30 samples, both clusters interleaved): omega-ha 30/30 `ok`,
  mean 0.14 s, max 0.24 s, 0 over 1 s; omega 30/30, mean 0.14 s, max 0.19 s.

### Cost (Vultr pending charges, read 15:05)

- The HA control plane shows **no charge**: the only control-plane line is `Load Balancer
  (controlplane_lb)` at unit price **$0**. The "$40–50/mo" estimate above is not what this
  account is billed. Confirm on the next invoice.
- Overlap while omega is kept: a second worker set $240/mo, 2 LBs $20/mo, new 160 GB Meili
  volume $16/mo and 10 GB VFS $1/mo. That is ~$277/mo pro-rata ≈ **$9/day** (~$65 for the 7-day
  soak).
- **Steady state after teardown: +$0/mo.** The worker shape, LB count and volume sizes are
  unchanged, and the old 160 GB Meili volume, old VFS and old CNPG volume go away with omega.

### Rollback (per tenant, while omega exists)

The omega Applications are paused, not deleted, and **must never be deleted**: deletion
cascades. `pause-old.sh <ns> <app> resume` restores sync and replicas. For re-attached
volumes, first scale the omega-ha workload to 0, wait for detach, then resume omega. The
omega PVC/PV objects still reference the same Vultr volumes. For dumped/restored DBs
(babybub, brandbrain), the omega copy is frozen at cutover time. DNS: `cf-set.py <names>
--rollback`, `vercel-set.py <domain> <names> --rollback`, restore glue/mail from
`cf-glue-records-before.txt`.

### Teardown of `omega` — not before 2026-10-05

```bash
# 1. Stop trusting omega's SA signing key (keep only omega-ha's) in all three WIF providers:
kubectl --kubeconfig ~/projects/paprika/terraform/omega-ha.kubeconfig get --raw /openid/v1/jwks > /tmp/jwks-ha.json
for p in uptime-485903:uptime-485903 brandbrain-486909:brandbrain-486909 cuttlefish-tf:cuttlefish-d16cd; do
  CLOUDSDK_ACTIVE_CONFIG_NAME=${p%%:*} gcloud iam workload-identity-pools providers update-oidc omega \
    --workload-identity-pool=vke-omega --location=global --project=${p##*:} --jwk-json-path=/tmp/jwks-ha.json; done
# 2. Drop omega from Terraform state (no destroy), then delete the cluster WITHOUT linked resources:
cd ~/projects/paprika/terraform
terraform state rm vultr_kubernetes_node_pools.core_large vultr_kubernetes_node_pools.search \
  vultr_kubernetes.omega local_file.kubeconfig null_resource.github_actions_deployer_rbac
curl -X DELETE -H "Authorization: Bearer $VULTR_API_KEY" \
  https://api.vultr.com/v2/kubernetes/clusters/7997fb87-6982-4cf1-a693-8cfee32d9668
# NEVER use .../delete-with-linked-resources: the 10 re-attached volumes now serve omega-ha.
# 3. Then delete, after checking each is unattached: old LBs 104.156.233.70 / 149.28.166.65,
#    old Meili volume pvc-c6d15a0cb04b49e2 (160 GB), old brandbrain VFS pvc-c0628261f4c24359,
#    old babybub CNPG volume pvc-e344ee953ded450a, and the pre-existing orphans.
# 4. Rename omega_ha -> omega in Terraform with a moved {} block; drop the old
#    PAPRIKA_KUBECONFIG secret in skunkworq/greenviel.
```

### Follow-ups (not done)

- IaC still hard-codes 104.156.233.70: `uptime/infra/modules/cloudflare-edge` (`origin_ip`),
  `flaggr/terraform/environments/dev` (`origin_ip`), `brandbrain/infra/terraform/envs/prod`
  (`droplet_ip`), `tautau/terraform/cloudflare` (`cluster_gateway_ip`). The next apply of any
  of them would point DNS back at omega, and after teardown at nothing. The pre-existing
  cuttlefish `deploy/shared-droplet/dns.tf` drift (`api.cuttlefish.sh` → droplet
  `reserved_ip`) is older than this migration.
- Mirror `quay.io/minio/minio@sha256:1dce27…` (and `minio/mc`) to a registry you control.
- cloud-guardian-agent was not installed on omega-ha. Its values pin omega's `clusterId` and
  agent id; register a new agent. irsa-webhook was not installed (no ServiceAccount uses it).
- The omega `dns-authority` still answers from a stale snapshot. Scale it to 0 after ~1 h.
- Purge the malformed test message from `truelabel-scan-jobs-dlq`.

## Post-migration: omega deleted early, and teardown (2026-10-06)

### What happened to `omega`

- `omega` (`7997fb87-…`) was deleted between **2026-09-28 15:41 and 2026-09-29 02:09 UTC**,
  outside any agent session, most likely from the Vultr console with
  **delete-with-linked-resources** (the option the teardown section above warns against). Vultr
  lists only `omega-ha` now. Terraform state still held omega until 2026-10-06.
- Volumes attached to omega-ha nodes at that moment survived, and so did every VFS volume,
  including the 5 that were unattached. The one casualty was cuttlefish's backups block volume
  `597adf62-…` (PV `pvc-6ffedd7b055d4d3a`). It was re-attached to omega-ha but only mounted
  while the 02:00 backup Job ran, so at delete time it was unattached and went with the cluster.
  Every nightly backup failed from 2026-09-29 (`storage not found: 597adf62…`, 4 stuck
  VolumeAttachments). The live cuttlefish DB volume (`82a3a928`, 20Gi) was unaffected.

### deephost DNS outage (2026-09-29 00:18 → 2026-10-05 22:53 UTC)

- At 2026-09-29 00:18, deephost `0490449`/`ba66c09` (an image re-pin) re-applied the omega-ha
  `dns` Application from repo values that **still carried omega's node IPs** (149.28.170.95,
  139.180.160.11, 207.148.84.78). `dns-authoritative-external` and `dns-mail-external` dropped
  the omega-ha node IPs that the ns1/ns2 glue and mail A records point at. Port 53 timed out,
  `live.benebsworth.com` stopped resolving, and the "External delegated DNS canary" failed
  from then on. **Lesson:** the migration patched the live Application inline but not the
  repo values, so the next apply from the repo reverted it. Live-only fixes must also land in
  the repo.
- Fix: castlemilk/deephost#2 sets `externalIPService.addresses` and
  `mail.externalAddresses.addresses` to omega-ha core nodes 45.77.235.78, 45.32.191.96 and
  45.77.238.25 (with a comment that they change on node replacement), and updates the e2e
  defaults and docs. Repo variables `DNS_NS1_ADDRESS`/`DNS_NS2_ADDRESS` (used by the canary) now
  hold the new IPs. Applied 22:53:15; Paprika synced within seconds (`dns-release-5ff3315ec3`).
- Verified: all three authorities answer `live.benebsworth.com` → 139.180.161.184 over UDP and
  TCP; 1.1.1.1 and 8.8.8.8 resolve it; the site returns 200; mail ports 25/587/465/995 are open on
  all three IPs, and MX/A for `mail.deephost` are unchanged. The canary run 37385322111 passed
  (83 checks), its first pass since 09-29.

### cuttlefish backups rebuilt (skunkworq/cuttlefish#441)

- Backups claim moved to `vultr-vfs-storage-retain`, `ReadWriteMany`, under a new name
  `cuttlefish-controlplane-release-db-backups-vfs`. storageClass and accessModes are immutable,
  so an in-place edit would have failed the release. The new name also avoided racing
  Paprika's self-heal.
- A `db-backups-holder` Deployment (pause image, 1m CPU, read-only mount) keeps the claim
  mounted at all times. The volume therefore always shows as attached to a serving-cluster node,
  and never as an orphan to a cleanup sweep. Its pod deliberately lacks the chart's `name`
  label, because the API Service and PDB select on name+instance.
- **Why VFS + holder:** on 2026-09-28/29 the attached volumes and all VFS volumes survived; the
  one unattached block volume did not. VFS RWX also removes the single-node attach, so the Job
  runs on any node; the first run landed on a different node from the holder.
- Rolled out by Paprika from main (new PV `pvc-93959388d8f24163`). The dead PVC/PV were deleted
  by hand, and the 4 stale VolumeAttachments had their finalizers cleared after Vultr returned
  404 for the volume.
- First backup (manual `kubectl create job --from=cronjob/…`, 2026-10-05 22:58 UTC):
  `cuttlefish-20261005-225817.dump`, 200 MB. `pg_restore -l` lists 65 TABLE DATA entries.
- **Still single-site:** VFS lives in the same Vultr account and region. An off-site copy (GCS
  through the existing `cuttlefish-d16cd` WIF) is the remaining gap.

### Teardown done (2026-10-06)

- WIF: providers `vke-omega/omega` in `uptime-485903`, `brandbrain-486909` and `cuttlefish-d16cd`
  now hold **only omega-ha's key** (`or2MZ04V…`; omega's `9OjyRyvi…` removed). Pre-change
  descriptions are saved in the scratch dir. Verified with a real STS exchange for the
  telesis, brandbrain and cuttlefish runtime KSAs (all OK) and SA impersonation (telesis,
  brandbrain OK).
  - **Pre-existing, not caused by this change:** `cf-controlplane@cuttlefish-d16cd`'s
    `workloadIdentityUser` binding names subject
    `system:serviceaccount:paprika-e2e:cuttlefish-controlplane-release`, but the pod runs in
    namespace `cuttlefish`, so impersonation is denied. cuttlefish logs show no GCP auth errors
    in 7 days. Rebind it if cuttlefish needs GCP.
- Terraform: `terraform state rm` of `vultr_kubernetes.omega`,
  `vultr_kubernetes_node_pools.{core_large,search}`, `local_file.kubeconfig` and
  `null_resource.github_actions_deployer_rbac` (state backup:
  `/Volumes/gamma-systems-2/paprika-vke-ha-migration/terraform.tfstate.pre-omega-teardown-*`).
  The code for those and their outputs was removed. The plan showed 0 resource actions, only
  output removals plus the stale `paprika_lb_ip` output. That output-only plan was applied, and
  the next `terraform plan` reported **No changes** (state serial 82). Deployer RBAC is now
  applied by hand to omega-ha (see the comment in `main.tf`).
- skunkworq/greenviel secret `PAPRIKA_KUBECONFIG` (omega) deleted. `deploy-paprika.yml` and
  `search-release-admin.yml` prefer `PAPRIKA_KUBECONFIG_B64` (omega-ha) and only fell back
  to it.
- **Left for a human:** 5 unattached VFS volumes from the omega era, kept on purpose:
  `pvc-c0628261f4c24359` (old brandbrain DB, 1.4 GB used), `pvc-40bad46460b74aae` (1.3 GB),
  `pvc-8d29f1074d3f4f7b` (empty), `pvc-cc150377b5eb43c5` (1.5 GB) and `pvc-27ca0020dd5d401f`
  (empty). ~$1/mo each. The old omega LBs (104.156.233.70, 149.28.166.65) and the old Meili/babybub block volumes
  no longer appear in Vultr (gone with omega). The only LBs are omega-ha's envoy
  (139.180.161.184) and kourier (104.156.232.122).

