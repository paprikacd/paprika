#!/usr/bin/env bash
# Prove that the exact published images are readable without the CI push token.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo 'At least one immutable Paprika image reference is required' >&2
  exit 1
fi
for image in "$@"; do
  if [[ ! "$image" =~ ^ghcr\.io/paprikacd/paprika(-render-worker)?@sha256:[0-9a-f]{64}$ ]]; then
    echo 'Anonymous image checks require an immutable Paprika image digest' >&2
    exit 1
  fi
done

anonymous_docker_config="$(mktemp -d)"
trap 'rm -rf "$anonymous_docker_config"' EXIT
# An explicit empty registry entry prevents Docker from auto-selecting a host
# credential helper. Never read or copy the publishing job's Docker config.
printf '%s\n' '{"auths":{"ghcr.io":{}}}' > "$anonymous_docker_config/config.json"
for image in "$@"; do
  # Newer Docker CLIs also accept credentials from DOCKER_AUTH_CONFIG.
  env -u DOCKER_AUTH_CONFIG docker --config "$anonymous_docker_config" \
    manifest inspect "$image" > /dev/null
done
