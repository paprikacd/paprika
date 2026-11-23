# Local CI and local deploy

The GitHub `CI` workflow (`.github/workflows/ci.yml`) is disabled. Its checks run on the developer
machine through Task commands, git hooks enforce the gate before a commit or push, and `task deploy`
replaces the GitHub `publish` and `deploy-vke` jobs. The workflow files stay in the repository unchanged,
because the local job definitions mirror them and the contract tests in `internal/cicontract` parse them.

## Commands

| Command | What it does |
| --- | --- |
| `task ci` | Runs all 13 ci.yml jobs for `HEAD`, each in a detached worktree of that commit (see Job worktrees below). |
| `task ci FRESH=1` | As `task ci`, and `go-test` runs without cached test results (`-count=1`). The job worktrees are also rebuilt without their kept caches (see below). |
| `task ci -- --jobs ui,go-lint` | Runs selected jobs and merges their results into the stamp. |
| `task ci:job JOB=chart` | Runs one job. |
| `task ci -- --rerun-failed` | Runs only jobs that are not passing in the stamp for this tree. A waived `fleet-scale` is not passing for this purpose, so it runs again and its waiver is recomputed against the current `origin/master`. |
| `task ci:status` | Shows the stamp for `HEAD`. Exits nonzero unless every job passed. |
| `task ci:fleet-anchor -- <sha> <reason>` | Records a commit as a verified base for the fleet-scale UI waiver (see below). |
| `task ci:quick` | Fast checks on what `HEAD` changed against `origin/master` (used by the pre-push hook). |
| `task ci:tools` | Installs and verifies the pinned tools (Helm, kind, Terraform; checks Go, Node, Task, GoReleaser). |
| `task hooks:install` | Sets `core.hooksPath` to `.githooks` and checks that the hooks are executable. |
| `task deploy` | Builds, pushes and deploys `master` to the VKE `paprika-e2e` namespace. See below. |

Every job checks out the commit into its own detached worktree, so uncommitted files cannot pass a check.
A dirty tree is refused. `task ci -- --allow-dirty` produces a report for the tracked changes, but it never
writes a stamp.

## Job worktrees and caches

Each job's worktree is kept at a stable path under the cache root: `<cache root>/paprika-ci/jobs/<job>`. The cache
root is `~/Library/Caches` on macOS and `$XDG_CACHE_HOME` (or `~/.cache`) elsewhere; `PAPRIKA_CI_CACHE_ROOT` changes it.
The path is stable because Go reuses its build and test results only for a package built at the same path, so a
worktree created afresh for every run would make every run cold.

Before each run, a job's worktree is reset to the commit. Git removes every untracked and ignored file except two caches
the jobs keep: `ui/.next/cache` (the Next.js cache) and `bin/k8s` (the envtest assets). Ignored files such as
`ui/node_modules` are removed too, so `npm ci` installs them again on every run. A reset that leaves anything else
behind fails the run, with the paths listed.

The check after the reset verifies three things: no tracked file differs from the commit; no untracked or ignored file
is left that a clean would remove, apart from the two kept caches; and no file carries an index flag. The check does not
look inside the kept caches. A worktree that git cannot reset (for example, an assume-unchanged file blocks checkout),
that is not a registered worktree of this repository, or that has a skip-worktree or assume-unchanged flag on any file, is
rebuilt at the same path before the check. A flagged file keeps its content through the checkout while `git status`
shows nothing for it, so a flag would otherwise hide a stale file.

The job worktrees stay registered, so they appear in `git worktree list` between runs. The run's own directory
(logs collected for the run, temporary files) is removed when the run ends.

**The lock.** The stable worktrees are shared by every run that uses the same cache root, so one run at a time owns them.
The lock is an advisory `flock` on `<cache root>/paprika-ci/jobs/.run.lock`. `run.sh` holds it through an open file
descriptor (fd 9) for the whole run, and each job inherits that descriptor. The kernel releases the lock when the last of
those processes exits, so it is released however the run ends, including a crash or SIGKILL, and no pid file can go
stale. A background process that a job leaves running keeps the lock until it exits. A second run that finds the lock
held does not wait: it uses per-run job worktrees, which are removed at its end, its caches are not reused, and it skips
the Go cache trim. The log says so. A leftover `.run.lock` file with no holder does not block a run.

**`FRESH=1`.** `task ci FRESH=1` sets `PAPRIKA_CI_FRESH`, and the values `1`, `true` and `yes` (in any case) all count.
A fresh run gives `go-test` `GOFLAGS=-count=1`, so no test result is taken from the cache, and it resets every job
worktree without keeping `ui/.next/cache` or `bin/k8s`, so those are rebuilt. The Go build cache for compiled packages is still used.

**The Go build cache.** The cache is `<cache root>/paprika-ci/go-build`, or `PAPRIKA_CI_GOCACHE`. Only the run that holds the
lock trims it, once per run and before the jobs start. The trim deletes the cache entry files (names ending in `-a` or
`-d`) that were not modified for more than `PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS` days (default 3), and logs how many. Other
files in the directory are left alone. Deleting an entry only costs a rebuild. To clear everything, remove
`<cache root>/paprika-ci` while no run is in progress.

**Cached test results.** The `go-test` job logs how many packages reused a cached result:
`go-test: N package(s) reused cached results; run task ci FRESH=1 to rerun all`. The count comes from the job's log.
Locally, a test that needs Docker skips when Docker is missing, but with `CI=true` (set for every local job, as on GitHub)
it fails instead. Go caches a skip as a pass, so a skip could otherwise be reused on a machine where Docker is present.

Jobs run three at a time (`--parallel N` or `PAPRIKA_CI_PARALLEL` changes it). The Docker jobs
(`application-records`, `fleet-scale`, `cluster-integration`) run one after another at the end. The CPU-heavy jobs
(`go-test`, `ui`, `fleet-ui-smoke`) never overlap each other, since together they push timing-sensitive tests past their
limits on a laptop; the lighter jobs run beside them.

Logs go to `artifacts/ci/<tree12>/<job>.log`. The run ends with a table of job, result, duration and log path. A rerun of the same tree first moves each selected job's previous log and diagnostics to `artifacts/ci/<tree12>/previous/<run id>/`, so a failure is not lost when a later run passes; the newest `PAPRIKA_CI_KEEP_PREVIOUS_RUNS` (default 5) previous runs are kept for each tree.

## The stamp

Results are stored per git tree, not per commit: `$(git rev-parse --git-common-dir)/paprika-ci/<tree>.json`. The
self-tests (`PAPRIKA_CI_SELFTEST=1`) write to `paprika-ci-selftest/` instead, so no test run can write a real stamp.
A shell that exports `PAPRIKA_CI_SELFTEST=1` makes `status.sh` (and so the pre-push gate and the deploy) read the
self-test stamps. `status.sh` prints a line saying so; unset the variable for real work.
A squash commit and its merge commit with the same tree share one result. A stamp counts only when:

- its `ciYmlSha256` matches the `ci.yml` in that commit,
- its tool versions match the pins in `hack/ci/lib.sh`, and
- every job in `ci.yml` has the result `pass`, or `pass-waived` for `fleet-scale` with a well-formed `ui` waiver
  (see the fleet-scale section below).

A change to `ci.yml` changes the tree, so a stamp never carries a pass across a workflow edit. The pins in
`hack/ci/lib.sh` are checked against `ci.yml` on every run, so they cannot drift silently.

Jobs with a time limit use the `timeout-minutes` value from `ci.yml`. A job that exceeds it is recorded as
`timeout`. The run log prints each limit (`time limit N s (ci.yml timeout-minutes M)`).

A job's environment is an allowlist, not the developer's shell. The names that reach a job are exactly these
(`ci_env_allowed` in `hack/ci/lib.sh`):

- session variables: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `PATH`, `SSH_AUTH_SOCK`;
- the runner's own variables: `PAPRIKA_CI_*` and `PAPRIKA_NODE22`;
- cache and client settings: `GOCACHE`, `GOMODCACHE`, `GOPATH`, `DOCKER_CONFIG` (a private copy, see Deploy);
- the self-test knobs `PAPRIKA_CI_SELFTEST_*`, only under the self-test gate.

The runner then sets `TZ=UTC`, `CI=true`, `GOFLAGS` empty (`-count=1` for `go-test` under `FRESH=1`), `GOTOOLCHAIN` to the
ci.yml Go version (a job that sets `GOTOOLCHAIN=auto` in ci.yml sets it itself), an empty `GOENV` file, a Go build cache of its own
(`<cache root>/paprika-ci/go-build`, see Job worktrees above, or `PAPRIKA_CI_GOCACHE`;
a `go clean -cache` or a cache cleanup elsewhere on the machine cannot remove entries mid-build), an empty
`npm_config_userconfig`,
`DOCKER_CONTEXT` to the developer's default Docker context, and an empty kubeconfig. Every other variable is removed,
including `GOFLAGS`, `NODE_OPTIONS`, `GOARCH`, `CGO_ENABLED`, `npm_config_*`, `AWS_*`, `CLOUDSDK_*`, `DOCKER_HOST`,
`KUBECONFIG`, `VKE_*`, `GH_TOKEN` and `GITHUB_TOKEN`. Exported shell functions are removed too. The variables that
ci.yml sets for one job or one step are exported by that job's script. An inline `NAME=value` prefix on a command is
accepted by the parity test only when ci.yml sets that name to that value for the job or step.
The runner starts each job with only the allowlisted names (`env -i`), so a `BASH_ENV` file or an exported function in
the developer's shell never reaches a job. `bash hack/test-local-ci.sh` plants these names, an exported function and a
`BASH_ENV` file (which writes a sentinel if a job's shell sources it), and checks that none of them reaches a job.

A job that stops at its time limit, or at Ctrl-C, stops its child processes too. A time-limited step inside the job,
including one run in a subshell such as `(cd ui && ci_with_timeout ...)` (the Playwright runs of the browser smoke job),
is listed when it starts and is stopped with the job, and the job's cleanup waits for it to exit.

### Interrupts

Ctrl-C (or a TERM to `run.sh`) stops every job and its children. Each job then runs its cleanup (`docker rm`
for PostgreSQL, `kind delete cluster`) before it exits, and `run.sh` removes the run's directory and releases the job
lock only after all jobs have exited (the lock is released when the last of their processes ends). The stable job worktrees stay for the next run. Two variables tune this:

- `PAPRIKA_CI_INTERRUPT_WAIT` (default 180 s): how long `run.sh` waits for jobs to finish cleanup before it kills them.
- `PAPRIKA_CI_KILL_AFTER` (default 120 s): how long a stopped job gets before its process group is killed.

Interrupted and timed-out jobs skip the cluster diagnostics and go straight to cleanup.

### fleet-scale on an arm64 Docker server

ci.yml runs `fleet-scale` on `ubuntu-latest`, a linux/amd64 Docker server. On an Apple silicon Docker Desktop the
gate's two halves do not both run natively, so the job splits them (owner decision, 2026-11-21):

- **API half, always run.** On an arm64 server the job runs `hack/test-fleet-scale.sh` with
  `PAPRIKA_FLEET_SCALE_PARTS=api` and `PAPRIKA_FLEET_SCALE_ALLOW_EMULATED_AMD64=1`. The API container still runs with
  `--platform linux/amd64` under emulation, and it checks inside the container that `uname -m` is `x86_64`; the host
  checks that the Go test reports `FLEET_GOARCH=amd64`. The budgets, image digests and memory requirement are the
  gate's own. `environment.txt` records `EMULATED_AMD64=1` and the Docker server platform.
- **UI half, waived per tree.** The UI half needs a native linux/amd64 server. Measured on this host (Docker Desktop
  with Rosetta, unchanged `origin/master`): the API p95 was 117.4 ms (budget below 300 ms); the UI initial p95 was
  3977.7 ms (budget below 2000 ms) and the switch p95 371.2 ms (budget below 250 ms), because Chromium runs under x86
  emulation, not because of the code. The waiver is recorded only when no changed path lapses it.

On a native linux/amd64 server the job runs the whole gate, as ci.yml does, and records `pass`.

**The lapse rule.** The waiver lapses when the change can alter what the UI half measures. The owner's rule is "the fleet
UI or the gate itself", so the lapse set is the traced closure, not whole trees (`hack/ci/fleet-lapse.sh`):

- *UI closure*: the files the fleet UI imports. `hack/ci/fleet-ui-closure.mjs` follows the imports of the app shell
  (`ui/src/app/layout.tsx`, `ui/src/app/dashboard/layout.tsx`) and of every route that `ui/e2e/fleet-scale.spec.ts`
  visits, through relative imports, the `@/` alias, index files and CSS. It also includes the Next.js convention files
  (`layout`, `template`, `error`, `loading`, `not-found`, `default`, `global-error`) of every route segment on the way to
  those pages, because Next.js bundles them into the page; empty slots are listed too, so adding one lapses the waiver.
  Every `goto` in the spec must name its route as a double-quoted literal, or the job fails. The closure is traced at both
  ends of the diff, so a rename out of it lapses too. Measured on 2026-11-21: 55 files under `ui/src/lib`,
  `components/{fleet,ui,layout,auth,overview}`, `gen/paprika/v1` and `app`; none under `ui/src/features/insights`. The
  tracer uses the TypeScript package in the developer checkout's `ui/node_modules` (run `npm ci` in `ui/`), not a
  version pinned by the tree.
- *UI build input*: `ui/package.json`, `ui/package-lock.json`, `ui/.npmrc`, `ui/patches/*` (applied by `npm ci`),
  `ui/next.config.*`, `ui/tsconfig*.json`, `ui/postcss.config.*`, `ui/tailwind.config.*`, `ui/playwright*.config.*`,
  `ui/src/app/globals.css`, `ui/public/*`, the app icons and the spec.
- *Fixture Go package*: every non-test file directly in a repository package that the fixture server is built from
  (`go list -deps ./test/fleetconsole ./internal/fleet`, about 50 packages, including `internal/api`, `api/*`, and
  `internal/insights/revisionsource`, but not `internal/insights`), plus `go.mod` and `go.sum`.
- *Gate*: `hack/test-fleet-scale.sh`, `hack/ci/jobs/fleet-scale.sh`, `hack/ci/fleet-lapse.sh` and
  `hack/ci/fleet-ui-closure.mjs`; and the fleet-scale job block of `.github/workflows/ci.yml`, only when that block's text
  changes.

Insights-only changes, docs and tooling outside the gate keep the waiver. The job decides the lapse before it runs the
API half, so a lapsing tree fails at once and lists each path with its group.

**The base.** The waiver is measured from a verified base. The search starts at `git merge-base HEAD origin/master`
(at `HEAD^1` when HEAD is already on master) and walks first parents to the nearest commit that is verified, which means
either of these:

- its tree has a stamp in which `fleet-scale` passed in full (`stamp-pass`) or was waived (`stamp-waived`), or
- it is listed in the anchors file `<git common dir>/paprika-ci/fleet-scale-anchors`, one `<full sha> <reason>` line per
  anchor (`anchor`).

The walk checks at most 500 commits. Malformed anchor lines are ignored with a warning. An unverified commit never counts,
so two commits pushed to master together (a fleet UI change, then a docs change) lapse: the UI change is checked, and the
search does not stop at the tip. Record an anchor only for a commit whose full fleet-scale run passed, natively or as a
waiver:

```
task ci:fleet-anchor -- <full sha> "<reason>"
```

The tool refuses a revision that is not a commit and an empty reason, and prints the line it records. Self-tests write
anchors to the self-test directory (`paprika-ci-selftest`), never to the real file.

**The waiver.** A passing tree records `fleet-scale` as `pass-waived` with a `waiver` object: `part` (`ui`), `reason`,
`base` (the full SHA), `baseKind` (`stamp-pass`, `stamp-waived` or `anchor`), `anchorReason` (only for an anchor),
`checkedPaths` (the number of changed paths from the base) and `apiP95Ms`. `task ci:status`, the pre-push master gate and
`task deploy` print it on every call:

```
WAIVED fleet-scale ui half: UI scale half needs a native linux/amd64 Docker server; ... (base <sha12> anchor: <reason>, N paths checked, API p95 <x> ms)
```

`status.sh` accepts `pass-waived` only for `fleet-scale`, only with a well-formed `ui` waiver (its `baseKind` must be one
of the three kinds, `anchorReason` must be present exactly for an anchor, and the counts must be whole numbers), and only as a
passing result; any other job with `pass-waived`, or a malformed waiver, fails. `vke.sh` adds the waiver object to the
deploy report (`artifacts/deploy/<commit12>.json`, key `waiver`, `null` when fleet-scale passed in full).

**How to get a full run.** A full run needs a linux/amd64 Docker server that sees the same paths as this machine:
set `PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT=<context>` for the run. Only the `fleet-scale` job exports it, as
`DOCKER_CONTEXT`. The gate bind-mounts the job's worktree, its `bin/` directory and the artifacts directory, so a
remote daemon must resolve those paths on its own host. A tree whose changes touch a lapse path can only pass in full.

## Hooks

`.githooks/pre-commit` checks only what is staged:

- Go: `gofmt` and `golangci-lint` on the staged packages (version pinned by the Makefile).
- UI: `eslint` on staged `ui/` TypeScript and JavaScript, on Node 22. Requires `ui/node_modules` (`npm ci`).
- Shell: `shellcheck` on staged `*.sh`.

`.githooks/pre-push` does two things:

- A push of `master` requires `hack/ci/status.sh` to pass for the pushed commit. `PAPRIKA_SKIP_PREPUSH`
  does not skip this gate.
- A push of any other ref (a branch or a tag, annotated or not) runs `task ci:quick` on `HEAD`, and every such ref
  must point at `HEAD`. Set `PAPRIKA_SKIP_PREPUSH=1` to skip the quick check only; the hook prints that it did,
  and the HEAD check still applies.

Git exports `GIT_DIR` and its other repository variables to hooks. Both hooks clear them (through `hack/ci/lib.sh`)
before running a check, so a git command meant for a scratch repository, such as the self-test's `git init`, acts on
that repository and never on the one being pushed.

Git's `--no-verify` skips hooks entirely. The master gate is enforced again by `task deploy`, which refuses
to run without a passing stamp.

## Deploy

`task deploy` runs `hack/deploy/vke.sh`. It refuses unless all of these hold:

1. The current branch is `master`, `HEAD` equals `origin/master` after a fetch, and the tree is clean.
2. The stamp for `HEAD` passes, and the pinned tools match.
3. The kubeconfig is named by `PAPRIKA_DEPLOY_KUBECONFIG`, either in the environment or in a
   `PAPRIKA_DEPLOY_KUBECONFIG=` line of a gitignored `.env.deploy`. The file must live outside the
   repository, and its current context must be `vke`.
4. No other deploy holds `$(git rev-parse --git-common-dir)/paprika-deploy.lock`.

It then builds and pushes `ghcr.io/paprikacd/paprika` (tags `latest` and `sha-<commit>`) and the dashboard
renderer, using digests from buildx metadata. It runs the deploy-vke.yml steps against the cluster: it verifies
access and the retained Insights PVC, reuses the existing `paprika-oidc` and `paprika-auth-token` Secrets,
upgrades the release with the pinned Helm, waits for rollout, and runs health checks through a port-forward on a
free local port. Afterwards it checks that every running Paprika container reports the pushed digest, and it
writes `artifacts/deploy/<commit12>.json`. That report holds no secrets.

### One-time kubeconfig setup

The kubeconfig for the cluster that runs the `paprika-e2e` namespace must live outside the repository.
Kubeconfig files inside the checkout (for example `terraform/*.kubeconfig`) are refused, and so is any file whose
current context is not `vke`. Copy the file once, restrict it, and rename its context inside that copy only:

```sh
install -m 0600 <path-to-the-cluster-kubeconfig> ~/.kube/paprika-vke
kubectl --kubeconfig ~/.kube/paprika-vke config rename-context <current-context> vke
echo "PAPRIKA_DEPLOY_KUBECONFIG=$HOME/.kube/paprika-vke" >> .env.deploy   # gitignored; write an absolute path
```

The rename changes only the copy. No global kubeconfig or current context is touched, and no command in the
checks ever reads this file.

Secret values come from the environment, or from the live release for the OIDC client ID and the password hash.
They are never printed. The auth values reach the values file through jq's environment, and the registry token is
piped to `docker login` on stdin, so neither is passed on any command line.

The deploy builds the images, and runs the chart, values files and helper scripts, from one fresh worktree of the
commit. A gitignored file in the developer checkout is never deployed.

Registry login: the deploy logs in to `ghcr.io` with a Docker config of its own, in its private temporary
directory (mode 0700), which is removed when the deploy ends. That config carries the buildx builders, the CLI
plugins and the Docker contexts of the developer's config, so the `desktop-linux` and `cuttlefish-gha-job` builders
still work, but none of its credentials or credential helpers. The developer's keychain and `config.json` are never
read for `ghcr.io` credentials or changed, and a `ghcr.io` login that already exists stays as it is.

The deploy takes no arguments; anything after `task deploy` is refused. Its cluster steps (`hack/deploy/vke-cluster.sh`)
run under the 20-minute limit of deploy-vke.yml, and the renderer health check under 120 seconds. Secrets are applied
in the order deploy-vke.yml uses: the renderer values, then the `paprika-oidc` and `paprika-auth-token` Secrets.

Environment overrides, all optional:

- `VKE_OIDC_CLIENT_ID`, `VKE_BASIC_PASSWORD_HASH`: used when set; otherwise read from the live release.
- `VKE_OIDC_CLIENT_SECRET`, `VKE_AUTH_TOKEN_SECRET`: when set, the matching Secret is rewritten; otherwise it is left as it is.

The self-tests (`bash hack/test-local-ci.sh`) exercise every refusal above, the checks that no secret value is printed, and the stamp
rules, using fake `docker`, `kubectl`, `helm` and `gh` on `PATH`. They never reach a registry or a cluster. Two
notes on running them:

- Run one self-test at a time. The renderer health check port-forwards to a fixed local port (19081), so two
  runs at once can fail with `dashboard renderer health check failed`.
- The self-tests assert the exact `helm upgrade` and `kubectl wait` arguments, so a change to deploy-vke.yml
  needs the same change in `hack/deploy/vke-cluster.sh` and in the self-test. `internal/cicontract` checks that
  every command of every ci.yml job is mirrored by its `hack/ci/jobs` script, so a new ci.yml step fails until the
  local job runs it too.

## Turning GitHub CI back on

```sh
gh workflow enable ci.yml
```

The workflow file itself is unchanged, so enabling it restores the previous behaviour.
