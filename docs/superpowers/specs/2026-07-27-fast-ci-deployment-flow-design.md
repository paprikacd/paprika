# Fast CI and Deployment Flow Design

## Goal

Make pull-request feedback fast and make every automatic VKE deployment consume the exact
`linux/amd64` image produced from a validated `master` commit.

## Design

Use one canonical `CI` workflow. Independent Go test, Go lint, UI, generated-code, and Helm
chart jobs run in parallel. A publish job depends on every fast validation job and runs only for
pushes to `master`; it publishes `latest` and `sha-<commit>` images for `linux/amd64`.

The VKE workflow listens for a successful `CI` workflow run on `master`, checks out the triggering
commit, and deploys the matching `sha-<commit>` image. Manual deployment remains available for an
explicit image tag. Obsolete GKE and Cloud Run automatic triggers become manual-only. Full Kind
e2e runs nightly and on demand so it does not extend the pull-request critical path.

## Safety Properties

- A failed or incomplete fast validation job cannot publish an image.
- Automatic VKE deployment cannot use `latest` or a source checkout different from the image SHA.
- Production images are always built for `linux/amd64`.
- Only `master` is used as the active development branch in workflow triggers.
- Existing tag-based GoReleaser releases remain independent.

## Verification

A Go contract test reads the workflow files and pins the properties above. Local verification also
runs the Go race suite, UI test/lint/build, Helm lint/template, and workflow YAML parsing.
