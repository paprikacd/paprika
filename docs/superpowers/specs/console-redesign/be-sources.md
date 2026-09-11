# BE-SOURCES — How Paprika learns about application sources & revisions

Scope: `internal/source`, `internal/repository`, `internal/reposerver`, `internal/reposerverclient`,
`internal/oci`, `internal/webhook`, plus the render engine (`internal/engine`) and the controllers
that drive them. All paths absolute-rooted at `/Users/benebsworth/projects/paprika`.

**Headline findings (for the redesign gap analysis):**

| Design need | Status |
|---|---|
| Commit author / message / timestamp | **ABSENT everywhere.** `go-git/plumbing/object` is never imported. Only the 40-char SHA is captured. |
| Run number / CI metadata on a revision | **ABSENT.** Nearest: GitHub Actions OIDC claims (repo/ref/workflow) at token-exchange time only, never persisted. |
| Source trigger / webhook event feed | **ABSENT.** No event is persisted, logged structurally, or emitted to the SSE broker. Webhook only mutates an annotation. |
| Jsonnet | **NOT SUPPORTED.** Zero occurrences repo-wide; no dependency in `go.mod`. |
| S3 / OCI inbound webhooks | **ABSENT.** Receiver handles GitHub + GitLab **git push only**; hardcodes `sourceType = "git"`. |

---

## 1. The core data structure: `source.ResolveResult`

`/Users/benebsworth/projects/paprika/internal/source/resolver.go:14-19`

```go
type ResolveResult struct {
	LocalPath string
	Hash      string
	Revision  string
}
```

**Three fields. That is the entire contract** between every source backend, the repo server, the
ConnectRPC API (`ResolveSourceResponse`), and the Application controller. Every richer piece of
metadata the redesign wants (author, message, commit time, tag, branch, run number) would have to be
added here first, then threaded through `reposerver` -> `reposerverclient` -> `api.proto`.

Helpers in the same file:
- `ComputeFileHash(path)` — `:22`
- `ComputeDirHash(dir)` — `:42` (SHA256 over relative path + content of every file; skips `.git` via `skipDirHashEntry` `:78`)
- `SanitizeName(s)` — `:89` (lowercases-or-dashes; used for cache dir names)
- `RepoCacheKey(repoURL, credentialID)` — `:103` (sha256(url)[0:32], optionally `-` sha256(url\0credID)[0:32])

---

## 2. Git source resolution — `internal/source/git.go`

### Types
- `GitAuth` — `:27-33` — `{Username, Password, Token, GitHubApp *GitHubAppAuth}`
- `GitSource` — `:35-43` — `{RepoURL, Revision, Path, WorkDir, Auth, Shallow}`

### Flow
1. `(*GitSource).Resolve(ctx)` — `:60`. Thin wrapper that records OTel metrics
   (`paprikametrics.GitOperations` / `GitErrors` / `GitDuration`, attribute `operation` = `"clone"`
   or `"fetch"`) then calls `resolve`.
2. `resolve` — `:77`. Computes `key := RepoCacheKey(RepoURL, credentialID())`, takes a per-repo
   process mutex (`repoLock`, `:50`, map at `:45-48`), and works in two dirs under `WorkDir`:
   - **mirror**: `<WorkDir>/git-mirrors/<key>` (bare)
   - **worktree**: `<WorkDir>/git-clones/<key>` (checkout)
   On a recoverable cache corruption (`isRecoverableGitCacheError`, `:142` — matches "unexpected eof",
   "object not found", "invalid checksum", "malformed", "packfile" AND a phase substring) it
   `os.RemoveAll`s both dirs (`resetGitCache`, `:133`) and retries once.
3. `resolveLocked` — `:100`. `openOrCloneMirror` -> `resolveAndCheckout` -> `ComputeDirHash(chartPath)`.
4. **Return shape** — `:126-130`:
   ```go
   &ResolveResult{
       LocalPath: chartPath,                              // worktreeDir [+ /Path]
       Hash:      commitHash[:16] + ":" + dirHash[:16],   // composite identity
       Revision:  commitHash,                             // full 40-char SHA
   }
   ```

### Mirror / fetch mechanics
- `openOrCloneMirror` `:162` — `git.PlainOpen`; on `ErrRepositoryNotExists` -> `createMirror` `:198`
  (`PlainInit(bare=true)` + `CreateRemote("origin")`).
- `fetchMirror` `:185` — refspec `+refs/heads/*:refs/heads/*`, `Depth: g.depth()`.
  **Note: tags are NOT fetched into the mirror** (only into the worktree, `:337-345`, `:366-372`).
- `setMirrorHEAD` `:219` / `setCloneableMirrorHEAD` `:253` / `firstCloneableMirrorRef` `:279` /
  `mirrorRefPriority` `:310` — HEAD preference order `refs/heads/main` > `master` > any head > any tag.
- Worktree: `openOrCloneWorktree` `:325`, `openExistingWorktree` `:332`, `cloneWorktree` `:349`.
  Worktree fetches from the **local mirror dir** (`URLs: []string{mirrorDir}`), refspecs
  `+refs/heads/*:refs/remotes/origin/*` and `+refs/tags/*:refs/tags/*`.

### Revision resolution
- `resolveAndCheckout` `:228` -> `resolveRevision` `:379`.
  - Empty revision -> `repo.Head()`.
  - Otherwise tries each of `revisionCandidates(revision)` `:397`:
    `refs/remotes/origin/<rev>`, `refs/heads/<rev>`, `refs/tags/<rev>`, then the raw string
    (so a bare SHA works). Special-cases inputs already prefixed `refs/heads/` or `refs/tags/`.
  - Failure message: `resolve revision %s: not found as branch, tag, or commit`.
- Checkout is `wt.Checkout(&git.CheckoutOptions{Hash: *hash, Force: true})`, returns `hash.String()`.
- `depth()` `:414` — returns 1 (shallow) only when `Shallow && isBranchReference()`.
  `branchReference()` `:421`, `isBranchReference()` `:437`, `isHexSHA` `:453` (`^[0-9a-fA-F]{40}$`).

### ***Where commit metadata could come from (currently unused)***
`resolveAndCheckout` already holds a `*plumbing.Hash` and an open `*git.Repository`. Adding
```go
c, err := mirrorRepo.CommitObject(*hash)  // c.Author.Name/.Email/.When, c.Committer, c.Message
```
is a ~5-line change at `internal/source/git.go:228-251` and is the single cheapest way to obtain
author / email / commit timestamp / commit message. `go-git v5.19.1` (go.mod:20) exposes
`object.Commit` fully. **Nothing in the repo does this today** — verified: no import of
`go-git/v5/plumbing/object` anywhere (`grep -rn 'plumbing/object'` -> 0 hits).

Caveat for implementers: with `Shallow: true` + `depth 1`, the commit object for a *pinned older SHA*
may not be in the mirror. But `depth()` returns 0 (full) for pinned SHAs, and for branch refs the tip
commit object IS present, so `CommitObject` works in both real cases.

### Auth
`credentialID()` `:457` (cache-key salt: `github-app:<app>:<inst>` | `token:<tok>` | `<user>:<pass>`);
`GitAuth.authMethod` `:474` returns `http.BasicAuth` (`x-access-token` for token / GitHub App).
**SSH is not supported** — only `net/http` transport is imported.

---

## 3. OCI source resolution — `internal/source/oci.go`

- `OCISource` `:21-30` — `{URL, Tag, Insecure, WorkDir, SecretRef, Namespace, Client client.Client}`.
- `IsOCIURL` `:84` — `strings.HasPrefix(url, "oci://")`.
- `Resolve` `:89`:
  1. `clientOptions` `:32` — `registry.ClientOptEnableCache(true)`, `ClientOptPlainHTTP()` if
     `Insecure`; credentials from the referenced Secret: `.dockerconfigjson` parsed in-memory by
     `parseDockerConfigCredentials` `:199` (falls back to writing a config.json to
     `<WorkDir>/oci-docker-config/<sanitized-url>/config.json`, `dockerConfigOptions` `:60`), else
     `username`/`password` keys -> `ClientOptBasicAuth`.
  2. `buildOCIRef(url, tag)` `:151` — `url + ":" + tag`.
  3. `pullOCIChart` `:134` — helm `registry.Client.Pull(ref)` -> `*registry.PullResult`.
  4. `writeChart` `:159` — writes `result.Chart.Data` to `<WorkDir>/oci-cache/<sanitized-url>/<chartName>.tgz`,
     extracts via `extractChartFiles` `:229` (helm `loader.Load` + write `c.Raw` files), removes the tgz.
  5. Returns `:126-130`: `Hash = ComputeDirHash(chartPath)`, `Revision = result.Ref` (the resolved
     reference string from helm's pull result; falls back to `o.Tag`).

**Metadata available but discarded:** helm's `registry.PullResult` carries `result.Chart.Digest`,
`result.Chart.Meta` (chart Name/Version), `result.Prov`, `result.Manifest.Digest`. Only `Ref` is used.
The chart digest is the natural "immutable revision" for OCI and is one field away.

### `internal/oci/verify.go` — separate, used by the Artifact controller
- `Verifier` interface `:18-20` — `Verify(ctx, ref) (digest string, err error)`.
- `RemoteVerifier.Verify` `:35` — strips `oci://`, `reference.ParseAnyReference`, builds an
  `oras-go/v2 remote.Repository` with `auth.DefaultCache`, returns `desc.Digest.String()`.
  A `reference.Digested` input short-circuits `:61-62`. Errors if neither tag nor digest present.
- `NopVerifier` `:75` for tests.
- Consumer: `internal/controller/pipelines/artifact_controller.go:92` (`case "oci":`), which writes
  `Artifact.Status.ResolvedDigest` / `.Verified`.

---

## 4. S3 source resolution — `internal/source/s3.go`

- `S3Source` `:20-30` — `{Bucket, Key, Region, Endpoint, WorkDir, AccessKey, SecretKey, Path}`.
- `Resolve` `:33`:
  - `loadConfig` `:163` — aws-sdk-go-v2 `LoadDefaultConfig`; static creds only when `Endpoint != ""`
    (LocalStack path; falls back to literal `"test"/"test"` credentials at `:171`).
  - `HeadObject` `:46` -> **ETag** (`:54-57`, quotes trimmed).
  - `downloadObject` `:92` — GET to `<localFile>.tmp` under `<WorkDir>/s3-cache/<sanitized-bucket>/`;
    if key ends `.tgz`/`.tar.gz` it shells out to `tar xzf` (`untarArchive` `:181`), else renames.
  - Returns `:85-89`: `Hash = ComputeDirHash(chartPath)`, `Revision = etag` (falls back to
    `dirHash[:16]`).

**Metadata available but discarded:** `HeadObjectOutput.LastModified`, `.VersionId`,
`.ContentLength`, `.Metadata`. `LastModified` is the obvious "source timestamp" for an S3 trigger feed.

---

## 5. GitHub App auth — `internal/source/github_app.go`

- `GitHubAppAuth` `:29-35` — `{AppID, InstallationID, PrivateKey []byte, EnterpriseURL}`.
- `InstallationToken(ctx)` `:38` — `parseRSAPrivateKey` `:62` (PKCS1 then PKCS8) ->
  `signGitHubAppJWT` `:82` (hand-rolled RS256, 10-minute expiry, `iat` back-dated 60s) ->
  `exchangeForInstallationToken` `:110` (`POST /app/installations/{id}/access_tokens`, or
  `<enterprise>/api/v3/...`). Only `{"token": ...}` is parsed (`installationTokenResponse` `:106`);
  `expires_at` and `permissions` are discarded. **Tokens are not cached** — a new JWT + REST
  round-trip on every resolve.

---

## 6. Repository CRD resolution — `internal/repository/resolver.go`

`Resolver` `:19`; `Resolved` `:28-35` = `{Spec TemplateSpec, Username, Password, GitHubApp, Insecure}`.

`ResolveTemplate(ctx, namespace, spec)` `:38`:
- No-ops when `spec.RepoRef == ""`.
- `Get`s `core.paprika.io/v1alpha1 Repository` by `{Name: spec.RepoRef, Namespace: namespace}`.
- Loads `username`/`password` from `repo.Spec.SecretRef` (`loadSecret` `:103`).
- `resolveGitHubApp` `:79` — only for `type=git` with `spec.GitHubApp`; reads key `privateKey` from
  the same Secret (`loadSecretKey` `:114`), `strconv.ParseInt`s AppID/InstallationID.
- Merges the Repository URL into the TemplateSpec by type:
  `applyGitRepo` `:129` (sets `Git.RepoURL`, `Git.SecretRef` if empty),
  `applyHelmRepo` `:141` (sets `Chart.Repo`),
  `applyOCIRepo` `:147` (sets `OCI.URL`, ORs `Insecure`).
  Note there is **no `s3` or `kustomize` case** — a `RepoRef` cannot supply an S3 bucket.

### Repository CRD — `/Users/benebsworth/projects/paprika/api/core/v1alpha1/repository_types.go`
- `RepositoryType` `:24-33`: **`git` | `helm` | `oci`** (`+kubebuilder:validation:Enum` at `:67`).
- `RepositorySpec` `:64-93`: `Type, URL, Insecure, EnableLFS, SecretRef, GitHubApp, ForceHTTPBasicAuth, NoProxy`.
  (`EnableLFS`, `ForceHTTPBasicAuth`, `NoProxy` are declared but **never read** by any resolver.)
- `ConnectionState` `:96-102`: `{Status, Message, AttemptedAt, ResponseTime, Revision}`.
  `ConnectionStatus` `:36-45`: `Unknown | Successful | Failed`.

### Repository controller — `internal/controller/core/repository_controller.go`
- `Reconcile` `:57`, requeue every `repositoryHealthCheckInterval = 5 * time.Minute` (`:42`).
- `testConnection` `:85`: git & helm -> `testHTTP` `:109` (plain `GET` on the URL, helm gets
  `/index.yaml` appended; 15s timeout `:43`; basic auth from Secret `loadBasicAuth` `:145`).
  **OCI is never tested** — hardcoded `ConnectionStatusUnknown` + `"OCI connection state updated on first pull"` (`:97-100`), and nothing ever updates it later.
- **`ConnectionState.Revision` and `.ResponseTime` are declared but NEVER populated** by any code
  path. They are ready-made slots for "last seen revision" / "fetch latency" in the redesign.
- `connectionStateEqual` `:154` compares only Status+Message, so status is not rewritten every 5 min.
- `WatchSecretChange` `:174` re-reconciles Repositories when their Secret changes (field index
  `spec.secretRef.name`).

---

## 7. Repo server — `internal/reposerver/server.go` + `internal/reposerverclient/client.go`

`Server` `:33-39` holds `renderer pipelines.SourceResolvingRenderer`, `workDir`, `cache repoCache`
(`Getter+Setter+PrefixDeleter`, `:26-30`), `invalidator *cache.Invalidator`.
`NewServerWithClient` `:47` wires `engine.NewCachedTemplateRenderer(engine.NewHelmSDKRendererWithClient(workDir, k8sClient), c, workDir, 0)`.

### RPCs actually implemented (everything else returns `CodeUnimplemented`, `:187-398`)
- **`ResolveSource`** `:61` — `decodeTemplate(req.Msg.Type, req.Msg.SpecJson)` `:255` (JSON-unmarshals
  a `paprika.TemplateSpec`, forces `spec.Type = sourceType`), sets Namespace/Name, calls
  `renderer.ResolveSource`, returns `ResolveSourceResponse{LocalPath, Hash, Revision}` `:82-86`.
  Logs `"Resolved source"` with hash + revision at `:80` — **this log line is the only place a
  resolution "event" is externalised today, and it is unstructured log output, not a feed.**
- **`Render`** `:90` — same decode + `decodeValues` `:267` (`map[string]string`), returns raw
  `manifests []byte`.

### HTTP surface — `Handler()` `:116`
- `/paprika.v1.PaprikaService/` (ConnectRPC, `WithReadMaxBytes(10 MiB)`)
- `POST /invalidate` — `handleInvalidate` `:136`, body `invalidateRequest{sourceType,sourceUrl,revision}` `:130-134`
- `GET /healthz`
- `Run(ctx, addr)` `:161` — optional TLS via `mtls.ServingConfig()` `:174`.

### Client — `internal/reposerverclient/client.go`
- `DefaultTimeout = 5 * time.Minute` `:24`; env override `PAPRIKA_REPO_SERVER_TIMEOUT` `:26`, `timeoutFromEnv` `:57`.
- `New` `:38`, `NewWithTimeout` `:43`, `NewFromEnv` `:72` (reads `PAPRIKA_REPO_SERVER_ADDR`, deprecated).
- `Invalidate` `:99` — `POST <base>/invalidate`.
- `ResolveSource` `:128` — marshals `tmpl.Spec` to JSON, returns `*source.ResolveResult` (`:149-153`).
- `Render` `:157`.

**Consequence for the redesign:** any new revision metadata must be added to *three* places in
lockstep — `source.ResolveResult`, `ResolveSourceResponse` in `proto/paprika/v1/api.proto:503-507`,
and the two mapping sites `reposerver/server.go:82-86` + `reposerverclient/client.go:149-153`.

---

## 8. The render pipeline & SOURCE_TYPE values

### Canonical constants
`/Users/benebsworth/projects/paprika/api/pipelines/v1alpha1/application_types.go:180-187`:
```go
SourceTypeGit = "git"; SourceTypeHelm = "helm"; SourceTypeKustomize = "kustomize"
SourceTypeS3 = "s3";   SourceTypeOCI = "oci";   SourceTypeInline = "inline"
```

### Enum sites
| Location | Allowed values |
|---|---|
| `api/pipelines/v1alpha1/application_types.go:199` (`ApplicationSource.Type`) | `git;helm;kustomize;s3;oci;inline` |
| `api/pipelines/v1alpha1/template_types.go:83` (`TemplateSpec.Type`) | `helm;kustomize;git;s3;oci` (**no `inline`**) |
| `api/core/v1alpha1/repository_types.go:67` (`RepositorySpec.Type`) | `git;helm;oci` |
| `api/pipelines/v1alpha1/pipeline_types.go:42` (`Source.Type`, pipeline build source) | `git` only |
| `api/pipelines/v1alpha1/artifact_types.go:18` (`ArtifactSpec.Type`) | `oci;configmap` |
| `internal/engine/helm_sdk_renderer.go:34-42` (internal consts) | `git,s3,helm,kustomize,oci` |
| `internal/controller/pipelines/template_controller.go:80` (validation switch) | `helm,kustomize,git,s3,oci` |
| `internal/fleet/projection.go:149` `mapSourceType` / `internal/fleet/facets.go:311` `canonicalSourceType` | all six + `Unspecified` |

### **JSONNET: CONFIRMED ABSENT**
`grep -rni jsonnet` over the whole repository (including `ui/`, `docs/`, `deploy/`, `go.mod`,
`go.sum`) returns **zero matches**. There is no jsonnet/go-jsonnet dependency, no `SourceTypeJsonnet`,
no renderer branch. Rendering backends are exactly two: **Helm SDK** (`helm.sh/helm/v3 v3.21.2`,
go.mod:62) and **Kustomize** (`sigs.k8s.io/kustomize/api v0.21.1`, go.mod:69). Adding Jsonnet is
greenfield work: new enum value in 3 CRDs, new `case` in `HelmSDKRenderer.render` and
`ResolveSource`, plus a dependency.

### Renderer chain
`internal/engine/renderer.go:11-46` defines the interfaces:
`templateRenderer`, and the controller-side `pipelines.Renderer` / `TemplateSourceResolver` /
`SourceResolvingRenderer` / `TemplateRenderer` in `internal/controller/pipelines/renderer.go:14-46`.

Implementations:
1. **`HelmSDKRenderer`** — `internal/engine/helm_sdk_renderer.go`. The real one.
   - `ResolveSource` `:78` — switch: `git`->`resolveGitSource` `:117`; `s3`->`resolveS3Source` `:174`;
     `oci`->`resolveOCISource` `:97`; `kustomize`->`resolveKustomizePath` then returns
     `&ResolveResult{LocalPath: path}` **with empty Hash and Revision** (`:87-92`) —
     a real gap: kustomize sources have no revision identity.
     `default:` returns `(nil, nil)` (helm/inline).
   - `resolveGitAuth` `:142` — `RepoRef` -> `repository.NewResolver(...).ResolveTemplate`; else reads
     `username`/`password`/`token` from `Spec.Git.SecretRef`.
   - `render` `:208` — `helm|git|oci|s3` -> `renderHelm` `:219` (helm `action.NewInstall` with
     `DryRun/Replace/ClientOnly/IncludeCRDs`, release name from `params["release-name"]` defaulting
     to `paprika-release`); `kustomize` -> `renderKustomize`; default -> `unsupported template type`.
   - Chart acquisition: `resolveChartPath` `:268`, `downloadChart` `:287`,
     `downloadHTTPChart` `:302` (helm `repo.FindChartInAuthRepoURL`, caches
     `<repoCache>/charts/<name>-<version>.tgz`), `downloadOCIChart` `:340` (delegates to `source.OCISource`).
   - Metrics: `metrics.RenderTotal/RenderErrors/RenderDuration` with attribute `type` (`:194-206`).
2. **`CachedTemplateRenderer`** — `internal/engine/cached_renderer.go:23-41`.
   - `Render` `:44` keys on `cache.ManifestKey(spec.Type, manifestSourceURL(spec), manifestSourceIdentity(tmpl), params)`.
   - `manifestSourceURLResolvers` `:102-108` — per-type URL builders (`:117-153`).
   - `manifestSourceIdentity` `:155` — prefers `Status.SourceHash`, then `Status.SourceRevision`,
     then `manifestSpecRevision` `:165` (`Git.Revision` / `OCI.Tag`).
   - **`ResolveSource` `:82` is a pure pass-through — source resolutions are NOT cached.**
     `DefaultManifestTTL = 5 * time.Minute` `:14`.
3. **`RepoServerRenderer`** — `internal/engine/repo_server_renderer.go:30-95`. Delegates to the
   repo-server client, falls back to a local renderer.
4. **`TemplateRenderer`** (legacy, shells out to the `helm` binary) — `internal/engine/template.go:17`.
   Its `ResolveSource` `:42` handles **only `git` and `s3`** and creates a `GitSource` with **no auth**.
   Still referenced by `RenderAll`/`RenderHelmChart` paths; treat as legacy.

### Kustomize specifics — `internal/engine/kustomize_renderer.go`
- `renderKustomize` `:21`, `resolveKustomizePath` `:56` (nested source: `git` `:63` / `s3` `:69` /
  `oci` `:75` under a `kustomize` template), `renderWithOverlay` `:86`, `buildKustomization` `:131`,
  `runKustomizeBuild` `:176` (in-process `krusty.MakeKustomizer` + `filesys.MakeFsOnDisk`).
- `KustomizeSourceSpec` (`template_types.go:61-79`): `Path, NamePrefix, NameSuffix, Namespace,
  Images, CommonLabels, CommonAnnotations, InputFromPrevious`.

### Source spec types (`api/pipelines/v1alpha1/template_types.go`)
- `ChartRef` `:8-14` — `{Repo, Name, Version, Path}`
- `OCISourceSpec` `:17-28` — `{URL (pattern ^oci://), Tag, Insecure, SecretRef}`
- `GitSourceSpec` `:31-36` — `{RepoURL, Revision, Path, SecretRef}` — **no `depth`, no `ref` kind,
  no `submodules`, no commit fields**
- `S3SourceSpec` `:39-46` — `{Bucket, Key, Region, Endpoint, Path, SecretRef}`
- `TemplateSpec` `:82-98`; `TemplateStatus` `:101-106` — `{LastRendered, LastRenderHash, SourceHash, SourceRevision}`

---

## 9. `internal/webhook` — what it actually contains

`internal/webhook/` is **overwhelmingly Kubernetes admission webhooks**, not inbound source events:
- `clusters/v1alpha1/cluster_webhook.go`, `core/v1alpha1/{appproject,repository}_webhook.go`,
  `featureflags/v1alpha1/*`, `pipelines/v1alpha1/{application,applicationset,artifact,analysisrun,
  analysistemplate,conftestpolicy,notificationconfig,pipeline,release,stage,template}_webhook.go`,
  `policy/v1alpha1/policy_webhook.go`, `rollouts/v1alpha1/rollout_webhook.go`.

The **only** inbound-event package is `internal/webhook/receiver`.

### `internal/webhook/receiver/handler.go` (367 lines) — the source-trigger receiver

**Wiring:**
- `cmd/main.go:771` `webhookreceiver.NewHandlerWithCacheAndRepo(apiClient, webhookSecret, inv, repoClient)`, mounted `cmd/main.go:774` at `mux.Handle("/webhook", handler)`
- `cmd/main_operator.go:474` `NewHandler(c, secret)`
- `cmd/cloud-run/main.go:229` `NewHandler(k8sClient, webhookSecret)`, mounted `:283`

**Constructors:** `NewHandler` `:76`, `NewHandlerWithCache` `:81`, `NewHandlerWithCacheAndRepo` `:86`.
Options: `WithClock` `:59`. Interfaces `cacheInvalidator` `:66` and `repoInvalidator` `:71` are both
`Invalidate(ctx, sourceType, sourceURL, revision string) error`.

**Accepted inbound events** (`ServeHTTP` `:97`, dispatch `:112-134`), keyed off headers
`X-GitHub-Event` (`:27`) or `X-GitLab-Event` (`:29`):

| Event value | Const | Handler | Response |
|---|---|---|---|
| `push` (GitHub) | `githubPushEvent` `:31` | `handleGitHubPush` `:142` | 202 `{"status":"accepted"}` |
| `Push Hook` (GitLab) | `gitlabPushEvent` `:32` | `handleGitLabPush` `:162` | 202 `{"status":"accepted"}` |
| `ping` / `System Hook` | `:33-34` | inline | 200 `pong` |
| anything else | — | — | **400 `unsupported event`** |

Body is capped at 1 MiB (`io.LimitReader(r.Body, 1<<20)` `:101`).

**Authentication:**
- GitHub: `verifyGitHubSignature` `:324` — HMAC-SHA256 of the raw body against
  `X-Hub-Signature-256` (`sha256=<hex>`), constant-time `hmac.Equal`. Skipped entirely if
  `h.secret == ""` (`:143`).
- GitLab: plain string compare of `X-GitLab-Token` `:164`. (Not constant-time.)

**Payload shapes actually decoded — the crux of the gap:**
```go
// handler.go:350-356
type githubPushPayload struct {
	Ref        string `json:"ref"`
	Repository struct{ CloneURL string `json:"clone_url"` } `json:"repository"`
}
// handler.go:358-364
type gitlabPushPayload struct {
	Ref     string `json:"ref"`
	Project struct{ GitHTTPURL string `json:"git_http_url"` } `json:"project"`
}
```
**Two fields per provider.** The real GitHub push payload also carries `after` (the new SHA),
`before`, `head_commit.{id,message,timestamp,url,author{name,email,username}}`, `commits[]`,
`pusher.{name,email}`, `sender.{login,avatar_url}`, `compare`, `forced`, `deleted`, `created`.
GitLab carries `checkout_sha`, `user_name`, `user_username`, `user_avatar`, `commits[]`,
`total_commits_count`, `project.web_url`. **All of it is parsed away and dropped.** Widening these
two structs is the lowest-cost source of commit author/message/timestamp *and* of a trigger feed.

**What a push does — `triggerReconciliation(ctx, repoURL, branch)` `:182`:**
1. `h.cache.Invalidate(ctx, "git", repoURL, "")` `:188` and `h.repoCache.Invalidate(...)` `:193`.
   `sourceType` is the **literal string `"git"`** — there is no S3/OCI/Helm branch anywhere.
   Revision is `""` deliberately ("the new commit hash is unknown", comment `:186-187`) so the whole
   repo prefix is flushed.
2. `annotateMatchingApplications` `:213` — **`client.List` over ALL Applications cluster-wide** (no
   field selector / index), filters with `matchesRepo` `:271` (`Spec.Source.Type == "git"` &&
   `urlsEqual(Spec.Source.RepoURL, repoURL)` && (`Spec.Source.Revision == "" || == branch`)), then
   sets `app.Annotations["paprika.io/sync"] = <unix seconds>` and full `Update`.
3. `annotateMatchingTemplates` `:242` — same over `TemplateList`, `matchesTemplateRepo` `:287`.
4. `log.Info("Webhook triggered reconciliation", "repo", repoURL, "branch", branch, "updated", updated)` `:209`.

URL matching: `urlsEqual` `:300` / `normalizeURL` `:312` (drop `.git`, strip userinfo/query/fragment,
lowercase).
`nowString` `:344` — `strconv.FormatInt(h.clock.Now().Unix(), 10)`.

**Retention of inbound events: NONE.** No CRD write other than the annotation, no
`corev1.Event`, no push to `events.Broker`, no counter metric, no ring buffer, nothing in Redis.
Once the annotation is consumed the event is unrecoverable. Confirmed by
`grep -rn 'LastTriggered|TriggeredBy|LastWebhook|WebhookEvent|TriggerEvent|SourceEvent'` -> 0 hits
across `internal/`, `api/`, `proto/`.

**Tests** (`internal/webhook/receiver/handler_test.go`): `TestHandler_ServeHTTP_GitHubPush` `:39`,
`_GitLabPush` `:94`, `_Ping` `:131`, `_InvalidEvent` `:144`, `_GitHubSignature` `:157`,
`TestUrlsEqual` `:191`, `TestNormalizeURL` `:199`, `TestNowString` `:212`.

---

## 10. How a trigger becomes a release (the consuming end)

`internal/controller/pipelines/application_controller.go`:
- Annotation constants `:52-59`: `syncAnnotation = "paprika.io/sync"` `:55`,
  `legacyWebhookTriggerAnnotation = "paprika.io/webhook-trigger"` `:59`;
  `resyncAnnotation = "paprika.io/resync"` (`release_controller.go:62`);
  `manualSyncAnnotation = "paprika.io/manual-sync"` (`sync_window.go:17`).
- `syncTriggerPresent` `:413`, `hasSyncTrigger` `:425`, `handleSyncTrigger` `:429` — clears all three
  annotations via a merge patch, then (if Healthy and not inline) `checkSourceChanged`; if changed,
  `startNewReleaseFlow(..., "SourceChanged", "source hash changed, creating a new release")`.
- `checkSourceChanged` `:1354` — calls `resolveSourceHash`, compares against `Status.SourceHash`,
  writes `Status.SourceHash` / `Status.SourceRevision`, logs old/new hash+revision + `changed`.
  Returns `false` on first observation (`oldHash == ""`).
- `resolveSourceHash` `:1392` — for `git|s3|kustomize|oci` it **looks up a Template named
  `<app.Name>-template`** in the app's namespace and calls `renderer.ResolveSource(ctx, &tmpl)`;
  returns `(result.Hash, result.Revision)`. For helm/local it returns
  `sha256(Chart.Path + Chart.Repo + Chart.Name)` with an **empty revision**.
- Poll cadence: `pollInterval` from `app.Spec.Source.PollInterval` (default `defaultRequeue`) at
  `:1845-1854` and `:1898`. This is the only "poller" — it is requeue-driven, not a separate loop.
- Revision propagation into Releases: `buildRelease` `:1067` copies `Status.SourceHash` ->
  `sourceHashAnnotation` and `Status.SourceRevision` -> `sourceRevisionAnnotation` onto the Release
  (`:1079-1084`); `releaseIdentity` `:1126` hashes them into the Release name.
  `release_controller.go:2754-2758` writes them back onto `Template.Status.SourceHash/SourceRevision`.

`internal/controller/pipelines/template_controller.go`:
- `propagateSyncTrigger` `:103` — a `paprika.io/sync` on a Template fans out to every owner
  Application, then deletes the annotation from the Template.
- Type validation switch at `:80` (`helm, kustomize, git, s3, oci`).

`internal/api/server.go:673` — `SyncApplication` sets `paprika.io/sync` to `UnixNano()` (note: the
webhook uses `Unix()` seconds, the API uses nanoseconds — inconsistent but harmless).

---

## 11. Where a "source trigger event feed" could come from

**Nothing persists such events today.** Ranked options for the implementer:

### (a) Widen the webhook payload structs + emit to the existing SSE broker — cheapest, highest value
`internal/api/events/broker.go` already exists and is Redis-fan-out capable:
- `Broker` `:30-37`; `NewBroker` `:41`, `NewRedisBrokerWithContext` `:62`, `NewBrokerFromEnv` `:86`.
- `Subscribe` `:125` (buffered chan of 16), `Unsubscribe` `:151`, `Publish` `:167`,
  `publishLocal` `:182` (**drops on full buffer, by design, comment `:196-201`**), `receiveLoop` `:203`.
- `Event` `:299-303` = `{Type string, Payload json.RawMessage, Timestamp time.Time}`; `NewEvent` `:283`.
- Topics/types `:265-280`: `TopicDashboard = "dashboard"`; types `application`, `release`, `rollout`,
  `audit`, `gate`, `pipeline`; plus `pipeline-artifact` (`eventtypes.go:32`).
- Payload shapes: `EventPayload` `eventtypes.go:5-16`, `AuditPayload` `:19-28`.
- **The broker has NO history/replay** — a late subscriber sees nothing. A feed needs its own store.
- SSE handler exists (`internal/api/sse.go:15` `SSEHandler`, `:27` `ServeHTTP`, `:87` `PublishEvent`)
  but `/events` is deliberately wired to `http.NotFoundHandler()` in `cmd/main.go:1001` and
  `cmd/cloud-run/main.go:282` ("Raw browser SSE is intentionally disabled until an authorized
  WatchEvents…", comment `cmd/main.go:998`). So the transport for a live feed is half-built.

Adding `events.TypeSourceTrigger` + a `SourceTriggerPayload{Provider, Event, RepoURL, Ref, Commit,
Author, Message, CommitTime, AppsTriggered []string, ReceivedAt}` published from
`triggerReconciliation` (`receiver/handler.go:182`) is a small, well-precedented change.

### (b) Persist a bounded ring in CR status — the existing in-repo precedent
`NotificationConfigStatus.Deliveries` (`api/pipelines/v1alpha1/notificationconfig_types.go:104-109`,
element type `NotificationDelivery` `:95-102`) keeps the **last 20** attempts, trimmed in
`internal/controller/pipelines/notification_controller.go:276-278`. The identical pattern
(`ApplicationStatus.SourceTriggers []SourceTriggerRecord`, capped) would give the console a durable
per-app feed with zero new infrastructure. `ApplicationStatus` is at
`api/pipelines/v1alpha1/application_types.go:556-640`.

### (c) Structured audit log — exists but does not cover webhooks
`internal/audit/audit.go`: `Event` `:20-33` (`Timestamp, Principal, Action, Resource, Name,
Namespace, Success, Error, Extra map[string]string, TraceID, SpanID`), `Auditor` `:37`,
`LogAuditor` `:43` (**writes JSON lines to stdout only — not queryable**), `NoopAuditor` `:81`.
Wired only as a ConnectRPC interceptor: `internal/api/audit_middleware.go:36`
`NewAuditInterceptor`, with `auditVerbs` `:18-26` = `Sync|Apply|Approve|Reject|Rollback|Promote|Abort`
(read RPCs are skipped, `classifyAudit` `:88`). Installed at `cmd/main.go:413`,
`cmd/main_operator.go:499`, `cmd/cloud-run/main.go:200`. **The webhook receiver never touches it**
(it is a separate HTTP mux, not a ConnectRPC procedure).

### (d) Kubernetes Events — emitted but never read back
`internal/observability/observability.go:498-521` `EventRecorder.Normal`/`.Warning`. Used at
`application_controller.go:342,353,2203`, `conftest_gate.go:87`, `release_controller.go:1081-1103`.
**No `SourceChanged`/`WebhookReceived` event is emitted, and no API handler ever lists `corev1.Event`**
(`grep 'corev1.Event\|EventList' internal/api/ internal/fleet/` -> 0 hits). K8s Events also expire
(default 1h), so they are a poor feed backing store.

### (e) Metrics — counters only, no per-event detail
`internal/metrics/otel.go`: `RenderDuration` `:14`, `RenderErrors` `:17`, `RenderTotal` `:20`,
`GitOperations` `:71`, `GitErrors` `:74`, `GitDuration` `:77`. There is **no webhook-received counter**.

---

## 12. Caching & rate limiting around sources (context for implementers)

`internal/cache`:
- `ManifestCachePrefix = "manifest"`, `SourceCachePrefix = "source"` (`interfaces.go:63-67`).
- `ManifestKey(sourceType, sourceURL, revision, params)` `:70`;
  `SourceKey(sourceType, sourceURL, revision)` `:75`;
  `manifestSourcePrefix` `:79`; `sourceSourcePrefix` `:83`.
- **`cache.SourceKey` is dead code in production** — referenced only from
  `internal/cache/cache_test.go:73`. Nothing ever writes a `source:` entry, yet
  `Invalidator.Invalidate` (`invalidator.go:21`) dutifully `DeleteByPrefix`es the `source:` prefix
  first (`:26-29`). So "source resolution caching" is designed-but-unimplemented; every
  `ResolveSource` does real git/S3/OCI I/O.
- Backends: `MemoryCache` (`memory.go:26`), `RedisCache` (`redis.go:18`, `DeleteByPrefix` `:72`).

`internal/ratelimit`: `SourceKey(sourceType, url)` `:338` (`"<type>:<url>"`), `ReconcileKey` `:332`,
`SourceLimiter` `:~326`. In practice only `AllowApp(ReconcileKey(ns,name))` is called
(`application_controller.go:186`, `release_controller.go:209`) — **the per-source limiter is
constructed but never consulted**.

---

## 13. Concrete gap list for the redesign (sources & revisions)

1. `source.ResolveResult` carries no commit metadata. **Add** `Author`, `AuthorEmail`, `Message`,
   `CommittedAt`, and (for OCI) `Digest`, (for S3) `LastModified`.
   Touch points: `internal/source/{git,oci,s3}.go`, `internal/source/resolver.go:14-19`,
   `proto/.../api.proto:503-507`, `internal/reposerver/server.go:82-86`,
   `internal/reposerverclient/client.go:149-153`.
2. Git commit object is never loaded. One `mirrorRepo.CommitObject(*hash)` at
   `internal/source/git.go:250` unlocks author/message/time.
3. Webhook payload structs discard everything (`receiver/handler.go:350-364`). Widening them yields
   `head_commit`, `pusher`, `sender`, `after` (the new SHA) — which would also let
   `triggerReconciliation` pass a real revision to `Invalidate` instead of `""`.
4. No trigger-event persistence at all. Nearest precedent: capped `Status.Deliveries` ring in
   `NotificationConfig` (cap 20, `notification_controller.go:277`).
5. `ConnectionState.Revision` / `.ResponseTime` (`repository_types.go:100-101`) are declared and
   never written — free slots for "last seen revision"/"fetch latency" per Repository.
6. OCI repositories are never connection-tested (`repository_controller.go:97-100`), so
   `ConnectionStatus` is permanently `Unknown` for OCI.
7. Kustomize sources resolve with **empty Hash and Revision**
   (`helm_sdk_renderer.go:87-92`) — no drift/change detection is possible for them.
8. Helm-repo (HTTP chart) sources get a synthetic hash from
   `sha256(Chart.Path+Chart.Repo+Chart.Name)` and an **empty revision**
   (`application_controller.go:1418-1420`) — the chart *version* is not part of the identity, so a
   chart republish is invisible.
9. Inbound events are git-only. S3 (bucket notification / EventBridge) and OCI (registry webhook)
   have no receiver; `triggerReconciliation` hardcodes `"git"` (`handler.go:188,193`).
10. `annotateMatchingApplications` does a cluster-wide unindexed `List` per push
    (`handler.go:217`) — will not scale to the fleet sizes the new console implies.
11. Source resolution is uncached (`cached_renderer.go:82-88`); `cache.SourceKey` is unused.
12. GitHub App installation tokens are minted per resolve with no caching
    (`github_app.go:38`, `git.go:476`); `expires_at` from the API response is discarded.
13. No SSH transport for git (`git.go` imports only `transport/http`).
14. Jsonnet is entirely unimplemented.
15. `/events` SSE is intentionally 404'd (`cmd/main.go:998-1001`); any live feed needs that
    endpoint (or a `WatchEvents` streaming RPC) turned on with authorization first.
