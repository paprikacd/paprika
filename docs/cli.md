# `paprika apply`

Apply raw Kubernetes manifests through Paprika so they are versioned, governed by policy, and tracked in the dashboard.

## Overview

`paprika apply` is a `kubectl apply`-like command that submits a local manifest bundle to the Paprika API server. The server creates an `Application`, a `Stage`, a versioned `Release`, and a snapshot `ConfigMap`. The operator then applies the snapshot to the cluster, evaluates health, and reports progress back to the CLI.

The command works in three phases:

1. **Render** — Load one or more YAML files or directories and concatenate them into a single manifest bundle.
2. **Submit** — Send the bundle to the `ApplyBundle` Connect-RPC method.
3. **Watch** — Poll `GetApplication` and render an interactive TUI (or plain output in CI) until the rollout reaches a terminal phase.

## Flags

| Flag | Shorthand | Description | Default |
|------|-----------|-------------|---------|
| `--file` | `-f` | File or directory to apply. Repeatable. | *required* |
| `--namespace` | `-n` | Target namespace for resources. | Current kubeconfig context namespace, or `default` |
| `--name` | | Application name. | First resource name, or directory/file base name |
| `--project` | | `AppProject` that governs the application. | `default` |
| `--skip-policy` | | Skip a named `Policy` for this apply. Repeatable. | |
| `--policy-override` | | Override a policy action (`name=enforce` or `name=warn`). Repeatable. | |
| `--dry-run` | | Render and evaluate policies without creating resources. | `false` |
| `--wait` | | Block and watch until the rollout is terminal. | `true` |
| `--timeout` | | Watch timeout. | `5m` |
| `--server` | | Paprika API server URL. | `$PAPRIKA_SERVER`, or `http://localhost:3000` |

## Workflow

### Namespace and naming

If a manifest omits `metadata.namespace`, Paprika defaults it to the value of `-n/--namespace`. Explicit namespaces are preserved. The application name is derived from the first named resource in the bundle; use `--name` to pin it.

### Policy evaluation

Before any cluster mutation, Paprika evaluates cluster-scoped `Policy` CRDs against the bundle. Evaluation order:

1. `--skip-policy` removes named policies from the run.
2. `--policy-override` changes a policy's action for this apply (`enforce` or `warn`).
3. Policies with `action: enforce` that fail block the apply. No resources are created.
4. Policies with `action: warn` that fail emit a warning but do not block.

### Dry run

With `--dry-run`, the server renders and evaluates policies but returns before creating `Application`, `Stage`, `Release`, or `ConfigMap` resources. Use it to preview policy results in CI or local workflows.

### Watching

By default the CLI opens a Bubble Tea TUI showing phase, resource health, and policy results. In non-TTY environments it falls back to plain polling output. Set `--wait=false` to submit and return immediately.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Apply succeeded and reached `Healthy`. |
| `1` | Apply was blocked by policy, failed, degraded, timed out, or the RPC failed. |

## Examples

### Basic apply

```sh
paprika apply -f ./manifests \
  -n production \
  --name payments-api \
  --project payments
```

The command loads all `.yaml` and `.yml` files in `./manifests`, creates an Application named `payments-api` in the `production` namespace, and watches the rollout.

### Dry-run with policy override

```sh
paprika apply -f deployment.yaml \
  -n staging \
  --name checkout \
  --project payments \
  --dry-run \
  --policy-override require-labels=warn \
  --skip-policy no-latest-tag
```

This renders the bundle, evaluates policies, downgrades `require-labels` to a warning, skips `no-latest-tag`, and exits without mutating the cluster.

## Reading policy results

Successful applies print a summary table:

```
Policy results:
  require-labels                 PASS  severity=critical action=enforce
  no-latest-tag                  FAIL  severity=critical action=enforce  (Deployment/nginx uses image 'nginx:latest')
```

If the apply is blocked, the CLI exits with the blocking reason:

```
Policy results:
  no-latest-tag                  FAIL  severity=critical action=enforce  (Deployment/nginx uses image 'nginx:latest')

apply blocked: policy no-latest-tag failed
```

A warning-only result looks like this:

```
Policy results:
  require-labels                 FAIL  severity=warning action=warn  (missing label 'team')
```

The apply proceeds and the warning is stored in the `Release` status.
