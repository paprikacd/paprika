# Pipeline Step Artifacts

## Status

Draft — pending spec review.

## Context

Paprika pipelines can declare output artifacts via `PipelineOutput` (name + path) at the
pipeline level. The pipeline controller already creates `Artifact` resources from these
outputs (`internal/controller/pipelines/pipeline_controller.go:215`). The Artifact
controller verifies OCI references and records digest mismatches. However, artifacts are
not yet exposed through the public API or surfaced in the dashboard step detail panel.

## Goal

Let users see what a pipeline step produced and download the resulting artifacts from
the pipeline DAG detail page.

## Non-goals

- Artifact retention / lifecycle policies.
- Artifact content browsing beyond downloading the whole object.
- Generic artifact registry (we only support OCI and ConfigMap outputs).
- Long-term artifact history; only the current pipeline run's artifacts are shown.
- Pagination for `ListArtifacts`.

## Proposed changes

### 1. CRD data model

#### `PipelineStep.Outputs`

Add an `Outputs []PipelineOutput` field to `PipelineStep` in
`api/pipelines/v1alpha1/pipeline_types.go`:

```go
type PipelineStep struct {
    Name    string   `json:"name"`
    Depends []string `json:"depends,omitempty"`
    Image   string   `json:"image"`
    Script  string   `json:"script"`
    // +optional
    Timeout int `json:"timeout,omitempty"`
    // +optional
    Retry int `json:"retry,omitempty"`
    // +optional
    Outputs []PipelineOutput `json:"outputs,omitempty"`
}
```

#### `PipelineOutput.Step`

Add an optional `Step string` field to `PipelineOutput` so existing pipeline-level
`Spec.Artifacts` can declare a producing step:

```go
type PipelineOutput struct {
    Name string `json:"name"`
    Path string `json:"path"`
    // +optional
    Step string `json:"step,omitempty"`
}
```

Pipeline-level artifacts without `Step` are treated as produced by the pipeline as a
whole and surfaced in a "Pipeline Artifacts" section on the detail page, not inside a
step panel.

#### `ArtifactProvenance.Step`

Add a `Step string` field to `ArtifactProvenance` in
`api/pipelines/v1alpha1/artifact_types.go`:

```go
type ArtifactProvenance struct {
    Pipeline string `json:"pipeline,omitempty"`
    Build    string `json:"build,omitempty"`
    // +optional
    Step string `json:"step,omitempty"`
}
```

`Build` continues to hold the execution/build identifier. `Step` records the producing
step name explicitly.

#### `PipelineStatus.ArtifactRefs`

Add a new CRD-only type in `api/pipelines/v1alpha1/pipeline_types.go`:

```go
// PipelineArtifactPhase represents the verification phase of a pipeline artifact.
// +kubebuilder:validation:Enum=Pending;Ready;Failed
type PipelineArtifactPhase string

const (
    PipelineArtifactPhasePending PipelineArtifactPhase = "Pending"
    PipelineArtifactPhaseReady   PipelineArtifactPhase = "Ready"
    PipelineArtifactPhaseFailed  PipelineArtifactPhase = "Failed"
)

// PipelineArtifactRef records an artifact produced by a pipeline run.
type PipelineArtifactRef struct {
    Name              string                `json:"name"`
    Kind              string                `json:"kind"`              // "oci" or "configmap"
    Reference         string                `json:"reference,omitempty"`
    ResolvedReference string                `json:"resolvedReference,omitempty"`
    Digest            string                `json:"digest,omitempty"`
    Phase             PipelineArtifactPhase `json:"phase,omitempty"`
    ProducingStep     string                `json:"producingStep,omitempty"`
    CreatedAt         int64                 `json:"createdAt,omitempty"`
}
```

Add `ArtifactRefs []PipelineArtifactRef` to `PipelineStatus`. This type is
independent from the protobuf `ArtifactRef`; the API server maps between them.

The pipeline controller populates `Status.ArtifactRefs` by upserting entries keyed by
the tuple `(ProducingStep, Name)` to remain idempotent across reconcile retries and to
prevent collisions when two steps declare outputs with the same name.

#### `Artifact` CRD

The existing `ArtifactStatus` has `ObservedGeneration`, `Verified`, `ResolvedDigest`,
and `Conditions`; no new status fields are added. The `ArtifactSpec.Type` enum will be
updated from `oci` to `oci;configmap`.

### 2. Reference format

All artifact references use a URL-like scheme. The pipeline controller derives
`ArtifactSpec.Type` and `ArtifactSpec.Reference` from `PipelineOutput.Path`:

| `PipelineOutput.Path` prefix | `ArtifactSpec.Type` | `ArtifactSpec.Reference` example |
|------------------------------|---------------------|----------------------------------|
| `oci://registry.io/repo:tag` | `oci` | `registry.io/repo:tag` (scheme stripped) |
| `configmap://my-cm/my-key` | `configmap` | `my-cm/my-key` (scheme stripped) |
| `configmap://my-cm` | `configmap` | `my-cm` (no key) |

The Artifact controller parses `ArtifactSpec.Reference` as:

- `oci`: the value is passed directly to the OCI verifier as an unqualified reference.
- `configmap`: `configmap/<configmap-name>[/<key>]`, where `<key>` is optional.

### 3. Artifact controller

Harden `internal/controller/pipelines/artifact_controller.go`:

- For `oci` artifacts, keep existing OCI verification. Populate `Status.ResolvedDigest`
  and set a `Ready` condition with `Reason` `Verified` or `VerificationFailed`.
- For `configmap` artifacts, parse `Spec.Reference` as `<configmap-name>[/<key>]`. Verify
  the ConfigMap exists and contains the requested key. Set `Status.Verified` to `true`
  and a `Ready` condition `Status=True`, `Reason=Verified` when found.
- Set `Status.ObservedGeneration` to `metadata.generation`.
- The Artifact controller does NOT set owner references or copy labels; it only reads
  the Artifact spec and updates status. This avoids races with the pipeline controller.

Add RBAC markers to the Artifact controller:

```go
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list
// +kubebuilder:rbac:groups="",resources=configmaps/status,verbs=get
```

#### Verification failure modes

| Kind | Failure | Phase | Ready Condition | Message |
|------|---------|-------|-----------------|---------|
| configmap | ConfigMap not found | Failed | False, Reason=ConfigMapNotFound | `configmap <name> not found` |
| configmap | Key not found | Failed | False, Reason=KeyNotFound | `key <key> not found in configmap <name>` |
| configmap | Multiple keys and none specified | Failed | False, Reason=AmbiguousKeys | `configmap <name> has multiple keys; specify a key in reference` |
| configmap | Verified | Ready | True, Reason=Verified | `key <key> verified` |
| oci | Reference invalid | Failed | False, Reason=InvalidReference | depends on parser error |
| oci | Digest mismatch | Failed | False, Reason=DigestMismatch | `resolved digest ... does not match spec digest ...` |
| oci | Verified | Ready | True, Reason=Verified | `resolved digest ...` |

### 4. Pipeline controller

#### Artifact name sanitization

The artifact name is `{pipeline}-{step}-{outputName}` for step outputs, or
`{pipeline}-{outputName}` for pipeline-level outputs. Each segment is sanitized:

1. Convert to lowercase.
2. Replace any run of characters not in `[a-z0-9]` with a single `-`.
3. Trim leading and trailing `-`.
4. Ensure each segment is non-empty; if a segment becomes empty, replace it with `x`.
5. Concatenate with `-` separators.
6. If the total length exceeds 63 characters, truncate the longest segment first
   (pipeline, then step, then output), ensuring the final name starts and ends with
   `[a-z0-9]` and is at most 63 characters.
7. If truncation produces a leading or trailing `-`, strip it; if this makes the name
   empty, use `artifact`.

Stable identity for upsert and cleanup is provided by labels, not by the computed name:

- `paprika.io/pipeline: <pipelineName>`
- `paprika.io/step: <stepName>` (omitted for pipeline-level artifacts)
- `paprika.io/output: <outputName>`

#### Create/update flow

Update `createArtifact` to:

- Compute the artifact name as described above.
- Build `Artifact.Spec` from the `PipelineOutput`, setting:
  - `Type` from the path prefix.
  - `Reference` from `PipelineOutput.Path` with the scheme stripped.
  - `Digest` from any digest embedded in the OCI reference (e.g. `oci://repo@sha256:abc...`).
  - `Provenance.Pipeline = pipeline.Name`
  - `Provenance.Build = pipeline.Status.LastExecutionID`
  - `Provenance.Step = PipelineOutput.Step` for pipeline-level outputs, or the step name
    for step outputs.
- Label the artifact with `paprika.io/pipeline`, `paprika.io/step` (if applicable), and
  `paprika.io/output`.
- Annotate the artifact with `paprika.io/producing-step: <stepName>` (or omitted for
  pipeline-level artifacts).
- Set the owner reference to the Pipeline (controller=true, blockOwnerDeletion=false).
- Copy project labels from the Pipeline to the Artifact.
- Create or update the `Artifact` using the upsert pattern.
- Upsert `Pipeline.Status.ArtifactRefs` with initial values:
  - `Name`: artifact name
  - `Kind`: `ArtifactSpec.Type`
  - `Reference`: original `PipelineOutput.Path`
  - `ResolvedReference`: empty
  - `Digest`: empty
  - `Phase`: `Pending`
  - `ProducingStep`: step name or empty for pipeline-level artifacts
  - `CreatedAt`: current Unix time

The pipeline controller later updates these entries when it reconciles owned Artifacts
and reads their `Status`.

#### Stale artifact cleanup

After creating/updating all expected artifacts, the pipeline controller lists
Artifacts owned by the Pipeline and deletes any whose labels do not match an expected
output. An expected output is identified by labels:

- `paprika.io/pipeline == pipeline.Name`
- `paprika.io/output == outputName`
- `paprika.io/step == stepName` for step outputs; pipeline-level artifacts omit the step
  label, so cleanup treats an artifact without the label as a pipeline-level artifact
  and matches it against pipeline-level `Spec.Artifacts`.

It also removes orphaned entries from `Pipeline.Status.ArtifactRefs`.

#### Watch and SSE

Add a watch on owned `Artifact` resources so the pipeline controller reconciles when an
artifact's `Status.Conditions` change. Map owned artifacts back to the pipeline via
`handler.EnqueueRequestForOwner`.

Publish an SSE event when an owned artifact's Ready condition transitions. Detection:
the pipeline controller reads the owned Artifact during reconcile, compares the current
`Ready` condition `Status` to the corresponding `PipelineArtifactRef.Phase`, and emits an
event only when they differ.

Event type: `pipeline-artifact`

Payload shape:

```json
{
  "pipeline": { "namespace": "...", "name": "..." },
  "step": "stepName",
  "artifact": {
    "name": "artifact-name",
    "path": "output/path",
    "kind": "oci",
    "reference": "registry.io/repo:tag",
    "resolved_reference": "oci://registry.io/repo@sha256:abc...",
    "digest": "sha256:abc...",
    "phase": "Ready",
    "producing_step": "stepName",
    "created_at": 1782000000,
    "failed_reason": ""
  },
  "phase": "Ready"
}
```

For pipeline-level artifacts, `step` and `producing_step` are empty strings.

### 5. API / protobuf

Extend `proto/paprika/v1/api.proto`.

`ArtifactRef` currently has:

```protobuf
message ArtifactRef {
  string name = 1;
  string path = 2;
}
```

Extend it by adding fields `3`–`10`:

```protobuf
message ArtifactRef {
  string name = 1;
  string path = 2;                 // original PipelineOutput.Path; retained for backward compatibility
  string kind = 3;                 // "oci" | "configmap"
  string reference = 4;            // original user reference from Spec.Reference
  string resolved_reference = 5;   // e.g. oci://... or configmap://ns/name/key
  string digest = 6;               // empty for configmap
  string phase = 7;                // Pending | Ready | Failed
  string producing_step = 8;
  int64 created_at = 9;
  string failed_reason = 10;       // Ready condition Reason when phase == Failed
}
```

Add RPCs to `PaprikaService`:

```protobuf
rpc GetArtifact(GetArtifactRequest) returns (GetArtifactResponse);
rpc ListArtifacts(ListArtifactsRequest) returns (ListArtifactsResponse);

message GetArtifactRequest {
  string namespace = 1;
  string name = 2;
}

message GetArtifactResponse {
  ArtifactRef artifact = 1;
  string download_url = 2;
}

message ListArtifactsRequest {
  string namespace = 1;
  optional string pipeline_name = 2;
}

message ListArtifactsResponse {
  repeated ArtifactRef artifacts = 1;
}
```

#### CRD → protobuf mapping

| `PipelineArtifactRef` | `ArtifactRef` field | Source when mapping |
|-----------------------|---------------------|---------------------|
| `Name` | `name` | directly |
| `Reference` (original path) | `path` | directly |
| `Kind` | `kind` | directly |
| `Reference` | `reference` | directly |
| `ResolvedReference` | `resolved_reference` | from Artifact status / spec |
| `Digest` | `digest` | from Artifact status `ResolvedDigest` |
| `Phase` | `phase` | directly |
| `ProducingStep` | `producing_step` | directly |
| `CreatedAt` | `created_at` | directly |
| n/a | `failed_reason` | `ArtifactStatus.Conditions["Ready"].Reason` when phase == Failed |

Download semantics:

- **ConfigMap artifacts**: `download_url` is a base64 data URI containing a JSON object
  with the requested key/value pair, where the object key is the ConfigMap key and the
  value is the string content, e.g.
  `data:application/json;base64,eyJteS1rZXkiOiJteS12YWx1ZSJ9`.
  - If the key is in `binaryData`, the value is base64-decoded and then re-encoded as a
    JSON string (UTF-8). If the bytes are not valid UTF-8, they are base64-encoded and
    the JSON value becomes a base64 string.
  - The 256 KiB limit is measured against the raw ConfigMap value bytes. If exceeded,
    `download_url` is empty, `phase` remains `Ready`, and the UI shows
    "too large to download".
- **OCI artifacts**: `download_url` is always empty. The UI shows the resolved reference
  and a "Copy pull command" action.

`ListArtifacts` filters by owner reference when `pipeline_name` is provided: it lists
Artifacts in the namespace and keeps those whose owner reference has
`APIVersion=pipelines.paprika.io/v1alpha1`, `Kind=Pipeline`, and `Name=pipeline_name`.

### 6. API server handlers

Add `GetArtifact` and `ListArtifacts` to `internal/api/server.go`:

- `ListArtifacts`: list `pipelinesv1alpha1.Artifact` resources in the requested
  namespace, optionally filter by owner reference, apply project authorization via
  `authorizeProjectFromLabels`, and convert each to the protobuf `ArtifactRef`.
  - If an Artifact lacks project labels, it is skipped (not returned) to avoid leaking
    cross-project data.
- `GetArtifact`: fetch a single `Artifact`. If it lacks project labels, return
  `PermissionDenied`. Otherwise authorize via project labels and return the protobuf
  `ArtifactRef` and `download_url` per the semantics above.

Add RBAC markers for `artifacts` (get, list, watch).

### 7. UI

Update `ui/src/components/dashboard/step-detail-panel.tsx`:

- `PipelineArtifactRef` values reach the UI via the existing `GetPipeline` response
  because the `Pipeline` proto carries `repeated ArtifactRef artifacts`.
- If the selected step has associated artifacts, render an "Artifacts" subsection.
- Each artifact card shows: name, kind badge, phase badge, truncated digest (if any),
  created at, and an action:
    - ConfigMap Ready + under size limit: download link.
    - ConfigMap too large or OCI: "Copy reference" button.
    - Failed: show a tooltip with `failed_reason` and the resolved reference.
- Use a small `useStepArtifacts(stepName)` hook that filters the pipeline's
  `ArtifactRefs` by `producing_step`.

Also add a "Pipeline Artifacts" subsection to the pipeline detail page for artifacts
with no `producing_step`.

States:

- **Loading**: show skeleton lines in the artifacts subsection.
- **Empty**: do not render the subsection if there are no artifacts.
- **Error**: if `GetArtifact` fails, show an inline error message below the artifact
  card with a retry button.

Add an SSE handler for `pipeline-artifact` events in `ui/src/lib/pipeline-sse.ts` so
artifact phase changes refresh the detail panel.

### 8. Authorization

Reuse existing project-scoped authorization (`authorizeProjectFromLabels`). The
pipeline controller copies project labels from the owner Pipeline to the Artifact during
creation/update.

## Implementation order

1. Add `Outputs` to `PipelineStep`, `Step` to `PipelineOutput`, and `Step` to
   `ArtifactProvenance`; regenerate CRDs / deepcopy.
2. Add `PipelineArtifactRef` and `Status.ArtifactRefs` to `Pipeline`; regenerate CRDs /
   deepcopy.
3. Update `Artifact` CRD validation enum to allow `configmap`; regenerate CRDs / deepcopy.
4. Harden Artifact controller for OCI + configmap with Ready condition and ConfigMap RBAC.
5. Update pipeline controller `createArtifact` to label, annotate, set owner refs, copy
   labels, upsert status, and watch owned artifacts.
6. Implement stale artifact cleanup in the pipeline controller.
7. Add SSE event publishing for artifact state changes.
8. Extend protobuf and run `make generate-proto`.
9. Add API handlers and RBAC markers.
10. Add UI artifacts section and SSE handler.
11. Add backend unit tests and frontend component tests.
12. Run `make manifests generate`, `make lint`, `make test`.

## Testing

- **Unit**: Artifact controller reconcile produces correct status and Ready condition for OCI and ConfigMap artifacts.
- **Unit**: Artifact controller handles ConfigMap failure modes (not found, missing key, ambiguous keys).
- **Unit**: Pipeline controller `createArtifact` labels, annotates, upserts `Status.ArtifactRefs`, and handles retries.
- **Unit**: Pipeline controller deletes stale artifacts and `Status.ArtifactRefs` entries.
- **Unit**: Pipeline controller watches owned artifacts and updates pipeline status.
- **Unit**: API handlers authorize, convert, and return correct `download_url` semantics.
- **Component**: Step detail panel renders artifacts and triggers download/copy actions.
- **E2E** (follow-up, out of scope for first plan): create a pipeline with step outputs, run it, verify artifacts appear in the UI.

## Open questions

1. Should OCI artifacts support a signed download URL in this iteration?
   - **Decision**: no. Return `resolved_reference` and let the user pull with registry
     tooling. ConfigMap artifacts are downloadable via the API.
2. How do we map artifacts to steps?
   - **Decision**: `PipelineStep.Outputs` declares step outputs; `PipelineOutput.Step`
     allows pipeline-level outputs to declare a step. `ArtifactProvenance.Step` records
     the producing step on the Artifact. The pipeline controller labels/annotates the
     Artifact with the step name and upserts `PipelineArtifactRef.ProducingStep`.
3. What happens when a ConfigMap artifact reference omits a key?
   - **Decision**: if the ConfigMap has exactly one key, use it. Otherwise the artifact
     phase becomes `Failed` with `Reason=AmbiguousKeys`.
