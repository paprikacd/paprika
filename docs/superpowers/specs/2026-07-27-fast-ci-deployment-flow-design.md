# Fast CI and Deployment Flow Design

## Goal

Make pull-request feedback fast and make every automatic VKE deployment consume the exact
`linux/amd64` image produced from a validated `master` commit.

## Architecture

`.github/workflows/ci.yml` is the canonical fast path. It runs for every pull request and only for
pushes to `master`. Five independent validation lanes run in parallel:

- Go race tests;
- Go lint and linter-configuration validation;
- UI tests, lint, and production build;
- regenerated protobuf drift detection; and
- Helm lint and template rendering.

The publish job depends on all five lanes and runs only for a `master` push. Buildx produces only
`linux/amd64` and publishes `latest` and `sha-<commit>` tags for operator discoverability. Tags are
not the promotion contract: the build action exposes the pushed manifest digest as a job output.

After publication, CI calls `.github/workflows/deploy-vke.yml` as a local reusable workflow and
passes `ghcr.io/paprikacd/paprika@<published digest>`. This keeps validation, publication, and the
privileged handoff in one trusted workflow run. The reusable deployment checks out `github.sha`
and has no separate privileged `workflow_run` trigger.

VKE also supports manual dispatch. VKE, GKE, and Cloud Run manual deployments accept exactly one
required `image_ref`, with no default, and reject anything except
`ghcr.io/paprikacd/paprika@sha256:<64 lowercase hex>`. GKE and Cloud Run are manual-only. The VKE
Helm command overrides every Paprika component image repository with that digest; the chart omits
the tag when a repository already contains `@`. Full Kind e2e runs nightly and on demand, outside
the pull-request critical path. Helm publishing follows chart changes on `master`, while `v*` tag
releases remain independent.

## Supply-Chain Hardening

Actions in the fast CI, deployment, E2E, and Helm-publish paths are pinned to immutable revisions.
Each job has a bounded timeout. The downloaded Kind binary is verified against a repository-pinned
SHA-256 checksum before installation. Workflow permissions are minimized per job; only publishing
receives `packages: write`, and only deployment jobs receive `id-token: write`.

## Safety Properties

- A failed, skipped, or incomplete validation lane cannot publish or deploy an image.
- Pull requests validate but cannot publish packages or request a VKE deployment.
- Automatic VKE promotion consumes the exact digest returned by the gated publish job, never a
  mutable tag or a separately reconstructed reference.
- Manual deployments cannot accept tags, alternate registries, uppercase digests, suffixes, or
  whitespace-padded input.
- Production CI images are always built for `linux/amd64`.
- Active push automation targets `master`; legacy GKE and Cloud Run deployment stays manual-only.
- Existing tag-based GoReleaser releases remain independent.

## Verification

`internal/cicontract/workflows_test.go` parses the workflow YAML and enforces the job graph,
failure propagation, branch/event restrictions, digest grammar and data flow, reusable VKE call,
manual-only legacy workflows, action revisions, permissions, timeouts, Kind checksum, and nightly
E2E schedule. Local verification runs the contract, Go race suite, UI test/lint/build, Helm
lint/template, workflow YAML parsing, and documentation stale-claim checks.
