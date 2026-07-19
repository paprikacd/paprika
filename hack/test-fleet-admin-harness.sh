#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2329

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRARY="${ROOT_DIR}/hack/lib/fleet-admin-harness.sh"
REAL_HARNESS="${ROOT_DIR}/hack/test-fleet-admin-dashboard.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/paprika-fleet-admin-harness.XXXXXX")"
TESTS_RUN=0

cleanup() {
  local status=$?
  for owned_pid in \
    "${TIMEOUT_NPM_PID:-}" \
    "${TIMEOUT_BROWSER_PID:-}"; do
    if [[ "${owned_pid}" =~ ^[1-9][0-9]*$ ]]; then
      kill -KILL "${owned_pid}" 2>/dev/null || true
    fi
  done
  if [[ -n "${INDEPENDENT_PID:-}" ]]; then
    kill "${INDEPENDENT_PID}" 2>/dev/null || true
    wait "${INDEPENDENT_PID}" 2>/dev/null || true
  fi
  rm -rf "${TEST_ROOT}"
  exit "${status}"
}
trap cleanup EXIT

fail() {
  printf 'not ok %s\n' "$*" >&2
  exit 1
}

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf 'ok %d - %s\n' "${TESTS_RUN}" "$1"
}

assert_file_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "${expected}" "${file}" ||
    fail "${file} does not contain ${expected}"
}

assert_file_not_contains() {
  local file=$1
  local forbidden=$2
  if grep -Fq -- "${forbidden}" "${file}"; then
    fail "${file} contains forbidden text ${forbidden}"
  fi
}

assert_file_not_matches() {
  local file=$1
  local forbidden=$2
  if grep -Eq -- "${forbidden}" "${file}"; then
    fail "${file} matches forbidden expression ${forbidden}"
  fi
}

first_line_containing() {
  local file=$1
  local expected=$2
  awk -v expected="${expected}" 'index($0, expected) { print NR; exit }' "${file}"
}

assert_rejected() {
  local file=$1
  local output="${TEST_ROOT}/readiness.normalized.json"
  if fleet_admin_parse_readiness "${file}" "${output}" 2>/dev/null; then
    fail "readiness parser accepted ${file}"
  fi
}

# The first RED must be the absent production library, not a test syntax error.
# shellcheck source=/dev/null
source "${LIBRARY}"

VALID_READY="${TEST_ROOT}/valid-ready.json"
cat >"${VALID_READY}" <<'JSON'
{"context":"omega","namespace":"paprika-e2e","pod":"paprika-api-0","url":"http://127.0.0.1:43123/dashboard/","subject":"ci@example.test","sessionExpiry":"2026-07-19T01:02:03Z","accessMode":"kubernetes-port-forward-admin"}
JSON
fleet_admin_parse_readiness "${VALID_READY}" "${TEST_ROOT}/valid.normalized.json"
jq -e '.url == "http://127.0.0.1:43123/dashboard/" and .context == "omega"' \
  "${TEST_ROOT}/valid.normalized.json" >/dev/null

printf '%s' '{"context":"omega"' >"${TEST_ROOT}/partial.json"
printf '%s\n%s\n' "$(cat "${VALID_READY}")" "$(cat "${VALID_READY}")" >"${TEST_ROOT}/multiple.json"
printf '%s\n' '{not-json}' >"${TEST_ROOT}/malformed.json"
printf '%s\n' \
  '{"context":"omega","namespace":"paprika-e2e","pod":"pod","proxyUrl":"http://127.0.0.1:1/","subject":"s","sessionExpiry":"2026-07-19T01:02:03Z","accessMode":"kubernetes-port-forward-admin"}' \
  >"${TEST_ROOT}/stale-contract.json"
assert_rejected "${TEST_ROOT}/partial.json"
assert_rejected "${TEST_ROOT}/multiple.json"
assert_rejected "${TEST_ROOT}/malformed.json"
assert_rejected "${TEST_ROOT}/stale-contract.json"
pass "readiness accepts exactly one complete current-contract JSON object"

RAPID_EXIT_SIGNAL_LOG="${TEST_ROOT}/rapid-exit-signals.log"
: >"${RAPID_EXIT_SIGNAL_LOG}"
for stopper in fleet_admin_stop_owned_cli fleet_admin_stop_owned_forward; do
  (
    : &
    expired_pid=$!
    wait "${expired_pid}"
    for _ in {1..200}; do
      : &
      churn_pid=$!
      wait "${churn_pid}"
    done
    kill() {
      printf '%s:%s\n' "${stopper}" "$*" >>"${RAPID_EXIT_SIGNAL_LOG}"
      builtin kill "$@"
    }
    "${stopper}" "${expired_pid}" 1 "${TEST_ROOT}/rapid-exit-results.log" 1 1 ||
      true
  )
done
[[ ! -s "${RAPID_EXIT_SIGNAL_LOG}" ]] ||
  fail "cleanup touched a PID after its exact Bash job exited: $(cat "${RAPID_EXIT_SIGNAL_LOG}")"
pass "rapidly exited jobs are never inspected or signalled by PID"

WATCHDOG_TEST_ROOT="${TEST_ROOT}/watchdog"
mkdir -p "${WATCHDOG_TEST_ROOT}/artifacts" "${WATCHDOG_TEST_ROOT}/work"
set +e
(
  FLEET_ADMIN_ARTIFACT_DIR="${WATCHDOG_TEST_ROOT}/artifacts"
  FLEET_ADMIN_WORK_DIR="${WATCHDOG_TEST_ROOT}/work"
  watchdog_exact_status() {
    printf 'bounded-command-output\n'
    return 37
  }
  fleet_admin_run_recorded_bounded \
    watchdog-exact-status 1s watchdog_exact_status
)
WATCHDOG_EXACT_STATUS=$?
set -e
[[ "${WATCHDOG_EXACT_STATUS}" -eq 37 ]] ||
  fail "bounded command returned ${WATCHDOG_EXACT_STATUS}, want exact status 37"
assert_file_contains \
  "${WATCHDOG_TEST_ROOT}/artifacts/watchdog-exact-status.log" \
  "bounded-command-output"

set +e
(
  FLEET_ADMIN_ARTIFACT_DIR="${WATCHDOG_TEST_ROOT}/artifacts"
  FLEET_ADMIN_WORK_DIR="${WATCHDOG_TEST_ROOT}/work"
  FLEET_ADMIN_TERM_TIMEOUT_SECONDS=1
  FLEET_ADMIN_KILL_TIMEOUT_SECONDS=1
  before_jobs="$(jobs -pr | sort)"
  watchdog_ignore_term() {
    exec perl -e '
      use strict;
      use warnings;
      $SIG{TERM} = "IGNORE";
      select undef, undef, undef, 0.05 while 1;
    '
  }
  SECONDS=0
  fleet_admin_run_recorded_bounded \
    watchdog-timeout 100ms watchdog_ignore_term 2>/dev/null
  bounded_status=$?
  elapsed=${SECONDS}
  after_jobs="$(jobs -pr | sort)"
  [[ "${bounded_status}" -eq 124 ]] || {
    printf 'bounded timeout returned %s, want 124\n' "${bounded_status}" >&2
    exit 1
  }
  [[ "${elapsed}" -lt 5 ]] || {
    printf 'bounded timeout took %ss, want less than 5s\n' "${elapsed}" >&2
    exit 1
  }
  [[ "${after_jobs}" == "${before_jobs}" ]] || {
    printf 'bounded timeout leaked a Bash job\n' >&2
    exit 1
  }
)
WATCHDOG_TIMEOUT_TEST_STATUS=$?
set -e
[[ "${WATCHDOG_TIMEOUT_TEST_STATUS}" -eq 0 ]] ||
  fail "bounded timeout did not terminate and reap only its owned child"
pass "bounded command watchdog preserves status and reaps TERM-ignoring children"

PROCESS_LOG="${TEST_ROOT}/process.log"
sleep 30 &
INDEPENDENT_PID=$!
perl -e '
  use strict;
  use warnings;
  my $log = shift;
  $SIG{INT} = sub {
    open my $fh, ">>", $log or die $!;
    print {$fh} "cli:int\ncli:authenticated-revocation-complete\n";
    close $fh;
    exit 0;
  };
  $SIG{TERM} = sub {
    open my $fh, ">>", $log or die $!;
    print {$fh} "cli:term\n";
    close $fh;
    exit 0;
  };
  open my $ready, ">>", $log or die $!;
  print {$ready} "cli:ready\n";
  close $ready;
  select undef, undef, undef, 0.05 while 1;
' "${PROCESS_LOG}" &
OWNED_CLI_PID=$!
for _ in {1..100}; do
  grep -Fq 'cli:ready' "${PROCESS_LOG}" 2>/dev/null && break
  sleep 0.01
done
assert_file_contains "${PROCESS_LOG}" "cli:ready"
fleet_admin_stop_owned_cli "${OWNED_CLI_PID}" 2 "${PROCESS_LOG}"
kill -0 "${INDEPENDENT_PID}" 2>/dev/null ||
  fail "independently owned listener was killed"
assert_file_contains "${PROCESS_LOG}" "cli:int"
assert_file_contains "${PROCESS_LOG}" "cli:authenticated-revocation-complete"
assert_file_not_contains "${PROCESS_LOG}" "cli:term"
pass "owned CLI receives INT and revokes while independent process survives"

perl -e '
  use strict;
  use warnings;
  my $log = shift;
  $SIG{INT} = sub {
    open my $fh, ">>", $log or die $!;
    print {$fh} "failed-revoke:int-exit-17\n";
    close $fh;
    exit 17;
  };
  open my $ready, ">>", $log or die $!;
  print {$ready} "failed-revoke:ready\n";
  close $ready;
  select undef, undef, undef, 0.05 while 1;
' "${PROCESS_LOG}" &
FAILED_REVOKE_PID=$!
for _ in {1..100}; do
  grep -Fq 'failed-revoke:ready' "${PROCESS_LOG}" 2>/dev/null && break
  sleep 0.01
done
set +e
fleet_admin_stop_owned_cli "${FAILED_REVOKE_PID}" 1 "${PROCESS_LOG}" 1 1
FAILED_REVOKE_STATUS=$?
set -e
[[ "${FAILED_REVOKE_STATUS}" -eq 17 ]] ||
  fail "failed authenticated revocation returned ${FAILED_REVOKE_STATUS}, want 17"
pass "owned CLI nonzero revocation exit propagates to cleanup"

perl -e '
  use strict;
  use warnings;
  my $log = shift;
  $SIG{INT} = "IGNORE";
  $SIG{TERM} = sub {
    open my $fh, ">>", $log or die $!;
    print {$fh} "stuck:term\n";
    close $fh;
    exit 0;
  };
  open my $ready, ">>", $log or die $!;
  print {$ready} "stuck:ready\n";
  close $ready;
  select undef, undef, undef, 0.05 while 1;
' "${PROCESS_LOG}" &
STUCK_PID=$!
for _ in {1..100}; do
  grep -Fq 'stuck:ready' "${PROCESS_LOG}" 2>/dev/null && break
  sleep 0.01
done
assert_file_contains "${PROCESS_LOG}" "stuck:ready"
fleet_admin_stop_owned_cli "${STUCK_PID}" 1 "${PROCESS_LOG}"
assert_file_contains "${PROCESS_LOG}" "stuck:term"
pass "owned CLI receives TERM only after bounded INT timeout"

HARD_STOP_RESULT="${TEST_ROOT}/hard-stop.result"
(
  perl -e '
    use strict;
    use warnings;
    $SIG{INT} = "IGNORE";
    $SIG{TERM} = "IGNORE";
    select undef, undef, undef, 0.05 while 1;
  ' &
  hard_pid=$!
  printf '%s\n' "${hard_pid}" >"${TEST_ROOT}/hard-stop.pid"
  set +e
  fleet_admin_stop_owned_cli "${hard_pid}" 1 "${PROCESS_LOG}" 1 1
  printf '%s\n' "$?" >"${HARD_STOP_RESULT}"
) 2>/dev/null &
HARD_STOP_WRAPPER=$!
for _ in {1..500}; do
  [[ -f "${HARD_STOP_RESULT}" ]] && break
  if ! kill -0 "${HARD_STOP_WRAPPER}" 2>/dev/null; then
    break
  fi
  sleep 0.01
done
if [[ ! -f "${HARD_STOP_RESULT}" ]]; then
  kill -KILL "${HARD_STOP_WRAPPER}" 2>/dev/null || true
  if [[ -f "${TEST_ROOT}/hard-stop.pid" ]]; then
    kill -KILL "$(cat "${TEST_ROOT}/hard-stop.pid")" 2>/dev/null || true
  fi
  wait "${HARD_STOP_WRAPPER}" 2>/dev/null || true
  fail "TERM-ignoring CLI entered an unbounded wait"
fi
wait "${HARD_STOP_WRAPPER}" 2>/dev/null || true
[[ "$(cat "${HARD_STOP_RESULT}")" -ne 0 ]] ||
  fail "forced-KILL CLI cleanup reported success"
assert_file_contains "${PROCESS_LOG}" "harness:cli-sigkill-after-timeout"
pass "TERM-ignoring CLI is KILLed without an unbounded wait"

HARD_FORWARD_RESULT="${TEST_ROOT}/hard-forward.result"
(
  perl -e '
    use strict;
    use warnings;
    $SIG{INT} = "IGNORE";
    $SIG{TERM} = "IGNORE";
    select undef, undef, undef, 0.05 while 1;
  ' &
  hard_pid=$!
  printf '%s\n' "${hard_pid}" >"${TEST_ROOT}/hard-forward.pid"
  set +e
  fleet_admin_stop_owned_forward "${hard_pid}" 1 "${PROCESS_LOG}" 1 1
  printf '%s\n' "$?" >"${HARD_FORWARD_RESULT}"
) 2>/dev/null &
HARD_FORWARD_WRAPPER=$!
for _ in {1..500}; do
  [[ -f "${HARD_FORWARD_RESULT}" ]] && break
  if ! kill -0 "${HARD_FORWARD_WRAPPER}" 2>/dev/null; then
    break
  fi
  sleep 0.01
done
if [[ ! -f "${HARD_FORWARD_RESULT}" ]]; then
  kill -KILL "${HARD_FORWARD_WRAPPER}" 2>/dev/null || true
  if [[ -f "${TEST_ROOT}/hard-forward.pid" ]]; then
    kill -KILL "$(cat "${TEST_ROOT}/hard-forward.pid")" 2>/dev/null || true
  fi
  wait "${HARD_FORWARD_WRAPPER}" 2>/dev/null || true
  fail "TERM-ignoring fake kubectl forward entered an unbounded wait"
fi
wait "${HARD_FORWARD_WRAPPER}" 2>/dev/null || true
[[ "$(cat "${HARD_FORWARD_RESULT}")" -ne 0 ]] ||
  fail "forced-KILL fake kubectl forward cleanup reported success"
assert_file_contains \
  "${PROCESS_LOG}" "harness:normal-forward-sigkill-after-timeout"
pass "TERM-ignoring fake kubectl forward is KILLed without an unbounded wait"

ORDER_LOG="${TEST_ROOT}/order.log"
set +e
(
  fleet_admin_collect_diagnostics() { printf 'diagnostics\n' >>"${ORDER_LOG}"; }
  fleet_admin_stop_all_owned_processes() { printf 'stop-processes\n' >>"${ORDER_LOG}"; }
  fleet_admin_delete_owned_fixtures() { printf 'delete-fixtures\n' >>"${ORDER_LOG}"; }
  fleet_admin_delete_owned_namespace() { printf 'delete-namespace\n' >>"${ORDER_LOG}"; }
  fleet_admin_finalize 37
)
FINAL_STATUS=$?
set -e
[[ "${FINAL_STATUS}" -eq 37 ]] || fail "finalizer returned ${FINAL_STATUS}, want 37"
[[ "$(cat "${ORDER_LOG}")" == $'diagnostics\nstop-processes\ndelete-fixtures\ndelete-namespace' ]] ||
  fail "diagnostics/cleanup order was $(tr '\n' ' ' <"${ORDER_LOG}")"
pass "diagnostics precede cleanup and original failure status is preserved"

set +e
(
  fleet_admin_collect_diagnostics() { return 0; }
  fleet_admin_stop_all_owned_processes() { return 17; }
  fleet_admin_collect_process_outputs() { return 0; }
  fleet_admin_delete_owned_fixtures() { return 0; }
  fleet_admin_delete_owned_namespace() { return 0; }
  fleet_admin_remove_owned_temporary_paths() { return 0; }
  FLEET_ADMIN_FINALIZED=0
  fleet_admin_finalize 0
)
SUCCESS_CLEANUP_STATUS=$?
(
  fleet_admin_collect_diagnostics() { return 0; }
  fleet_admin_stop_all_owned_processes() { return 17; }
  fleet_admin_collect_process_outputs() { return 0; }
  fleet_admin_delete_owned_fixtures() { return 0; }
  fleet_admin_delete_owned_namespace() { return 0; }
  fleet_admin_remove_owned_temporary_paths() { return 0; }
  FLEET_ADMIN_FINALIZED=0
  fleet_admin_finalize 37
)
FAILED_RUN_CLEANUP_STATUS=$?
set -e
[[ "${SUCCESS_CLEANUP_STATUS}" -eq 1 ]] ||
  fail "successful run with failed revocation returned ${SUCCESS_CLEANUP_STATUS}, want 1"
[[ "${FAILED_RUN_CLEANUP_STATUS}" -eq 37 ]] ||
  fail "original failure was replaced by cleanup status ${FAILED_RUN_CLEANUP_STATUS}"
pass "finalizer fails success on revocation failure and preserves original failures"

ACCUMULATION_LOG="${TEST_ROOT}/accumulation.log"
: >"${ACCUMULATION_LOG}"
set +e
(
  FLEET_ADMIN_ARTIFACT_DIR="${TEST_ROOT}/accumulation-artifacts"
  FLEET_ADMIN_WORK_DIR="${TEST_ROOT}/accumulation-work"
  mkdir -p "${FLEET_ADMIN_ARTIFACT_DIR}" "${FLEET_ADMIN_WORK_DIR}"
  redact_count=0
  fleet_admin_redact_file() {
    redact_count=$((redact_count + 1))
    printf 'redact:%s\n' "$2" >>"${ACCUMULATION_LOG}"
    [[ "${redact_count}" -ne 1 ]]
  }
  fleet_admin_collect_process_outputs
)
PROCESS_OUTPUT_ACCUMULATION_STATUS=$?
set -e
[[ "${PROCESS_OUTPUT_ACCUMULATION_STATUS}" -ne 0 ]] ||
  fail "process output collection lost an early sanitizer failure"
[[ "$(grep -c '^redact:' "${ACCUMULATION_LOG}")" -eq 4 ]] ||
  fail "process output collection stopped before attempting every artifact"

: >"${ACCUMULATION_LOG}"
set +e
(
  fleet_admin_collect_process_outputs() {
    printf 'process-outputs\n' >>"${ACCUMULATION_LOG}"
    return 51
  }
  fleet_admin_capture_diagnostic() {
    printf 'diagnostic:%s\n' "$1" >>"${ACCUMULATION_LOG}"
    return 0
  }
  FLEET_ADMIN_KUBECTL=kubectl
  FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/kubeconfig"
  FLEET_ADMIN_CONTEXT=omega
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e
  FLEET_ADMIN_NAMESPACE=paprika-fleet-e2e-accumulate
  FLEET_ADMIN_SUITE_LABEL=paprika.io/e2e-suite=fleet-admin-dashboard
  FLEET_ADMIN_RUN_LABEL=paprika.io/e2e-run=accumulate
  fleet_admin_collect_diagnostics
)
DIAGNOSTIC_ACCUMULATION_STATUS=$?
set -e
[[ "${DIAGNOSTIC_ACCUMULATION_STATUS}" -ne 0 ]] ||
  fail "diagnostic collection lost an early process-output failure"
[[ "$(grep -c '^diagnostic:' "${ACCUMULATION_LOG}")" -eq 6 ]] ||
  fail "diagnostic collection stopped before attempting every diagnostic"

ACCUMULATION_ROOT="${TEST_ROOT}/accumulation-root"
ACCUMULATION_ARTIFACT="${ACCUMULATION_ROOT}/artifacts/accumulate"
mkdir -p \
  "${ACCUMULATION_ROOT}/config/e2e/fleet-admin" \
  "${ACCUMULATION_ARTIFACT}"
ACCUMULATION_OVERLAY="$(
  mktemp -d \
    "${ACCUMULATION_ROOT}/config/e2e/fleet-admin/.run-accumulate.XXXXXX"
)"
ACCUMULATION_WORK="$(mktemp -d "${ACCUMULATION_ARTIFACT}/.work.XXXXXX")"
: >"${ACCUMULATION_LOG}"
set +e
(
  rm_count=0
  rm() {
    rm_count=$((rm_count + 1))
    printf 'rm:%s\n' "${*: -1}" >>"${ACCUMULATION_LOG}"
    if [[ "${rm_count}" -eq 1 ]]; then
      return 61
    fi
    command rm "$@"
  }
  FLEET_ADMIN_ROOT="${ACCUMULATION_ROOT}"
  FLEET_ADMIN_RUN_ID=accumulate
  FLEET_ADMIN_ARTIFACT_DIR="${ACCUMULATION_ARTIFACT}"
  FLEET_ADMIN_OVERLAY_DIR="${ACCUMULATION_OVERLAY}"
  FLEET_ADMIN_WORK_DIR="${ACCUMULATION_WORK}"
  fleet_admin_remove_owned_temporary_paths
)
REMOVAL_ACCUMULATION_STATUS=$?
set -e
[[ "${REMOVAL_ACCUMULATION_STATUS}" -ne 0 ]] ||
  fail "temporary cleanup lost an early removal failure"
[[ "$(grep -c '^rm:' "${ACCUMULATION_LOG}")" -eq 2 ]] ||
  fail "temporary cleanup stopped before attempting every owned path"

: >"${ACCUMULATION_LOG}"
set +e
(
  fleet_admin_stop_owned_cli() {
    printf 'stop-cli\n' >>"${ACCUMULATION_LOG}"
    return 71
  }
  fleet_admin_stop_owned_forward() {
    printf 'stop-forward\n' >>"${ACCUMULATION_LOG}"
    return 0
  }
  FLEET_ADMIN_ARTIFACT_DIR="${TEST_ROOT}/accumulation-artifacts"
  FLEET_ADMIN_CLI_PID=101
  FLEET_ADMIN_FORWARD_PID=102
  fleet_admin_stop_all_owned_processes
)
STOP_ACCUMULATION_STATUS=$?
set -e
[[ "${STOP_ACCUMULATION_STATUS}" -eq 71 ]] ||
  fail "stop-all returned ${STOP_ACCUMULATION_STATUS}, want the first failure 71"
[[ "$(cat "${ACCUMULATION_LOG}")" == $'stop-cli\nstop-forward' ]] ||
  fail "stop-all did not attempt both owned processes"
pass "cleanup helpers attempt every step while preserving the first failure"

FAKE_BIN="${TEST_ROOT}/bin"
mkdir -p "${FAKE_BIN}"
COMMAND_LOG="${TEST_ROOT}/commands.log"
cat >"${FAKE_BIN}/kubectl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
FAKE
cat >"${FAKE_BIN}/guard" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'guard' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
FAKE
chmod +x "${FAKE_BIN}/kubectl" "${FAKE_BIN}/guard"

FLEET_ADMIN_KUBECTL="${FAKE_BIN}/kubectl"
FLEET_ADMIN_GUARD_BIN="${FAKE_BIN}/guard"
FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/kubeconfig"
FLEET_ADMIN_CONTEXT="omega"
FLEET_ADMIN_RUN_ID="run-123"
FLEET_ADMIN_NAMESPACE="paprika-fleet-e2e-run-123"
FLEET_ADMIN_NAMESPACE_UID="uid-run-123"
FLEET_ADMIN_SUITE_LABEL="paprika.io/e2e-suite=fleet-admin-dashboard"
FLEET_ADMIN_RUN_LABEL="paprika.io/e2e-run=run-123"
FLEET_ADMIN_REQUEST_TIMEOUT="60s"
FAKE_COMMAND_LOG="${COMMAND_LOG}"
export FAKE_COMMAND_LOG
fleet_admin_delete_owned_fixtures
fleet_admin_delete_owned_namespace
assert_file_contains "${COMMAND_LOG}" \
  '--selector=paprika.io/e2e-suite=fleet-admin-dashboard\,paprika.io/e2e-run=run-123'
assert_file_contains "${COMMAND_LOG}" \
  'guard delete --run-id run-123 --namespace paprika-fleet-e2e-run-123 --uid uid-run-123'
assert_file_not_contains "${COMMAND_LOG}" 'kubectl delete namespace'
pass "cleanup uses exact run selector and only the UID-preconditioned guard for namespace deletion"

SECRET_INPUT="${TEST_ROOT}/secret-input.log"
cat >"${SECRET_INPUT}" <<'EOF'
Authorization: Bearer kubernetes-bearer-value
X-Paprika-Admin-Session: opaque-admin-value
KUBECONFIG_TOKEN=process-environment-secret
ordinary safe diagnostic
EOF
fleet_admin_redact_file "${SECRET_INPUT}" "${TEST_ROOT}/redacted.log"
assert_file_contains "${TEST_ROOT}/redacted.log" "ordinary safe diagnostic"
for secret in \
  "Authorization" \
  "X-Paprika-Admin-Session" \
  "KUBECONFIG_TOKEN" \
  "kubernetes-bearer-value" \
  "opaque-admin-value" \
  "process-environment-secret"; do
  assert_file_not_contains "${TEST_ROOT}/redacted.log" "${secret}"
done
assert_file_contains "${TEST_ROOT}/redacted.log" "[REDACTED"
pass "artifact sanitizer redacts credentials, sensitive headers, and process-style secrets"

EXACT_SNAPSHOT_DIR="${TEST_ROOT}/exact-snapshot"
mkdir -p "${EXACT_SNAPSHOT_DIR}"
cat >"${EXACT_SNAPSHOT_DIR}/fleet.json" <<'JSON'
{"total":6,"indexGeneration":42,"roots":[
  {
    "stableId":"a:paprika-fleet-e2e-exact/billing",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"billing",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"billing"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_DEGRADED","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"finance"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-west"},
      "currentStage":"production",
      "sync":"FLEET_SYNC_STATE_OUT_OF_SYNC",
      "release":"FLEET_RELEASE_STATE_AWAITING_APPROVAL",
      "rollout":"FLEET_ROLLOUT_STATE_PAUSED"
    }
  },
  {
    "stableId":"a:paprika-fleet-e2e-exact/catalog",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"catalog",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"catalog"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_PROGRESSING","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"storefront"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-east"},
      "currentStage":"staging",
      "sync":"FLEET_SYNC_STATE_UNKNOWN",
      "release":"FLEET_RELEASE_STATE_PROMOTING",
      "rollout":"FLEET_ROLLOUT_STATE_PROGRESSING"
    }
  },
  {
    "stableId":"a:paprika-fleet-e2e-exact/checkout",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"checkout",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"checkout"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_HEALTHY","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"storefront"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-east"},
      "currentStage":"production",
      "sync":"FLEET_SYNC_STATE_SYNCED",
      "release":"FLEET_RELEASE_STATE_COMPLETE",
      "rollout":"FLEET_ROLLOUT_STATE_HEALTHY"
    }
  },
  {
    "stableId":"a:paprika-fleet-e2e-exact/ledger",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"ledger",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"ledger"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_FAILED","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"finance"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-west"},
      "currentStage":"production",
      "sync":"FLEET_SYNC_STATE_OUT_OF_SYNC",
      "release":"FLEET_RELEASE_STATE_FAILED",
      "rollout":"FLEET_ROLLOUT_STATE_FAILED"
    }
  },
  {
    "stableId":"a:paprika-fleet-e2e-exact/notifications",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"notifications",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"notifications"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_MISSING","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"finance"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-west"},
      "currentStage":"development",
      "sync":"FLEET_SYNC_STATE_UNKNOWN"
    }
  },
  {
    "stableId":"a:paprika-fleet-e2e-exact/search",
    "kind":"FLEET_MAP_NODE_KIND_APPLICATION",
    "label":"search",
    "application":{"namespace":"paprika-fleet-e2e-exact","name":"search"},
    "applicationCount":"1",
    "targetCount":"1",
    "health":[{"health":"FLEET_HEALTH_UNKNOWN","count":"1"}],
    "applicationMetadata":{
      "project":{"namespace":"paprika-fleet-e2e-exact","name":"storefront"},
      "currentCluster":{"namespace":"paprika-fleet-e2e-exact","name":"cluster-east"},
      "currentStage":"development",
      "sync":"FLEET_SYNC_STATE_SYNCED"
    }
  }
]}
JSON
cat >"${EXACT_SNAPSHOT_DIR}/releases.json" <<'JSON'
{"totalCount":4,"releases":[
  {"namespace":"paprika-fleet-e2e-exact","name":"billing-gated","phase":"AwaitingApproval","application":"billing","rolloutRef":"billing-gated-rollout"},
  {"namespace":"paprika-fleet-e2e-exact","name":"catalog-active","phase":"Promoting","application":"catalog","rolloutRef":"catalog-active-rollout"},
  {"namespace":"paprika-fleet-e2e-exact","name":"checkout-complete","phase":"Complete","application":"checkout","rolloutRef":"checkout-complete-rollout"},
  {"namespace":"paprika-fleet-e2e-exact","name":"ledger-failed","phase":"Failed","application":"ledger","rolloutRef":"ledger-failed-rollout"}
]}
JSON
cat >"${EXACT_SNAPSHOT_DIR}/rollouts.json" <<'JSON'
{"rollouts":[
  {"namespace":"paprika-fleet-e2e-exact","name":"billing-gated-rollout","phase":"Paused"},
  {"namespace":"paprika-fleet-e2e-exact","name":"catalog-active-rollout","phase":"Progressing"},
  {"namespace":"paprika-fleet-e2e-exact","name":"checkout-complete-rollout","phase":"Healthy"},
  {"namespace":"paprika-fleet-e2e-exact","name":"ledger-failed-rollout","phase":"Failed"}
]}
JSON
cat >"${EXACT_SNAPSHOT_DIR}/pipelines.json" <<'JSON'
{"pipelines":[
  {"namespace":"paprika-fleet-e2e-exact","name":"finance-ci","phase":"Running","project":"finance"},
  {"namespace":"paprika-fleet-e2e-exact","name":"storefront-ci","phase":"Succeeded","project":"storefront"}
]}
JSON
fleet_admin_validate_exact_snapshot \
  "paprika-fleet-e2e-exact" \
  "${EXACT_SNAPSHOT_DIR}/fleet.json" \
  "${EXACT_SNAPSHOT_DIR}/releases.json" \
  "${EXACT_SNAPSHOT_DIR}/rollouts.json" \
  "${EXACT_SNAPSHOT_DIR}/pipelines.json"
jq '.releases += [{"namespace":"paprika-fleet-e2e-exact","name":"unowned-extra"}]' \
  "${EXACT_SNAPSHOT_DIR}/releases.json" >"${EXACT_SNAPSHOT_DIR}/releases-extra.json"
if fleet_admin_validate_exact_snapshot \
  "paprika-fleet-e2e-exact" \
  "${EXACT_SNAPSHOT_DIR}/fleet.json" \
  "${EXACT_SNAPSHOT_DIR}/releases-extra.json" \
  "${EXACT_SNAPSHOT_DIR}/rollouts.json" \
  "${EXACT_SNAPSHOT_DIR}/pipelines.json"; then
  fail "exact snapshot validator accepted an extra release"
fi
jq '.pipelines[0].namespace = "some-other-run"' \
  "${EXACT_SNAPSHOT_DIR}/pipelines.json" >"${EXACT_SNAPSHOT_DIR}/pipelines-wrong-namespace.json"
if fleet_admin_validate_exact_snapshot \
  "paprika-fleet-e2e-exact" \
  "${EXACT_SNAPSHOT_DIR}/fleet.json" \
  "${EXACT_SNAPSHOT_DIR}/releases.json" \
  "${EXACT_SNAPSHOT_DIR}/rollouts.json" \
  "${EXACT_SNAPSHOT_DIR}/pipelines-wrong-namespace.json"; then
  fail "exact snapshot validator accepted a foreign namespace"
fi
for semantic_case in stable-identity association health release rollout; do
  case "${semantic_case}" in
    stable-identity)
      jq '.roots[0].stableId = "a:some-other-run/billing"' \
        "${EXACT_SNAPSHOT_DIR}/fleet.json"
      ;;
    association)
      jq '.releases[0].application = "catalog"' \
        "${EXACT_SNAPSHOT_DIR}/releases.json"
      ;;
    health)
      jq '.roots[0].health[0].health = "FLEET_HEALTH_HEALTHY"' \
        "${EXACT_SNAPSHOT_DIR}/fleet.json"
      ;;
    release)
      jq '.roots[0].applicationMetadata.release = "FLEET_RELEASE_STATE_COMPLETE"' \
        "${EXACT_SNAPSHOT_DIR}/fleet.json"
      ;;
    rollout)
      jq '.rollouts[0].phase = "Healthy"' \
        "${EXACT_SNAPSHOT_DIR}/rollouts.json"
      ;;
  esac >"${EXACT_SNAPSHOT_DIR}/${semantic_case}-wrong.json"
  semantic_fleet="${EXACT_SNAPSHOT_DIR}/fleet.json"
  semantic_releases="${EXACT_SNAPSHOT_DIR}/releases.json"
  semantic_rollouts="${EXACT_SNAPSHOT_DIR}/rollouts.json"
  case "${semantic_case}" in
    stable-identity|health|release)
      semantic_fleet="${EXACT_SNAPSHOT_DIR}/${semantic_case}-wrong.json"
      ;;
    association)
      semantic_releases="${EXACT_SNAPSHOT_DIR}/${semantic_case}-wrong.json"
      ;;
    rollout)
      semantic_rollouts="${EXACT_SNAPSHOT_DIR}/${semantic_case}-wrong.json"
      ;;
  esac
  if fleet_admin_validate_exact_snapshot \
    "paprika-fleet-e2e-exact" \
    "${semantic_fleet}" \
    "${semantic_releases}" \
    "${semantic_rollouts}" \
    "${EXACT_SNAPSHOT_DIR}/pipelines.json"; then
    fail "exact snapshot validator accepted wrong ${semantic_case} semantics"
  fi
done
jq '.pipelines[0].project = "storefront"' \
  "${EXACT_SNAPSHOT_DIR}/pipelines.json" \
  >"${EXACT_SNAPSHOT_DIR}/pipeline-project-wrong.json"
if fleet_admin_validate_exact_snapshot \
  "paprika-fleet-e2e-exact" \
  "${EXACT_SNAPSHOT_DIR}/fleet.json" \
  "${EXACT_SNAPSHOT_DIR}/releases.json" \
  "${EXACT_SNAPSHOT_DIR}/rollouts.json" \
  "${EXACT_SNAPSHOT_DIR}/pipeline-project-wrong.json"; then
  fail "exact snapshot validator accepted the wrong pipeline project"
fi
pass "snapshot validator requires exact identity, association, health, delivery, and pipeline semantics"

FAKE_GO_ROOT="${TEST_ROOT}/fake-go-root"
mkdir -p "${FAKE_GO_ROOT}/test/fleetadmin/guard" "${TEST_ROOT}/fake-go-work"
cat >"${FAKE_BIN}/go" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|go' "${PWD}" >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
FAKE
chmod +x "${FAKE_BIN}/go"
: >"${COMMAND_LOG}"
FLEET_ADMIN_ROOT="${FAKE_GO_ROOT}"
FLEET_ADMIN_WORK_DIR="${TEST_ROOT}/fake-go-work"
FLEET_ADMIN_GO="${FAKE_BIN}/go"
FLEET_ADMIN_GUARD_BIN=""
fleet_admin_build_guard
FAKE_GO_ROOT_CANON="$(cd "${FAKE_GO_ROOT}" && pwd)"
assert_file_contains "${COMMAND_LOG}" \
  "${FAKE_GO_ROOT_CANON}|go build -o ${TEST_ROOT}/fake-go-work/fleetadmin-guard ./test/fleetadmin/guard"
pass "guard build uses the repository working directory and a relative Go package"

SAFE_ROOT="${TEST_ROOT}/safe-cleanup-root"
SAFE_ARTIFACT="${SAFE_ROOT}/artifacts/run-safe"
SAFE_OVERLAY="${SAFE_ROOT}/config/e2e/fleet-admin/.run-run-safe.123456"
SAFE_WORK="${SAFE_ARTIFACT}/.work.123456"
UNSAFE_PATH="${TEST_ROOT}/must-survive"
mkdir -p "${SAFE_OVERLAY}" "${SAFE_WORK}" "${UNSAFE_PATH}"
FLEET_ADMIN_ROOT="${SAFE_ROOT}"
FLEET_ADMIN_RUN_ID="run-safe"
FLEET_ADMIN_ARTIFACT_DIR="${SAFE_ARTIFACT}"
FLEET_ADMIN_OVERLAY_DIR="${UNSAFE_PATH}"
FLEET_ADMIN_WORK_DIR="${SAFE_WORK}"
if fleet_admin_remove_owned_temporary_paths; then
  fail "temporary cleanup accepted an overlay outside the owned prefix"
fi
[[ -d "${UNSAFE_PATH}" && -d "${SAFE_WORK}" ]] ||
  fail "unsafe temporary cleanup removed a path before validating every path"
FLEET_ADMIN_OVERLAY_DIR="${SAFE_OVERLAY}"
FLEET_ADMIN_WORK_DIR="${UNSAFE_PATH}"
if fleet_admin_remove_owned_temporary_paths; then
  fail "temporary cleanup accepted a work directory outside the artifact directory"
fi
[[ -d "${SAFE_OVERLAY}" && -d "${UNSAFE_PATH}" ]] ||
  fail "unsafe work cleanup removed a path before validating every path"
FLEET_ADMIN_WORK_DIR="${SAFE_WORK}"
fleet_admin_remove_owned_temporary_paths
[[ ! -e "${SAFE_OVERLAY}" && ! -e "${SAFE_WORK}" ]] ||
  fail "owned temporary cleanup did not remove its exact paths"
mkdir -p "${SAFE_WORK}"
FLEET_ADMIN_OVERLAY_DIR=""
FLEET_ADMIN_WORK_DIR="${SAFE_WORK}"
fleet_admin_remove_owned_temporary_paths
[[ ! -e "${SAFE_WORK}" ]] ||
  fail "owned temporary cleanup did not remove a work-only path"
pass "temporary cleanup refuses paths outside canonical run-owned prefixes"

FULL_FAKE_BIN="${TEST_ROOT}/full-bin"
FULL_COMMAND_LOG="${TEST_ROOT}/full-commands.log"
FULL_ARTIFACT_ROOT="${TEST_ROOT}/artifacts"
mkdir -p "${FULL_FAKE_BIN}" "${FULL_ARTIFACT_ROOT}"
touch "${TEST_ROOT}/full-kubeconfig"

INVALID_COMMAND_LOG="${TEST_ROOT}/invalid-run-commands.log"
cat >"${FULL_FAKE_BIN}/invalid-command" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$(basename "$0")" "$*" >>"${INVALID_COMMAND_LOG}"
exit 99
FAKE
chmod +x "${FULL_FAKE_BIN}/invalid-command"
export INVALID_COMMAND_LOG
invalid_index=0
for invalid_run_id in \
  '../escape' \
  'Uppercase' \
  '-leading' \
  'trailing-' \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; do
  invalid_index=$((invalid_index + 1))
  invalid_root="${TEST_ROOT}/invalid-run-${invalid_index}"
  invalid_artifact_root="${invalid_root}/artifacts"
  : >"${INVALID_COMMAND_LOG}"
  set +e
  env \
    INVALID_COMMAND_LOG="${INVALID_COMMAND_LOG}" \
    FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_GO="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
    FLEET_ADMIN_CONTEXT=omega \
    FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
    FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
    FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
    FLEET_ADMIN_ARTIFACT_ROOT="${invalid_artifact_root}" \
    FLEET_ADMIN_RUN_ID="${invalid_run_id}" \
    bash "${REAL_HARNESS}" \
    >"${TEST_ROOT}/invalid-run-${invalid_index}.stdout" \
    2>"${TEST_ROOT}/invalid-run-${invalid_index}.stderr"
  invalid_status=$?
  set -e
  [[ "${invalid_status}" -eq 2 ]] ||
    fail "invalid run ID ${invalid_run_id} returned ${invalid_status}, want 2"
  [[ ! -e "${invalid_artifact_root}/${invalid_run_id}" ]] ||
    fail "invalid run ID ${invalid_run_id} created an artifact/work path"
  [[ ! -s "${INVALID_COMMAND_LOG}" ]] ||
    fail "invalid run ID ${invalid_run_id} invoked a fake command"
done
pass "invalid run IDs fail before paths, guard, Helm, or Kubernetes"

timeout_index=0
for invalid_timeout in '0s' '-1s' 'nonsense'; do
  timeout_index=$((timeout_index + 1))
  timeout_artifact_root="${TEST_ROOT}/invalid-timeout-${timeout_index}/artifacts"
  : >"${INVALID_COMMAND_LOG}"
  set +e
  env \
    INVALID_COMMAND_LOG="${INVALID_COMMAND_LOG}" \
    FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_GO="${FULL_FAKE_BIN}/invalid-command" \
    FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
    FLEET_ADMIN_CONTEXT=omega \
    FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
    FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
    FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
    FLEET_ADMIN_ARTIFACT_ROOT="${timeout_artifact_root}" \
    FLEET_ADMIN_RUN_ID=valid-timeout-run \
    FLEET_ADMIN_REQUEST_TIMEOUT="${invalid_timeout}" \
    bash "${REAL_HARNESS}" \
    >"${TEST_ROOT}/invalid-timeout-${timeout_index}.stdout" \
    2>"${TEST_ROOT}/invalid-timeout-${timeout_index}.stderr"
  invalid_status=$?
  set -e
  [[ "${invalid_status}" -eq 2 ]] ||
    fail "invalid request timeout ${invalid_timeout} returned ${invalid_status}, want 2"
  [[ ! -e "${timeout_artifact_root}/valid-timeout-run" ]] ||
    fail "invalid request timeout ${invalid_timeout} created an artifact/work path"
  [[ ! -s "${INVALID_COMMAND_LOG}" ]] ||
    fail "invalid request timeout ${invalid_timeout} invoked a fake command"
done
pass "invalid request timeouts fail before paths, guard, Helm, or Kubernetes"

cat >"${FULL_FAKE_BIN}/kubectl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
joined=" $* "
case "${joined}" in
  *" auth can-i create pods/portforward "*)
    printf 'yes\n'
    ;;
  *" get nodes "*)
    printf 'node/fake-ready\n'
    ;;
  *" kustomize "*)
    printf '%s\n' \
      'apiVersion: v1' \
      'kind: List' \
      'Authorization: Bearer fixture-authorization-secret' \
      'X-Paprika-Admin-Session: fixture-admin-secret' \
      'FIXTURE_TOKEN=fixture-environment-secret' \
      'access_token: fixture-access-token-value' \
      'clientSecret: fixture-client-secret-value' \
      'Cookie: session=fixture-cookie-value' \
      'Set-Cookie: session=fixture-set-cookie-value' \
      'registryCredential: fixture-registry-credential-value' \
      'note: Bearer fixture-standalone-bearer' \
      'items: []'
    ;;
  *" create --dry-run=client "*)
    printf '%s\n' '{"apiVersion":"v1","kind":"List","items":[]}'
    ;;
  *" apply -f "*)
    if [[ -n "${FAKE_FAIL_APPLY:-}" ]]; then
      exit "${FAKE_FAIL_APPLY}"
    fi
    printf 'fixtures applied\n'
    ;;
  *" get appprojects.core.paprika.io,clusters.clusters.paprika.io,applications.pipelines.paprika.io,stages.pipelines.paprika.io,releases.pipelines.paprika.io,pipelines.pipelines.paprika.io,rollouts.rollouts.paprika.io "*" -o json "*)
    cat <<'JSON'
{"apiVersion":"v1","kind":"List","items":[
{"kind":"AppProject","metadata":{"name":"storefront"},"status":{"observedGeneration":1}},
{"kind":"AppProject","metadata":{"name":"finance"},"status":{"observedGeneration":1}},
{"kind":"Cluster","metadata":{"name":"cluster-east"},"status":{"observedGeneration":1,"phase":"Healthy"}},
{"kind":"Cluster","metadata":{"name":"cluster-west"},"status":{"observedGeneration":1,"phase":"Healthy"}},
{"kind":"Application","metadata":{"name":"checkout"},"status":{"observedGeneration":1,"health":"Healthy"}},
{"kind":"Application","metadata":{"name":"catalog"},"status":{"observedGeneration":1,"health":"Progressing"}},
{"kind":"Application","metadata":{"name":"billing"},"status":{"observedGeneration":1,"health":"Degraded"}},
{"kind":"Application","metadata":{"name":"ledger"},"status":{"observedGeneration":1,"phase":"Failed"}},
{"kind":"Application","metadata":{"name":"search"},"status":{"observedGeneration":1,"health":"Unknown"}},
{"kind":"Application","metadata":{"name":"notifications"},"status":{"observedGeneration":1,"resources":[{"status":"Missing"}]}},
{"kind":"Stage","metadata":{"name":"checkout-production"},"status":{"observedGeneration":1}},
{"kind":"Stage","metadata":{"name":"catalog-staging"},"status":{"observedGeneration":1}},
{"kind":"Stage","metadata":{"name":"billing-production"},"status":{"observedGeneration":1}},
{"kind":"Stage","metadata":{"name":"ledger-production"},"status":{"observedGeneration":1}},
{"kind":"Stage","metadata":{"name":"search-development"},"status":{"observedGeneration":1}},
{"kind":"Stage","metadata":{"name":"notifications-development"},"status":{"observedGeneration":1}},
{"kind":"Release","metadata":{"name":"catalog-active"},"status":{"observedGeneration":1,"phase":"Promoting"}},
{"kind":"Release","metadata":{"name":"checkout-complete"},"status":{"observedGeneration":1,"phase":"Complete"}},
{"kind":"Release","metadata":{"name":"ledger-failed"},"status":{"observedGeneration":1,"phase":"Failed"}},
{"kind":"Release","metadata":{"name":"billing-gated"},"status":{"observedGeneration":1,"phase":"AwaitingApproval"}},
{"kind":"Pipeline","metadata":{"name":"storefront-ci"},"status":{"observedGeneration":1,"phase":"Succeeded"}},
{"kind":"Pipeline","metadata":{"name":"finance-ci"},"status":{"observedGeneration":1,"phase":"Running"}},
{"kind":"Rollout","metadata":{"name":"catalog-active-rollout"},"status":{"observedGeneration":1,"phase":"Progressing"}},
{"kind":"Rollout","metadata":{"name":"checkout-complete-rollout"},"status":{"observedGeneration":1,"phase":"Healthy"}},
{"kind":"Rollout","metadata":{"name":"ledger-failed-rollout"},"status":{"observedGeneration":1,"phase":"Failed"}},
{"kind":"Rollout","metadata":{"name":"billing-gated-rollout"},"status":{"observedGeneration":1,"phase":"Paused"}}
]}
JSON
    ;;
  *" port-forward "*)
    exec perl -e '
      use strict;
      use warnings;
      $SIG{INT} = sub { exit 0 };
      $SIG{TERM} = sub { exit 0 };
      print STDERR "Forwarding from 127.0.0.1:45678 -> 3000\n";
      select undef, undef, undef, 0.05 while 1;
    '
    ;;
  *)
    printf '%s\n' \
      'safe fake kubernetes diagnostic' \
      'aCcEsS_ToKeN: diagnostic-access-token-value' \
      'cLiEnTsEcReT: diagnostic-client-secret-value' \
      'CoOkIe: session=diagnostic-cookie-value' \
      'sEt-CoOkIe: session=diagnostic-set-cookie-value' \
      'password: diagnostic-password-value'
    ;;
esac
FAKE

cat >"${FULL_FAKE_BIN}/helm" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'helm' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\nstatus: deployed\n' >>"${FAKE_COMMAND_LOG}"
if [[ "${1:-}" == "status" ]]; then
  for argument in "$@"; do
    case "${argument}" in
      --timeout|--timeout=*)
        printf 'helm status: unknown flag: --timeout\n' >&2
        exit 64
        ;;
    esac
  done
fi
printf 'status: deployed\n'
FAKE

cat >"${FULL_FAKE_BIN}/guard" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'guard' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
case "${1:-}" in
  create)
    printf '%s\n' \
      '{"namespace":"paprika-fleet-e2e-fake-success","runId":"fake-success","uid":"uid-fake-success"}'
    ;;
  overlay)
    printf '%s\n' \
      'apiVersion: kustomize.config.k8s.io/v1beta1' \
      'kind: Kustomization' \
      'resources:' \
      '  - ../base'
    ;;
  fixture-documents)
    mode=""
    while (($#)); do
      case "$1" in
        --mode)
          mode=$2
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    case "${mode}" in
      objects)
        printf '%s\n' \
          'apiVersion: v1' \
          'kind: List' \
          'items: []'
        ;;
      stages)
        printf '%s\n' \
          'apiVersion: pipelines.paprika.io/v1alpha1' \
          'kind: Stage' \
          'metadata:' \
          '  name: billing-production'
        ;;
      *)
        exit 2
        ;;
    esac
    ;;
  link|delete)
    ;;
  *)
    exit 2
    ;;
esac
FAKE

cat >"${FULL_FAKE_BIN}/paprika" <<'FAKE'
#!/usr/bin/env perl
use strict;
use warnings;
$| = 1;
my $log = $ENV{FAKE_COMMAND_LOG};
open my $command, ">>", $log or die $!;
print {$command} "paprika @ARGV\n";
close $command;
$SIG{INT} = sub {
  open my $result, ">>", $log or die $!;
  print {$result} "paprika authenticated-revocation-complete\n";
  close $result;
  print STDERR "Authorization: Bearer fake-kubernetes-bearer\n";
  print STDERR "X-Paprika-Admin-Session: fake-opaque-admin-session\n";
  exit 0;
};
$SIG{TERM} = sub {
  open my $result, ">>", $log or die $!;
  print {$result} "paprika unexpected-term\n";
  close $result;
  exit 0;
};
print "{\"context\":\"omega\",\"namespace\":\"paprika-e2e\",\"pod\":\"paprika-api-0\",\"url\":\"http://127.0.0.1:43123/dashboard/\",\"subject\":\"ci-example.test\",\"sessionExpiry\":\"2026-07-19T01:02:03Z\",\"accessMode\":\"kubernetes-port-forward-admin\"}\n";
select undef, undef, undef, 0.05 while 1;
FAKE

cat >"${FULL_FAKE_BIN}/curl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
headers=""
body_file=""
data=""
url=""
while (($#)); do
  case "$1" in
    --dump-header)
      headers=$2
      shift 2
      ;;
    --output)
      body_file=$2
      shift 2
      ;;
    --data)
      data=$2
      shift 2
      ;;
    --request|--header|--connect-timeout|--max-time|--write-out)
      shift 2
      ;;
    --silent|--show-error)
      shift
      ;;
    http://*|https://*)
      url=$1
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf 'curl %s %s\n' "${url}" "${data}" >>"${FAKE_COMMAND_LOG}"
if [[ "${url}" == https://public.example.test/* ]] ||
  [[ "${url}" == http://127.0.0.1:45678/* ]]; then
  printf 'HTTP/1.1 401 Unauthorized\r\nConnect-Error-Code: unauthenticated\r\n\r\n' >"${headers}"
  printf '%s\n' '{"code":"unauthenticated"}' >"${body_file}"
  printf '401'
  exit 0
fi
printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' >"${headers}"
case "${url}" in
  */QueryFleetMap)
    snapshot=fleet.json
    ;;
  */QueryReleases)
    snapshot=releases.json
    ;;
  */ListRollouts)
    snapshot=rollouts.json
    ;;
  */ListPipelines)
    snapshot=pipelines.json
    ;;
  *)
    printf '%s\n' '{}' >"${body_file}"
    ;;
esac
if [[ -n "${snapshot:-}" ]]; then
  jq --arg from "paprika-fleet-e2e-exact" \
    --arg to "paprika-fleet-e2e-fake-success" '
      walk(if type == "string" then gsub($from; $to) else . end)
    ' "${FAKE_SNAPSHOT_FIXTURE_DIR}/${snapshot}" >"${body_file}"
fi
printf '200'
FAKE

cat >"${FULL_FAKE_BIN}/npm" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'playwright-env base=%s run=%s namespace=%s subject=%s count=%s digest=%s project=%s cluster=%s stage=%s detail=%s trace=%s output=%s\n' \
  "${PAPRIKA_E2E_BASE_URL:-}" \
  "${PAPRIKA_E2E_RUN_ID:-}" \
  "${PAPRIKA_E2E_RUN_NAMESPACE:-}" \
  "${PAPRIKA_E2E_ADMIN_SUBJECT:-}" \
  "${PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT:-}" \
  "${PAPRIKA_E2E_EXPECTED_APPLICATION_DIGEST:-}" \
  "${PAPRIKA_E2E_EXPECTED_PROJECT:-}" \
  "${PAPRIKA_E2E_EXPECTED_CLUSTER:-}" \
  "${PAPRIKA_E2E_EXPECTED_STAGE:-}" \
  "${PAPRIKA_E2E_DETAIL_APPLICATION:-}" \
  "${PAPRIKA_E2E_TRACE:-}" \
  "${PAPRIKA_E2E_OUTPUT_DIR:-}" \
  >>"${FAKE_COMMAND_LOG}"
printf 'playwright-identities=%s\n' \
  "${PAPRIKA_E2E_EXPECTED_APPLICATION_IDS:-}" >>"${FAKE_COMMAND_LOG}"
printf 'playwright-admin-session-stub=%s\n' \
  "${PAPRIKA_E2E_ADMIN_SESSION_STUB:-unset}" >>"${FAKE_COMMAND_LOG}"
printf 'npm' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
printf 'npm-block-config mode=%s npm-pid-file=%s browser-pid-file=%s\n' \
  "${FAKE_NPM_BLOCK:-unset}" \
  "${FAKE_NPM_PID_FILE:-unset}" \
  "${FAKE_BROWSER_PID_FILE:-unset}" \
  >>"${FAKE_COMMAND_LOG}"
if [[ "${FAKE_NPM_BLOCK:-0}" != 0 ]]; then
  printf '%s\n' "$$" >"${FAKE_NPM_PID_FILE}"
  /usr/bin/perl -e '
    use strict;
    use warnings;
    open my $pid_file, ">", $ENV{FAKE_BROWSER_PID_FILE} or die $!;
    print {$pid_file} "$$\n";
    close $pid_file;
    $SIG{TERM} = sub {
      open my $log, ">>", $ENV{FAKE_COMMAND_LOG} or die $!;
      print {$log} $ENV{FAKE_NPM_BLOCK} eq "ignore-term"
        ? "browser-block-ignore-term\n"
        : "browser-block-term\n";
      close $log;
      exit 0 unless $ENV{FAKE_NPM_BLOCK} eq "ignore-term";
    };
    $SIG{INT} = $SIG{TERM};
    select undef, undef, undef, 0.05 while 1;
  ' &
  browser_pid=$!
  if [[ "${FAKE_NPM_BLOCK}" == ignore-term ]]; then
    trap 'printf "npm-block-ignore-term\n" >>"${FAKE_COMMAND_LOG}"' TERM
  else
    trap '
      printf "npm-block-term\n" >>"${FAKE_COMMAND_LOG}"
      wait "${browser_pid}" 2>/dev/null || true
      exit 0
    ' INT TERM
  fi
  printf 'npm-block-ready\n' >>"${FAKE_COMMAND_LOG}"
  while kill -0 "${browser_pid}" 2>/dev/null; do
    wait "${browser_pid}" 2>/dev/null || true
  done
fi
FAKE

cat >"${FULL_FAKE_BIN}/make" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf 'make' >>"${FAKE_COMMAND_LOG}"
for argument in "$@"; do
  printf ' %q' "${argument}" >>"${FAKE_COMMAND_LOG}"
done
printf '\n' >>"${FAKE_COMMAND_LOG}"
FAKE

chmod +x "${FULL_FAKE_BIN}"/*
sleep 30 &
INDEPENDENT_PID=$!
export FAKE_COMMAND_LOG="${FULL_COMMAND_LOG}"
env \
  PATH="${FULL_FAKE_BIN}:${PATH}" \
  FAKE_COMMAND_LOG="${FULL_COMMAND_LOG}" \
  FAKE_SNAPSHOT_FIXTURE_DIR="${EXACT_SNAPSHOT_DIR}" \
  PAPRIKA_E2E_ADMIN_SESSION_STUB=1 \
  FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/kubectl" \
  FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/helm" \
  FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/guard" \
  FLEET_ADMIN_CURL="${FULL_FAKE_BIN}/curl" \
  FLEET_ADMIN_PAPRIKA_BIN="${FULL_FAKE_BIN}/paprika" \
  FLEET_ADMIN_NPM="${FULL_FAKE_BIN}/npm" \
  FLEET_ADMIN_MAKE="${FULL_FAKE_BIN}/make" \
  FLEET_ADMIN_SKIP_CLI_BUILD=1 \
  FLEET_ADMIN_SUITE_LABEL=evil.example/selector=wrong \
  FLEET_ADMIN_STOP_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_TERM_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_KILL_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_DIAGNOSTIC_REQUEST_TIMEOUT=3s \
  FLEET_ADMIN_DIAGNOSTIC_LOG_TAIL=25 \
  FLEET_ADMIN_REQUEST_TIMEOUT=7s \
  FLEET_ADMIN_READINESS_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_SNAPSHOT_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
  FLEET_ADMIN_CONTEXT=omega \
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
  FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
  FLEET_ADMIN_ARTIFACT_ROOT="${FULL_ARTIFACT_ROOT}" \
  FLEET_ADMIN_RUN_ID=fake-success \
  bash "${REAL_HARNESS}" \
  >"${TEST_ROOT}/full-harness.stdout" \
  2>"${TEST_ROOT}/full-harness.stderr"
kill -0 "${INDEPENDENT_PID}" 2>/dev/null ||
  fail "full harness killed an independently owned listener"
assert_file_contains "${FULL_COMMAND_LOG}" "paprika authenticated-revocation-complete"
assert_file_not_contains "${FULL_COMMAND_LOG}" "paprika unexpected-term"
assert_file_contains "${FULL_COMMAND_LOG}" \
  'kubectl --kubeconfig'
if ! awk '
  /helm status paprika-e2e --namespace paprika-e2e --kube-context omega --kubeconfig/ {
    found = 1
    if (index($0, "--timeout") != 0) exit 1
  }
  END { if (!found) exit 1 }
' "${FULL_COMMAND_LOG}"; then
  fail "helm status received an unsupported timeout flag"
fi
for guard_action in create link delete; do
  if ! awk -v action="${guard_action}" '
    $0 ~ ("guard " action " ") {
      found = 1
      if (index($0, "--timeout 7s") == 0) exit 1
    }
    END { if (!found) exit 1 }
  ' "${FULL_COMMAND_LOG}"; then
    fail "guard ${guard_action} did not receive the bounded request timeout"
  fi
done
if ! awk '
  index($0, " auth can-i create pods/portforward ") ||
    $0 ~ / get nodes$/ ||
    index($0, " apply -f ") ||
    index($0, " wait --for=create ") ||
    index($0, " label --overwrite ") ||
    index($0, " apply --server-side ") ||
    (index($0, " get appprojects.core.paprika.io") && index($0, " -o json")) ||
    index($0, " delete appprojects.core.paprika.io") {
    count++
    if (index($0, "--request-timeout=7s") == 0) {
      print "missing bounded timeout: " $0 > "/dev/stderr"
      missing = 1
    }
  }
  END {
    if (count < 8) {
      print "matched only " count " one-shot kubectl commands" > "/dev/stderr"
    }
    if (missing || count < 8) exit 1
  }
' "${FULL_COMMAND_LOG}"; then
  fail "one-shot kubectl commands were missing the bounded request timeout"
fi
if ! awk '
  index($0, " apply --server-side ") && index($0, "--subresource=status") {
    found = 1
    if (index($0, "--force-conflicts") == 0) exit 1
  }
  END { if (!found) exit 1 }
' "${FULL_COMMAND_LOG}"; then
  fail "fixture status apply did not explicitly take ownership in the disposable namespace"
fi
assert_file_contains "${FULL_COMMAND_LOG}" \
  'app.kubernetes.io/instance=paprika-e2e\,app.kubernetes.io/component=api-server'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'app.kubernetes.io/instance=paprika-e2e\,control-plane=controller-manager'
assert_file_not_matches "${FULL_COMMAND_LOG}" \
  'app.kubernetes.io/component=api([[:space:]]|$)'
assert_file_not_matches "${FULL_COMMAND_LOG}" \
  'app.kubernetes.io/component=manager([[:space:]]|$)'
if ! awk '
  / logs / || / get events / ||
    (/ get appprojects[.]core[.]paprika[.]io/ && / -o yaml/) {
    count++
    if (index($0, "--request-timeout=3s") == 0) exit 1
    if ($0 ~ / logs / && index($0, "--tail=25") == 0) exit 1
  }
  END { if (count != 6) exit 1 }
' "${FULL_COMMAND_LOG}"; then
  fail "diagnostic commands were missing bounded request timeout or finite log tail"
fi
assert_file_contains "${FULL_COMMAND_LOG}" \
  'guard fixture-documents --mode objects --input'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'guard fixture-documents --mode stages --input'
if ! awk '
  index($0, " apply -f ") && index($0, "fixtures-objects.yaml") {
    object_apply = NR
  }
  index($0, " wait --for=create ") && index($0, "fixtures-stage-metadata.yaml") {
    stage_wait = NR
  }
  index($0, " label --overwrite ") && index($0, "fixtures-stage-metadata.yaml") {
    stage_label = NR
  }
  index($0, "guard link ") {
    owner_link = NR
  }
  END {
    if (!object_apply || !stage_wait || !stage_label || !owner_link ||
        !(object_apply < stage_wait && stage_wait < stage_label &&
          stage_label < owner_link)) {
      exit 1
    }
  }
' "${FULL_COMMAND_LOG}"; then
  fail "Stage lifecycle did not apply parents, wait, label metadata, then validate ownership"
fi
assert_file_not_contains "${FULL_COMMAND_LOG}" '--tail=-1'
assert_file_contains "${FULL_COMMAND_LOG}" \
  '--selector=paprika.io/e2e-suite=fleet-admin-dashboard\,paprika.io/e2e-run=fake-success'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'guard delete --run-id fake-success --namespace paprika-fleet-e2e-fake-success --uid uid-fake-success'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'npm --prefix'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'run test:e2e -- e2e/fleet-admin-live.spec.ts --project=chromium'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'playwright-env base=http://127.0.0.1:43123 run=fake-success namespace=paprika-fleet-e2e-fake-success subject=ci-example.test count=6 digest=hm1-'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'project=paprika-fleet-e2e-fake-success/finance cluster=paprika-fleet-e2e-fake-success/cluster-west stage=production detail=checkout trace=on'
assert_file_contains "${FULL_COMMAND_LOG}" \
  'playwright-identities=["a:paprika-fleet-e2e-fake-success/billing","a:paprika-fleet-e2e-fake-success/catalog","a:paprika-fleet-e2e-fake-success/checkout","a:paprika-fleet-e2e-fake-success/ledger","a:paprika-fleet-e2e-fake-success/notifications","a:paprika-fleet-e2e-fake-success/search"]'
assert_file_contains "${FULL_COMMAND_LOG}" 'playwright-admin-session-stub=0'
DIAGNOSTIC_LINE="$(first_line_containing "${FULL_COMMAND_LOG}" ' logs ')"
RUN_VALIDATION_LINE="$(
  first_line_containing "${FULL_COMMAND_LOG}" \
    'guard overlay --run-id fake-success'
)"
KUBERNETES_PREFLIGHT_LINE="$(
  first_line_containing "${FULL_COMMAND_LOG}" \
    ' auth can-i create pods/portforward'
)"
REVOCATION_LINE="$(
  first_line_containing "${FULL_COMMAND_LOG}" \
    'paprika authenticated-revocation-complete'
)"
OBJECT_DELETE_LINE="$(
  first_line_containing "${FULL_COMMAND_LOG}" \
    ' delete appprojects.core.paprika.io'
)"
NAMESPACE_DELETE_LINE="$(
  first_line_containing "${FULL_COMMAND_LOG}" \
    'guard delete --run-id fake-success'
)"
[[ -n "${DIAGNOSTIC_LINE}" &&
  -n "${RUN_VALIDATION_LINE}" &&
  "${RUN_VALIDATION_LINE}" -lt "${KUBERNETES_PREFLIGHT_LINE}" &&
  "${DIAGNOSTIC_LINE}" -lt "${REVOCATION_LINE}" &&
  "${REVOCATION_LINE}" -lt "${OBJECT_DELETE_LINE}" &&
  "${OBJECT_DELETE_LINE}" -lt "${NAMESPACE_DELETE_LINE}" ]] ||
  fail "full lifecycle ordering was validation=${RUN_VALIDATION_LINE:-missing}, preflight=${KUBERNETES_PREFLIGHT_LINE:-missing}, diagnostics=${DIAGNOSTIC_LINE:-missing}, revocation=${REVOCATION_LINE:-missing}, objects=${OBJECT_DELETE_LINE:-missing}, namespace=${NAMESPACE_DELETE_LINE:-missing}"
SUCCESS_ARTIFACTS="${FULL_ARTIFACT_ROOT}/fake-success"
[[ -z "$(
  find "${SUCCESS_ARTIFACTS}" -maxdepth 1 -type d -name '.work.*' -print -quit
)" ]] ||
  fail "raw work directory survived successful sanitization"
for secret in \
  fake-kubernetes-bearer \
  fake-opaque-admin-session \
  fixture-authorization-secret \
  fixture-admin-secret \
  fixture-environment-secret \
  fixture-access-token-value \
  fixture-client-secret-value \
  fixture-cookie-value \
  fixture-set-cookie-value \
  fixture-registry-credential-value \
  fixture-standalone-bearer \
  diagnostic-access-token-value \
  diagnostic-client-secret-value \
  diagnostic-cookie-value \
  diagnostic-set-cookie-value \
  diagnostic-password-value \
  Authorization \
  X-Paprika-Admin-Session; do
  if grep -R -Fq -- "${secret}" "${SUCCESS_ARTIFACTS}"; then
    fail "artifact tree retained sensitive value ${secret}"
  fi
done
pass "full fake lifecycle validates auth boundaries, revokes first, preserves sanitized artifacts, and owns only its PIDs"

INTERRUPT_ARTIFACT_ROOT="${TEST_ROOT}/interrupt-artifacts"
INTERRUPT_NPM_PID_FILE="${TEST_ROOT}/interrupt-npm.pid"
INTERRUPT_BROWSER_PID_FILE="${TEST_ROOT}/interrupt-browser.pid"
mkdir -p "${INTERRUPT_ARTIFACT_ROOT}"
env \
  PATH="${FULL_FAKE_BIN}:${PATH}" \
  FAKE_COMMAND_LOG="${FULL_COMMAND_LOG}" \
  FAKE_SNAPSHOT_FIXTURE_DIR="${EXACT_SNAPSHOT_DIR}" \
  FAKE_NPM_BLOCK=ignore-term \
  FAKE_NPM_PID_FILE="${INTERRUPT_NPM_PID_FILE}" \
  FAKE_BROWSER_PID_FILE="${INTERRUPT_BROWSER_PID_FILE}" \
  FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/kubectl" \
  FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/helm" \
  FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/guard" \
  FLEET_ADMIN_CURL="${FULL_FAKE_BIN}/curl" \
  FLEET_ADMIN_PAPRIKA_BIN="${FULL_FAKE_BIN}/paprika" \
  FLEET_ADMIN_NPM="${FULL_FAKE_BIN}/npm" \
  FLEET_ADMIN_MAKE="${FULL_FAKE_BIN}/make" \
  FLEET_ADMIN_SKIP_CLI_BUILD=1 \
  FLEET_ADMIN_STOP_TIMEOUT_SECONDS=2 \
  FLEET_ADMIN_TERM_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_KILL_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_REQUEST_TIMEOUT=7s \
  FLEET_ADMIN_READINESS_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_SNAPSHOT_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_PLAYWRIGHT_TIMEOUT=12m \
  FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
  FLEET_ADMIN_CONTEXT=omega \
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
  FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
  FLEET_ADMIN_ARTIFACT_ROOT="${INTERRUPT_ARTIFACT_ROOT}" \
  FLEET_ADMIN_RUN_ID=fake-success \
  bash "${REAL_HARNESS}" \
  >"${TEST_ROOT}/interrupt-harness.stdout" \
  2>"${TEST_ROOT}/interrupt-harness.stderr" &
INTERRUPT_HARNESS_PID=$!
for _ in {1..200}; do
  [[ -s "${INTERRUPT_NPM_PID_FILE}" &&
    -s "${INTERRUPT_BROWSER_PID_FILE}" ]] && break
  if ! kill -0 "${INTERRUPT_HARNESS_PID}" 2>/dev/null; then
    fail "interrupt harness exited before Playwright became active: stderr=$(tr '\n' ' ' <"${TEST_ROOT}/interrupt-harness.stderr") log=$(tail -n 8 "${FULL_COMMAND_LOG}" | tr '\n' '|')"
  fi
  sleep 0.05
done
[[ -s "${INTERRUPT_NPM_PID_FILE}" &&
  -s "${INTERRUPT_BROWSER_PID_FILE}" ]] ||
  fail "interrupt harness never reached the owned Playwright process group"
INTERRUPT_NPM_PID="$(cat "${INTERRUPT_NPM_PID_FILE}")"
INTERRUPT_BROWSER_PID="$(cat "${INTERRUPT_BROWSER_PID_FILE}")"
kill -TERM "${INTERRUPT_HARNESS_PID}"
set +e
wait "${INTERRUPT_HARNESS_PID}"
INTERRUPT_STATUS=$?
set -e
[[ "${INTERRUPT_STATUS}" -eq 143 ]] ||
  fail "interrupted harness returned ${INTERRUPT_STATUS}, want 143"
if kill -0 "${INTERRUPT_NPM_PID}" 2>/dev/null; then
  fail "interrupted harness orphaned fake npm PID ${INTERRUPT_NPM_PID}"
fi
if kill -0 "${INTERRUPT_BROWSER_PID}" 2>/dev/null; then
  fail "interrupted harness orphaned fake browser PID ${INTERRUPT_BROWSER_PID}"
fi
assert_file_contains "${FULL_COMMAND_LOG}" "npm-block-ignore-term"
assert_file_contains "${FULL_COMMAND_LOG}" "browser-block-ignore-term"
pass "TERM during Playwright escalates and reaps a TERM-ignoring npm/browser group"

TIMEOUT_ARTIFACT_ROOT="${TEST_ROOT}/timeout-artifacts"
TIMEOUT_COMMAND_LOG="${TEST_ROOT}/timeout-commands.log"
TIMEOUT_NPM_PID_FILE="${TEST_ROOT}/timeout-npm.pid"
TIMEOUT_BROWSER_PID_FILE="${TEST_ROOT}/timeout-browser.pid"
mkdir -p "${TIMEOUT_ARTIFACT_ROOT}"
: >"${TIMEOUT_COMMAND_LOG}"
set +e
env \
  PATH="${FULL_FAKE_BIN}:${PATH}" \
  FAKE_COMMAND_LOG="${TIMEOUT_COMMAND_LOG}" \
  FAKE_SNAPSHOT_FIXTURE_DIR="${EXACT_SNAPSHOT_DIR}" \
  FAKE_NPM_BLOCK=ignore-term \
  FAKE_NPM_PID_FILE="${TIMEOUT_NPM_PID_FILE}" \
  FAKE_BROWSER_PID_FILE="${TIMEOUT_BROWSER_PID_FILE}" \
  FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/kubectl" \
  FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/helm" \
  FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/guard" \
  FLEET_ADMIN_CURL="${FULL_FAKE_BIN}/curl" \
  FLEET_ADMIN_PAPRIKA_BIN="${FULL_FAKE_BIN}/paprika" \
  FLEET_ADMIN_NPM="${FULL_FAKE_BIN}/npm" \
  FLEET_ADMIN_MAKE="${FULL_FAKE_BIN}/make" \
  FLEET_ADMIN_SKIP_CLI_BUILD=1 \
  FLEET_ADMIN_STOP_TIMEOUT_SECONDS=10 \
  FLEET_ADMIN_TERM_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_KILL_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_REQUEST_TIMEOUT=7s \
  FLEET_ADMIN_READINESS_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_SNAPSHOT_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_PLAYWRIGHT_TIMEOUT=250ms \
  FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
  FLEET_ADMIN_CONTEXT=omega \
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
  FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
  FLEET_ADMIN_ARTIFACT_ROOT="${TIMEOUT_ARTIFACT_ROOT}" \
  FLEET_ADMIN_RUN_ID=fake-success \
  bash "${REAL_HARNESS}" \
  >"${TEST_ROOT}/timeout-harness.stdout" \
  2>"${TEST_ROOT}/timeout-harness.stderr"
TIMEOUT_STATUS=$?
set -e
[[ "${TIMEOUT_STATUS}" -eq 124 ]] ||
  fail "naturally timed out harness returned ${TIMEOUT_STATUS}, want 124"
[[ -s "${TIMEOUT_NPM_PID_FILE}" && -s "${TIMEOUT_BROWSER_PID_FILE}" ]] ||
  fail "naturally timed out harness did not record exact npm/browser PIDs"
TIMEOUT_NPM_PID="$(cat "${TIMEOUT_NPM_PID_FILE}")"
TIMEOUT_BROWSER_PID="$(cat "${TIMEOUT_BROWSER_PID_FILE}")"
if kill -0 "${TIMEOUT_NPM_PID}" 2>/dev/null; then
  fail "naturally timed out harness orphaned fake npm PID ${TIMEOUT_NPM_PID}"
fi
if kill -0 "${TIMEOUT_BROWSER_PID}" 2>/dev/null; then
  fail "naturally timed out harness orphaned fake browser PID ${TIMEOUT_BROWSER_PID}"
fi
assert_file_contains "${TIMEOUT_COMMAND_LOG}" "npm-block-ignore-term"
assert_file_contains "${TIMEOUT_COMMAND_LOG}" "browser-block-ignore-term"
assert_file_contains \
  "${TIMEOUT_ARTIFACT_ROOT}/fake-success/playwright.log" \
  "harness:bounded-command-timeout=250ms"
TIMEOUT_NPM_PID=""
TIMEOUT_BROWSER_PID=""
pass "natural Playwright timeout preserves 124 and reaps a TERM-ignoring npm/browser group"

CONFLICT_BIN="${TEST_ROOT}/conflict-kubectl"
cat >"${CONFLICT_BIN}" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' \
  '{"items":[],"note":"Authorization: Bearer conflict-authorization-secret","admin":"X-Paprika-Admin-Session: conflict-admin-secret","env":"CONFLICT_TOKEN=conflict-environment-secret","access_token":"conflict-access-token-value","clientSecret":"conflict-client-secret-value","Cookie":"session=conflict-cookie-value","Set-Cookie":"session=conflict-set-cookie-value"}'
FAKE
chmod +x "${CONFLICT_BIN}"
CONFLICT_ARTIFACT="${TEST_ROOT}/conflict-artifacts"
CONFLICT_WORK="${TEST_ROOT}/conflict-work"
mkdir -p "${CONFLICT_ARTIFACT}" "${CONFLICT_WORK}"
FLEET_ADMIN_KUBECTL="${CONFLICT_BIN}"
FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig"
FLEET_ADMIN_CONTEXT=omega
FLEET_ADMIN_NAMESPACE=paprika-fleet-e2e-conflict
FLEET_ADMIN_RUN_LABEL=paprika.io/e2e-run=conflict
FLEET_ADMIN_SUITE_LABEL=paprika.io/e2e-suite=fleet-admin-dashboard
FLEET_ADMIN_ARTIFACT_DIR="${CONFLICT_ARTIFACT}"
FLEET_ADMIN_WORK_DIR="${CONFLICT_WORK}"
if fleet_admin_verify_live_statuses; then
  fail "conflicting live status fixture unexpectedly validated"
fi
for secret in \
  conflict-authorization-secret \
  conflict-admin-secret \
  conflict-environment-secret \
  conflict-access-token-value \
  conflict-client-secret-value \
  conflict-cookie-value \
  conflict-set-cookie-value \
  Authorization \
  X-Paprika-Admin-Session \
  CONFLICT_TOKEN; do
  assert_file_not_contains \
    "${CONFLICT_ARTIFACT}/conflicting-fixture-status.json" "${secret}"
done
pass "conflicting live status artifacts are sanitized"

FAILURE_ARTIFACT_ROOT="${TEST_ROOT}/failure-artifacts"
mkdir -p "${FAILURE_ARTIFACT_ROOT}"
set +e
env \
  PATH="${FULL_FAKE_BIN}:${PATH}" \
  FAKE_COMMAND_LOG="${FULL_COMMAND_LOG}" \
  FAKE_FAIL_APPLY=37 \
  FLEET_ADMIN_KUBECTL="${FULL_FAKE_BIN}/kubectl" \
  FLEET_ADMIN_HELM="${FULL_FAKE_BIN}/helm" \
  FLEET_ADMIN_GUARD_BIN="${FULL_FAKE_BIN}/guard" \
  FLEET_ADMIN_CURL="${FULL_FAKE_BIN}/curl" \
  FLEET_ADMIN_PAPRIKA_BIN="${FULL_FAKE_BIN}/paprika" \
  FLEET_ADMIN_SKIP_CLI_BUILD=1 \
  FLEET_ADMIN_STOP_TIMEOUT_SECONDS=1 \
  FLEET_ADMIN_CLI_PID="${INDEPENDENT_PID}" \
  FLEET_ADMIN_FORWARD_PID="${INDEPENDENT_PID}" \
  FLEET_ADMIN_READINESS_TIMEOUT_SECONDS=5 \
  FLEET_ADMIN_KUBECONFIG="${TEST_ROOT}/full-kubeconfig" \
  FLEET_ADMIN_CONTEXT=omega \
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
  FLEET_ADMIN_PUBLIC_URL=https://public.example.test \
  FLEET_ADMIN_ARTIFACT_ROOT="${FAILURE_ARTIFACT_ROOT}" \
  FLEET_ADMIN_RUN_ID=fake-success \
  bash "${REAL_HARNESS}" \
  >"${TEST_ROOT}/failure-harness.stdout" \
  2>"${TEST_ROOT}/failure-harness.stderr"
FAILURE_STATUS=$?
set -e
[[ "${FAILURE_STATUS}" -eq 37 ]] ||
  fail "full failing harness returned ${FAILURE_STATUS}, want original 37"
kill -0 "${INDEPENDENT_PID}" 2>/dev/null ||
  fail "inherited PID environment caused the harness to kill an unowned process"
[[ -d "${FAILURE_ARTIFACT_ROOT}/fake-success" ]] ||
  fail "failing harness did not preserve artifacts"
pass "full fake apply failure preserves diagnostics and its original exit code"

[[ -x "${REAL_HARNESS}" ]] || fail "real harness is not executable"
bash -n "${LIBRARY}"
bash -n "${REAL_HARNESS}"

printf '1..%d\n' "${TESTS_RUN}"
