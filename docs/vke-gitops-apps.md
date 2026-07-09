# VKE GitOps Applications

Date: 2026-07-09

Paprika manages these VKE applications from public chart repositories:

| Application | Chart repository | Kubernetes app |
| --- | --- | --- |
| `telesis-api` | `https://github.com/paprikacd/telesis-api-chart` | `paprika-e2e/telesis-api` |
| `brandbrain-api` | `https://github.com/paprikacd/brandbrain-api-chart` | `paprika-e2e/brandbrain-api` |
| `cuttlefish-controlplane` | `https://github.com/paprikacd/cuttlefish-controlplane-chart` | `paprika-e2e/cuttlefish-controlplane` |
| `flaggr-api` | `https://github.com/paprikacd/flaggr-api-chart` | `paprika-e2e/flaggr-api` |

## Ownership Rules

- Chart repos own image repositories, tags, default non-secret runtime values, probes, resources, and Kubernetes object shape.
- Paprika Application manifests own cluster-specific wiring: pull secrets, runtime secrets, Workload Identity project/service-account bindings, Gateway hostnames, replica counts, and health checks.
- Do not set `image.repository`, `image.tag`, `image.digest`, or component image overrides in the Application manifests. Those values shadow chart defaults and prevent chart image bumps from changing the rendered workload.
- Do not mount Google service-account JSON keys for runtime credentials. The chart repos render keyless Workload Identity Federation config when `workloadIdentity.enabled=true`.
- All four Applications use `source.type: git`, `source.revision: main`, `source.pollInterval: 60s`, and `syncPolicy: Auto`. A chart commit should be enough for Paprika to detect drift and create a new release.

## Google Workload Identity Federation

The VKE cluster is registered as an OIDC provider in each Google project through a `vke-omega/omega` Workload Identity pool/provider. The provider trusts projected Kubernetes service-account tokens from the `paprika-e2e` namespace and each Google service account grants `roles/iam.workloadIdentityUser` to its exact Kubernetes service-account subject.

| Application | Kubernetes subject | Google service account |
| --- | --- | --- |
| `telesis-api` | `system:serviceaccount:paprika-e2e:telesis-api-release` | `telesis-vke-runtime@uptime-485903.iam.gserviceaccount.com` |
| `brandbrain-api` | `system:serviceaccount:paprika-e2e:brandbrain-api-release` | `brandbrain-backend@brandbrain-486909.iam.gserviceaccount.com` |
| `cuttlefish-controlplane` | `system:serviceaccount:paprika-e2e:cuttlefish-controlplane-release` | `cf-controlplane@cuttlefish-d16cd.iam.gserviceaccount.com` |
| `flaggr-api` | `system:serviceaccount:paprika-e2e:flaggr-api-release` | `flaggr-grpc-sa@flaggr-478302.iam.gserviceaccount.com` |

Bootstrap or refresh the WIF providers and IAM bindings:

```bash
scripts/bootstrap-vke-gcp-wif.sh
```

Validate the STS and impersonation path with real projected Kubernetes tokens:

```bash
scripts/validate-vke-gcp-wif.sh
```

## Image Promotion Flow

1. Build and push the service image.
2. Commit the new image tag to the chart repo `values.yaml`.
3. Push to the chart repo `main` branch.
4. Paprika polls the chart repo, renders the new chart default, and rolls out the change through the Application canary strategy.

## Validation

Run:

```bash
scripts/validate-vke-gitops-apps.sh
```

The script checks:

- Application manifests pass server-side dry-run.
- Application manifests do not shadow chart-owned image versions.
- Application manifests and values examples do not reference Google JSON-key credential wiring.
- Live Applications are `git` sourced from `main`, auto-syncing, healthy, and synced.
- Live Applications use the expected Workload Identity project numbers and Google service accounts.
- Referenced runtime and pull secrets exist with required key names.
