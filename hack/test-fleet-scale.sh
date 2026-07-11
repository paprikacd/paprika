#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly GO_IMAGE_TAG="golang:1.26.0-bookworm"
readonly GO_IMAGE_DIGEST="sha256:4f7e5f23bfacf4c2934ba70c132532742b6a53f01a4209e2c2eb7bd06c16f0bc"
readonly GO_IMAGE_REF="${GO_IMAGE_TAG}@${GO_IMAGE_DIGEST}"
readonly PLAYWRIGHT_IMAGE_TAG="mcr.microsoft.com/playwright:v1.61.1-noble"
readonly PLAYWRIGHT_IMAGE_DIGEST="sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6"
readonly PLAYWRIGHT_IMAGE_REF="${PLAYWRIGHT_IMAGE_TAG}@${PLAYWRIGHT_IMAGE_DIGEST}"
readonly REQUIRED_DOCKER_PLATFORM="linux/amd64"
readonly REQUIRED_MEMORY_BYTES=$((8 * 1024 * 1024 * 1024))

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
artifact_dir="${repo_root}/artifacts/fleet-scale"
environment_file="${artifact_dir}/environment.txt"
api_container="paprika-fleet-api-scale-$$"
ui_container="paprika-fleet-ui-scale-$$"

rm -rf -- "${artifact_dir}"
mkdir -p "${artifact_dir}" "${repo_root}/bin"
: >"${environment_file}"

cleanup() {
  docker rm --force --volumes "${ui_container}" >/dev/null 2>&1 || true
  docker rm --force --volumes "${api_container}" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'fleet scale gate: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is required"
docker info >/dev/null 2>&1 || fail "Docker server is unavailable"

docker_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
case "${docker_platform}" in
  linux/x86_64) docker_platform="linux/amd64" ;;
esac
docker_memory_bytes="$(docker info --format '{{.MemTotal}}')"
[[ "${docker_memory_bytes}" =~ ^[0-9]+$ ]] || fail "Docker reported an invalid memory total: ${docker_memory_bytes}"

{
  printf 'UTC=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'HOST_UNAME=%s\n' "$(uname -a)"
  printf 'DOCKER_SERVER_VERSION=%s\n' "$(docker version --format '{{.Server.Version}}')"
  printf 'DOCKER_SERVER_PLATFORM=%s\n' "${docker_platform}"
  printf 'DOCKER_KERNEL=%s\n' "$(docker info --format '{{.KernelVersion}}')"
  printf 'DOCKER_CGROUP_DRIVER=%s\n' "$(docker info --format '{{.CgroupDriver}}')"
  printf 'DOCKER_CGROUP_VERSION=%s\n' "$(docker info --format '{{.CgroupVersion}}')"
  printf 'DOCKER_MEMORY_BYTES=%s\n' "${docker_memory_bytes}"
  printf 'GO_IMAGE_TAG=%s\n' "${GO_IMAGE_TAG}"
  printf 'GO_IMAGE_COMMITTED_DIGEST=%s\n' "${GO_IMAGE_DIGEST}"
  printf 'GO_IMAGE_REF=%s\n' "${GO_IMAGE_REF}"
  printf 'PLAYWRIGHT_IMAGE_TAG=%s\n' "${PLAYWRIGHT_IMAGE_TAG}"
  printf 'PLAYWRIGHT_IMAGE_COMMITTED_DIGEST=%s\n' "${PLAYWRIGHT_IMAGE_DIGEST}"
  printf 'PLAYWRIGHT_IMAGE_REF=%s\n' "${PLAYWRIGHT_IMAGE_REF}"
} >>"${environment_file}"

[[ "${docker_platform}" == "${REQUIRED_DOCKER_PLATFORM}" ]] ||
  fail "Docker server must report ${REQUIRED_DOCKER_PLATFORM}; got ${docker_platform}"
((docker_memory_bytes >= REQUIRED_MEMORY_BYTES)) ||
  fail "Docker must report at least ${REQUIRED_MEMORY_BYTES} bytes (8 GiB); got ${docker_memory_bytes}"

{
  docker pull --platform "${REQUIRED_DOCKER_PLATFORM}" "${GO_IMAGE_REF}"
  docker pull --platform "${REQUIRED_DOCKER_PLATFORM}" "${PLAYWRIGHT_IMAGE_REF}"
} 2>&1 | tee "${artifact_dir}/docker-pull.log"

go_image_digests="$(docker image inspect --format '{{json .RepoDigests}}' "${GO_IMAGE_REF}")"
playwright_image_digests="$(docker image inspect --format '{{json .RepoDigests}}' "${PLAYWRIGHT_IMAGE_REF}")"
[[ "${go_image_digests}" == *"${GO_IMAGE_DIGEST}"* ]] || fail "Go image digest verification failed"
[[ "${playwright_image_digests}" == *"${PLAYWRIGHT_IMAGE_DIGEST}"* ]] ||
  fail "Playwright image digest verification failed"
{
  printf 'GO_IMAGE_REPO_DIGESTS=%s\n' "${go_image_digests}"
  printf 'PLAYWRIGHT_IMAGE_REPO_DIGESTS=%s\n' "${playwright_image_digests}"
} >>"${environment_file}"

host_uid="$(id -u)"
host_gid="$(id -g)"

docker run \
  --name "${api_container}" \
  --platform "${REQUIRED_DOCKER_PLATFORM}" \
  --cpus 4 \
  --memory 8g \
  --mount "type=bind,source=${repo_root},target=/source,readonly" \
  --mount "type=bind,source=${repo_root}/bin,target=/workspace/bin" \
  --mount "type=bind,source=${artifact_dir},target=/workspace/artifacts/fleet-scale" \
  --workdir /source \
  --env GOMAXPROCS=4 \
  --env GOTOOLCHAIN=local \
  --env PAPRIKA_FLEET_SCALE_CONTROLLED=1 \
  --env GOCACHE=/tmp/paprika-go-build \
  --env GOMODCACHE=/tmp/paprika-go-mod \
  --env ARTIFACT_DIR=/workspace/artifacts/fleet-scale \
  --env ENVIRONMENT_FILE=/workspace/artifacts/fleet-scale/environment.txt \
  --env HOST_UID="${host_uid}" \
  --env HOST_GID="${host_gid}" \
  "${GO_IMAGE_REF}" \
  bash -Eeuo pipefail -c '
    read_cgroup_value() {
      local candidate
      for candidate in "$@"; do
        if [[ -r "${candidate}" ]]; then
          tr "\n" " " <"${candidate}" | sed "s/[[:space:]]*$//"
          return
        fi
      done
      printf "unavailable"
    }

    finish_api_container() {
      local status=$?
      local memory_peak
      trap - EXIT
      memory_peak="$(read_cgroup_value /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes)"
      {
        printf "API_CGROUP_CPU_MAX=%s\n" "$(read_cgroup_value /sys/fs/cgroup/cpu.max /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"
        printf "API_CGROUP_CPUSET=%s\n" "$(read_cgroup_value /sys/fs/cgroup/cpuset.cpus.effective /sys/fs/cgroup/cpuset/cpuset.cpus)"
        printf "API_CGROUP_MEMORY_MAX_BYTES=%s\n" "$(read_cgroup_value /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes)"
        printf "API_CONTAINER_MEMORY_PEAK_BYTES=%s\n" "${memory_peak}"
        printf "API_CGROUP_PIDS_MAX=%s\n" "$(read_cgroup_value /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids/pids.max)"
      } >>"${ENVIRONMENT_FILE}"
      if [[ ! "${memory_peak}" =~ ^[0-9]+$ ]]; then
        printf "API container did not expose a numeric cgroup peak-memory counter\n" >&2
        status=1
      fi
      chown -R "${HOST_UID}:${HOST_GID}" "${ARTIFACT_DIR}" /workspace/bin/fleet-console-fixture 2>/dev/null || true
      exit "${status}"
    }
    trap finish_api_container EXIT

    mkdir -p "${ARTIFACT_DIR}" /workspace/bin
    {
      printf "API_CONTAINER_UNAME=%s\n" "$(uname -a)"
      printf "GO_VERSION=%s\n" "$(go version)"
      printf "GOOS_GOARCH=%s/%s\n" "$(go env GOOS)" "$(go env GOARCH)"
      printf "GOMAXPROCS=%s\n" "${GOMAXPROCS}"
    } >>"${ENVIRONMENT_FILE}"

    go test ./internal/fleet -run "^TestFleetAPIScaleGate$" -count=1 -v 2>&1 |
      tee "${ARTIFACT_DIR}/api-scale.log"
    go build -o /workspace/bin/fleet-console-fixture ./test/fleetconsole 2>&1 |
      tee "${ARTIFACT_DIR}/fixture-build.log"
  '

grep -q 'FLEET_API_P95_MS=' "${artifact_dir}/api-scale.log" ||
  fail "API scale test did not emit FLEET_API_P95_MS"
grep -q 'FLEET_HEAP_BYTES=' "${artifact_dir}/api-scale.log" ||
  fail "API scale test did not emit FLEET_HEAP_BYTES"
[[ -x "${repo_root}/bin/fleet-console-fixture" ]] || fail "fixture binary was not built"

docker run \
  --name "${ui_container}" \
  --platform "${REQUIRED_DOCKER_PLATFORM}" \
  --cpus 4 \
  --memory 8g \
  --ipc host \
  --mount "type=bind,source=${repo_root},target=/source,readonly" \
  --mount "type=bind,source=${artifact_dir},target=/workspace/artifacts/fleet-scale" \
  --workdir /workspace \
  --env ARTIFACT_DIR=/workspace/artifacts/fleet-scale \
  --env ENVIRONMENT_FILE=/workspace/artifacts/fleet-scale/environment.txt \
  --env HOST_UID="${host_uid}" \
  --env HOST_GID="${host_gid}" \
  --env PLAYWRIGHT_NO_WEBSERVER=1 \
  --env PAPRIKA_FLEET_SCALE_CONTROLLED=1 \
  --env CI=true \
  "${PLAYWRIGHT_IMAGE_REF}" \
  bash -Eeuo pipefail -c '
    fixture_pid=""

    read_cgroup_value() {
      local candidate
      for candidate in "$@"; do
        if [[ -r "${candidate}" ]]; then
          tr "\n" " " <"${candidate}" | sed "s/[[:space:]]*$//"
          return
        fi
      done
      printf "unavailable"
    }

    finish_ui_container() {
      local status=$?
      local memory_peak
      trap - EXIT
      if [[ -n "${fixture_pid}" ]]; then
        kill "${fixture_pid}" >/dev/null 2>&1 || true
        wait "${fixture_pid}" >/dev/null 2>&1 || true
      fi
      memory_peak="$(read_cgroup_value /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes)"
      {
        printf "UI_CGROUP_CPU_MAX=%s\n" "$(read_cgroup_value /sys/fs/cgroup/cpu.max /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"
        printf "UI_CGROUP_CPUSET=%s\n" "$(read_cgroup_value /sys/fs/cgroup/cpuset.cpus.effective /sys/fs/cgroup/cpuset/cpuset.cpus)"
        printf "UI_CGROUP_MEMORY_MAX_BYTES=%s\n" "$(read_cgroup_value /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes)"
        printf "UI_CONTAINER_MEMORY_PEAK_BYTES=%s\n" "${memory_peak}"
        printf "UI_CGROUP_PIDS_MAX=%s\n" "$(read_cgroup_value /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids/pids.max)"
      } >>"${ENVIRONMENT_FILE}"
      if [[ ! "${memory_peak}" =~ ^[0-9]+$ ]]; then
        printf "UI container did not expose a numeric cgroup peak-memory counter\n" >&2
        status=1
      fi
      if [[ -d /workspace/ui/test-results ]]; then
        mkdir -p "${ARTIFACT_DIR}/test-results"
        cp -a /workspace/ui/test-results/. "${ARTIFACT_DIR}/test-results/"
      fi
      if [[ -d /workspace/ui/playwright-report ]]; then
        mkdir -p "${ARTIFACT_DIR}/playwright-report"
        cp -a /workspace/ui/playwright-report/. "${ARTIFACT_DIR}/playwright-report/"
      fi
      chown -R "${HOST_UID}:${HOST_GID}" "${ARTIFACT_DIR}" 2>/dev/null || true
      exit "${status}"
    }
    trap finish_ui_container EXIT

    mkdir -p /workspace/ui /workspace/bin "${ARTIFACT_DIR}"
    tar \
      --directory /source/ui \
      --exclude ./node_modules \
      --exclude ./.next \
      --exclude ./out \
      --exclude ./test-results \
      --exclude ./playwright-report \
      --create \
      --file - \
      . | tar --directory /workspace/ui --extract --file -
    install --mode 0755 /source/bin/fleet-console-fixture /workspace/bin/fleet-console-fixture
    cd /workspace/ui

    npm ci 2>&1 | tee "${ARTIFACT_DIR}/npm-ci.log"
    npm run build 2>&1 | tee "${ARTIFACT_DIR}/ui-build.log"

    chromium_path="$(node -e "console.log(require(\"playwright\").chromium.executablePath())")"
    {
      printf "UI_CONTAINER_UNAME=%s\n" "$(uname -a)"
      printf "NODE_VERSION=%s\n" "$(node --version)"
      printf "NPM_VERSION=%s\n" "$(npm --version)"
      printf "PLAYWRIGHT_VERSION=%s\n" "$(npx --no-install playwright --version)"
      printf "CHROMIUM_VERSION=%s\n" "$("${chromium_path}" --version 2>&1)"
    } >>"${ENVIRONMENT_FILE}"

    /workspace/bin/fleet-console-fixture \
      --listen 127.0.0.1:3100 \
      --assets /workspace/ui/out \
      --applications 10000 \
      >"${ARTIFACT_DIR}/fixture.log" 2>&1 &
    fixture_pid=$!

    ready=0
    readiness_deadline=$((SECONDS + 120))
    for _ in $(seq 1 240); do
      if node -e "
        fetch(\"http://127.0.0.1:3100/readyz\", { signal: AbortSignal.timeout(1000) })
          .then((response) => process.exit(response.ok ? 0 : 1))
          .catch(() => process.exit(1))
      "; then
        ready=1
        break
      fi
      if ! kill -0 "${fixture_pid}" >/dev/null 2>&1; then
        printf "fleet fixture exited before readiness\n" >&2
        cat "${ARTIFACT_DIR}/fixture.log" >&2
        exit 1
      fi
      if ((SECONDS >= readiness_deadline)); then
        break
      fi
      sleep 0.5
    done
    [[ "${ready}" == 1 ]] || {
      printf "fleet fixture did not become ready within 120 seconds\n" >&2
      cat "${ARTIFACT_DIR}/fixture.log" >&2
      exit 1
    }

    npx playwright test e2e/fleet-scale.spec.ts \
      --project=chromium \
      --retries=0 \
      --workers=1 2>&1 | tee "${ARTIFACT_DIR}/ui-scale.log"
  '

[[ -s "${artifact_dir}/ui-scale.json" ]] || fail "UI scale test did not write ui-scale.json"
grep -q 'FLEET_UI_INITIAL_P95_MS=' "${artifact_dir}/ui-scale.log" ||
  fail "UI scale test did not emit FLEET_UI_INITIAL_P95_MS"
grep -q 'FLEET_UI_SWITCH_P95_MS=' "${artifact_dir}/ui-scale.log" ||
  fail "UI scale test did not emit FLEET_UI_SWITCH_P95_MS"

printf 'FLEET_API_P95_MS<300 verified\n'
printf 'FLEET_UI_INITIAL_P95_MS<2000 verified\n'
printf 'FLEET_UI_SWITCH_P95_MS<250 verified\n'
printf 'Fleet scale artifacts: %s\n' "${artifact_dir}"
