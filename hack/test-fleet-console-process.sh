#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/paprika-fleet-console-process.XXXXXX")"
SIGNAL_LOG="${TEST_ROOT}/signals.log"
INDEPENDENT_PID=""
OWNED_PID=""
TESTS_RUN=0

cleanup() {
  local status=$?
  for pid in "${OWNED_PID}" "${INDEPENDENT_PID}"; do
    if [[ "${pid}" =~ ^[1-9][0-9]*$ ]]; then
      builtin kill -KILL "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
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

# shellcheck source=/dev/null
source "${ROOT_DIR}/hack/lib/fleet-console-process.sh"

STALE_LOG="${TEST_ROOT}/paprika-fleet-console.log.XXXXXX"
: >"${STALE_LOG}"
SEQUENTIAL_LOG_ONE="$(fleet_console_allocate_fixture_log "${TEST_ROOT}")"
SEQUENTIAL_LOG_TWO="$(fleet_console_allocate_fixture_log "${TEST_ROOT}")"
CONCURRENT_RESULT_ONE="${TEST_ROOT}/concurrent-one.path"
CONCURRENT_RESULT_TWO="${TEST_ROOT}/concurrent-two.path"
fleet_console_allocate_fixture_log "${TEST_ROOT}" >"${CONCURRENT_RESULT_ONE}" &
ALLOCATOR_PID_ONE=$!
fleet_console_allocate_fixture_log "${TEST_ROOT}" >"${CONCURRENT_RESULT_TWO}" &
ALLOCATOR_PID_TWO=$!
wait "${ALLOCATOR_PID_ONE}"
wait "${ALLOCATOR_PID_TWO}"
CONCURRENT_LOG_ONE="$(<"${CONCURRENT_RESULT_ONE}")"
CONCURRENT_LOG_TWO="$(<"${CONCURRENT_RESULT_TWO}")"
ALLOCATED_LOGS=(
  "${SEQUENTIAL_LOG_ONE}"
  "${SEQUENTIAL_LOG_TWO}"
  "${CONCURRENT_LOG_ONE}"
  "${CONCURRENT_LOG_TWO}"
)
[[ "$(printf '%s\n' "${ALLOCATED_LOGS[@]}" | sort -u | wc -l | tr -d ' ')" == 4 ]] ||
  fail "fixture log allocations collided"
for allocated_log in "${ALLOCATED_LOGS[@]}"; do
  [[ -f "${allocated_log}" ]] || fail "fixture log allocation did not create ${allocated_log}"
  [[ "${allocated_log}" != "${STALE_LOG}" ]] ||
    fail "fixture log allocation reused the stale literal-X path"
  [[ "$(basename "${allocated_log}")" =~ ^paprika-fleet-console[.]log[.][A-Za-z0-9]+$ ]] ||
    fail "fixture log allocator did not use a trailing-X template: ${allocated_log}"
done
pass "sequential and concurrent fixture logs are unique and cannot reuse stale literal-X paths"

kill() {
  printf '%s\n' "$*" >>"${SIGNAL_LOG}"
  builtin kill "$@"
}

(exit 0) &
RAPID_PID=$!
for _ in {1..100}; do
  fleet_console_job_is_running "${RAPID_PID}" || break
  sleep 0.01
done
sleep 30 &
INDEPENDENT_PID=$!
fleet_console_stop_owned_job "${RAPID_PID}" 1 1
[[ ! -s "${SIGNAL_LOG}" ]] ||
  fail "rapidly exited fixture was signalled: $(tr '\n' ' ' <"${SIGNAL_LOG}")"
builtin kill -0 "${INDEPENDENT_PID}" 2>/dev/null ||
  fail "rapid-exit cleanup disturbed an independently owned job"
pass "rapidly exited fixtures are reaped without signalling a numeric PID"

: >"${SIGNAL_LOG}"
OWNED_READY="${TEST_ROOT}/owned.ready"
OWNED_READY="${OWNED_READY}" /usr/bin/perl -e '
  $SIG{TERM} = "IGNORE";
  open my $ready, ">", $ENV{OWNED_READY} or die $!;
  print {$ready} "ready\n";
  close $ready;
  select undef, undef, undef, 0.05 while 1;
' &
OWNED_PID=$!
for _ in {1..100}; do
  [[ -s "${OWNED_READY}" ]] && break
  sleep 0.01
done
[[ -s "${OWNED_READY}" ]] || fail "TERM-ignoring fixture did not become ready"
started_at=${SECONDS}
fleet_console_stop_owned_job "${OWNED_PID}" 1 1
elapsed=$((SECONDS - started_at))
[[ "${elapsed}" -le 3 ]] ||
  fail "TERM-ignoring fixture cleanup exceeded its bounded deadline"
if builtin kill -0 "${OWNED_PID}" 2>/dev/null; then
  fail "TERM-ignoring fixture survived bounded cleanup"
fi
grep -Fq -- "-TERM ${OWNED_PID}" "${SIGNAL_LOG}" ||
  fail "TERM-ignoring fixture did not receive TERM"
grep -Fq -- "-KILL ${OWNED_PID}" "${SIGNAL_LOG}" ||
  fail "TERM-ignoring fixture did not receive KILL"
OWNED_PID=""
pass "TERM-ignoring active fixture jobs receive bounded TERM then KILL"

[[ "$(fleet_console_final_status 0 1)" == 1 ]] ||
  fail "cleanup failure did not fail an otherwise successful gate"
[[ "$(fleet_console_final_status 37 1)" == 37 ]] ||
  fail "cleanup failure replaced the original nonzero gate status"
pass "fixture cleanup failures fail success while preserving original failures"

printf '1..%d\n' "${TESTS_RUN}"
