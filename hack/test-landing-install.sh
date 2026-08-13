#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
landing="${repo_root}/landing/index.html"
cli_docs="${repo_root}/docs/cli.md"
getting_started="${repo_root}/docs/getting-started.md"

install_command='curl -fsSL https://raw.githubusercontent.com/paprikacd/paprika/master/install.sh | sh'
login_command='paprika login --server https://paprika.benebsworth.com'
status_command='paprika status'
checksum_url='https://github.com/paprikacd/paprika/releases/download/vX.Y.Z/checksums.txt'

fail() {
  printf 'landing install contract: %s\n' "$1" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local literal="$2"
  local description="$3"
  grep -Fq -- "${literal}" "${file}" || fail "${description} (${file#"${repo_root}/"})"
}

require_regex() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  grep -Eq -- "${pattern}" "${file}" || fail "${description} (${file#"${repo_root}/"})"
}

for file in "${landing}" "${cli_docs}" "${getting_started}"; do
  [[ -f "${file}" ]] || fail "missing ${file#"${repo_root}/"}"
  require_literal "${file}" "${install_command}" "missing canonical installer command"
  require_literal "${file}" "${login_command}" "missing canonical login command"
  require_literal "${file}" "${status_command}" "missing status command"
  require_literal "${file}" "${checksum_url}" "missing pinned checksum URL pattern"
done

require_regex "${landing}" 'href="#install"[^>]*>[^<]*Install CLI|>[^<]*Install CLI[^<]*</a>' 'missing visible Install CLI anchor'
require_literal "${landing}" 'id="install"' 'missing dedicated install section'
require_regex "${landing}" 'Darwin[^<]*(and|/|,)[^<]*Linux|Darwin|macOS' 'missing Darwin/macOS platform guidance'
require_literal "${landing}" 'Linux' 'missing Linux platform guidance'
require_literal "${landing}" 'amd64' 'missing amd64 platform guidance'
require_literal "${landing}" 'arm64' 'missing arm64 platform guidance'
require_literal "${landing}" 'PAPRIKA_VERSION' 'missing version pin guidance'
require_literal "${landing}" 'PAPRIKA_INSTALL_DIR' 'missing install directory guidance'
require_regex "${landing}" '[Cc]hecksum' 'missing checksum verification guidance'
require_regex "${landing}" '[Ss]ource' 'missing source install guidance'
require_regex "${landing}" 'sudo' 'missing no-sudo guidance'
require_literal "${landing}" 'PATH' 'missing PATH fallback guidance'
require_regex "${landing}" 'aria-live="polite"' 'missing polite copy live region'
require_regex "${landing}" ':focus-visible' 'missing keyboard focus-visible styling'
require_regex "${landing}" '@media[[:space:]]*\(prefers-reduced-motion:[[:space:]]*reduce\)' 'missing reduced-motion CSS'
require_regex "${landing}" 'type="button"[^>]*data-copy-target="[^\"]+"[^>]*aria-label="[^\"]+"|type="button"[^>]*aria-label="[^\"]+"[^>]*data-copy-target="[^\"]+"' 'missing accessible copy buttons'
require_literal "${landing}" 'navigator.clipboard' 'missing Clipboard API copy behavior'
require_literal "${landing}" 'document.execCommand' 'missing safe clipboard fallback'
require_literal "${landing}" 'textContent' 'copy feedback must use a text-only sink'
if grep -Fq -- 'innerHTML' "${landing}"; then
  fail 'copy behavior must not use an innerHTML sink'
fi

copy_targets=()
while IFS= read -r target; do
  copy_targets+=("${target}")
done < <(grep -oE 'data-copy-target="[^"]+"' "${landing}" | cut -d'"' -f2)
[[ ${#copy_targets[@]} -ge 3 ]] || fail 'expected at least three copy controls'
accessible_copy_count=$(grep -Ec 'type="button"[^>]*data-copy-target="[^"]+"[^>]*aria-label="[^"]+"|type="button"[^>]*aria-label="[^"]+"[^>]*data-copy-target="[^"]+"' "${landing}")
[[ ${accessible_copy_count} -eq ${#copy_targets[@]} ]] || fail 'every copy control must be a labeled button'
[[ $(printf '%s\n' "${copy_targets[@]}" | sort -u | wc -l | tr -d ' ') -eq ${#copy_targets[@]} ]] || fail 'copy controls must have unique targets'
for target in "${copy_targets[@]}"; do
  [[ $(grep -cF -- "id=\"${target}\"" "${landing}") -eq 1 ]] || fail "copy target '${target}' must resolve to exactly one element"
done

if grep -Eqi -- 'brew[[:space:]]+install|available (on|via) Homebrew|Homebrew support(ed)?' "${landing}" "${cli_docs}" "${getting_started}"; then
  fail 'Homebrew must not be presented as a supported install path'
fi
if grep -Eqi -- 'v0\.1\.0[^<\n]*first release' "${landing}"; then
  fail 'landing must not claim an unreleased v0.1.0 release'
fi

for file in "${cli_docs}" "${getting_started}"; do
  require_literal "${file}" 'PAPRIKA_VERSION' 'docs missing version pin guidance'
  require_literal "${file}" 'PAPRIKA_INSTALL_DIR' 'docs missing install directory guidance'
  require_regex "${file}" '[Cc]hecksum' 'docs missing checksum verification guidance'
  require_regex "${file}" 'sudo' 'docs missing no-sudo guidance'
  require_literal "${file}" 'PATH' 'docs missing PATH fallback guidance'
  require_regex "${file}" 'Homebrew[^\n]*(not|isn.t|is not)[^\n]*(supported|available)|Homebrew[^\n]*(supported|available)[^\n]*(not|isn.t|is not)' 'docs must state that Homebrew is not yet supported'
done

printf 'landing install contract: PASS\n'
