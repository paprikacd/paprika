# Paprika CLI

## Install

Install the latest published CLI release on Darwin (macOS) or Linux, for
`amd64` or `arm64`:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh
```

The installer downloads only from the canonical GitHub release, verifies the
archive against the release checksums, and then installs the binary. Audit the
[latest published checksums](https://github.com/paprikacd/paprika/releases/latest/download/checksums.txt).
A pinned release uses this exact URL pattern:

`https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt`

Pin a release by passing `PAPRIKA_VERSION` to the installer shell:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_VERSION=vX.Y.Z sh
```

The installer never invokes `sudo`. It selects a writable directory already on
your `PATH` when possible and otherwise falls back to `~/.local/bin`, printing
the exact `PATH` export needed. To choose the destination yourself, pass
`PAPRIKA_INSTALL_DIR`:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | PAPRIKA_INSTALL_DIR="$HOME/.local/bin" sh
```

Homebrew is not yet supported. To build from source instead, clone
<https://github.com/paprikacd/paprika> and run:

```sh
go build -o ./bin/paprika ./cmd/paprika
```

Authenticate with the hosted service, then request the current fleet snapshot:

```sh
paprika login --server https://paprika.benebsworth.com
paprika status
```

The CLI reads `~/.paprika/config.yaml` by default. Global flags such as
`--server`, `--namespace`, `--token`, and `--config` override the corresponding
stored values for the current command.

## `paprika login`

`paprika login` performs an OIDC authorization-code flow with PKCE in the
system browser. Before using it, register this exact redirect URI with the OIDC
provider:

```text
http://127.0.0.1:17632/callback
```

The scheme, numeric loopback address, port, path, and absence of a trailing
slash are all significant. This fixed callback is for the CLI; keep the HTTPS
dashboard callback configured by `auth.oidc.redirectURL` registered as well if
browser login to the dashboard is enabled.

Configure a server once, then log in:

```sh
paprika config init --server https://paprika.example.com
paprika login
```

Or select and persist a different server for this login:

```sh
paprika --server https://paprika.example.com login
```

`--server` overrides the server in the config file. Non-loopback servers must
use HTTPS; HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`.

The command binds `127.0.0.1:17632`, asks the Paprika API to start a login,
opens the returned provider URL, validates the callback state, and exchanges
the authorization code using the in-memory PKCE verifier. If the browser
cannot be opened, the CLI prints the validated URL so it can be opened
manually. The callback waits for up to five minutes. If the port is already in
use, the command stops before starting the provider flow and reports that the
callback URI is unavailable.

After the API validates the ID token, the CLI stores the token and its `exp`
time in the selected config file. The file is written atomically with mode
`0600`. Paprika does not currently refresh CLI OIDC sessions. When the token
expires, an authenticated RPC returns `Unauthenticated`; `paprika status`
reports `authentication required; run 'paprika login'`. Run `paprika login`
again to replace the expired token.

## `paprika status`

`paprika status` shows a single, authorization-filtered snapshot of the
applications the current principal may read:

```sh
paprika status
```

The default table contains total application and attention counts, selected
health counts, the out-of-sync count, and the highest-priority applications
requiring attention. An application requires attention when it has an
unhealthy or unknown state, sync drift, blocked gates, an active high-impact
change, or an unhealthy referenced connection. The server ranks attention
rows deterministically by operational impact.

The configured namespace is used when present. Override it for one request
with the global flag, or leave it unset to query every authorized namespace:

```sh
paprika --namespace payments status
```

The CLI requests at most 20 attention rows by default. Explicit limits from 1
through 100 are accepted. `0` asks the server to use its default, which is also
20; values above 100 are rejected before the RPC is made.

```sh
paprika status --attention-limit 50
paprika status --attention-limit 0
```

Table output is the default. JSON and YAML use the protobuf response shape and
include `indexGeneration`, all health and sync buckets, `attentionTotal`, and
`hasMoreAttention` in addition to the returned attention rows:

```sh
paprika status -o json
paprika status -o yaml --attention-limit 100
```

Counts and names are computed only after the server has restricted the
snapshot to projects on which the principal has `read` access to
`applications`. An unauthorized application cannot affect totals, buckets, or
attention rows. An authenticated principal with no authorized projects gets a
successful zero-valued view.

For the equivalent Connect JSON request, see the [API reference](api.md#getsystemstatus).

## `paprika apply`

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
