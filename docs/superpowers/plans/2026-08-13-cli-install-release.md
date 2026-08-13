# CLI Installation and Release Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a trustworthy one-command Paprika CLI installer, a concise Taskfile developer interface, clear landing-page onboarding, and a verified public `v0.1.0` release.

**Architecture:** GoReleaser produces separate CLI archives and a server container from explicit build IDs. A POSIX installer downloads an immutable tagged archive plus checksum, validates the archive, and atomically installs the CLI. Taskfile wraps existing Make/npm workflows, while the static landing page leads with install, login, and status commands.

**Tech Stack:** Go 1.26, Cobra, GoReleaser v2, POSIX shell, GitHub Actions/Releases, Task v3, static HTML/CSS/JavaScript, Vitest/Playwright where applicable.

**Design:** `docs/superpowers/specs/2026-08-13-cli-install-release-design.md`

---

## Chunk 1: CLI artifact and installer contract

### Task 1: Add a versioned CLI surface

**Files:**
- Modify: `cmd/paprika/main.go`
- Create: `cmd/paprika/main_test.go`

- [ ] **Step 1: Write the failing version-command tests**

Add focused tests that construct `newRootCmd`, execute `version`, and assert:

- the development default is `paprika dev`;
- injected version/commit/date values render as stable plain text;
- `version` is registered alongside `login` and `status`;
- no environment/config loading is needed.

- [ ] **Step 2: Verify RED**

Run:

```bash
go test ./cmd/paprika -run 'TestVersion' -count=1
```

Expected: FAIL because the version command and build variables do not exist.

- [ ] **Step 3: Implement the minimal command**

Add package variables with safe development defaults:

```go
var (
    version = "dev"
    commit  = "none"
    date    = "unknown"
)
```

Register a no-argument `version` Cobra command. Keep normal output concise (`paprika <version>`) and expose commit/date only in a structured second line when populated by release builds. Do not read config or contact the API.

- [ ] **Step 4: Verify GREEN and regression coverage**

```bash
go test ./cmd/paprika -run 'TestVersion|TestRoot' -count=1
go test ./cmd/paprika -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/paprika/main.go cmd/paprika/main_test.go
git commit -m "feat(cli): report build version"
```

### Task 2: Correct and separate release artifacts

**Files:**
- Modify: `.goreleaser.yaml`
- Modify: `Dockerfile.goreleaser`
- Modify: `.gitignore`
- Create: `hack/test-cli-release-contract.sh`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write a failing release-contract test**

Create a shell test that fails unless:

- GoReleaser defines `cli` (`./cmd/paprika`, binary `paprika`) and `server` (`./cmd`, binary `paprika-server`) build IDs;
- CLI supports exactly Darwin/Linux × amd64/arm64;
- archives include only `cli` and use `paprika_{{ .Version }}_{{ .Os }}_{{ .Arch }}`;
- Docker publishing includes only `server`;
- `Dockerfile.goreleaser` copies `paprika-server` to `/paprika`;
- release linker flags target the CLI variables;
- `release.draft` is true;
- GoReleaser writes only to an ignored `.goreleaser-dist/` directory and never deletes tracked `dist/install.yaml`;
- `goreleaser check` succeeds when available.

The test must parse YAML structurally (small Go helper or the repository's `gopkg.in/yaml.v3`), not rely only on fragile indentation grep.

- [ ] **Step 2: Verify RED**

```bash
bash hack/test-cli-release-contract.sh
```

Expected: FAIL because the current release config has one ambiguous build, public releases, and a mismatched binary.

- [ ] **Step 3: Implement the explicit build split**

Update GoReleaser to:

- build CLI and server separately;
- archive only the CLI;
- Dockerize only the server;
- name CLI archives predictably;
- set CLI version linker variables;
- create draft GitHub releases;
- use `.goreleaser-dist/` for every generated artifact and add that directory to `.gitignore`;
- publish only the versioned server container tag from tagged releases; leave the normal `master` image pipeline as the sole owner of `latest`.

Update `Dockerfile.goreleaser` for the server artifact. Do not change the normal `master` CI image pipeline.

- [ ] **Step 4: Add release packaging to PR CI**

Add a bounded `release-contract` CI job that runs the contract script, installs a pinned GoReleaser v2, runs `goreleaser check`, and builds the CLI snapshot. Execute the resulting CLI and assert `login`, `status`, and `version` appear in help. Add this job to the publication gate.

Use commit-pinned third-party Actions and extend `internal/cicontract` in Task 5 to enforce the job contract.

- [ ] **Step 5: Verify GREEN**

```bash
bash hack/test-cli-release-contract.sh
goreleaser check
goreleaser build --snapshot --clean --id cli
```

Locate the host-target snapshot binary from `.goreleaser-dist/artifacts.json` and verify:

```bash
<snapshot-binary> version
<snapshot-binary> login --help
<snapshot-binary> status --help
```

Expected: PASS; the binary is the CLI, not the operator.

- [ ] **Step 6: Commit**

```bash
git add .goreleaser.yaml Dockerfile.goreleaser .gitignore hack/test-cli-release-contract.sh .github/workflows/ci.yml
git commit -m "fix(release): package the Paprika CLI"
```

### Task 3: Build the checksum-verifying installer test-first

**Files:**
- Create: `install.sh`
- Create: `hack/test-cli-install.sh`

- [ ] **Step 1: Write the offline installer test harness**

Create a temporary fake release tree with valid Darwin/Linux, amd64/arm64 tarballs, a `checksums.txt`, and a controlled `curl` shim. The shim must record requested URLs but never access the network.

Test independently:

1. `PAPRIKA_VERSION=v0.1.0` and `0.1.0` both request tag `v0.1.0` and asset `paprika_0.1.0_<os>_<arch>.tar.gz`.
2. Every supported OS/architecture mapping selects the expected archive.
3. A valid archive installs an executable at `PAPRIKA_INSTALL_DIR/paprika`.
4. The installed fixture executes and reports its expected version marker.
5. Unsupported OS/architecture fails before any download.
6. Missing, duplicate, and malformed checksum entries fail.
7. Checksum mismatch fails.
8. Missing, duplicate, path-qualified, symlink, or non-regular `paprika` archive entries fail.
9. Extraction/copy failure leaves a sentinel destination binary byte-for-byte unchanged.
10. Success atomically replaces the sentinel and uses mode 0755.
11. Temporary files are removed on success, error, and interrupt.
12. Error text does not print downloaded content or local secret/environment values.
13. The unpinned path resolves only the HTTPS GitHub `/releases/latest` redirect and installs the normalized returned tag.
14. Empty, malformed, traversal-like, shell-like, and non-semver `PAPRIKA_VERSION` values fail before download.
15. Default destination selection chooses the first writable existing PATH directory among `/opt/homebrew/bin`, `/usr/local/bin`, and `$HOME/.local/bin`; otherwise it creates `$HOME/.local/bin` and prints an exact PATH instruction.
16. Missing `curl`, `tar`, `mktemp`, `mv`, `chmod`, and both supported checksum tools fail with a concise prerequisite error before destination mutation.
17. HTTP/redirect/download failures preserve an existing destination byte-for-byte and do not fall back to insecure URLs.
18. Successful installation prints the exact `paprika login --server https://paprika.benebsworth.com` next step.
19. The installer creates its download/extraction directory under `umask 077` (and explicitly enforces mode 0700), with a test inspecting permissions before cleanup.

- [ ] **Step 2: Verify RED**

```bash
bash hack/test-cli-install.sh
```

Expected: FAIL because `install.sh` does not exist.

- [ ] **Step 3: Implement minimal secure installer primitives**

Implement POSIX-shell functions for:

- `require_command`;
- safe semver normalization (`vX.Y.Z` and `X.Y.Z` only, with optional safe prerelease suffix if supported consistently);
- platform mapping;
- latest-tag resolution through GitHub's HTTPS `/releases/latest` redirect;
- exact checksum-line selection and verification via `sha256sum` or `shasum -a 256`;
- archive manifest validation before extraction;
- destination selection from writable PATH candidates;
- destination-local temporary file plus atomic `mv`;
- a private mode-0700 download/extraction directory created under `umask 077` before any remote content is written;
- cleanup trap.

Use fixed repository URLs. Test-only download indirection may be accepted through an explicitly named environment variable, but production defaults must not accept insecure schemes. Never call `sudo`.

- [ ] **Step 4: Verify GREEN across shells**

```bash
bash -n install.sh hack/test-cli-install.sh
bash hack/test-cli-install.sh
dash -n install.sh
```

On macOS also run the test with the system Bash 3.2-compatible syntax requirement. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add install.sh hack/test-cli-install.sh
git commit -m "feat(cli): add verified release installer"
```

## Chunk 2: Contributor commands, publication safety, and onboarding

### Task 4: Add a thin Taskfile developer interface

**Files:**
- Create: `Taskfile.yml`
- Create: `hack/test-taskfile-contract.sh`
- Modify: `README.md`

- [ ] **Step 1: Write failing Taskfile contract tests**

Assert `task --list` exposes documented descriptions for:

`build`, `build:all`, `install`, `test`, `test:race`, `test:e2e`, `lint`, `check`, `generate`, `ui:dev`, `ui:test`, `ui:build`, `docker:build`, and `clean`.

Use a controlled `make`/`npm`/`go` shim test to prove each task delegates to the intended existing command with variables preserved. Explicitly prove `task install` targets `./cmd/paprika`, not `./cmd` or `cmd/main.go`. Verify no undeclared deploy/push task is introduced.

- [ ] **Step 2: Verify RED**

```bash
bash hack/test-taskfile-contract.sh
```

Expected: FAIL because `Taskfile.yml` does not exist.

- [ ] **Step 3: Implement Taskfile schema v3**

Keep commands thin:

- delegate Go generation/build/test/lint/e2e to Make;
- delegate UI workflows to npm with `dir: ui`;
- use `go install ./cmd/paprika` for source installation;
- pass `IMG` through to `make docker-build`;
- make `default` list tasks;
- keep `clean` scoped to `bin/paprika`, coverage, ignored GoReleaser `.goreleaser-dist`, and UI build output only; never remove tracked `dist/install.yaml`.

Do not duplicate Makefile recipes or add deployment tasks.

- [ ] **Step 4: Verify GREEN and execute representative real tasks**

```bash
task --list
bash hack/test-taskfile-contract.sh
task build
./bin/paprika version
task ui:test
```

Expected: PASS.

- [ ] **Step 5: Update README contributor and user commands**

Lead the CLI section with the canonical installer/login/status commands. Keep `go install` and `task install` as source/developer alternatives. Replace the scattered Make-only command list with the Taskfile equivalents while noting Make remains supported.
Link directly to the exact release checksum asset pattern (`https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt`) and assert that link in the documentation contract.

- [ ] **Step 6: Commit**

```bash
git add Taskfile.yml hack/test-taskfile-contract.sh README.md
git commit -m "build: add everyday Taskfile commands"
```

### Task 5: Make tagged publication draft-until-verified

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `internal/cicontract/workflows_test.go`
- Test: `internal/cicontract/workflows_test.go`

- [ ] **Step 1: Add failing structured workflow-contract tests**

Extend the CI contract suite so `release.yml` must:

- use commit-pinned allowlisted Actions;
- have bounded job timeouts;
- serialize runs for the same tag;
- run a pre-mutation exact-tag guard that fails for an existing public release and permits only no release or a resumable draft;
- preflight the versioned Helm OCI tag before GoReleaser or image publication: package the source chart at the exact version, unpack both the local package and pulled OCI artifact, normalize Helm-generated metadata, and reuse the existing tag only when those normalized trees match; otherwise fail without overwriting it;
- create GoReleaser output as a draft release;
- make Helm publication depend on successful GoReleaser output;
- have a final verification/publish job depending on both artifact and Helm jobs;
- query the exact tag's draft release, never `/latest`;
- require exactly four CLI archives plus `checksums.txt`;
- download and checksum-verify each archive;
- execute a CLI artifact and check `version`, `login`, and `status`;
- verify the versioned server image is Linux/amd64 and digest-addressable;
- publish the GitHub release only as the final command after all assertions;
- never delete/overwrite an existing public release.

- [ ] **Step 2: Verify RED**

```bash
go test ./internal/cicontract -run 'TestWorkflowContract/.+release' -count=1
```

Expected: FAIL because `release.yml` publishes inside the first job and uses unpinned Actions.

- [ ] **Step 3: Implement the three-stage release workflow**

1. **Preflight:** under same-tag concurrency, inspect the exact GitHub release state and fail if it is public. Permit no release or a same-tag draft. Inspect the exact semantic Helm OCI tag before any other release mutation. If absent, mark it for publication; if present, package the source chart to a temporary archive with the same version, unpack both archives, normalize only Helm-generated `Chart.yaml` formatting/metadata, and compare the normalized trees. Reuse only an exact normalized match and fail on any substantive mismatch.
2. **Artifacts:** after preflight, GoReleaser creates or resumes only the draft release, uploads CLI archives/checksums, and pushes the versioned server image.
3. **Helm:** after preflight, package and push the semantic chart version without the leading `v` only when preflight proved it absent; otherwise verify/reuse the identical existing artifact without overwriting it.
4. **Verify and publish:** fetch draft assets for the exact tag, enforce the asset allowlist/count, verify checksums and CLI behavior, inspect the server image platform/digest, then run `gh release edit "$TAG" --draft=false --latest` as the final mutation.

Use least-privilege job permissions and pin every third-party Action to a full commit SHA. Ensure a failure leaves a draft release that the default installer cannot select.

In `ci.yml`, add a bounded `distribution-contracts` job that installs a commit/version-pinned Task binary and runs `hack/test-cli-install.sh`, `hack/test-taskfile-contract.sh`, and `hack/test-landing-install.sh`. Make it a required publication-gate dependency alongside the release packaging contract.

- [ ] **Step 4: Verify GREEN**

```bash
go test ./internal/cicontract -run TestWorkflowContract -count=1
bash hack/test-cli-release-contract.sh
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml internal/cicontract/workflows_test.go
git commit -m "ci(release): verify artifacts before publishing"
```

### Task 6: Put install, login, and status on the landing page

**Files:**
- Modify: `landing/index.html`
- Create: `hack/test-landing-install.sh`
- Modify: `docs/cli.md`
- Modify: `docs/getting-started.md`

- [ ] **Step 1: Write a failing static landing contract**

Assert the landing HTML contains:

- the canonical `curl .../install.sh | sh` command;
- `paprika login --server https://paprika.benebsworth.com`;
- `paprika status`;
- a visible Install CLI anchor from the hero/nav;
- copy buttons with unique targets and accessible labels;
- a polite live region for copy success;
- supported platform, checksum, `PAPRIKA_VERSION`, `PAPRIKA_INSTALL_DIR`, and source-install guidance;
- a canonical link to the selected release's `checksums.txt` asset;
- reduced-motion CSS and keyboard-visible focus;
- no unsupported Homebrew claim.

- [ ] **Step 2: Verify RED**

```bash
bash hack/test-landing-install.sh
```

Expected: FAIL because install onboarding is absent.

- [ ] **Step 3: Implement the focused landing UX**

Preserve the existing Instrument Sans/JetBrains Mono, warm surfaces, sparse paprika orange, and pipeline visualization. Add:

- a compact command block adjacent to/below the hero actions;
- numbered install/login/status lines;
- accessible copy controls with non-blocking success feedback;
- a dedicated `#install` section with platform/security/source alternatives;
- mobile wrapping/scrolling that never truncates commands;
- `prefers-reduced-motion` behavior;
- `:focus-visible` styling.

Do not redesign the feature/comparison sections or add generic card grids.

- [ ] **Step 4: Update CLI/getting-started docs**

Use the same canonical commands and version-pin/install-dir examples. State that checksums are verified, no implicit sudo occurs, and Homebrew is not yet supported.
Link to the exact checksum asset pattern for pinned releases and include it in the static contract.

- [ ] **Step 5: Verify static contract**

```bash
bash hack/test-landing-install.sh
```

Expected: PASS.

- [ ] **Step 6: Browser verification**

Serve `landing/` locally and inspect with Playwright/Chrome at:

- 1440×900 desktop;
- 390×844 mobile;
- keyboard-only navigation;
- reduced motion.

Exercise all copy buttons and external/dashboard links. Capture screenshots only for review; do not commit them unless explicitly useful.

- [ ] **Step 7: Commit**

```bash
git add landing/index.html hack/test-landing-install.sh docs/cli.md docs/getting-started.md
git commit -m "docs: lead with CLI installation"
```

## Chunk 3: Full verification, merge, and first release

### Task 7: Run the complete pre-merge validation matrix

**Files:**
- Modify only if a verification failure proves a scoped defect.

- [ ] **Step 1: Run focused contracts**

```bash
bash hack/test-cli-install.sh
bash hack/test-cli-release-contract.sh
bash hack/test-taskfile-contract.sh
bash hack/test-landing-install.sh
go test ./cmd/paprika ./internal/cicontract -count=1
```

- [ ] **Step 2: Run release/config/build checks**

```bash
goreleaser check
goreleaser build --snapshot --clean --id cli
task build
task ui:test
task lint
```

- [ ] **Step 3: Run repository gates**

```bash
make test
make test-race
helm lint charts/chart --values deploy/test-values.yaml
git diff --check
git status --short
```

Use hard bounds matching CI. Investigate any failure systematically; do not waive failures caused by this change.

- [ ] **Step 4: Request independent code/security review**

Review installer atomicity/path handling, workflow draft boundary, artifact identity, Taskfile safety, landing accessibility, and secret/log disclosure. Fix important findings test-first and re-run affected gates.

- [ ] **Step 5: Commit any review fixes**

Use narrow commits with messages matching the corrected behavior.

### Task 8: Push, merge, publish Pages, and release `v0.1.0`

**Files:**
- No source changes unless CI finds a reproducible defect.

- [ ] **Step 1: Push and open a PR**

Push `issue/cli-install`, create a ready PR, and wait for every required PR check including release packaging and landing contracts.

- [ ] **Step 2: Merge only on green**

Merge into `master`, record the exact merge SHA, and follow its CI/CD and GitHub Pages runs to success.

- [ ] **Step 3: Verify pre-tag public state**

Confirm:

- `https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh` serves the merged installer;
- the landing page shows the canonical commands;
- no public/draft `v0.1.0` release or tag already exists;
- the existing `ghcr.io/paprikacd/charts/paprika:0.1.0` artifact matches a freshly packaged merge-SHA chart after narrowly normalizing Helm-generated metadata and will be safely reused; abort before tagging if normalized archive contents differ;
- `origin/master` equals the recorded merge SHA.

- [ ] **Step 4: Create and push the annotated release tag**

```bash
git tag -a v0.1.0 <merge-sha> -m "Paprika v0.1.0"
git push origin v0.1.0
```

Do not move or reuse the tag after pushing.

- [ ] **Step 5: Follow the exact tag workflow**

Wait for the run whose `headSha` and tag match the recorded merge. Confirm the release remains draft until artifacts, Helm, CLI execution, and server-image checks pass, then becomes public/latest.

- [ ] **Step 6: Verify public assets independently**

Use the GitHub API to assert the public release has exactly:

- four `paprika_0.1.0_{darwin,linux}_{amd64,arm64}.tar.gz` assets;
- `checksums.txt`;
- no operator binary mislabeled as `paprika`.

Download all assets, verify checksums, inspect archive layouts, and execute the host CLI's `version`, `login --help`, and `status --help`.

- [ ] **Step 7: Run a clean public install and live E2E**

Create a new mode-0700 temporary root, create its `bin` and home directories, and use an explicit config path for every authenticated invocation:

```bash
PAPRIKA_E2E_ROOT="$(mktemp -d)"
chmod 0700 "$PAPRIKA_E2E_ROOT"
mkdir -m 0700 "$PAPRIKA_E2E_ROOT/bin" "$PAPRIKA_E2E_ROOT/home"
PAPRIKA_VERSION=v0.1.0 PAPRIKA_INSTALL_DIR="$PAPRIKA_E2E_ROOT/bin" \
  sh -c 'curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh'
HOME="$PAPRIKA_E2E_ROOT/home" "$PAPRIKA_E2E_ROOT/bin/paprika" version
HOME="$PAPRIKA_E2E_ROOT/home" "$PAPRIKA_E2E_ROOT/bin/paprika" --config "$PAPRIKA_E2E_ROOT/config.yaml" login --server https://paprika.benebsworth.com
HOME="$PAPRIKA_E2E_ROOT/home" "$PAPRIKA_E2E_ROOT/bin/paprika" --config "$PAPRIKA_E2E_ROOT/config.yaml" status
```

Complete the real OAuth loopback redirect. Confirm config mode 0600 and authorized status data. Perform the unauthenticated 401 check with a direct `curl` POST to the documented Connect `GetSystemStatus` endpoint without `Authorization`, asserting status 401 and a generic response. Remove the private root with a trap and confirm no credentials or processes remain afterward.

- [ ] **Step 8: Final handoff**

Report PR, merge SHA, release URL, workflow URLs, exact asset names/checksums status, landing URL, install command, live login/status evidence, and any intentionally deferred Homebrew tap work.
