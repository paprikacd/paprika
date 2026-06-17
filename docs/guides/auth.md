# Authentication

Paprika can secure the API server and dashboard with HTTP Basic authentication or OIDC bearer tokens. Authentication is disabled by default.

## Enabling Authentication

Set `--auth-enabled=true` on the operator or API server. When enabled, you must also configure at least one authenticator (Basic or OIDC) or set `--auth-allow-unauthenticated=true` to let anonymous requests through.

## Basic Auth

### Operator flags

| Flag | Description |
|------|-------------|
| `--auth-enabled` | Enable authentication |
| `--auth-basic-username` | Allowed username |
| `--auth-basic-password` | Plain-text password (development only) |
| `--auth-basic-password-hash` | SHA-256 hash of the password, hex-encoded (recommended) |
| `--auth-allow-unauthenticated` | Allow requests with no credentials to pass through |

### Example

```sh
PASSWORD_HASH=$(printf 'changeme' | shasum -a 256 | awk '{print $1}')

paprika \
  --auth-enabled \
  --auth-basic-username admin \
  --auth-basic-password-hash "$PASSWORD_HASH"
```

For quick local testing:

```sh
paprika \
  --auth-enabled \
  --auth-basic-username admin \
  --auth-basic-password changeme
```

### CLI usage with Basic auth

```sh
paprika config init --server http://localhost:3000 \
  --username admin \
  --password changeme

paprika apps list
```

The CLI sends the username and password via HTTP Basic authentication; the server hashes the password and compares it to the configured hash.

## OIDC

### Operator flags

| Flag | Description |
|------|-------------|
| `--auth-enabled` | Enable authentication |
| `--auth-oidc-issuer-url` | OIDC issuer URL, e.g. `https://accounts.google.com` |
| `--auth-oidc-client-id` | OIDC client ID |
| `--auth-oidc-client-secret` | OIDC client secret (if required by the provider) |

### Example

```sh
paprika \
  --auth-enabled \
  --auth-oidc-issuer-url https://accounts.google.com \
  --auth-oidc-client-id $OIDC_CLIENT_ID \
  --auth-oidc-client-secret $OIDC_CLIENT_SECRET
```

### CLI usage with a bearer token

```sh
export TOKEN=$(gcloud auth print-identity-token)

paprika apps list --token "$TOKEN"
```

Or store it in the config:

```sh
paprika config init --server http://localhost:3000 --token "$TOKEN"
paprika apps list
```

## Authorization

When authentication is enabled, the built-in authorizer classifies each RPC:

- `List*` and `Get*` RPCs are classified as **read** operations.
- `SyncApplication`, `ApproveGate`, `ResolveSource`, and `Render` are classified as **write** operations.

By default, the `AllowAllAuthorizer` grants full access to any authenticated principal. For finer-grained control, configure RBAC rules via the auth package's `RBACRules` field.

## Mixed Authentication

You can configure both Basic and OIDC authenticators at the same time. The server tries each authenticator in order until one succeeds. This is useful for bootstrapping (Basic) and production users (OIDC).

## Deployment Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: paprika-controller-manager
  namespace: paprika-system
spec:
  template:
    spec:
      containers:
        - name: manager
          args:
            - --auth-enabled
            - --auth-basic-username=admin
            - --auth-basic-password-hash=fd7b9c... # SHA-256 of your password
            - --auth-oidc-issuer-url=https://accounts.google.com
            - --auth-oidc-client-id=$(OIDC_CLIENT_ID)
            - --auth-oidc-client-secret=$(OIDC_CLIENT_SECRET)
```

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `Unauthenticated` errors | Missing or malformed `Authorization` header, or password hash mismatch. |
| `PermissionDenied` errors | Auth succeeded but the action is not allowed by the authorizer. |
| OIDC login fails | Issuer URL unreachable, client ID mismatch, or expired token. |

For programmatic access details, see the [API reference](../api.md). For CLI auth examples, see the [CLI guide](../cli.md).
