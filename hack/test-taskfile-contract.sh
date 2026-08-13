#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
taskfile=$repo_root/Taskfile.yml

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" || fail "$file does not contain: $expected"
}

assert_log() {
  local expected=$1
  local actual
  actual=$(cat "$contract_log")
  [[ "$actual" == "$expected" ]] || fail "delegation mismatch
expected:
$expected
actual:
$actual"
}

run_task() {
  : >"$contract_log"
  PATH="$shim_dir:$PATH" CONTRACT_LOG="$contract_log" \
    CONTRACT_IMG_CAPTURE="${CONTRACT_IMG_CAPTURE:-}" \
    task --silent --dir "$repo_root" "$@"
}

[[ -f "$taskfile" ]] || fail "Taskfile.yml does not exist"

task_list=$(task --dir "$repo_root" --list)
default_list=$(task --silent --dir "$repo_root")
[[ "$default_list" == "$task_list" ]] || fail 'the default task must list available tasks'

assert_listed_task() {
  local task_name=$1
  local description=$2
  local task_line
  task_line=$(grep -E "^[[:space:]]*\*[[:space:]]+$task_name:" <<<"$task_list" || true)
  [[ -n "$task_line" ]] || fail "task --list does not expose $task_name"
  [[ "$task_line" == *"$description"* ]] ||
    fail "task $task_name does not show its documented description"
}

assert_listed_task build 'Build the Paprika CLI to bin/paprika.'
assert_listed_task build:all 'Build the CLI, embedded UI, and server.'
assert_listed_task install 'Install the Paprika CLI from source.'
assert_listed_task test 'Run Go tests.'
assert_listed_task test:race 'Run Go tests with the race detector.'
assert_listed_task test:e2e 'Run the Kind end-to-end test suite.'
assert_listed_task lint 'Run Go and UI linters.'
assert_listed_task check 'Run generation, tests, and linters.'
assert_listed_task generate 'Run project code generation.'
assert_listed_task ui:dev 'Run the UI development server.'
assert_listed_task ui:test 'Run UI tests.'
assert_listed_task ui:build 'Build the UI.'
assert_listed_task docker:build 'Build the container image.'
assert_listed_task clean 'Remove local build and test output.'

all_tasks=$(task --dir "$repo_root" --list-all)
if grep -Eq '^[[:space:]]*\*[[:space:]]+([^:[:space:]]+:)?(deploy|push):' <<<"$all_tasks"; then
  fail 'Taskfile must not expose deploy or push tasks'
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/paprika-taskfile-contract.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT
shim_dir=$temp_dir/bin
contract_log=$temp_dir/delegation.log
mkdir -p "$shim_dir"

for command_name in make npm go; do
  cat >"$shim_dir/$command_name" <<'SHIM'
#!/bin/sh
printf '%s|%s|%s\n' "$(basename "$0")" "$PWD" "$*" >>"$CONTRACT_LOG"
if [ "$(basename "$0")" = make ] && [ -n "${CONTRACT_IMG_CAPTURE:-}" ]; then
  printf '%s' "${IMG-}" >"$CONTRACT_IMG_CAPTURE"
fi
SHIM
  chmod +x "$shim_dir/$command_name"
done

run_task build
assert_log "make|$repo_root|build-cli"

run_task build:all
assert_log "make|$repo_root|build-cli build-with-ui"

run_task install
assert_log "go|$repo_root|install ./cmd/paprika"
if grep -Eq 'install (\./cmd$|\./cmd/main\.go)' "$contract_log"; then
  fail 'task install targets the server instead of ./cmd/paprika'
fi

run_task test
assert_log "make|$repo_root|test"

run_task test:race
assert_log "make|$repo_root|test-race"

run_task test:e2e
assert_log "make|$repo_root|test-e2e"

run_task generate
assert_log "make|$repo_root|generate"

run_task ui:dev
assert_log "npm|$repo_root/ui|run dev"

run_task ui:test
assert_log "npm|$repo_root/ui|run test"

run_task ui:build
assert_log "npm|$repo_root/ui|run build"

run_task lint
assert_log "make|$repo_root|lint
npm|$repo_root/ui|run lint"

run_task check
assert_log "make|$repo_root|generate
make|$repo_root|test
make|$repo_root|lint
npm|$repo_root/ui|run lint"

run_task docker:build IMG=example.invalid/paprika:contract
assert_log "make|$repo_root|docker-build"

img_capture=$temp_dir/img.capture
injection_one=$temp_dir/injected-one
injection_two=$temp_dir/injected-two
adversarial_img=$(printf '%s\n %s' \
  "repo.invalid/paprika:tag'\"\$(touch $injection_one)\`touch $injection_two\`" \
  'value with whitespace')
CONTRACT_IMG_CAPTURE=$img_capture run_task docker:build IMG="$adversarial_img"
assert_log "make|$repo_root|docker-build"
[[ ! -e "$injection_one" && ! -e "$injection_two" ]] || fail 'IMG executed shell content'
[[ $(cat "$img_capture") == "$adversarial_img" ]] || fail 'docker:build did not preserve IMG exactly'

CONTRACT_IMG_CAPTURE=$img_capture run_task docker:build
assert_log "make|$repo_root|docker-build"
[[ $(cat "$img_capture") == 'ghcr.io/paprikacd/paprika:latest' ]] ||
  fail 'docker:build did not provide the default IMG environment value'

clean_root=$temp_dir/clean-fixture
mkdir -p "$clean_root/bin" "$clean_root/.goreleaser-dist" "$clean_root/ui/out" \
  "$clean_root/ui/coverage" "$clean_root/dist"
cp "$taskfile" "$clean_root/Taskfile.yml"
touch "$clean_root/bin/paprika" "$clean_root/cover.out" "$clean_root/coverage.out" \
  "$clean_root/.goreleaser-dist/archive" "$clean_root/ui/out/index.html" \
  "$clean_root/ui/coverage/index.html"
printf 'tracked installer bundle\n' >"$clean_root/dist/install.yaml"
printf 'unrelated binary\n' >"$clean_root/bin/manager"
printf 'unrelated output\n' >"$clean_root/unrelated.out"

task --silent --dir "$clean_root" clean

for removed_path in bin/paprika cover.out coverage.out .goreleaser-dist ui/out ui/coverage; do
  [[ ! -e "$clean_root/$removed_path" ]] || fail "clean left generated output: $removed_path"
done
for preserved_path in dist/install.yaml bin/manager unrelated.out; do
  [[ -e "$clean_root/$preserved_path" ]] || fail "clean removed unrelated or tracked file: $preserved_path"
done
assert_file_contains "$clean_root/dist/install.yaml" 'tracked installer bundle'

for symlink_parent in bin .goreleaser-dist ui ui/out ui/coverage; do
  symlink_root=$temp_dir/symlink-${symlink_parent//\//-}
  external_root=$temp_dir/external-${symlink_parent//\//-}
  mkdir -p "$symlink_root/bin" "$symlink_root/.goreleaser-dist" \
    "$symlink_root/ui/out" "$symlink_root/ui/coverage" "$external_root"
  cp "$taskfile" "$symlink_root/Taskfile.yml"
  printf 'external canary\n' >"$external_root/canary"
  rm -rf "${symlink_root:?}/$symlink_parent"
  ln -s "$external_root" "$symlink_root/$symlink_parent"

  if task --silent --dir "$symlink_root" clean >/dev/null 2>&1; then
    fail "clean accepted symlinked scoped parent: $symlink_parent"
  fi
  assert_file_contains "$external_root/canary" 'external canary'
done

readme=$repo_root/README.md
installer_command='curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh'
login_command='paprika login --server https://paprika.benebsworth.com'
status_command='paprika status'
checksum_url='https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt'
markdown_tick=$(printf '\140')
local_bin='~'/.local/bin
path_guidance="printed ${markdown_tick}PATH${markdown_tick} export"
gobin_guidance="${markdown_tick}GOBIN${markdown_tick}"
go_bin_guidance="Go bin directory is on ${markdown_tick}PATH${markdown_tick}"

assert_file_contains "$readme" "$installer_command"
assert_file_contains "$readme" "$login_command"
assert_file_contains "$readme" "$status_command"
assert_file_contains "$readme" 'go install ./cmd/paprika'
assert_file_contains "$readme" 'task install'
assert_file_contains "$readme" "$checksum_url"
assert_file_contains "$readme" "$local_bin"
assert_file_contains "$readme" "$path_guidance"
assert_file_contains "$readme" "$gobin_guidance"
assert_file_contains "$readme" "$go_bin_guidance"

installer_line=$(grep -Fn "$installer_command" "$readme" | head -1 | cut -d: -f1)
path_line=$(grep -Fn "$path_guidance" "$readme" | head -1 | cut -d: -f1)
login_line=$(grep -Fn "$login_command" "$readme" | head -1 | cut -d: -f1)
status_line=$(grep -Fn "$status_command" "$readme" | head -1 | cut -d: -f1)
((installer_line < path_line && path_line < login_line && login_line < status_line)) ||
  fail 'README must explain PATH before leading into login and status'

if grep -Eqi 'homebrew|brew install' "$readme"; then
  fail 'README must not claim Homebrew support'
fi

printf 'Taskfile and README contract tests passed.\n'
