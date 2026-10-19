# CI on Cuttlefish Runners

How Paprika's `CI` workflow (`.github/workflows/ci.yml`) runs on a
Cuttlefish-backed self-hosted GitHub Actions runner. GitHub still orchestrates
the workflow, shows the logs and reports the checks. Only the compute moves to
a machine running the Cuttlefish agent.

The switch is a repository variable. Merging the workflow change does not move
any job: with `CUTTLEFISH_RUNS_ON` unset, every job stays on `ubuntu-latest`.

## What moves and what stays

When `CUTTLEFISH_RUNS_ON` is set, the portable jobs use it as their `runs-on`
value:

| Job | Runs on |
|-----|---------|
| Go race tests, Go lint, UI, Generated code drift, Helm chart, CLI release contract, Distribution entrypoint contracts, Fleet console browser smoke | `CUTTLEFISH_RUNS_ON` |
| Controlled fleet scale gate | `ubuntu-latest`: needs a `linux/amd64` Docker server |
| Kind and Helm integration | `ubuntu-latest`: installs `kind-linux-amd64` with `sudo` and builds the full image |
| Publish image | `ubuntu-latest`: pushes a `linux/amd64` image with `packages: write` |
| Deploy published image to VKE | `ubuntu-latest`: holds the VKE credentials |

Pull requests from forks always run on GitHub-hosted runners, whatever the
variable says.

The portable jobs work on either kind of runner:

- `actions/setup-go` and `actions/setup-node` cache only on GitHub-hosted
  runners. On a reused self-hosted host, the post-job cache upload can hang for
  an hour, and the Go module, build and npm caches already persist on disk.
- Every portable job runs `.github/actions/reclaim-runner-disk` after checkout.
  It removes `actions/runner` diagnostics and npm logs, and does nothing on
  GitHub-hosted runners.
- The CLI release contract builds every CLI target and runs the one built for
  the runner's own platform. On `ubuntu-latest` that is still `linux/amd64`.
- Playwright installs system packages (`--with-deps`) on Linux only.

## Prerequisites

On the machine that will run the jobs (normally a macOS Cuttlefish rig):

1. The `cuttle` CLI on `PATH`: `cuttle version`.
2. A ready agent: `cuttle agent doctor` exits 0 (ready) or 2 (ready with
   caveats). It prints a fix command for any failing check.
3. The host tuned for rig duty: `cuttle agent host status`, then
   `cuttle agent host tune` if it reports problems.
4. `gh` authenticated with admin on the repository:
   `gh api repos/paprikacd/paprika --jq .permissions.admin` prints `true`.
5. Go, Node.js 22 and `jq` available to the runner user. `setup-go` and
   `setup-node` install their toolchains. Race tests need the Xcode command line
   tools for cgo.

## Register the runner

From a checkout of the Cuttlefish repository, the onboarding script checks the
prerequisites, registers the runner, installs a LaunchAgent so it survives
reboots, and waits for it to come online:

```sh
scripts/onboard-repo.sh paprikacd/paprika --persist
```

To do it by hand:

```sh
TOKEN=$(gh api -X POST repos/paprikacd/paprika/actions/runners/registration-token --jq .token)
nohup cuttle agent github-runner register --repo paprikacd/paprika --token "$TOKEN" \
  > /tmp/cuttlefish-runner-paprika.log 2>&1 &
```

The registration token lasts about an hour. The hand-started runner does not
survive a reboot or agent restart; use `--persist` for that.

A runner can also be added in the Cuttlefish console (**Rigs → a rig → GitHub
Runners**) once the repository is mapped to a Cuttlefish project.

Confirm the runner is online before going live:

```sh
gh api repos/paprikacd/paprika/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Expect `status: online` and labels that include `self-hosted` and `cuttlefish`.

## Go live

1. Before registering a runner, require approval for fork pull request
   workflows: **Settings → Actions → General → Fork pull request workflows from
   outside collaborators → Require approval for all external contributors**.
   This repository is public. The `runs-on` expression routes unmodified fork
   pull requests to GitHub-hosted runners, but a fork can edit the workflow
   file in its pull request and target the self-hosted labels directly. The
   approval gate is what keeps unreviewed code off the rig.
2. Register the runner and confirm it is online (above).
3. Set the variable:

   ```sh
   gh variable set CUTTLEFISH_RUNS_ON -R paprikacd/paprika \
     --body '["self-hosted","cuttlefish"]'
   ```

   The value must be JSON: a quoted string or an array of labels. Add `macOS`
   or `ARM64` to pin a platform when more than one kind of runner carries the
   `cuttlefish` label.
4. Re-run CI on a branch pull request and check that the portable jobs report
   the Cuttlefish runner's name in their **Set up job** step.

## Throughput

One runner runs one job at a time. The eight portable jobs therefore run one
after another on a single runner, where GitHub-hosted runners run them in
parallel. `cuttle agent github-runner register` keeps one runner per repository
on a host, so register on more rigs, or add managed runners in the Cuttlefish
console, to run jobs in parallel.

## Roll back

```sh
gh variable delete CUTTLEFISH_RUNS_ON -R paprikacd/paprika
```

Every job returns to `ubuntu-latest` on the next run. To remove the runner, run
`cuttle agent github-runner deregister --repo paprikacd/paprika`, or delete it
under **Settings → Actions → Runners**.

## Status

```sh
cuttle agent status
cuttle agent logs
gh api repos/paprikacd/paprika/actions/runners --jq '.runners[].name'
```
