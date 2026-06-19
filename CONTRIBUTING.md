# Contributing to paprika

Thank you for considering contributing to paprika! We welcome contributions of all kinds — bug fixes, features, documentation, tests, and design feedback.

## Before You Start

- Check [open issues](https://github.com/benebsworth/paprika/issues) for existing discussions
- For new features, open an issue first to discuss the design before writing code
- Review [ARCHITECTURE.md](#) and the [codebase overview](README.md#architecture) to understand the project structure

## Development Setup

### Prerequisites

- Go 1.26+
- Docker
- kubectl
- Access to a Kubernetes cluster (v1.29+) or [Kind](https://kind.sigs.k8s.io/) for local testing
- [golangci-lint](https://golangci-lint.run/) v2.x (`make lint` installs it automatically)

### Local Development

```sh
# Clone your fork
git clone https://github.com/YOUR_USERNAME/paprika.git
cd paprika

# Install dependencies
go mod download

# Run unit tests
make test

# Run linter
make lint

# Run locally against your current kubeconfig context
ENABLE_WEBHOOKS=false make run
```

### Pre-commit Hooks

This repo provides a local pre-commit hook that runs `golangci-lint` on staged
`.go` files. Install it once with:

```sh
git config core.hooksPath .githooks
```

### E2E Testing

E2E tests create an isolated Kind cluster:

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

- Create a branch from `main` for your work: `git checkout -b feature/my-feature`
- Keep branches focused — one feature or fix per branch
- Rebase onto `main` before opening a PR

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

- Open a [discussion](https://github.com/benebsworth/paprika/discussions) or issue
- Tag `@benebsworth` in issues or PRs

## Code of Conduct

All contributors must abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
