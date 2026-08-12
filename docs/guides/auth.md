# Authentication and authorization

Paprika can protect the API server and dashboard with HTTP Basic credentials,
OIDC bearer tokens, and Paprika-signed bearer tokens. Authentication and
authorization are disabled by default.

## Enabling authentication

Set `--auth-enabled=true` on an operator or API-server process and configure at
least one authenticator:

- Basic authentication with `--auth-basic-username` and a bcrypt
  `--auth-basic-password-hash`.
- OIDC with `--auth-oidc-issuer-url` and `--auth-oidc-client-id`.
- A Paprika token-signing key through `PAPRIKA_AUTH_TOKEN_SECRET`; this also
  enables verification of tokens minted by the Basic browser-login endpoint.

Authentication success does not grant authorization by itself. See
[Authorization](#authorization) before enabling auth in production.

## HTTP Basic authentication

### Operator flags

| Flag | Description |
|------|-------------|
| `--auth-enabled` | Enable authentication and authorization. |
| `--auth-basic-username` | Allowed username. |
| `--auth-basic-password` | Plain-text password; deprecated and intended only for local development. |
| `--auth-basic-password-hash` | Bcrypt password hash (recommended). |

Prefer the Helm values `auth.basic.username` and
`auth.basic.passwordHash`. Do not commit the clear-text password.

```yaml
auth:
  enabled: true
  basic:
    enabled: true
    username: admin
    passwordHash: <bcrypt-hash>
```

The CLI can store Basic credentials for use on RPCs:

```sh
paprika config init \
  --server https://paprika.example.com \
  --username admin \
  --password "${PAPRIKA_BASIC_PASSWORD}"

paprika apps list
```

The config file contains the supplied password and is written with mode
`0600`. Use a dedicated, least-privilege account and protect the workstation.

## OIDC

### Provider redirect URIs

Register every callback used by the deployment with the OIDC provider. The CLI
callback is fixed and must be registered exactly as follows:

```text
http://127.0.0.1:17632/callback
```

Do not substitute `localhost`, change the port, add a trailing slash, or use
HTTPS. The loopback listener is bound only for the duration of `paprika login`.

If the dashboard also offers browser login, register its HTTPS callback (for
example `https://paprika.example.com/auth/callback`) and configure that value
as `auth.oidc.redirectURL`. Paprika permits either the configured dashboard
callback or the fixed CLI callback during the code exchange.

### Referencing the client secret from Helm

For a confidential OIDC client, create a Kubernetes Secret in the Paprika
release namespace. The key name is configurable; this example uses
`client-secret`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: paprika-oidc
  namespace: paprika-system
type: Opaque
stringData:
  client-secret: <oidc-client-secret>
```

Reference the Secret from the chart:

```yaml
auth:
  enabled: true
  oidc:
    enabled: true
    issuerURL: https://issuer.example.com
    clientID: paprika
    existingSecretName: paprika-oidc
    existingSecretKey: client-secret
    redirectURL: https://paprika.example.com/auth/callback
```

`existingSecretName` and `existingSecretKey` must either both be set or both be
empty. Leave both empty for an OIDC public client. For a confidential client,
the chart reads the key through a Secret-backed environment variable and does
not render the client secret into container arguments.

### Breaking migration from inline `clientSecret`

Inline `auth.oidc.clientSecret` is no longer supported. Any nonempty value now
causes Helm rendering to fail, even when auth or an authenticated workload is
disabled. This fail-closed behavior prevents an old values file from silently
putting a secret into rendered values or process arguments.

Migrate before upgrading:

1. Create or update the Kubernetes Secret in the Helm release namespace.
2. Remove `auth.oidc.clientSecret` from every values file and `--set` argument.
3. Set both `auth.oidc.existingSecretName` and
   `auth.oidc.existingSecretKey`.
4. Render or lint the chart and confirm no
   `--auth-oidc-client-secret` argument is present.

When running the binary without Helm, pass the client secret through
`PAPRIKA_OIDC_CLIENT_SECRET`; avoid the command-line secret flag because
process arguments may be visible to other users on the host.

### CLI browser login

Configure the Paprika server and start the flow:

```sh
paprika config init --server https://paprika.example.com
paprika login
```

Or override the stored server for this login:

```sh
paprika --server https://paprika.example.com login
```

Paprika opens the provider authorization page with PKCE, accepts a
state-matched callback on the fixed loopback URI, exchanges the code through
the Paprika API, and stores the validated ID token and its expiry in
`~/.paprika/config.yaml`. The PKCE verifier remains in memory. If the browser
cannot be launched, the CLI prints the provider URL for manual use.

CLI sessions are not refreshed automatically. After the ID token expires, the
API returns `Unauthenticated`; run `paprika login` again. The `paprika status`
command turns this response into explicit relogin guidance.

For non-browser automation, a bearer token can still be supplied explicitly:

```sh
paprika --token "${PAPRIKA_TOKEN}" apps list
```

## Authorization

Paprika classifies `List*` and `Get*` RPCs as `read`; other RPCs are generally
`write`. `write` permission implies `read`, and `admin` implies every action.
Resources include `applications`, `pipelines`, `releases`, `stages`,
`templates`, `artifacts`, and `rollouts`.

Global Helm RBAC rules match authenticated subjects, actions, resources,
namespaces, and optional projects:

```yaml
auth:
  enabled: true
  rbac:
    - subjects: ["group:operators"]
      actions: ["read"]
      resources: ["applications", "releases"]
      namespaces: ["production"]
      projects: ["payments"]
```

Subjects may be exact principal subjects, `group:<claim-value>`, or `*` for any
authenticated principal. Wildcards are also accepted for resources,
namespaces, and projects. An empty project list means that the rule is not
restricted by project.

Paprika also evaluates roles on `AppProject` objects when a Kubernetes reader
is available. When global RBAC and AppProject authorization are both active,
their results are intersected: every authorizer must allow the operation. If
no authorizer can be constructed, Paprika fails closed with a deny-all
authorizer. There is no implicit allow-all mode when authentication is enabled.

Fleet queries, including `GetSystemStatus`, defer project-set authorization to
the handler. The handler obtains the real project candidates from one snapshot,
filters them by `read` access to `applications`, and only then computes names,
counts, health/sync buckets, and attention rows. Unauthorized applications do
not influence aggregates. A principal with an empty authorized project set
receives a successful empty result rather than learning that hidden projects
exist.

## Mixed authentication

Basic, OIDC, and Paprika-signed bearer authenticators can be enabled together.
Paprika tries the configured authenticators until one succeeds, then applies
the same authorization policy to the resulting principal.

## Troubleshooting

| Symptom | Cause or next action |
|---------|----------------------|
| `Unauthenticated` | Credentials are missing, malformed, invalid, or expired. For a CLI OIDC session, rerun `paprika login`. |
| `PermissionDenied` | Authentication succeeded, but RBAC or the AppProject role does not allow the action. |
| CLI callback URI unavailable | Another process owns `127.0.0.1:17632`; stop it and retry. |
| Provider rejects the CLI callback | Register exactly `http://127.0.0.1:17632/callback`. |
| Helm rejects `auth.oidc.clientSecret` | Create a Kubernetes Secret and use `existingSecretName` plus `existingSecretKey`. |
| Helm rejects a partial Secret reference | Set both Secret reference fields, or clear both for a public client. |

For direct Connect requests, see the [API reference](../api.md). For command
output and flags, see the [CLI guide](../cli.md).
