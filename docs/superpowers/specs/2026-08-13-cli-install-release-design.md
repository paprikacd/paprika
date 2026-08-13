# CLI Installation and Release Design

**Date:** 2026-08-13
**Status:** Approved for implementation

## Goal

Make `paprika login --server https://paprika.benebsworth.com` work for a new user after one obvious installation command, while giving contributors a small, consistent Taskfile interface for everyday development.

## Context

Paprika now has a browser-login and authorized status CLI, but the repository has no published releases and no CLI installer. The existing GoReleaser configuration builds `cmd/main.go` as a binary named `paprika`; that is the operator/server entrypoint, not `cmd/paprika`. Advertising the current release artifact as the CLI would therefore be incorrect.

The project already has a comprehensive Makefile and a static GitHub Pages landing site. This change should wrap those existing workflows rather than replace them.

## Considered approaches

### 1. Checksum-verified install script backed by GitHub Releases — selected

Publish Darwin and Linux CLI archives for `amd64` and `arm64`, plus `checksums.txt`. A small POSIX shell installer detects the platform, downloads the matching archive and checksum, verifies it, and installs `paprika` into a directory already on `PATH` when possible.

This works immediately from the existing repository and release workflow, requires no additional package repository, and is easy to test offline.

### 2. Homebrew tap as the primary path

This is excellent ergonomically, but proper `brew install paprikacd/tap/paprika` distribution requires a separate `paprikacd/homebrew-tap` repository and another publication credential/automation boundary. Creating and operating that repository is disproportionate for the first release. It can be layered on later without changing the archive or installer contract.

### 3. `go install` only

`go install github.com/benebsworth/paprika/cmd/paprika@latest` avoids release scripting, but requires a matching Go toolchain and exposes the historical module path. It is suitable for contributors, not the primary end-user installation path.

## Distribution architecture

GoReleaser will define two explicit builds:

- `cli`: `./cmd/paprika`, binary name `paprika`, Darwin/Linux and amd64/arm64, included in user-facing archives.
- `server`: `./cmd`, binary name `paprika-server`, Linux/amd64, used only to preserve the versioned container image produced by tagged releases.

`.goreleaser.yaml` will restrict the archive to the `cli` build and the Docker publisher to the `server` build by ID. `Dockerfile.goreleaser` will copy `paprika-server` and retain `/paprika` as the container entrypoint. This explicit split prevents either build from being substituted for the other.

Archives will include only the `cli` build and use the stable filename:

`paprika_<version>_<os>_<arch>.tar.gz`

The installer maps `uname` values to those exact lowercase Go platform names. It accepts:

- `PAPRIKA_VERSION` to pin a version; otherwise it resolves the latest non-prerelease GitHub release.
- `PAPRIKA_INSTALL_DIR` to override the destination.

Pins accept either `v0.1.0` or `0.1.0`. The installer validates semantic-version syntax, normalizes the release tag to `v0.1.0`, and normalizes the asset version to `0.1.0`. Thus tag `v0.1.0` maps exactly to `paprika_0.1.0_<os>_<arch>.tar.gz`; untrusted version input never becomes an unchecked URL path.

The default destination is the first existing, writable directory already present on `PATH` among `/opt/homebrew/bin`, `/usr/local/bin`, and `$HOME/.local/bin`. If none qualifies, it creates `$HOME/.local/bin` and prints the exact shell command needed to add it to `PATH`.

The installer will:

1. Require `curl`, `tar`, and either `sha256sum` or `shasum`.
2. Reject unsupported operating systems and architectures before downloading.
3. Create a mode-0700 temporary directory and clean it with a trap.
4. Download the archive and `checksums.txt` from the same immutable release tag over HTTPS.
5. Require exactly one well-formed checksum entry for the archive and verify it before extraction.
6. Reject archives that contain a missing, duplicate, non-regular, or path-qualified `paprika` entry.
7. Extract the expected binary, copy it to a mode-0755 temporary file created in the destination directory, and atomically rename that file over the destination only after every check succeeds. Any download, checksum, extraction, or copy failure leaves an existing executable unchanged.
8. Never invoke `sudo` implicitly.
9. Print `paprika login --server https://paprika.benebsworth.com` as the next step.

The release will also add a `paprika version` command populated by GoReleaser linker flags. Development builds report `dev` without failing.

## Taskfile interface

`Taskfile.yml` schema v3 will be a discoverable, thin interface over established Make/npm commands:

- `task` / `task --list`: show available tasks.
- `task build`: build the CLI to `bin/paprika`.
- `task build:all`: build CLI, embedded UI, and server.
- `task install`: install the CLI from source with `go install ./cmd/paprika`.
- `task test`: run the established Go test target.
- `task test:race`: run race tests.
- `task test:e2e`: run the Kind end-to-end suite.
- `task lint`: run Go and UI lint.
- `task check`: run generation drift-relevant checks, tests, and lint.
- `task generate`: run code generation.
- `task ui:dev`, `task ui:test`, `task ui:build`: common UI workflows.
- `task docker:build`: build the container using the existing image variable.
- `task clean`: remove only generated local build/test output owned by these workflows.

Make remains the underlying source of truth for existing project automation. Task commands do not duplicate long recipes or change CI semantics.

## Landing-page experience

The existing sharp, confident, warm visual language remains unchanged. Installation becomes the primary onboarding action without redesigning unrelated sections.

The hero will show a compact command surface with two explicit steps:

```sh
curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh
paprika login --server https://paprika.benebsworth.com
```

The command surface will include an accessible copy button with visible success feedback and keyboard focus styling. A short install section below the hero will explain supported platforms, the default installation location behavior, version pinning, and source-install fallback. The existing dashboard and GitHub links remain available but no longer obscure the first CLI action.

The README and CLI docs will repeat the canonical commands and link to the release checksums. The landing page will not claim Homebrew support until a real tap exists.

## Testing and validation

### Installer

An offline shell test will place fake release archives/checksums behind a controlled `curl` shim and prove:

- Darwin/Linux and amd64/arm64 mapping selects the expected asset.
- A valid archive installs an executable `paprika` in the requested directory.
- Checksum mismatch, malformed/duplicate checksum entries, truncated extraction, and invalid archive layout fail without replacing an existing binary.
- Unsupported platforms fail before download.
- Missing checksum entries and missing required tools produce actionable, non-secret errors.
- Temporary files are removed.

### Release

- `goreleaser check` validates configuration.
- A snapshot CLI build is executed and the produced binary must expose `login`, `status`, and `version`.
- GoReleaser creates a draft GitHub release and uploads archives/checksums to it. The workflow verifies the exact four archives, checksum asset, CLI contents, server image, and Helm publication before changing the release from draft to public/latest. A failed workflow therefore cannot become the release selected by the installer.
- After tagging, a clean temporary environment runs the public installer pinned to `v0.1.0`, verifies `paprika version`, completes a real browser login, and queries `paprika status`.

### Taskfile

A contract test parses `task --list` and runs safe focused tasks (`build`, CLI tests, UI lint/test wrappers) to ensure they delegate correctly. Destructive deployment tasks are intentionally not added.

### Landing and docs

- A static contract test checks that the canonical installer and login commands are present and copy controls have accessible labels.
- The landing page is inspected at desktop and mobile widths, including keyboard focus and reduced-motion behavior.
- The existing GitHub Pages workflow publishes the change after merge.

## Rollout

1. Merge through a reviewed pull request after all CI gates pass.
2. Confirm the landing GitHub Pages deployment succeeds.
3. Tag the exact merged commit as `v0.1.0` and push the tag.
4. Follow the Release workflow through draft creation, exact artifact/Helm verification, and the final explicit publish step; inspect its four CLI archives plus checksum asset.
5. Run the public installer and live login/status validation from a clean temporary environment.
6. Only then advertise `v0.1.0` as available.

If the release workflow fails, do not create a replacement tag with the same name. Fix the workflow on `master`, use the next patch version, and keep the failed release as draft or remove it before advertising.
