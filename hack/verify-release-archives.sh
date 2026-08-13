#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s ASSET_DIRECTORY VERSION\n' "$0" >&2
  exit 2
fi

asset_dir="$1"
version="$2"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT

targets=(darwin_amd64 darwin_arm64 linux_amd64 linux_arm64)
for target in "${targets[@]}"; do
  archive="${asset_dir}/paprika_${version}_${target}.tar.gz"
  test -f "${archive}"

  entries=()
  while IFS= read -r entry; do
    entries+=("${entry}")
  done < <(tar -tzf "${archive}")
  if [[ ${#entries[@]} -ne 1 || "${entries[0]}" != "paprika" ]]; then
    printf '%s must contain exactly one root entry named paprika\n' "${archive}" >&2
    exit 1
  fi
  listing="$(tar -tvzf "${archive}")"
  if [[ "${listing:0:1}" != "-" ]]; then
    printf '%s root entry must be a regular file\n' "${archive}" >&2
    exit 1
  fi

  target_dir="${work_dir}/${target}"
  mkdir "${target_dir}"
  tar -xzf "${archive}" -C "${target_dir}"
  binary="${target_dir}/paprika"
  if [[ ! -f "${binary}" || -L "${binary}" || ! -x "${binary}" ]]; then
    printf '%s must contain one regular non-symlink executable\n' "${archive}" >&2
    exit 1
  fi

  description="$(file -b "${binary}")"
  case "${target}" in
    darwin_amd64) pattern='Mach-O 64-bit.*(x86_64|x86-64)' ;;
    darwin_arm64) pattern='Mach-O 64-bit.*(arm64|ARM64)' ;;
    linux_amd64) pattern='ELF 64-bit.*(x86-64|x86_64)' ;;
    linux_arm64) pattern='ELF 64-bit.*(ARM aarch64|aarch64|ARM64)' ;;
  esac
  if ! grep -Eiq "${pattern}" <<<"${description}"; then
    printf '%s has wrong binary format or architecture\n' "${archive}" >&2
    exit 1
  fi
done
