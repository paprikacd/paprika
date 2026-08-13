#!/usr/bin/env bash

set -euo pipefail

helm_cmd() {
  "${HELM_BIN:-helm}" "$@"
}

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
    helm_cmd show chart "${local_archive}" >"${local_chart}"
    helm_cmd show chart "${remote_archive}" >"${remote_chart}"
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

    helm_cmd package "${fixture_dir}/a" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/a.tgz"
    helm_cmd package "${fixture_dir}/b" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/b.tgz"
    compare_archives "${fixture_dir}/a.tgz" "${fixture_dir}/b.tgz"

    printf '%s\n' 'kind: Secret' >"${fixture_dir}/b/templates/config.yaml"
    helm_cmd package "${fixture_dir}/b" --destination "${fixture_dir}/packages" >/dev/null
    mv "${fixture_dir}/packages/paprika-0.1.0.tgz" "${fixture_dir}/different.tgz"
    if compare_archives "${fixture_dir}/a.tgz" "${fixture_dir}/different.tgz" >/dev/null 2>&1; then
      printf 'chart comparison accepted different substantive contents\n' >&2
      exit 1
    fi

    mock_helm="${fixture_dir}/mock-helm"
    cat >"${mock_helm}" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pull" ]]; then
  destination=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--destination" ]]; then
      destination="$2"
      break
    fi
    shift
  done
  cp "${MOCK_ARCHIVE}" "${destination}/paprika-0.1.0.tgz"
else
  exec "${REAL_HELM}" "$@"
fi
MOCK
    chmod +x "${mock_helm}"
    HELM_BIN="${mock_helm}" REAL_HELM="$(command -v helm)" MOCK_ARCHIVE="${fixture_dir}/b.tgz" \
      compare_oci_ref "${fixture_dir}/a.tgz" \
      'oci://ghcr.io/paprikacd/charts/paprika@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    if compare_oci_ref "${fixture_dir}/a.tgz" 'oci://ghcr.io/paprikacd/charts/paprika:0.1.0' >/dev/null 2>&1; then
      printf 'mutable chart reference unexpectedly passed\n' >&2
      exit 1
    fi
  )
}

compare_oci_ref() {
  (
    set -euo pipefail
    local_archive="$1"
    oci_digest_ref="$2"
    if [[ ! "${oci_digest_ref}" =~ ^oci://[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
      printf 'chart OCI reference must be digest-addressed\n' >&2
      exit 2
    fi
    pull_dir="$(mktemp -d)"
    trap 'rm -rf -- "${pull_dir}"' EXIT
    helm_cmd pull "${oci_digest_ref}" --destination "${pull_dir}"
    archives=()
    while IFS= read -r archive; do
      archives+=("${archive}")
    done < <(find "${pull_dir}" -maxdepth 1 -type f -name '*.tgz' -print)
    if [[ ${#archives[@]} -ne 1 ]]; then
      printf 'digest pull returned %s chart archives, want one\n' "${#archives[@]}" >&2
      exit 1
    fi
    compare_archives "${local_archive}" "${archives[0]}"
  )
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

if [[ "${1:-}" == "--oci" ]]; then
  if [[ $# -ne 3 ]]; then
    printf 'usage: %s --oci LOCAL_CHART.tgz OCI_DIGEST_REF\n' "$0" >&2
    exit 2
  fi
  compare_oci_ref "$2" "$3"
  exit 0
fi

if [[ $# -ne 2 ]]; then
  printf 'usage: %s LOCAL_CHART.tgz REMOTE_CHART.tgz\n' "$0" >&2
  exit 2
fi

compare_archives "$1" "$2"
