# Argo Feature Coverage Notes

This is a working map for Paprika coverage across Argo CD, Argo Rollouts, and Argo Workflows.

Primary references:

- Argo CD diff strategies: https://argo-cd.readthedocs.io/en/stable/user-guide/diff-strategies/
- Argo CD diff customization: https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/
- Argo CD sync phases and waves: https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/
- Argo CD sync options: https://argo-cd.readthedocs.io/en/latest/user-guide/sync-options/
- Argo CD automated sync: https://argo-cd.readthedocs.io/en/latest/user-guide/auto_sync/
- Argo CD resource health: https://argo-cd.readthedocs.io/en/latest/operator-manual/health/
- Argo CD ApplicationSet progressive syncs: https://argo-cd.readthedocs.io/en/latest/operator-manual/applicationset/Progressive-Syncs/
- Argo Rollouts canary: https://argo-rollouts.readthedocs.io/en/stable/features/canary/
- Argo Rollouts blue-green: https://argo-rollouts.readthedocs.io/en/stable/features/bluegreen/
- Argo Rollouts analysis: https://argo-rollouts.readthedocs.io/en/stable/features/analysis/
- Argo Workflows templates: https://argo-workflows.readthedocs.io/en/latest/workflow-templates/
- Argo Workflows artifact repositories: https://argo-workflows.readthedocs.io/en/latest/configure-artifact-repository/

## Covered Or In Flight

| Area | Argo behavior | Paprika status |
| --- | --- | --- |
| Desired vs live diff | Argo CD compares desired and live state and exposes diffs in the app UI. | Resource RPC returns desired, live, and unified diff. UI now has an application sync diff workbench and richer resource diff viewer. |
| Diff customization | Argo CD supports ignored JSON pointers and field managers. | `IgnoreDiff` exists for JSON pointers. Next step is surfacing ignored paths in the UI diff viewer and adding server-side dry-run diff. |
| Auto sync | Argo CD can automatically sync on drift. | `syncPolicy: Auto` and self-heal config exist. UI now makes drift visible at app scope. |
| Sync options | Argo CD supports prune, replace, force, and apply out-of-sync only. | `SyncOptions` covers prune propagation, replace, force, and apply out-of-sync only. UI should expose these in source/sync detail. |
| Resource health | Argo CD rolls resource health into app health. | Resource health and custom CEL health checks exist. E2E demo now uses real pod probes plus HTTP-backed app health. |
| Progressive delivery | Argo Rollouts canary and analysis gate promotion. | Paprika stages support canary steps and analysis checks. E2E demo now runs a canary promotion path. |
| Rollout operations | Argo Rollouts exposes promote and abort operations. | UI has rollout detail/debug surfaces and RPCs for promote/abort. |
| Workflow templates | Argo Workflows reuses cluster WorkflowTemplates. | Paprika Templates and Pipeline steps cover the build/release execution model. |
| Artifacts | Argo Workflows supports artifact repositories for step outputs. | Paprika has artifact RPCs and UI cards. Artifact repository abstraction is still lighter than Argo Workflows. |

## Next Highest-Value Gaps

| Priority | Feature | Reason |
| --- | --- | --- |
| 1 | Server-side dry-run diff option | Argo CD's stable server-side diff catches admission failures before sync and better reflects webhook mutation behavior. |
| 2 | Diff ignore UI and explanations | Operators need to know whether drift is real or intentionally ignored. |
| 3 | Sync waves and hook timeline | Paprika has stage and gate concepts, but users need an Argo-like ordered timeline for pre-sync, sync, post-sync, and failure hooks. |
| 4 | Resource action catalog | Argo CD resource actions are useful for operational repairs. Paprika should expose curated restart, scale, retry, promote, abort, and rollback actions with RBAC checks. |
| 5 | ApplicationSet progressive sync controls | Paprika ApplicationSets should show rollout batches and block on health before moving to the next batch. |
| 6 | Artifact repository refs | Move artifact storage config out of pipeline definitions, matching the Argo Workflows pattern of reusable repository refs. |
| 7 | Blue-green preview service workflow | Paprika supports BlueGreen as a strategy enum, but needs a first-class preview service, pre-promotion analysis, and fast rollback UX. |
| 8 | Notification subscriptions | Argo CD notifications are a major operator workflow. Paprika has notification configs, but app detail should show subscriptions and recent sends. |

## Implementation Bias

- Prefer one Paprika Application view over three separate Argo-style product silos.
- Keep resource state inspectable: app heatmap, app diff workbench, resource detail, logs, events, and investigation should form one flow.
- Prefer controller-side capability over UI-only inference when the behavior affects sync correctness.
- Keep all new metrics in OTel unless extending existing direct Prometheus code.
