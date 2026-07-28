# Fast CI and Deployment Flow Design

## Goal

Make pull-request feedback fast and make every automatic VKE deployment consume the exact
`linux/amd64` image produced from a validated `master` commit.

## Architecture

`.github/workflows/ci.yml` is the canonical fast path. It runs for every pull request and only for
pushes to `master`. Eight independent validation lanes run in parallel:

- Go race tests;
- Go lint and linter-configuration validation;
- UI tests, lint, and production build;
- a real fleet-console browser smoke test;
- the controlled `linux/amd64` fleet-scale gate;
- regenerated protobuf drift detection; and
- Helm lint and template rendering; and
- a Kind-backed Helm deployment smoke with split-plane metrics validation.

The publish job depends on all eight lanes and runs only for a `master` push. Buildx produces only
`linux/amd64` and publishes `latest` and `sha-<commit>` tags for operator discoverability. Tags are
not the promotion contract: the build action exposes the pushed manifest digest as a job output.
CI concurrency remains shared by workflow and ref. Superseded pull-request runs cancel. For
`master`, the running group member continues without cancellation, so a later push cannot cancel
an in-flight reusable VKE deployment. GitHub's default retains only the newest pending group
member and may replace an older pending `master` run; this is intentional latest-pending behavior,
not an all-runs FIFO queue.

After publication, CI calls `.github/workflows/deploy-vke.yml` as a local reusable workflow and
passes `ghcr.io/paprikacd/paprika@<published digest>`. This keeps validation, publication, and the
privileged handoff in one trusted workflow run. The reusable deployment checks out `github.sha`
and has no separate privileged `workflow_run` trigger.

VKE manual promotion uses a `deploy-vke` repository dispatch wrapper which calls the reusable
workflow from default-branch code. GKE and Cloud Run use the typed `deploy-gke` and
`deploy-cloudrun` repository dispatch events. Each accepts a `client_payload.image_ref` and rejects anything except
`ghcr.io/paprikacd/paprika@sha256:<64 lowercase hex>`. GKE and Cloud Run are manual-only. The VKE
Helm command overrides every Paprika component image repository with that digest; the chart omits
the tag when a repository already contains `@`. Full Kind e2e runs nightly and on demand, outside
the pull-request critical path. Helm publishing follows chart changes on `master`; a typed
`publish-helm` repository dispatch accepts only a safe semantic chart version. The `publish-pages`
repository dispatch similarly replaces the privileged Pages `workflow_dispatch`. `v*` tag
releases remain independent.

Example privileged manual requests are:

```sh
IMAGE_REF='ghcr.io/paprikacd/paprika@sha256:<64-lowercase-hex>'
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-vke -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-gke -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=deploy-cloudrun -f "client_payload[image_ref]=${IMAGE_REF}"
gh api repos/paprikacd/paprika/dispatches --method POST \
  -f event_type=publish-helm -f 'client_payload[version]=0.1.0'
gh api repos/paprikacd/paprika/dispatches --method POST -f event_type=publish-pages
```

## Supply-Chain Hardening

Actions in the fast CI, deployment, E2E, and Helm-publish paths are pinned to immutable revisions.
Each job has a bounded timeout. The downloaded Kind binary is verified against a repository-pinned
SHA-256 checksum before installation. Workflow permissions are minimized per job; only publishing
receives `packages: write`, and only deployment jobs receive `id-token: write`.

The reusable VKE job has an exact defense gate: only `push` or `repository_dispatch` on
`refs/heads/master` may reach its environment or steps. The public token exchange is a separate
authorization boundary. In addition to repository, environment, and subject, it requires an
allowed `event_name`, exact `refs/heads/master`, an allowlisted caller `workflow_ref` (`ci.yml` or
`deploy-vke-manual.yml`), and the exact called `deploy-vke.yml` `job_workflow_ref`. Missing claims
fail closed before service-account token minting.

The GitHub `vke-production` environment policy was applied and verified on 2026-07-27. Its
`deployment_branch_policy` has `custom_branch_policies=true` and `protected_branches=false`, with
exactly one allowed policy: `{name: master, type: branch}`.

## Safety Properties

- A failed, skipped, or incomplete validation lane cannot publish or deploy an image.
- Pull requests validate but cannot publish packages or request a VKE deployment.
- Automatic VKE promotion consumes the exact digest returned by the gated publish job, never a
  mutable tag or a separately reconstructed reference.
- Privileged manual requests execute default-branch workflow code and cannot select a branch.
- Manual deployments cannot accept tags, alternate registries, uppercase digests, suffixes, or
  whitespace-padded input.
- An untrusted event, branch, caller workflow, or called workflow cannot exchange GitHub OIDC for
  the VKE service-account credential.
- Production CI images are always built for `linux/amd64`.
- Active push automation targets `master`; legacy GKE and Cloud Run deployment stays manual-only.
- Existing tag-based GoReleaser releases remain independent.

## Verification

`internal/cicontract/workflows_test.go` parses the workflow YAML and enforces the job graph,
failure propagation, branch/event restrictions, digest grammar and data flow, reusable VKE call,
manual-only legacy workflows, action revisions, permissions, timeouts, Kind checksum, and nightly
E2E schedule. Local verification runs the contract, Go race suite, UI test/lint/build, Helm
lint/template, workflow YAML parsing, and documentation stale-claim checks.
