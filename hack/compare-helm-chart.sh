#!/usr/bin/env bash

set -euo pipefail

compare_archives() {
  (
    set -euo pipefail
    local_archive="$1"
    remote_archive="$2"
    work_dir="$(mktemp -d)"
    trap 'rm -rf -- "${work_dir}"' EXIT

    local_tree="${work_dir}/local"
    remote_tree="${work_dir}/remote"
    mkdir -p "${local_tree}" "${remote_tree}"
    tar -xzf "${local_archive}" -C "${local_tree}"
    tar -xzf "${remote_archive}" -C "${remote_tree}"

    local_chart="${local_tree}/paprika/Chart.yaml"
    remote_chart="${remote_tree}/paprika/Chart.yaml"
    test -f "${local_chart}"
    test -f "${remote_chart}"
    helm show chart "${local_archive}" >"${local_chart}"
    helm show chart "${remote_archive}" >"${remote_chart}"
    diff --recursive --unified "${local_tree}" "${remote_tree}"
  )
}

self_test() {
  (
    set -euo pipefail
    fixture_dir="$(mktemp -d)"
    trap 'rm -rf -- "${fixture_dir}"' EXIT
    mkdir -p "${fixture_dir}/a/templates" "${fixture_dir}/b/templates" "${fixture_dir}/packages"

    printf '%s\n' \
      'apiVersion: v2' \
      'name: paprika' \
      'version: 0.1.0' \
      'appVersion: "0.1.0"' >"${fixture_dir}/a/Chart.yaml"
    printf '%s\n' \
      'name: paprika' \
      'appVersion: 0.1.0' \
      'version: 0.1.0' \
      'apiVersion: v2' >"${fixture_dir}/b/Chart.yaml"
    printf '%s\n' 'kind: ConfigMap' >"${fixture_dir}/a/templates/config.yaml"
    cp "${fixture_dir}/a/templates/config.yaml" "${fixture_dir}/b/templates/config.yaml"

    helm package "${fixture_dir}/a" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/a.tgz"
    helm package "${fixture_dir}/b" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/b.tgz"
    compare_archives "${fixture_dir}/a.tgz" "${fixture_dir}/b.tgz"

    printf '%s\n' 'kind: Secret' >"${fixture_dir}/b/templates/config.yaml"
    helm package "${fixture_dir}/b" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/different.tgz"
    if compare_archives "${fixture_dir}/a.tgz" "${fixture_dir}/different.tgz" >/dev/null 2>&1; then
      printf 'chart comparison accepted different substantive contents\n' >&2
      exit 1
    fi
  )
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

if [[ $# -ne 2 ]]; then
  printf 'usage: %s LOCAL_CHART.tgz REMOTE_CHART.tgz\n' "$0" >&2
  exit 2
fi

compare_archives "$1" "$2"
