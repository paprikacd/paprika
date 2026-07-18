#!/usr/bin/env bash

fleet_console_allocate_fixture_log() {
  local temporary_root=${1:-${TMPDIR:-/tmp}}
  [[ -d "${temporary_root}" ]] || return 2
  mktemp "${temporary_root%/}/paprika-fleet-console.log.XXXXXX"
}

fleet_console_job_is_running() {
  local expected_pid=$1
  [[ "${expected_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  local running_pid
  for running_pid in $(jobs -pr 2>/dev/null); do
    [[ "${running_pid}" == "${expected_pid}" ]] && return 0
  done
  return 1
}

fleet_console_stop_owned_job() {
  local pid=$1
  local term_timeout_seconds=$2
  local kill_timeout_seconds=$3
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 0
  [[ "${term_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "${kill_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || return 2

  local iterations
  if fleet_console_job_is_running "${pid}"; then
    kill -TERM "${pid}" 2>/dev/null || true
    iterations=$((10#${term_timeout_seconds} * 20))
    while ((iterations > 0)) && fleet_console_job_is_running "${pid}"; do
      sleep 0.05
      iterations=$((iterations - 1))
    done
  fi
  if fleet_console_job_is_running "${pid}"; then
    kill -KILL "${pid}" 2>/dev/null || true
    iterations=$((10#${kill_timeout_seconds} * 20))
    while ((iterations > 0)) && fleet_console_job_is_running "${pid}"; do
      sleep 0.05
      iterations=$((iterations - 1))
    done
  fi
  fleet_console_job_is_running "${pid}" && return 1
  # A PID absent from this shell's running-job table is either an exited child
  # (wait is immediately reap-only) or no longer ours; never signal it.
  wait "${pid}" 2>/dev/null || true
}

fleet_console_final_status() {
  local original_status=$1
  local cleanup_status=$2
  if [[ "${original_status}" -ne 0 ]]; then
    printf '%s\n' "${original_status}"
  else
    printf '%s\n' "${cleanup_status}"
  fi
}
