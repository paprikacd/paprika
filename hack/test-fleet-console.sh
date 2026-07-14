#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture_pid=""
fixture_log="$(mktemp "${TMPDIR:-/tmp}/paprika-fleet-console.XXXXXX.log")"
requested_output_dir="${PAPRIKA_E2E_OUTPUT_DIR:-${repo_root}/ui/test-results}"
validated_output_dir=""

fail() {
  printf 'fleet console gate: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "${fixture_pid}" ]] && kill -0 "${fixture_pid}" >/dev/null 2>&1; then
    kill "${fixture_pid}" >/dev/null 2>&1 || true
    wait "${fixture_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${validated_output_dir}" ]] && [[ -d "${validated_output_dir}" ]]; then
    cp "${fixture_log}" "${validated_output_dir}/fleet-console-fixture.log" 2>/dev/null || true
  fi
  rm -f "${fixture_log}" || true
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in go node npm; do
  command -v "${command}" >/dev/null 2>&1 || fail "${command} is required"
done

applications="${PAPRIKA_E2E_APPLICATIONS:-250}"
[[ "${applications}" =~ ^[1-9][0-9]*$ ]] || fail "PAPRIKA_E2E_APPLICATIONS must be a positive integer"
((applications <= 100000)) || fail "PAPRIKA_E2E_APPLICATIONS must not exceed 100000"

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
npm --prefix "${repo_root}/ui" run test:e2e -- \
  e2e/fleet-console.spec.ts \
  e2e/fleet-responsive.spec.ts \
  --project=chromium

printf 'Fleet console browser gate passed; evidence: %s\n' "${validated_output_dir}"
