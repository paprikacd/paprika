#!/usr/bin/env bash
# Ensures, verifies and reports the pinned tools for the local CI runner.
#
#   hack/ci/tools.sh ensure  download missing pinned binaries into bin/ci-tools
#                            (sha256 checked against the published checksums), then verify
#   hack/ci/tools.sh verify  check every tool; download nothing; nonzero on any mismatch
#   hack/ci/tools.sh json    print the pinned tool versions as one JSON object (verifies first)
#
# Helm, kind and Terraform are installed into bin/ci-tools and always used from there, so the
# host Helm 4 never shadows the pinned Helm 3. Task, GoReleaser and Go are checked where they are.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CI_TOOL_FAILURES=0
CI_TOOL_TMP=${PAPRIKA_CI_TMPDIR:-${TMPDIR:-/tmp}}

host_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) printf 'darwin-arm64\n' ;;
    Linux-x86_64) printf 'linux-amd64\n' ;;
    *) ci_die "no pinned tool set for $(uname -s)/$(uname -m); supported hosts are darwin/arm64 and linux/amd64" ;;
  esac
}

# Published SHA-256 values. Helm and Terraform: their release checksum files. kind darwin/arm64:
# kind-darwin-arm64.sha256sum for v0.32.0. kind linux/amd64 is the value ci.yml pins.
helm_sha256() {
  case $1 in
    darwin-arm64) printf 'aea537342b4c03cf58e089cb8dc99468087bb1a0218531df40462faca3f6c5d3\n' ;;
    linux-amd64) printf '0a745198de24545d0055cd8414bc8d2ba10363ef5f5d38369ea1b399671cc083\n' ;;
  esac
}

kind_sha256() {
  case $1 in
    darwin-arm64) printf 'dca67911095a110c2b5c36e26df6cac860c602033e456c0db47be498cdef1ebb\n' ;;
    linux-amd64) printf '%s\n' "$CI_KIND_LINUX_AMD64_SHA256" ;;
  esac
}

terraform_sha256() {
  case $1 in
    darwin-arm64) printf '5d91a8d6877e792de00be8db2324a2561edeb312ec2ff141b877131b82622c76\n' ;;
    linux-amd64) printf '364c6ee08b0cb8fcbb28a115aacb2aa48e88abc56c149170bd65c2f75d98ea8d\n' ;;
  esac
}

# fetch <url> <sha256> <dest>: download to a partial file, verify, then move into place.
fetch() {
  curl --fail --location --retry 3 --retry-all-errors --silent --show-error \
    --output "$3.part" "$1"
  if [ "$(ci_sha256_file "$3.part")" != "$2" ]; then
    rm -f -- "$3.part"
    ci_die "checksum mismatch for $1"
  fi
  mv -- "$3.part" "$3"
}

installed_helm() {
  [ -x "$CI_TOOL_BIN/helm" ] || return 0
  "$CI_TOOL_BIN/helm" version --template '{{.Version}}' 2>/dev/null || true
}

installed_kind() {
  [ -x "$CI_TOOL_BIN/kind" ] || return 0
  "$CI_TOOL_BIN/kind" version 2>/dev/null | awk '{print $2}' || true
}

installed_terraform() {
  [ -x "$CI_TOOL_BIN/terraform" ] || return 0
  "$CI_TOOL_BIN/terraform" version 2>/dev/null | head -1 | awk '{print $2}' | sed 's/^v//' || true
}

install_helm() {
  local plat=$1 tmp
  tmp=$(mktemp -d "$CI_TOOL_TMP/ci-tools-helm.XXXXXX")
  fetch "https://get.helm.sh/helm-$CI_HELM_VERSION-$plat.tar.gz" "$(helm_sha256 "$plat")" "$tmp/helm.tar.gz"
  tar -xzf "$tmp/helm.tar.gz" -C "$tmp" "$plat/helm"
  install -m 0755 "$tmp/$plat/helm" "$CI_TOOL_BIN/helm"
  rm -rf -- "$tmp"
}

install_kind() {
  local plat=$1 tmp
  tmp=$(mktemp -d "$CI_TOOL_TMP/ci-tools-kind.XXXXXX")
  fetch "https://github.com/kubernetes-sigs/kind/releases/download/$CI_KIND_VERSION/kind-$plat" \
    "$(kind_sha256 "$plat")" "$tmp/kind"
  install -m 0755 "$tmp/kind" "$CI_TOOL_BIN/kind"
  rm -rf -- "$tmp"
}

install_terraform() {
  local plat=$1 tmp zip
  tmp=$(mktemp -d "$CI_TOOL_TMP/ci-tools-terraform.XXXXXX")
  zip="$tmp/terraform.zip"
  fetch "https://releases.hashicorp.com/terraform/$CI_TERRAFORM_VERSION/terraform_${CI_TERRAFORM_VERSION}_${plat/-/_}.zip" \
    "$(terraform_sha256 "$plat")" "$zip"
  unzip -q -o "$zip" terraform -d "$tmp"
  install -m 0755 "$tmp/terraform" "$CI_TOOL_BIN/terraform"
  rm -rf -- "$tmp"
}

# report <tool> <expected> <actual> <path>: prints one line and counts a mismatch.
report() {
  if [ "$3" = "$2" ]; then
    ci_log "ok    $1 $3 ($4)"
  else
    ci_log "FAIL  $1: expected $2, found '${3:-none}' at '${4:-none}'"
    CI_TOOL_FAILURES=$((CI_TOOL_FAILURES + 1))
  fi
}

ensure_pinned() {
  local plat
  plat=$(host_platform)
  mkdir -p -- "$CI_TOOL_BIN"
  if [ "$(installed_helm)" != "$CI_HELM_VERSION" ]; then
    ci_log "installing helm $CI_HELM_VERSION into $CI_TOOL_BIN"
    install_helm "$plat"
  fi
  if [ "$(installed_kind)" != "$CI_KIND_VERSION" ]; then
    ci_log "installing kind $CI_KIND_VERSION into $CI_TOOL_BIN"
    install_kind "$plat"
  fi
  if [ "$(installed_terraform)" != "$CI_TERRAFORM_VERSION" ]; then
    ci_log "installing terraform $CI_TERRAFORM_VERSION into $CI_TOOL_BIN"
    install_terraform "$plat"
  fi
}

verify_all() {
  local actual node_bin version
  CI_TOOL_FAILURES=0

  actual=$(go version 2>/dev/null | awk '{print $3}' | sed 's/^go//' || true)
  report go "$CI_GO_VERSION" "$actual" "$(command -v go || true)"

  node_bin=$(ci_node_bin 2>/dev/null || true)
  version=""
  if [ -n "$node_bin" ]; then
    version=$("$node_bin/node" --version 2>/dev/null || true)
  fi
  report node "v$CI_NODE_VERSION" "$version" "${node_bin:-not found}"

  report helm "$CI_HELM_VERSION" "$(installed_helm)" "$CI_TOOL_BIN/helm"
  report kind "$CI_KIND_VERSION" "$(installed_kind)" "$CI_TOOL_BIN/kind"
  report terraform "$CI_TERRAFORM_VERSION" "$(installed_terraform)" "$CI_TOOL_BIN/terraform"

  actual=$(task --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  report task "$CI_TASK_VERSION" "$actual" "$(command -v task || true)"

  actual=$(goreleaser --version 2>/dev/null | awk -F': *' '/GitVersion/ {print $2}' | head -1 || true)
  report goreleaser "${CI_GORELEASER_VERSION#v}" "$actual" "$(command -v goreleaser || true)"

  if [ "$CI_TOOL_FAILURES" -ne 0 ]; then
    ci_die "$CI_TOOL_FAILURES pinned tool(s) do not match; run: task ci:tools"
  fi
}

main() {
  local command=${1:-}
  case "$command" in
    ensure)
      ensure_pinned
      verify_all
      ci_log "all pinned tools are present and verified"
      ;;
    verify)
      verify_all
      ci_log "all pinned tools match"
      ;;
    json)
      verify_all >&2
      ci_pins_json
      ;;
    *)
      ci_die "usage: hack/ci/tools.sh ensure|verify|json"
      ;;
  esac
}

# Sourced by the self-tests (fetch), so main runs only when executed.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
