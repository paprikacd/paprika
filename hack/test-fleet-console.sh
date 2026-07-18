#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=/dev/null
source "${repo_root}/hack/lib/fleet-console-process.sh"
fixture_pid=""
fixture_log=""
requested_output_dir="${PAPRIKA_E2E_OUTPUT_DIR:-${repo_root}/ui/test-results}"
validated_output_dir=""
fixture_term_timeout_seconds="${PAPRIKA_E2E_FIXTURE_TERM_TIMEOUT_SECONDS:-5}"
fixture_kill_timeout_seconds="${PAPRIKA_E2E_FIXTURE_KILL_TIMEOUT_SECONDS:-2}"

fail() {
  printf 'fleet console gate: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "${fixture_pid}" ]]; then
    fleet_console_stop_owned_job \
      "${fixture_pid}" \
      "${fixture_term_timeout_seconds}" \
      "${fixture_kill_timeout_seconds}" || {
      cleanup_status=$?
      printf 'fleet console gate: fixture cleanup exceeded its bounded deadline\n' >&2
    }
  fi
  if [[ -n "${fixture_log}" ]] &&
    [[ -n "${validated_output_dir}" ]] &&
    [[ -d "${validated_output_dir}" ]]; then
    cp "${fixture_log}" "${validated_output_dir}/fleet-console-fixture.log" 2>/dev/null || true
  fi
  [[ -z "${fixture_log}" ]] || rm -f "${fixture_log}" || true
  exit "$(fleet_console_final_status "${status}" "${cleanup_status}")"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fixture_log="$(fleet_console_allocate_fixture_log "${TMPDIR:-/tmp}")"

for command in go node npm; do
  command -v "${command}" >/dev/null 2>&1 || fail "${command} is required"
done

applications="${PAPRIKA_E2E_APPLICATIONS:-250}"
[[ "${applications}" =~ ^[1-9][0-9]*$ ]] || fail "PAPRIKA_E2E_APPLICATIONS must be a positive integer"
((applications <= 100000)) || fail "PAPRIKA_E2E_APPLICATIONS must not exceed 100000"
[[ "${fixture_term_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] ||
  fail "PAPRIKA_E2E_FIXTURE_TERM_TIMEOUT_SECONDS must be a positive integer"
[[ "${fixture_kill_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] ||
  fail "PAPRIKA_E2E_FIXTURE_KILL_TIMEOUT_SECONDS must be a positive integer"

playwright_specs=(
  "e2e/fleet-console.spec.ts"
  "e2e/fleet-responsive.spec.ts"
)
if [[ -n "${PAPRIKA_E2E_EXTRA_SPECS:-}" ]]; then
  normalized_extra_specs="${PAPRIKA_E2E_EXTRA_SPECS//$'\n'/ }"
  normalized_extra_specs="${normalized_extra_specs//$'\t'/ }"
  extra_specs=()
  IFS=' ' read -r -a extra_specs <<<"${normalized_extra_specs}"
  ((${#extra_specs[@]} > 0)) ||
    fail "PAPRIKA_E2E_EXTRA_SPECS must name at least one spec"
  for spec in "${extra_specs[@]}"; do
    [[ "${spec}" =~ ^e2e/[A-Za-z0-9][A-Za-z0-9._-]*[.]spec[.]ts$ ]] ||
      fail "PAPRIKA_E2E_EXTRA_SPECS contains an unsafe spec path: ${spec}"
    [[ -f "${repo_root}/ui/${spec}" ]] ||
      fail "PAPRIKA_E2E_EXTRA_SPECS does not exist: ${spec}"
    canonical_spec="$(node -e '
      const fs = require("node:fs");
      process.stdout.write(fs.realpathSync(process.argv[1]));
    ' "${repo_root}/ui/${spec}")"
    [[ "$(dirname "${canonical_spec}")" == "${repo_root}/ui/e2e" ]] ||
      fail "PAPRIKA_E2E_EXTRA_SPECS must stay directly under ui/e2e: ${spec}"
    duplicate=0
    for accepted in "${playwright_specs[@]}"; do
      if [[ "${accepted}" == "${spec}" ]]; then
        duplicate=1
        break
      fi
    done
    [[ "${duplicate}" == 0 ]] && playwright_specs+=("${spec}")
  done
fi

choose_free_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.unref();
    server.on("error", (error) => { console.error(error.message); process.exit(1); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") process.exit(1);
      process.stdout.write(String(address.port));
      server.close();
    });
  '
}

port_is_listening() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (status) => { socket.destroy(); process.exit(status); };
    socket.setTimeout(400, () => finish(1));
    socket.once("connect", () => finish(0));
    socket.once("error", () => finish(1));
  ' "${1}"
}

port="${PAPRIKA_E2E_PORT:-$(choose_free_port)}"
[[ "${port}" =~ ^[0-9]+$ ]] || fail "PAPRIKA_E2E_PORT must be an integer"
((port >= 1 && port <= 65535)) || fail "PAPRIKA_E2E_PORT must be between 1 and 65535"
if port_is_listening "${port}"; then
  fail "127.0.0.1:${port} is already owned by another listener; refusing to reuse or terminate it"
fi

absolute_output_dir="$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const requested = path.resolve(process.argv[1]);
  const suffix = [];
  let existing = requested;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) process.exit(1);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  process.stdout.write(path.join(fs.realpathSync(existing), ...suffix));
' "${requested_output_dir}")"
case "${absolute_output_dir}/" in
  "${repo_root}/ui/test-results/"* | "${repo_root}/output/playwright/"*) ;;
  *) fail "PAPRIKA_E2E_OUTPUT_DIR must stay under ui/test-results or output/playwright" ;;
esac
mkdir -p "${absolute_output_dir}"
canonical_output_dir="$(cd "${absolute_output_dir}" && pwd -P)"
case "${canonical_output_dir}/" in
  "${repo_root}/ui/test-results/"* | "${repo_root}/output/playwright/"*) ;;
  *) fail "PAPRIKA_E2E_OUTPUT_DIR must stay under ui/test-results or output/playwright" ;;
esac
validated_output_dir="${canonical_output_dir}"

printf 'Building exported UI and deterministic fleet fixture...\n'
npm --prefix "${repo_root}/ui" run build
mkdir -p "${repo_root}/bin"
go build -o "${repo_root}/bin/fleet-console-fixture" "${repo_root}/test/fleetconsole"

# The build can take long enough for another process to claim a port that was
# free during initial validation. Recheck immediately before spawning so this
# harness never attaches to, reuses, or later terminates an independently owned
# listener.
if port_is_listening "${port}"; then
  fail "127.0.0.1:${port} became occupied during the build; refusing to reuse or terminate it"
fi

"${repo_root}/bin/fleet-console-fixture" \
  --listen "127.0.0.1:${port}" \
  --assets "${repo_root}/ui/out" \
  --applications "${applications}" \
  >"${fixture_log}" 2>&1 &
fixture_pid=$!

base_url="http://127.0.0.1:${port}"
ready=0
for _ in $(seq 1 240); do
  # shellcheck disable=SC2016 # JavaScript template interpolation, not shell expansion.
  if node -e '
    fetch(`${process.argv[1]}/readyz`, { signal: AbortSignal.timeout(750) })
      .then(async (response) => {
        const body = await response.text();
        process.exit(response.ok && body === "ready\n" ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "${base_url}"; then
    ready=1
    break
  fi
  if ! kill -0 "${fixture_pid}" >/dev/null 2>&1; then
    printf 'Fixture exited before readiness:\n' >&2
    sed -n '1,240p' "${fixture_log}" >&2
    fail "fixture process ${fixture_pid} exited before readiness"
  fi
  sleep 0.25
done
[[ "${ready}" == 1 ]] || fail "fixture did not become ready at ${base_url}/readyz"

printf 'Fleet fixture ready: %s (PID %s)\n' "${base_url}" "${fixture_pid}"
PLAYWRIGHT_NO_WEBSERVER=1 \
PAPRIKA_E2E_BASE_URL="${base_url}" \
PAPRIKA_E2E_PORT="${port}" \
PAPRIKA_E2E_OUTPUT_DIR="${validated_output_dir}" \
PAPRIKA_E2E_APPLICATIONS="${applications}" \
PAPRIKA_E2E_RUN_NAMESPACE="${PAPRIKA_E2E_RUN_NAMESPACE:-team-00}" \
PAPRIKA_E2E_ADMIN_SUBJECT="${PAPRIKA_E2E_ADMIN_SUBJECT:-system:serviceaccount:paprika-e2e:reviewed-fleet-admin}" \
PAPRIKA_E2E_ADMIN_SESSION_STUB="${PAPRIKA_E2E_ADMIN_SESSION_STUB:-1}" \
npm --prefix "${repo_root}/ui" run test:e2e -- \
  "${playwright_specs[@]}" \
  --project=chromium

printf 'Fleet console browser gate passed; evidence: %s\n' "${validated_output_dir}"
