# Disaster Recovery

Paprika is a GitOps platform: the manifests it deploys to target clusters come from git, OCI,
or S3 sources, so the **deployed workload state is already durable** in source. Disaster
recovery for Paprika itself is mainly about its **control-plane state** — the Paprika CRDs
(`Application`, `Stage`, `Release`, `Pipeline`, `Template`, `ConftestPolicy`, `FeatureFlag`,
`AppProject`, etc.) that live in etcd.

This guide covers backing up and restoring that control-plane state with [Velero](https://velero.io).

## What to back up (and what not to)

| State | Location | Back up? |
|---|---|---|
| Paprika CRDs (specs, status, release history, gate approvals) | etcd (cluster) | **Yes** — this is the DR target. |
| Rendered-manifest and source cache | Redis (ephemeral) | No — Paprika rebuilds it on restart. |
| Source manifests (git/OCI/S3) | External source systems | No — already durable; Paprika re-renders from source after restore. |
| Paprika container images | Registry | No — re-pull on restore. |

## Prerequisites

1. **Install Velero** with a backend that supports your object store (S3, GCS, Azure, MinIO,
   etc.). See the [Velero install docs](https://velero.io/docs/main/install/overview/).
2. Confirm a `BackupStorageLocation` exists and is `Available`:
   ```bash
   kubectl get backupstoragelocation -n velero
   ```
3. Install or upgrade Paprika with the Velero schedule enabled (see below), or create backups
   manually.

## Option A — scheduled backups via the Helm chart

Enable the chart's Velero integration to render a `Schedule` that backs up the Paprika
release namespace (plus cluster-scoped CRDs) on a cron:

```yaml
velero:
  enabled: true
  namespace: velero                # the namespace Velero is installed in
  storageLocation: default          # an existing BackupStorageLocation name
  schedule: "0 */6 * * *"           # every 6 hours
  ttl: "720h"                       # retain 30 days
  includeNamespaces:                # extra namespaces where your Applications live
    - team-a
    - team-b
```

The `Schedule` is created in the Velero namespace (`velero.namespace`) — Velero only reconciles
schedules that live there. `includeClusterResources: true` is set so the custom resource
**definitions** are backed up and restored before their instances.

Verify the schedule is picked up:
```bash
kubectl get schedule -n velero
velero schedule describe <release>-paprika-backup -n velero
```

## Option B — on-demand backups

For an ad-hoc backup before a risky change:

```bash
velero backup create paprika-pre-change \
  --include-namespaces paprika-system \
  --include-cluster-resources=true \
  --storage-location default
```

Add `--include-namespaces team-a,team-b` (or use `--include-namespaces paprika-system,team-a,...`)
to also capture Applications living in other namespaces.

## Restore procedure

Restoring into the **same** cluster after accidental deletion, or into a **new** cluster
during region failover:

1. Ensure Paprika is **not** running against the namespace you are restoring into (stop the
   Paprika manager, or restore into a fresh cluster) to avoid the controller fighting the
   restore.
2. Restore CRDs **before** their instances. Velero handles this when
   `--include-cluster-resources=true` was used for the backup, but if you restore selectively,
   restore the CRDs first:
   ```bash
   velero restore create paprika-restore --from-backup <backup-name> \
     --include-cluster-resources=true
   ```
3. Once the CRDs and instances are restored, (re)install/start Paprika. On startup it will
   rebuild the Redis cache and re-resolve sources from git/OCI/S3; no manual re-sync is needed
   for already-deployed applications whose sources are unchanged.

## Multi-region / cluster failover

Because sources live in git/OCI/S3, failing Paprika over to a new cluster is:

1. Restore the Paprika CRD backup into the new cluster (above).
2. Install Paprika in the new cluster pointed at the same source systems.
3. Paprika reconciles the restored Applications against the target clusters and re-applies
   manifests from source.

No application manifests need to be re-staged — they are re-rendered from source.

## Redis note

The Redis cache (`redis.enabled`) holds rendered manifests and source fetches to speed up
reconciliation. It is **ephemeral** and intentionally not backed up: Paprika repopulates it on
demand. If Redis is lost, the only effect is slower first-reconciles after restore until the
cache warms.

## Verifying a backup

```bash
velero backup describe <backup-name> --details
velero backup logs <backup-name>
```

Confirm the backup reports `Phase: Completed` and lists the Paprika CRD kinds under the
included resources before relying on it.
