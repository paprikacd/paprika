# Contributing to paprika

Thank you for considering a contribution. Bug reports, usage questions, documentation fixes, tests, design feedback, and code changes are all useful.

## Before You Start

- Search [open issues](https://github.com/paprikacd/paprika/issues) before filing a new one.
- Use the [question, bug, or feature template](https://github.com/paprikacd/paprika/issues/new/choose) so maintainers have the context they need. For a larger feature, describe the problem in an issue before writing code.
- For a first contribution, improve an example or guide, reproduce a reported bug, or add a focused test. Say in the issue that you plan to work on it to avoid duplicate effort.
- Read the [codebase overview](README.md#architecture) and the [getting started guide](docs/getting-started.md).

## Development Setup

### Prerequisites

- Go 1.26+
- Docker
- kubectl
- Access to a Kubernetes cluster (v1.29+) or [Kind](https://kind.sigs.k8s.io/) for integration testing
- [golangci-lint](https://golangci-lint.run/) v2.x (`make lint` installs it automatically)

### Local Development

```sh
# Clone your fork
git clone https://github.com/YOUR_USERNAME/paprika.git
cd paprika

# Install dependencies
go mod download

# Run the focused Go tests required for controller work
go test ./internal/engine ./internal/controller/pipelines -count=1

# Run the linter before a code PR
make lint

# Check the target before running a controller against a cluster
kubectl config current-context
ENABLE_WEBHOOKS=false make run
```

### Pre-commit Hooks

This repo provides a local pre-commit hook that runs `golangci-lint` on staged
`.go` files. Install it once with:

```sh
git config core.hooksPath .githooks
```

### E2E Testing

E2E tests create an isolated Kind cluster. They build images and take longer than the focused tests:

```sh
make test-e2e
```

## Making Changes

### Code Style

- Follow [Go standard formatting](https://go.dev/doc/effective_go) (`go fmt ./...`)
- Run `make lint` before committing — all linters must pass
- Use structured logging via `log.FromContext(ctx)` (see [Kubernetes logging conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-instrumentation/logging.md))
- All exported types and functions must have Go doc comments
- New features must include tests (unit tests for logic, envtest for controllers)

### Branching

- Create a branch from `master` for your work: `git switch -c feature/my-feature`
- Keep branches focused — one feature or fix per branch
- Update your branch from `master` before opening a PR

### Commit Messages

```
<area>: <short description>

<optional longer explanation>
```

Examples:
```
engine: add release-name param to HelmSDKRenderer
traffic/istio: handle missing VirtualService gracefully
controller/application: skip pipeline creation when no build steps
```

### Pull Request Process

1. Update documentation if your change affects the API or user-facing behavior
2. Add or update tests as appropriate
3. Ensure all CI checks pass (lint, test, e2e)
4. Request review from a maintainer
5. Address review feedback — keep conversations moving

### Code Review Guidelines

- Every PR requires at least one review from a maintainer
- Reviewers should verify correctness, test coverage, and adherence to project conventions
- All PRs must pass CI before merging
- Squash commits on merge to keep history clean

## Project Conventions

- **Multi-group layout**: API types in `api/<group>/<version>/`, controllers in `internal/controller/<group>/`
- **Auto-generated files**: Do not edit `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `**/zz_generated.*.go` — regenerate with `make manifests generate`
- **Kubebuilder markers**: Never remove `// +kubebuilder:scaffold:*` comments
- **Mocking**: Use `go.uber.org/mock` with `//go:generate mockgen` directives at package boundaries
- **Interface boundaries**: Use `*Impl` suffix for concrete types, `interfaces.go` files per package
- **Testing**: Ginkgo + Gomega for envtest controllers, standard `testing` package for unit tests
- **Finalizer pattern**: Use `controllerutil.AddFinalizer`/`RemoveFinalizer` with deferred cleanup
- **Webhooks**: Validate + defaulting per CRD; cert-manager for certificate management
- **HA patterns**: Rate limiting at `QPS=50, Burst=100`; leader election for single-active replica

## Getting Help

- Ask a usage question with the [question template](https://github.com/paprikacd/paprika/issues/new?template=question.md). Include the Paprika version, Kubernetes version, deployment method, and what you tried.
- Report a bug with the [bug template](https://github.com/paprikacd/paprika/issues/new?template=bug_report.md), including a small reproduction and relevant redacted logs.
- Send suspected vulnerabilities through the private route in [SECURITY.md](SECURITY.md), not a public issue.

## Code of Conduct

All contributors must abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
