# Connect-RPC API — Apply & Rollback

This page documents the Connect-RPC methods used by `paprika apply` and rollback workflows. The full service definition is in `proto/paprika/v1/api.proto`.

## `ApplyBundle`

Submit a rendered manifest bundle to create or update an Application, Stage, Release, and manifest snapshot.

### Request

```protobuf
message ApplyBundleRequest {
  string namespace = 1;          // Target namespace (required)
  string name = 2;               // Application name (required)
  bytes manifests = 3;           // YAML bundle
  repeated string skip_policies = 4;
  map<string, string> policy_overrides = 5;  // policy name -> "enforce" | "warn"
  bool dry_run = 6;
  string project = 7;            // AppProject name; defaults to "default"
}
```

### Response

```protobuf
message ApplyBundleResponse {
  Application application = 1;
  Release release = 2;
  repeated PolicyResult policy_results = 3;
  bool blocked = 4;
  string block_reason = 5;
}
```

### Behavior

1. The server ensures the target namespace exists.
2. It parses the bundle, defaults missing namespaces, and injects `app.paprika.io/managed-by` and `app.paprika.io/name` labels.
3. It resolves the `AppProject` (`default` if empty) and validates project boundaries when governance is enabled.
4. It evaluates matching `Policy` CRDs, honoring `skip_policies` and `policy_overrides`.
5. If any enforced policy fails, the response has `blocked: true`, `block_reason` is set, and no resources are created.
6. If `dry_run` is true, the response contains the rendered Application/Release shapes and policy results but no resources are persisted.
7. Otherwise, the server creates or updates the `Application`, creates a `Stage` named `{app}-default`, creates a unique `Release`, and stores the bundle in a snapshot `ConfigMap` named `{release}-manifests`.

### Policy result

```protobuf
message PolicyResult {
  string name = 1;
  string severity = 2;   // "critical" | "warning"
  string action = 3;     // "enforce" | "warn"
  bool passed = 4;
  string message = 5;
}
```

### Example curl-like request

```sh
curl -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  --data '{
    "namespace": "production",
    "name": "payments-api",
    "project": "payments",
    "manifests": "YXBpVmVy...",
    "skipPolicies": [],
    "policyOverrides": {"require-labels": "warn"},
    "dryRun": false
  }' \
  http://localhost:3000/paprika.v1.PaprikaService/ApplyBundle
```

### Example response

```json
{
  "application": {
    "name": "payments-api",
    "namespace": "production",
    "phase": "Promoting",
    "project": "payments"
  },
  "release": {
    "name": "payments-api-release-a1b2c3d4-1750000000",
    "namespace": "production",
    "phase": "Promoting",
    "target": "payments-api-default"
  },
  "policyResults": [
    {"name": "require-labels", "severity": "critical", "action": "enforce", "passed": true, "message": ""}
  ],
  "blocked": false
}
```

## `RollbackRelease`

Request that a release be rolled back to the previous viable snapshot.

### Request

```protobuf
message RollbackReleaseRequest {
  string namespace = 1;
  string name = 2;       // Release name
}
```

### Response

```protobuf
message RollbackReleaseResponse {
  Release release = 1;
}
```

### Behavior

The server fetches the named `Release`, sets the annotation `paprika.io/rollback-requested: "true"`, and ensures `spec.onFailure.action` is set to `rollback`. The release controller observes the annotation and applies the previous release's manifest snapshot. The response returns the updated `Release` with the new annotation.

### Example curl-like request

```sh
curl -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  --data '{
    "namespace": "production",
    "name": "payments-api-release-a1b2c3d4-1750000000"
  }' \
  http://localhost:3000/paprika.v1.PaprikaService/RollbackRelease
```

### Example response

```json
{
  "release": {
    "name": "payments-api-release-a1b2c3d4-1750000000",
    "namespace": "production",
    "phase": "Failed",
    "rolledBackTo": "payments-api-release-z9y8x7w6-1749900000"
  }
}
```
