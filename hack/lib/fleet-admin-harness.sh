#!/usr/bin/env bash

# Shared lifecycle for the fleet-admin live acceptance harness. This file is
# intentionally sourceable so the safety properties can be tested without a
# cluster. The executable entrypoint is hack/test-fleet-admin-dashboard.sh.

FLEET_ADMIN_SUITE_LABEL="${FLEET_ADMIN_SUITE_LABEL:-paprika.io/e2e-suite=fleet-admin-dashboard}"
FLEET_ADMIN_CLI_PID="${FLEET_ADMIN_CLI_PID:-}"
FLEET_ADMIN_FORWARD_PID="${FLEET_ADMIN_FORWARD_PID:-}"
FLEET_ADMIN_BOUNDED_PID="${FLEET_ADMIN_BOUNDED_PID:-}"
FLEET_ADMIN_NAMESPACE="${FLEET_ADMIN_NAMESPACE:-}"
FLEET_ADMIN_NAMESPACE_UID="${FLEET_ADMIN_NAMESPACE_UID:-}"
FLEET_ADMIN_RUN_ID="${FLEET_ADMIN_RUN_ID:-}"
FLEET_ADMIN_RUN_LABEL="${FLEET_ADMIN_RUN_LABEL:-}"
FLEET_ADMIN_ARTIFACT_DIR="${FLEET_ADMIN_ARTIFACT_DIR:-}"
FLEET_ADMIN_WORK_DIR="${FLEET_ADMIN_WORK_DIR:-}"
FLEET_ADMIN_OVERLAY_DIR="${FLEET_ADMIN_OVERLAY_DIR:-}"
FLEET_ADMIN_FINALIZED="${FLEET_ADMIN_FINALIZED:-0}"

fleet_admin_log() {
  printf 'fleet-admin: %s\n' "$*" >&2
}

fleet_admin_require_value() {
  local name=$1
  local value=$2
  if [[ -z "${value}" ]]; then
    fleet_admin_log "required environment input ${name} is empty"
    return 2
  fi
}

fleet_admin_validate_run_id_local() {
  local run_id=$1
  local namespace="paprika-fleet-e2e-${run_id}"
  if [[ ${#run_id} -lt 1 ||
    ${#run_id} -gt 63 ||
    ! "${run_id}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ||
    ${#namespace} -gt 63 ]]; then
    fleet_admin_log \
      "invalid run ID: require a DNS1123 label that fits the fleet namespace"
    return 2
  fi
}

fleet_admin_validate_positive_duration() {
  local name=$1
  local value=$2
  if [[ ! "${value}" =~ ^[1-9][0-9]*(ms|s|m|h)$ ]]; then
    fleet_admin_log "${name} must be a positive duration such as 500ms, 30s, or 2m"
    return 2
  fi
}

fleet_admin_redact_file() {
  local source=$1
  local destination=$2
  if [[ ! -f "${source}" ]]; then
    : >"${destination}"
    return 0
  fi
  # Artifact inputs are untrusted Kubernetes/API output, so redact the entire
  # line whenever a case-insensitive structured key contains a credential
  # marker. This covers headers, JSON, YAML, and process-style assignments,
  # including camelCase and underscore-delimited keys.
  awk '
    {
      lower = tolower($0)
      if (lower ~ /(^|[^[:alnum:]_.-])(authorization|x-paprika-admin-session|[[:alnum:]_.-]*(token|secret|password|credential|cookie)[[:alnum:]_.-]*)[[:space:]"]*[:=]/) {
        print "[REDACTED SENSITIVE KEY]"
      } else {
        print
      }
    }
  ' "${source}" |
    sed -E \
      -e 's/([Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/g' \
      >"${destination}"
}

fleet_admin_parse_readiness() {
  local source=$1
  local destination=$2
  [[ -s "${source}" ]] || return 1

  local line_count
  line_count="$(wc -l <"${source}" | tr -d '[:space:]')"
  [[ "${line_count}" == "1" ]] || return 1
  [[ -z "$(tail -c 1 "${source}")" ]] || return 1

  jq -e -S '
    select(
    type == "object" and
    (keys == [
      "accessMode",
      "context",
      "namespace",
      "pod",
      "sessionExpiry",
      "subject",
      "url"
    ]) and
    (.context | type == "string" and length > 0) and
    (.namespace | type == "string" and length > 0) and
    (.pod | type == "string" and length > 0) and
    (.url | type == "string" and test("^http://127[.]0[.]0[.]1:[0-9]+/dashboard/$")) and
    (.subject | type == "string" and length > 0) and
    (.sessionExpiry | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$")) and
    .accessMode == "kubernetes-port-forward-admin"
    )
  ' "${source}" >"${destination}"
}

fleet_admin_is_active_child() {
  local pid=$1
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1

  local active_pid
  while IFS= read -r active_pid; do
    if [[ "${active_pid}" == "${pid}" ]]; then
      return 0
    fi
  done < <(jobs -pr)
  return 1
}

fleet_admin_signal_active_child() {
  local pid=$1
  local signal=$2
  fleet_admin_is_active_child "${pid}" || return 1
  kill "-${signal}" "${pid}" 2>/dev/null
}

fleet_admin_duration_poll_iterations() {
  local duration=$1
  fleet_admin_validate_positive_duration timeout "${duration}" || return 2

  local magnitude
  case "${duration}" in
    *ms)
      magnitude=$((10#${duration%ms}))
      printf '%s\n' "$(((magnitude + 49) / 50))"
      ;;
    *s)
      magnitude=$((10#${duration%s}))
      printf '%s\n' "$((magnitude * 20))"
      ;;
    *m)
      magnitude=$((10#${duration%m}))
      printf '%s\n' "$((magnitude * 1200))"
      ;;
    *h)
      magnitude=$((10#${duration%h}))
      printf '%s\n' "$((magnitude * 72000))"
      ;;
  esac
}

fleet_admin_wait_owned_child_iterations() {
  local pid=$1
  local iterations=$2
  while ((iterations > 0)); do
    fleet_admin_is_active_child "${pid}" || return 0
    sleep 0.05
    iterations=$((iterations - 1))
  done
  ! fleet_admin_is_active_child "${pid}"
}

fleet_admin_positive_seconds_poll_iterations() {
  local seconds=$1
  if [[ ! "${seconds}" =~ ^[1-9][0-9]*$ ]]; then
    return 2
  fi
  printf '%s\n' "$((10#${seconds} * 20))"
}

fleet_admin_run_recorded_bounded() {
  local name=$1
  local timeout=$2
  shift 2
  local raw="${FLEET_ADMIN_WORK_DIR}/${name}.raw"
  local iterations
  iterations="$(fleet_admin_duration_poll_iterations "${timeout}")" || return $?
  [[ -z "${FLEET_ADMIN_BOUNDED_PID}" ]] || {
    fleet_admin_log "refusing concurrent bounded command while PID ${FLEET_ADMIN_BOUNDED_PID} is owned"
    return 125
  }

  "$@" >"${raw}" 2>&1 &
  local pid=$!
  FLEET_ADMIN_BOUNDED_PID="${pid}"
  local timed_out=0
  if ! fleet_admin_wait_owned_child_iterations "${pid}" "${iterations}"; then
    timed_out=1
    printf 'harness:bounded-command-timeout=%s\n' "${timeout}" >>"${raw}"
    fleet_admin_signal_active_child "${pid}" TERM || true
    iterations="$(
      fleet_admin_positive_seconds_poll_iterations \
        "${FLEET_ADMIN_TERM_TIMEOUT_SECONDS:-2}"
    )" || iterations=40
    fleet_admin_wait_owned_child_iterations "${pid}" "${iterations}" || true
    if fleet_admin_is_active_child "${pid}"; then
      printf 'harness:bounded-command-sigkill-after-timeout\n' >>"${raw}"
      fleet_admin_signal_active_child "${pid}" KILL || true
      iterations="$(
        fleet_admin_positive_seconds_poll_iterations \
          "${FLEET_ADMIN_KILL_TIMEOUT_SECONDS:-2}"
      )" || iterations=40
      fleet_admin_wait_owned_child_iterations "${pid}" "${iterations}" || true
    fi
  fi

  if fleet_admin_is_active_child "${pid}"; then
    printf 'harness:bounded-command-still-running-after-sigkill\n' >>"${raw}"
    fleet_admin_redact_file \
      "${raw}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.log" || true
    return 125
  fi

  local command_status=0
  wait "${pid}" 2>/dev/null || command_status=$?
  FLEET_ADMIN_BOUNDED_PID=""
  local redact_status=0
  fleet_admin_redact_file \
    "${raw}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.log" ||
    redact_status=$?
  if [[ "${timed_out}" -ne 0 ]]; then
    return 124
  fi
  if [[ "${command_status}" -ne 0 ]]; then
    return "${command_status}"
  fi
  return "${redact_status}"
}

fleet_admin_wait_readiness() {
  local source=$1
  local destination=$2
  local pid=$3
  local timeout_seconds=$4
  local deadline=$((SECONDS + timeout_seconds))

  while ((SECONDS < deadline)); do
    if fleet_admin_parse_readiness "${source}" "${destination}" 2>/dev/null; then
      return 0
    fi

    if [[ -s "${source}" ]]; then
      local line_count
      line_count="$(wc -l <"${source}" | tr -d '[:space:]')"
      if [[ "${line_count}" -gt 1 ]] ||
        { [[ "${line_count}" == "1" ]] && [[ -z "$(tail -c 1 "${source}")" ]]; }; then
        fleet_admin_log "CLI emitted a malformed or ambiguous readiness contract"
        return 1
      fi
    fi
    if ! fleet_admin_is_active_child "${pid}"; then
      fleet_admin_log "CLI exited before emitting readiness"
      return 1
    fi
    sleep 0.1
  done
  fleet_admin_log "timed out waiting for one complete readiness object"
  return 1
}

fleet_admin_stop_owned_cli() {
  local pid=$1
  local timeout_seconds=$2
  local result_log=$3
  local term_timeout_seconds=${4:-${FLEET_ADMIN_TERM_TIMEOUT_SECONDS:-2}}
  local kill_timeout_seconds=${5:-${FLEET_ADMIN_KILL_TIMEOUT_SECONDS:-2}}
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 0
  fleet_admin_is_active_child "${pid}" || {
    local early_result=0
    wait "${pid}" 2>/dev/null || early_result=$?
    printf 'harness:cli-exit=%s\n' "${early_result}" >>"${result_log}"
    return "${early_result}"
  }

  if fleet_admin_signal_active_child "${pid}" INT; then
    printf 'harness:cli-sigint\n' >>"${result_log}"
  fi
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
    sleep 0.05
  done
  if fleet_admin_signal_active_child "${pid}" TERM; then
    printf 'harness:cli-sigterm-after-timeout\n' >>"${result_log}"
    deadline=$((SECONDS + term_timeout_seconds))
    while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
      sleep 0.05
    done
  fi
  if fleet_admin_signal_active_child "${pid}" KILL; then
    printf 'harness:cli-sigkill-after-timeout\n' >>"${result_log}"
    deadline=$((SECONDS + kill_timeout_seconds))
    while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
      sleep 0.05
    done
  fi
  if fleet_admin_is_active_child "${pid}"; then
    printf 'harness:cli-still-running-after-sigkill\n' >>"${result_log}"
    return 1
  fi
  local result=0
  wait "${pid}" 2>/dev/null || result=$?
  printf 'harness:cli-exit=%s\n' "${result}" >>"${result_log}"
  return "${result}"
}

fleet_admin_stop_owned_forward() {
  local pid=$1
  local timeout_seconds=$2
  local result_log=$3
  local term_timeout_seconds=${4:-${FLEET_ADMIN_TERM_TIMEOUT_SECONDS:-2}}
  local kill_timeout_seconds=${5:-${FLEET_ADMIN_KILL_TIMEOUT_SECONDS:-2}}
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 0
  fleet_admin_is_active_child "${pid}" || {
    local early_result=0
    wait "${pid}" 2>/dev/null || early_result=$?
    printf 'harness:normal-forward-exit=%s\n' "${early_result}" >>"${result_log}"
    return "${early_result}"
  }

  if fleet_admin_signal_active_child "${pid}" INT; then
    printf 'harness:normal-forward-sigint\n' >>"${result_log}"
  fi
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
    sleep 0.05
  done
  if fleet_admin_signal_active_child "${pid}" TERM; then
    printf 'harness:normal-forward-sigterm-after-timeout\n' >>"${result_log}"
    deadline=$((SECONDS + term_timeout_seconds))
    while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
      sleep 0.05
    done
  fi
  if fleet_admin_signal_active_child "${pid}" KILL; then
    printf 'harness:normal-forward-sigkill-after-timeout\n' >>"${result_log}"
    deadline=$((SECONDS + kill_timeout_seconds))
    while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
      sleep 0.05
    done
  fi
  if fleet_admin_is_active_child "${pid}"; then
    printf 'harness:normal-forward-still-running-after-sigkill\n' >>"${result_log}"
    return 1
  fi
  local result=0
  wait "${pid}" 2>/dev/null || result=$?
  printf 'harness:normal-forward-exit=%s\n' "${result}" >>"${result_log}"
  return "${result}"
}

fleet_admin_stop_owned_bounded() {
  local pid=$1
  local timeout_seconds=$2
  local result_log=$3
  local kill_timeout_seconds=${4:-${FLEET_ADMIN_KILL_TIMEOUT_SECONDS:-2}}
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 0
  fleet_admin_is_active_child "${pid}" || {
    local early_result=0
    wait "${pid}" 2>/dev/null || early_result=$?
    printf 'harness:bounded-exit=%s\n' "${early_result}" >>"${result_log}"
    return "${early_result}"
  }

  if fleet_admin_signal_active_child "${pid}" TERM; then
    printf 'harness:bounded-sigterm\n' >>"${result_log}"
  fi
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
    sleep 0.05
  done
  if fleet_admin_signal_active_child "${pid}" KILL; then
    printf 'harness:bounded-sigkill-after-timeout\n' >>"${result_log}"
    deadline=$((SECONDS + kill_timeout_seconds))
    while ((SECONDS < deadline)) && fleet_admin_is_active_child "${pid}"; do
      sleep 0.05
    done
  fi
  if fleet_admin_is_active_child "${pid}"; then
    printf 'harness:bounded-still-running-after-sigkill\n' >>"${result_log}"
    return 1
  fi
  local result=0
  wait "${pid}" 2>/dev/null || result=$?
  printf 'harness:bounded-exit=%s\n' "${result}" >>"${result_log}"
  return "${result}"
}

fleet_admin_capture_diagnostic() {
  local name=$1
  shift
  [[ -n "${FLEET_ADMIN_ARTIFACT_DIR}" && -n "${FLEET_ADMIN_WORK_DIR}" ]] || return 0
  local raw="${FLEET_ADMIN_WORK_DIR}/diagnostic-${name}.raw"
  "$@" >"${raw}" 2>&1 || true
  fleet_admin_redact_file "${raw}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.log"
}

fleet_admin_collect_process_outputs() {
  [[ -n "${FLEET_ADMIN_ARTIFACT_DIR}" ]] || return 0
  local cleanup_status=0
  local step_status=0
  mkdir -p "${FLEET_ADMIN_ARTIFACT_DIR}" ||
    {
      step_status=$?
      cleanup_status=${step_status}
    }
  if [[ -n "${FLEET_ADMIN_WORK_DIR}" ]]; then
    fleet_admin_redact_file \
      "${FLEET_ADMIN_WORK_DIR}/admin-cli.stdout" \
      "${FLEET_ADMIN_ARTIFACT_DIR}/admin-cli.stdout" ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
    fleet_admin_redact_file \
      "${FLEET_ADMIN_WORK_DIR}/admin-cli.stderr" \
      "${FLEET_ADMIN_ARTIFACT_DIR}/admin-cli.stderr" ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
    fleet_admin_redact_file \
      "${FLEET_ADMIN_WORK_DIR}/normal-port-forward.stdout" \
      "${FLEET_ADMIN_ARTIFACT_DIR}/normal-port-forward.stdout" ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
    fleet_admin_redact_file \
      "${FLEET_ADMIN_WORK_DIR}/normal-port-forward.stderr" \
      "${FLEET_ADMIN_ARTIFACT_DIR}/normal-port-forward.stderr" ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
  fi
  return "${cleanup_status}"
}

fleet_admin_collect_diagnostics() {
  local cleanup_status=0
  local step_status=0
  fleet_admin_collect_process_outputs ||
    {
      step_status=$?
      cleanup_status=${step_status}
    }

  [[ -n "${FLEET_ADMIN_KUBECTL:-}" ]] || return "${cleanup_status}"
  local kube=(
    "${FLEET_ADMIN_KUBECTL}"
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}"
    --context "${FLEET_ADMIN_CONTEXT}"
    --request-timeout="${FLEET_ADMIN_DIAGNOSTIC_REQUEST_TIMEOUT:-15s}"
  )
  local instance_label="app.kubernetes.io/instance=${FLEET_ADMIN_TARGET_RELEASE}"
  fleet_admin_capture_diagnostic api-current \
    "${kube[@]}" logs -n "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    -l "${instance_label},app.kubernetes.io/component=api-server" \
    --all-containers=true --prefix=true \
    --tail="${FLEET_ADMIN_DIAGNOSTIC_LOG_TAIL:-500}" ||
    {
      step_status=$?
      [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
    }
  fleet_admin_capture_diagnostic api-previous \
    "${kube[@]}" logs -n "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    -l "${instance_label},app.kubernetes.io/component=api-server" \
    --all-containers=true --prefix=true \
    --tail="${FLEET_ADMIN_DIAGNOSTIC_LOG_TAIL:-500}" --previous ||
    {
      step_status=$?
      [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
    }
  fleet_admin_capture_diagnostic manager-current \
    "${kube[@]}" logs -n "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    -l "${instance_label},control-plane=controller-manager" \
    --all-containers=true --prefix=true \
    --tail="${FLEET_ADMIN_DIAGNOSTIC_LOG_TAIL:-500}" ||
    {
      step_status=$?
      [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
    }
  fleet_admin_capture_diagnostic manager-previous \
    "${kube[@]}" logs -n "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    -l "${instance_label},control-plane=controller-manager" \
    --all-containers=true --prefix=true \
    --tail="${FLEET_ADMIN_DIAGNOSTIC_LOG_TAIL:-500}" --previous ||
    {
      step_status=$?
      [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
    }
  if [[ -n "${FLEET_ADMIN_NAMESPACE}" ]]; then
    fleet_admin_capture_diagnostic namespace-events \
      "${kube[@]}" get events -n "${FLEET_ADMIN_NAMESPACE}" \
      --sort-by=.metadata.creationTimestamp ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
    fleet_admin_capture_diagnostic fixture-live \
      "${kube[@]}" get \
      appprojects.core.paprika.io,clusters.clusters.paprika.io,\
applications.pipelines.paprika.io,stages.pipelines.paprika.io,\
releases.pipelines.paprika.io,pipelines.pipelines.paprika.io,\
rollouts.rollouts.paprika.io \
      -n "${FLEET_ADMIN_NAMESPACE}" \
      --selector="${FLEET_ADMIN_SUITE_LABEL},${FLEET_ADMIN_RUN_LABEL}" \
      -o yaml ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
  fi
  return "${cleanup_status}"
}

fleet_admin_stop_all_owned_processes() {
  local result_log="${FLEET_ADMIN_ARTIFACT_DIR:-${TMPDIR:-/tmp}}/process-results.log"
  local cleanup_status=0
  local process_status=0
  mkdir -p "$(dirname "${result_log}")"
  # Bounded acceptance commands may own a detached browser process group. Stop
  # that group before revoking the admin session it is actively using.
  if [[ -n "${FLEET_ADMIN_BOUNDED_PID}" ]]; then
    fleet_admin_stop_owned_bounded \
      "${FLEET_ADMIN_BOUNDED_PID}" \
      "${FLEET_ADMIN_STOP_TIMEOUT_SECONDS:-10}" \
      "${result_log}" ||
      {
        process_status=$?
        cleanup_status=${process_status}
      }
    FLEET_ADMIN_BOUNDED_PID=""
  fi
  # The CLI must exit first: its authenticated DELETE revokes the session while
  # the hidden Kubernetes tunnel is still owned by the CLI.
  if [[ -n "${FLEET_ADMIN_CLI_PID}" ]]; then
    fleet_admin_stop_owned_cli \
      "${FLEET_ADMIN_CLI_PID}" \
      "${FLEET_ADMIN_STOP_TIMEOUT_SECONDS:-10}" \
      "${result_log}" ||
      {
        process_status=$?
        cleanup_status=${process_status}
      }
    FLEET_ADMIN_CLI_PID=""
  fi
  if [[ -n "${FLEET_ADMIN_FORWARD_PID}" ]]; then
    fleet_admin_stop_owned_forward \
      "${FLEET_ADMIN_FORWARD_PID}" \
      "${FLEET_ADMIN_STOP_TIMEOUT_SECONDS:-10}" \
      "${result_log}" ||
      {
        process_status=$?
        if [[ "${cleanup_status}" -eq 0 ]]; then
          cleanup_status=${process_status}
        fi
      }
    FLEET_ADMIN_FORWARD_PID=""
  fi
  return "${cleanup_status}"
}

fleet_admin_delete_owned_fixtures() {
  [[ -n "${FLEET_ADMIN_NAMESPACE}" && -n "${FLEET_ADMIN_RUN_LABEL}" ]] || return 0
  "${FLEET_ADMIN_KUBECTL}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --request-timeout="${FLEET_ADMIN_REQUEST_TIMEOUT}" \
    delete \
    appprojects.core.paprika.io,clusters.clusters.paprika.io,\
applications.pipelines.paprika.io,stages.pipelines.paprika.io,\
releases.pipelines.paprika.io,pipelines.pipelines.paprika.io,\
rollouts.rollouts.paprika.io \
    --namespace "${FLEET_ADMIN_NAMESPACE}" \
    --selector="${FLEET_ADMIN_SUITE_LABEL},${FLEET_ADMIN_RUN_LABEL}" \
    --ignore-not-found=true \
    --wait=true \
    --timeout="${FLEET_ADMIN_DELETE_TIMEOUT:-60s}"
}

fleet_admin_delete_owned_namespace() {
  [[ -n "${FLEET_ADMIN_NAMESPACE}" && -n "${FLEET_ADMIN_NAMESPACE_UID}" ]] || return 0
  "${FLEET_ADMIN_GUARD_BIN}" delete \
    --run-id "${FLEET_ADMIN_RUN_ID}" \
    --namespace "${FLEET_ADMIN_NAMESPACE}" \
    --uid "${FLEET_ADMIN_NAMESPACE_UID}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --timeout "${FLEET_ADMIN_REQUEST_TIMEOUT}"
}

fleet_admin_finalize() {
  local original_status=${1:-1}
  [[ "${FLEET_ADMIN_FINALIZED}" == "0" ]] || return "${original_status}"
  FLEET_ADMIN_FINALIZED=1
  local cleanup_status=0

  fleet_admin_collect_diagnostics || cleanup_status=1
  fleet_admin_stop_all_owned_processes || cleanup_status=1
  # Capture the CLI's shutdown/revocation result after it has exited. This is a
  # second sanitized copy, not a second Kubernetes diagnostics pass.
  fleet_admin_collect_process_outputs || cleanup_status=1
  fleet_admin_delete_owned_fixtures || cleanup_status=1
  fleet_admin_delete_owned_namespace || cleanup_status=1
  fleet_admin_remove_owned_temporary_paths || cleanup_status=1
  if [[ "${original_status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    return 1
  fi
  return "${original_status}"
}

fleet_admin_remove_owned_temporary_paths() {
  [[ -n "${FLEET_ADMIN_OVERLAY_DIR}" || -n "${FLEET_ADMIN_WORK_DIR}" ]] || return 0
  [[ -n "${FLEET_ADMIN_ROOT}" &&
    -n "${FLEET_ADMIN_RUN_ID}" &&
    -n "${FLEET_ADMIN_ARTIFACT_DIR}" ]] || {
    fleet_admin_log "refusing temporary cleanup with incomplete ownership paths"
    return 1
  }

  local root artifact overlay work fleet_parent
  root="$(cd "${FLEET_ADMIN_ROOT}" && pwd -P)" || return 1
  artifact="$(cd "${FLEET_ADMIN_ARTIFACT_DIR}" && pwd -P)" || return 1
  fleet_parent="${root}/config/e2e/fleet-admin"

  if [[ -n "${FLEET_ADMIN_OVERLAY_DIR}" ]]; then
    overlay="$(cd "${FLEET_ADMIN_OVERLAY_DIR}" && pwd -P)" || return 1
    [[ "$(dirname "${overlay}")" == "${fleet_parent}" ]] || {
      fleet_admin_log "refusing cleanup for overlay outside the fleet-admin directory"
      return 1
    }
    case "$(basename "${overlay}")" in
      ".run-${FLEET_ADMIN_RUN_ID}."*) ;;
      *)
        fleet_admin_log "refusing cleanup for overlay without the owned run prefix"
        return 1
        ;;
    esac
  fi
  if [[ -n "${FLEET_ADMIN_WORK_DIR}" ]]; then
    work="$(cd "${FLEET_ADMIN_WORK_DIR}" && pwd -P)" || return 1
    [[ "$(dirname "${work}")" == "${artifact}" ]] || {
      fleet_admin_log "refusing cleanup for work directory outside the artifact directory"
      return 1
    }
    case "$(basename "${work}")" in
      .work.*) ;;
      *)
        fleet_admin_log "refusing cleanup for work directory without the owned prefix"
        return 1
        ;;
    esac
  fi

  local cleanup_status=0
  local step_status=0
  if [[ -n "${overlay}" ]]; then
    rm -rf "${overlay}" ||
      {
        step_status=$?
        cleanup_status=${step_status}
      }
  fi
  if [[ -n "${work}" ]]; then
    rm -rf "${work}" ||
      {
        step_status=$?
        [[ "${cleanup_status}" -ne 0 ]] || cleanup_status=${step_status}
      }
  fi
  return "${cleanup_status}"
}

fleet_admin_run_recorded() {
  local name=$1
  shift
  local raw="${FLEET_ADMIN_WORK_DIR}/${name}.raw"
  local status=0
  "$@" >"${raw}" 2>&1 || status=$?
  fleet_admin_redact_file "${raw}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.log"
  return "${status}"
}

fleet_admin_build_guard() {
  if [[ -n "${FLEET_ADMIN_GUARD_BIN:-}" ]]; then
    return 0
  fi
  FLEET_ADMIN_GUARD_BIN="${FLEET_ADMIN_WORK_DIR}/fleetadmin-guard"
  (
    cd "${FLEET_ADMIN_ROOT}" || exit
    "${FLEET_ADMIN_GO:-go}" build \
      -o "${FLEET_ADMIN_GUARD_BIN}" \
      ./test/fleetadmin/guard
  )
}

fleet_admin_validate_run_id() {
  "${FLEET_ADMIN_GUARD_BIN}" overlay \
    --run-id "${FLEET_ADMIN_RUN_ID}" \
    >"${FLEET_ADMIN_WORK_DIR}/validated-kustomization.yaml"
}

fleet_admin_create_namespace() {
  local ownership="${FLEET_ADMIN_WORK_DIR}/namespace-ownership.json"
  "${FLEET_ADMIN_GUARD_BIN}" create \
    --run-id "${FLEET_ADMIN_RUN_ID}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --timeout "${FLEET_ADMIN_REQUEST_TIMEOUT}" >"${ownership}"
  jq -e -S '
    type == "object" and
    (keys == ["namespace", "runId", "uid"]) and
    (.namespace | type == "string" and length > 0) and
    (.runId | type == "string" and length > 0) and
    (.uid | type == "string" and length > 0)
  ' "${ownership}" >"${FLEET_ADMIN_ARTIFACT_DIR}/namespace-ownership.json"
  FLEET_ADMIN_NAMESPACE="$(jq -r '.namespace' "${ownership}")"
  FLEET_ADMIN_NAMESPACE_UID="$(jq -r '.uid' "${ownership}")"
  [[ "$(jq -r '.runId' "${ownership}")" == "${FLEET_ADMIN_RUN_ID}" ]]
}

fleet_admin_prepare_fixture_documents() {
  FLEET_ADMIN_OVERLAY_DIR="$(mktemp -d \
    "${FLEET_ADMIN_ROOT}/config/e2e/fleet-admin/.run-${FLEET_ADMIN_RUN_ID}.XXXXXX")"
  cp "${FLEET_ADMIN_WORK_DIR}/validated-kustomization.yaml" \
    "${FLEET_ADMIN_OVERLAY_DIR}/kustomization.yaml"

  local rendered_with_status="${FLEET_ADMIN_WORK_DIR}/fixtures-with-status.yaml"
  local rendered_all_objects="${FLEET_ADMIN_WORK_DIR}/fixtures-all-objects.yaml"
  local rendered_objects="${FLEET_ADMIN_WORK_DIR}/fixtures-objects.yaml"
  local rendered_stages="${FLEET_ADMIN_WORK_DIR}/fixtures-stage-metadata.yaml"
  "${FLEET_ADMIN_KUBECTL}" kustomize \
    "${FLEET_ADMIN_OVERLAY_DIR}" >"${rendered_with_status}"

  # Kustomize removes every top-level status before the create/update request.
  # Statuses are sent later through the status subresource only.
  {
    printf '%s\n' \
      'patches:' \
      '  - target:' \
      '      labelSelector: paprika.io/e2e-suite=fleet-admin-dashboard' \
      '    patch: |-' \
      '      - op: remove' \
      '        path: /status'
  } >>"${FLEET_ADMIN_OVERLAY_DIR}/kustomization.yaml"
  "${FLEET_ADMIN_KUBECTL}" kustomize \
    "${FLEET_ADMIN_OVERLAY_DIR}" >"${rendered_all_objects}"
  if grep -q '^status:' "${rendered_all_objects}"; then
    fleet_admin_log "object fixture rendering retained a top-level status"
    return 1
  fi
  "${FLEET_ADMIN_GUARD_BIN}" fixture-documents \
    --mode objects \
    --input "${rendered_all_objects}" >"${rendered_objects}"
  "${FLEET_ADMIN_GUARD_BIN}" fixture-documents \
    --mode stages \
    --input "${rendered_all_objects}" >"${rendered_stages}"
  if grep -q '^kind: Stage$' "${rendered_objects}"; then
    fleet_admin_log "object fixture rendering retained a controller-owned Stage"
    return 1
  fi
  if ! grep -q '^kind: Stage$' "${rendered_stages}"; then
    fleet_admin_log "Stage metadata fixture rendering is empty"
    return 1
  fi
  fleet_admin_redact_file "${rendered_with_status}" \
    "${FLEET_ADMIN_ARTIFACT_DIR}/fixtures-rendered-with-status.yaml"
  fleet_admin_redact_file "${rendered_objects}" \
    "${FLEET_ADMIN_ARTIFACT_DIR}/fixtures-objects.yaml"
  fleet_admin_redact_file "${rendered_stages}" \
    "${FLEET_ADMIN_ARTIFACT_DIR}/fixtures-stage-metadata.yaml"
}

fleet_admin_apply_fixtures() {
  local kube=(
    "${FLEET_ADMIN_KUBECTL}"
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}"
    --context "${FLEET_ADMIN_CONTEXT}"
    --request-timeout="${FLEET_ADMIN_REQUEST_TIMEOUT}"
  )
  "${kube[@]}" \
    apply -f "${FLEET_ADMIN_WORK_DIR}/fixtures-objects.yaml"
  # Applications are the sole Stage spec owners. Wait for their reconciler to
  # materialize the exact identities and controller-owner graph before adding
  # only the harness ownership labels used by cleanup and inventory checks.
  "${FLEET_ADMIN_GUARD_BIN}" wait-stages \
    --run-id "${FLEET_ADMIN_RUN_ID}" \
    --namespace "${FLEET_ADMIN_NAMESPACE}" \
    --uid "${FLEET_ADMIN_NAMESPACE_UID}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --timeout "${FLEET_ADMIN_REQUEST_TIMEOUT}"
  "${kube[@]}" \
    label \
    --overwrite \
    -f "${FLEET_ADMIN_WORK_DIR}/fixtures-stage-metadata.yaml" \
    "${FLEET_ADMIN_SUITE_LABEL}" \
    "${FLEET_ADMIN_RUN_LABEL}"
  "${FLEET_ADMIN_GUARD_BIN}" link \
    --run-id "${FLEET_ADMIN_RUN_ID}" \
    --namespace "${FLEET_ADMIN_NAMESPACE}" \
    --uid "${FLEET_ADMIN_NAMESPACE_UID}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --timeout "${FLEET_ADMIN_REQUEST_TIMEOUT}"
  # Server-side apply uses the PATCH verb against only the status subresource;
  # spec and ownership metadata cannot be rewritten by this operation.
  "${kube[@]}" \
    apply \
    --server-side \
    --force-conflicts \
    --subresource=status \
    --field-manager=paprika-fleet-admin-harness \
    -f "${FLEET_ADMIN_WORK_DIR}/fixtures-with-status.yaml"
}

fleet_admin_verify_live_statuses() {
  local live="${FLEET_ADMIN_WORK_DIR}/fixture-live-status.json"
  "${FLEET_ADMIN_KUBECTL}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --request-timeout="${FLEET_ADMIN_REQUEST_TIMEOUT}" \
    get \
    appprojects.core.paprika.io,clusters.clusters.paprika.io,\
applications.pipelines.paprika.io,stages.pipelines.paprika.io,\
releases.pipelines.paprika.io,pipelines.pipelines.paprika.io,\
rollouts.rollouts.paprika.io \
    --namespace "${FLEET_ADMIN_NAMESPACE}" \
    --selector="${FLEET_ADMIN_SUITE_LABEL},${FLEET_ADMIN_RUN_LABEL}" \
    -o json >"${live}" || return 1
  if ! jq -e '
    def one($kind; $name):
      [.items[] | select(.kind == $kind and .metadata.name == $name)]
      | select(length == 1) | .[0];
    def inventory($kind; $count):
      [.items[] | select(.kind == $kind)]
      | length == $count;
    def observed($kind):
      [.items[] | select(.kind == $kind) | .status.observedGeneration]
      | all(. == 1);
    inventory("AppProject"; 2) and observed("AppProject") and
    inventory("Cluster"; 2) and observed("Cluster") and
    inventory("Application"; 6) and observed("Application") and
    inventory("Stage"; 6) and observed("Stage") and
    inventory("Release"; 4) and observed("Release") and
    inventory("Pipeline"; 2) and observed("Pipeline") and
    inventory("Rollout"; 4) and observed("Rollout") and
    (one("Application"; "checkout").status.health == "Healthy") and
    (one("Application"; "catalog").status.health == "Progressing") and
    (one("Application"; "billing").status.health == "Degraded") and
    (one("Application"; "ledger").status.phase == "Degraded") and
    (one("Application"; "ledger").status.health == "Failed") and
    (one("Application"; "search").status.health == "Unknown") and
    (one("Application"; "notifications").status.resources[0].status == "Missing") and
    (one("Release"; "catalog-active").status.phase == "Failed") and
    (one("Release"; "checkout-complete").status.phase == "Complete") and
    (one("Release"; "ledger-failed").status.phase == "Failed") and
    (one("Release"; "billing-gated").status.phase == "AwaitingApproval") and
    (one("Rollout"; "catalog-active-rollout").status.phase == "Progressing") and
    (one("Rollout"; "checkout-complete-rollout").status.phase == "Healthy") and
    (one("Rollout"; "ledger-failed-rollout").status.phase == "Failed") and
    (one("Rollout"; "billing-gated-rollout").status.phase == "Paused") and
    (one("Pipeline"; "storefront-ci").status.phase == "Succeeded") and
    (one("Pipeline"; "finance-ci").status.phase == "Failed")
  ' "${live}" >/dev/null; then
    fleet_admin_redact_file "${live}" \
      "${FLEET_ADMIN_ARTIFACT_DIR}/conflicting-fixture-status.json"
    fleet_admin_log "controller changed the deterministic fixture inventory or status"
    return 1
  fi
}

fleet_admin_start_cli() {
  local stdout="${FLEET_ADMIN_WORK_DIR}/admin-cli.stdout"
  local stderr="${FLEET_ADMIN_WORK_DIR}/admin-cli.stderr"
  : >"${stdout}"
  : >"${stderr}"
  "${FLEET_ADMIN_PAPRIKA_BIN}" --output=json admin dashboard \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --namespace "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    --release "${FLEET_ADMIN_TARGET_RELEASE}" \
    --port 0 \
    --no-open \
    --timeout "${FLEET_ADMIN_CLI_TIMEOUT:-60s}" \
    >"${stdout}" 2>"${stderr}" &
  FLEET_ADMIN_CLI_PID=$!
  fleet_admin_wait_readiness \
    "${stdout}" \
    "${FLEET_ADMIN_ARTIFACT_DIR}/admin-readiness.json" \
    "${FLEET_ADMIN_CLI_PID}" \
    "${FLEET_ADMIN_READINESS_TIMEOUT_SECONDS:-70}"

  [[ "$(jq -r '.namespace' "${FLEET_ADMIN_ARTIFACT_DIR}/admin-readiness.json")" == \
    "${FLEET_ADMIN_TARGET_NAMESPACE}" ]] || {
    fleet_admin_log "CLI readiness namespace does not match the requested namespace"
    return 1
  }
  FLEET_ADMIN_SELECTED_POD="$(jq -r '.pod' \
    "${FLEET_ADMIN_ARTIFACT_DIR}/admin-readiness.json")"
  FLEET_ADMIN_DASHBOARD_URL="$(jq -r '.url' \
    "${FLEET_ADMIN_ARTIFACT_DIR}/admin-readiness.json")"
  FLEET_ADMIN_PROXY_URL="${FLEET_ADMIN_DASHBOARD_URL%/dashboard/}"
  [[ "${FLEET_ADMIN_PROXY_URL}" != "${FLEET_ADMIN_DASHBOARD_URL}" ]] || {
    fleet_admin_log "CLI readiness URL is not the expected dashboard URL"
    return 1
  }
}

fleet_admin_connect_request() {
  local origin=$1
  local method=$2
  local body=$3
  local name=$4
  local raw_headers="${FLEET_ADMIN_WORK_DIR}/${name}.headers.raw"
  local raw_body="${FLEET_ADMIN_WORK_DIR}/${name}.body.raw"
  local status_file="${FLEET_ADMIN_ARTIFACT_DIR}/${name}.status"
  local status=0
  status="$("${FLEET_ADMIN_CURL}" \
    --silent --show-error \
    --connect-timeout "${FLEET_ADMIN_HTTP_CONNECT_TIMEOUT_SECONDS:-5}" \
    --max-time "${FLEET_ADMIN_HTTP_TIMEOUT_SECONDS:-15}" \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'Connect-Protocol-Version: 1' \
    --data "${body}" \
    --dump-header "${raw_headers}" \
    --output "${raw_body}" \
    --write-out '%{http_code}' \
    "${origin}/paprika.v1.PaprikaService/${method}")" || return $?
  printf '%s\n' "${status}" >"${status_file}"
  fleet_admin_redact_file \
    "${raw_headers}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.headers"
  fleet_admin_redact_file \
    "${raw_body}" "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.body.json"
}

fleet_admin_json_contains_all() {
  local file=$1
  shift
  local needle
  for needle in "$@"; do
    jq -e --arg needle "${needle}" \
      '[.. | strings] | index($needle) != null' "${file}" >/dev/null || return 1
  done
}

fleet_admin_validate_exact_snapshot() {
  local namespace=$1
  local fleet=$2
  local releases=$3
  local rollouts=$4
  local pipelines=$5

  jq -e --arg namespace "${namespace}" '
    def object($name): {namespace: $namespace, name: $name};
    def metadata($project; $cluster; $stage; $sync; $release; $rollout):
      {
        project: object($project),
        currentCluster: object($cluster),
        currentStage: $stage,
        sync: $sync,
        release: $release,
        rollout: $rollout
      };
    def expected_application(
      $name; $project; $cluster; $stage; $health; $sync; $release; $rollout
    ):
      {
        stableId: ("a:" + $namespace + "/" + $name),
        kind: "FLEET_MAP_NODE_KIND_APPLICATION",
        label: $name,
        application: object($name),
        applicationCount: 1,
        targetCount: 1,
        health: [{health: $health, count: 1}],
        applicationMetadata:
          metadata($project; $cluster; $stage; $sync; $release; $rollout)
      };
    def expected:
      [
        expected_application(
          "billing"; "finance"; "cluster-west"; "production";
          "FLEET_HEALTH_DEGRADED"; "FLEET_SYNC_STATE_OUT_OF_SYNC";
          "FLEET_RELEASE_STATE_AWAITING_APPROVAL"; "FLEET_ROLLOUT_STATE_PAUSED"
        ),
        expected_application(
          "catalog"; "storefront"; "cluster-east"; "staging";
          "FLEET_HEALTH_PROGRESSING"; "FLEET_SYNC_STATE_UNKNOWN";
          "FLEET_RELEASE_STATE_FAILED"; "FLEET_ROLLOUT_STATE_PROGRESSING"
        ),
        expected_application(
          "checkout"; "storefront"; "cluster-east"; "production";
          "FLEET_HEALTH_HEALTHY"; "FLEET_SYNC_STATE_SYNCED";
          "FLEET_RELEASE_STATE_COMPLETE"; "FLEET_ROLLOUT_STATE_HEALTHY"
        ),
        expected_application(
          "ledger"; "finance"; "cluster-west"; "production";
          "FLEET_HEALTH_FAILED"; "FLEET_SYNC_STATE_OUT_OF_SYNC";
          "FLEET_RELEASE_STATE_FAILED"; "FLEET_ROLLOUT_STATE_FAILED"
        ),
        expected_application(
          "notifications"; "finance"; "cluster-west"; "development";
          "FLEET_HEALTH_MISSING"; "FLEET_SYNC_STATE_UNKNOWN";
          "FLEET_RELEASE_STATE_UNSPECIFIED"; "FLEET_ROLLOUT_STATE_UNSPECIFIED"
        ),
        expected_application(
          "search"; "storefront"; "cluster-east"; "development";
          "FLEET_HEALTH_UNKNOWN"; "FLEET_SYNC_STATE_SYNCED";
          "FLEET_RELEASE_STATE_UNSPECIFIED"; "FLEET_ROLLOUT_STATE_UNSPECIFIED"
        )
      ];
    def normalized_application:
      {
        stableId,
        kind,
        label,
        application,
        applicationCount: (.applicationCount | tonumber),
        targetCount: (.targetCount | tonumber),
        health: [
          .health[] | {health, count: (.count | tonumber)}
        ],
        applicationMetadata: {
          project: .applicationMetadata.project,
          currentCluster: .applicationMetadata.currentCluster,
          currentStage: .applicationMetadata.currentStage,
          sync: (
            .applicationMetadata.sync //
            "FLEET_SYNC_STATE_UNSPECIFIED"
          ),
          release: (
            .applicationMetadata.release //
            "FLEET_RELEASE_STATE_UNSPECIFIED"
          ),
          rollout: (
            .applicationMetadata.rollout //
            "FLEET_ROLLOUT_STATE_UNSPECIFIED"
          )
        }
      };
    [
      .. | objects
      | select(
          .kind? == "FLEET_MAP_NODE_KIND_APPLICATION" and
          (.application? | type == "object")
        )
      | normalized_application
    ] as $applications
    | ((.total | tonumber) == 6) and
      ((.indexGeneration | tonumber) > 0) and
      ($applications | length == 6) and
      ($applications | sort_by(.label) == expected)
  ' "${fleet}" >/dev/null &&
    jq -e --arg namespace "${namespace}" '
      def release($name; $phase; $application; $rollout):
        {
          namespace: $namespace,
          name: $name,
          phase: $phase,
          application: $application,
          rolloutRef: $rollout
        };
      def expected:
        [
          release(
            "billing-gated"; "AwaitingApproval"; "billing";
            "billing-gated-rollout"
          ),
          release(
            "catalog-active"; "Failed"; "catalog";
            "catalog-active-rollout"
          ),
          release(
            "checkout-complete"; "Complete"; "checkout";
            "checkout-complete-rollout"
          ),
          release(
            "ledger-failed"; "Failed"; "ledger";
            "ledger-failed-rollout"
          )
        ];
      ((.totalCount | tonumber) == 4) and
      (.releases | length == 4) and
      ([
        .releases[]
        | {namespace, name, phase, application, rolloutRef}
      ] | sort_by(.name) == expected)
    ' "${releases}" >/dev/null &&
    jq -e --arg namespace "${namespace}" '
      def rollout($name; $phase):
        {namespace: $namespace, name: $name, phase: $phase};
      def expected:
        [
          rollout("billing-gated-rollout"; "Paused"),
          rollout("catalog-active-rollout"; "Progressing"),
          rollout("checkout-complete-rollout"; "Healthy"),
          rollout("ledger-failed-rollout"; "Failed")
        ];
      (.rollouts | length == 4) and
      ([
        .rollouts[] | {namespace, name, phase}
      ] | sort_by(.name) == expected)
    ' "${rollouts}" >/dev/null &&
    jq -e --arg namespace "${namespace}" '
      def pipeline($name; $phase; $project):
        {
          namespace: $namespace,
          name: $name,
          phase: $phase,
          project: $project
        };
      def expected:
        [
          pipeline("finance-ci"; "Failed"; "finance"),
          pipeline("storefront-ci"; "Succeeded"; "storefront")
        ];
      (.pipelines | length == 2) and
      ([
        .pipelines[] | {namespace, name, phase, project}
      ] | sort_by(.name) == expected)
    ' "${pipelines}" >/dev/null
}

fleet_admin_query_exact_snapshot() {
  local deadline=$((SECONDS + ${FLEET_ADMIN_SNAPSHOT_TIMEOUT_SECONDS:-60}))
  local namespace_body
  namespace_body="$(jq -cn --arg namespace "${FLEET_ADMIN_NAMESPACE}" \
    '{namespace: $namespace}')"
  local fleet_body
  fleet_body="$(jq -cn --arg namespace "${FLEET_ADMIN_NAMESPACE}" \
    '{filter: {namespaces: [$namespace]}}')"
  local release_body
  release_body="$(jq -cn --arg namespace "${FLEET_ADMIN_NAMESPACE}" \
    '{filter: {namespaces: [$namespace]}, pageSize: 100}')"

  while ((SECONDS < deadline)); do
    if ! fleet_admin_verify_live_statuses; then
      return 1
    fi
    if fleet_admin_connect_request \
      "${FLEET_ADMIN_PROXY_URL}" QueryFleetMap "${fleet_body}" snapshot-fleet &&
      fleet_admin_connect_request \
        "${FLEET_ADMIN_PROXY_URL}" QueryReleases "${release_body}" snapshot-releases &&
      fleet_admin_connect_request \
        "${FLEET_ADMIN_PROXY_URL}" ListRollouts "${namespace_body}" snapshot-rollouts &&
      fleet_admin_connect_request \
        "${FLEET_ADMIN_PROXY_URL}" ListPipelines "${namespace_body}" snapshot-pipelines &&
      [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-fleet.status")" == "200" ]] &&
      [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-releases.status")" == "200" ]] &&
      [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-rollouts.status")" == "200" ]] &&
      [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-pipelines.status")" == "200" ]] &&
      fleet_admin_validate_exact_snapshot \
        "${FLEET_ADMIN_NAMESPACE}" \
        "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-fleet.body.json" \
        "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-releases.body.json" \
        "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-rollouts.body.json" \
        "${FLEET_ADMIN_ARTIFACT_DIR}/snapshot-pipelines.body.json"; then
      return 0
    fi
    sleep 0.5
  done
  fleet_admin_log "timed out waiting for the exact run-scoped API snapshot"
  return 1
}

fleet_admin_wait_normal_forward() {
  local stderr=$1
  local pid=$2
  local timeout_seconds=$3
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    local count
    count="$(grep -Ec '^Forwarding from 127[.]0[.]0[.]1:[0-9]+ -> 3000$' \
      "${stderr}" 2>/dev/null || true)"
    if [[ "${count}" == "1" ]]; then
      FLEET_ADMIN_NORMAL_PORT="$(
        sed -nE 's/^Forwarding from 127[.]0[.]0[.]1:([0-9]+) -> 3000$/\1/p' \
          "${stderr}"
      )"
      [[ "${FLEET_ADMIN_NORMAL_PORT}" =~ ^[1-9][0-9]*$ ]]
      return
    fi
    if [[ "${count}" -gt 1 ]] || ! fleet_admin_is_active_child "${pid}"; then
      fleet_admin_log "normal port-forward failed readiness"
      return 1
    fi
    sleep 0.1
  done
  fleet_admin_log "timed out waiting for normal port-forward readiness"
  return 1
}

fleet_admin_start_normal_forward() {
  local stdout="${FLEET_ADMIN_WORK_DIR}/normal-port-forward.stdout"
  local stderr="${FLEET_ADMIN_WORK_DIR}/normal-port-forward.stderr"
  : >"${stdout}"
  : >"${stderr}"
  "${FLEET_ADMIN_KUBECTL}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}" \
    --context "${FLEET_ADMIN_CONTEXT}" \
    --namespace "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    port-forward \
    --address=127.0.0.1 \
    "pod/${FLEET_ADMIN_SELECTED_POD}" \
    :3000 >"${stdout}" 2>"${stderr}" &
  FLEET_ADMIN_FORWARD_PID=$!
  fleet_admin_wait_normal_forward \
    "${stderr}" "${FLEET_ADMIN_FORWARD_PID}" \
    "${FLEET_ADMIN_FORWARD_TIMEOUT_SECONDS:-15}"
}

fleet_admin_assert_unauthenticated() {
  local name=$1
  [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.status")" == "401" ]] || return 1
  grep -Eiq 'unauthenticated' \
    "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.headers" \
    "${FLEET_ADMIN_ARTIFACT_DIR}/${name}.body.json"
}

fleet_admin_prove_auth_boundaries() {
  local request='{}'
  fleet_admin_connect_request \
    "${FLEET_ADMIN_PUBLIC_URL%/}" QueryFleetMap "${request}" public-fleet
  fleet_admin_assert_unauthenticated public-fleet

  fleet_admin_connect_request \
    "${FLEET_ADMIN_PROXY_URL}" QueryFleetMap "${request}" admin-fleet
  [[ "$(cat "${FLEET_ADMIN_ARTIFACT_DIR}/admin-fleet.status")" == "200" ]]
  fleet_admin_json_contains_all \
    "${FLEET_ADMIN_ARTIFACT_DIR}/admin-fleet.body.json" \
    "${FLEET_ADMIN_NAMESPACE}"

  fleet_admin_start_normal_forward
  fleet_admin_connect_request \
    "http://127.0.0.1:${FLEET_ADMIN_NORMAL_PORT}" \
    QueryFleetMap "${request}" normal-forward-fleet
  fleet_admin_assert_unauthenticated normal-forward-fleet
}

fleet_admin_expected_application_digest() {
  local stable_ids=$1
  # shellcheck disable=SC2016 # JavaScript template interpolation, not shell expansion.
  "${FLEET_ADMIN_NODE}" -e '
    const ids = JSON.parse(process.argv[1]);
    if (!Array.isArray(ids) || ids.length === 0 ||
        ids.some((value) => typeof value !== "string")) process.exit(2);
    const encoder = new TextEncoder();
    const mask = BigInt("18446744073709551615");
    const prime = BigInt("1099511628211");
    let hash = BigInt("14695981039346656037");
    const hashByte = (byte) => {
      hash ^= BigInt(byte);
      hash = (hash * prime) & mask;
    };
    for (const stableId of [...ids].sort()) {
      const encoded = encoder.encode(stableId);
      hashByte((encoded.length >>> 24) & 0xff);
      hashByte((encoded.length >>> 16) & 0xff);
      hashByte((encoded.length >>> 8) & 0xff);
      hashByte(encoded.length & 0xff);
      for (const byte of encoded) hashByte(byte);
    }
    process.stdout.write(`hm1-${hash.toString(16).padStart(16, "0")}`);
  ' "${stable_ids}"
}

fleet_admin_run_live_playwright() {
  local stable_ids
  stable_ids="$(jq -cn --arg namespace "${FLEET_ADMIN_NAMESPACE}" '
    ["billing", "catalog", "checkout", "ledger", "notifications", "search"]
    | map("a:" + $namespace + "/" + .)
  ')"
  local expected_digest
  expected_digest="$(fleet_admin_expected_application_digest "${stable_ids}")"
  [[ "${expected_digest}" =~ ^hm1-[0-9a-f]{16}$ ]] || {
    fleet_admin_log "failed to compute the exact fleet fixture digest"
    return 1
  }
  local reviewed_subject
  reviewed_subject="$(jq -er '.subject' \
    "${FLEET_ADMIN_ARTIFACT_DIR}/admin-readiness.json")"
  local playwright_artifacts="${FLEET_ADMIN_ARTIFACT_DIR}/playwright"
  mkdir -p "${playwright_artifacts}"
  local stop_timeout_seconds="${FLEET_ADMIN_STOP_TIMEOUT_SECONDS:-10}"
  [[ "${stop_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || {
    fleet_admin_log "FLEET_ADMIN_STOP_TIMEOUT_SECONDS must be a positive integer"
    return 2
  }
  local term_timeout_seconds="${FLEET_ADMIN_TERM_TIMEOUT_SECONDS:-2}"
  [[ "${term_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || {
    fleet_admin_log "FLEET_ADMIN_TERM_TIMEOUT_SECONDS must be a positive integer"
    return 2
  }
  local group_kill_boundary_seconds="${stop_timeout_seconds}"
  if ((10#${term_timeout_seconds} < 10#${group_kill_boundary_seconds})); then
    group_kill_boundary_seconds="${term_timeout_seconds}"
  fi
  # The detached browser group must be KILLed before either caller can KILL
  # the Node wrapper and lose the process-group owner.
  local group_kill_after_ms="$((10#${group_kill_boundary_seconds} * 500))"

  fleet_admin_run_recorded_bounded \
    playwright "${FLEET_ADMIN_PLAYWRIGHT_TIMEOUT:-12m}" \
    env FLEET_ADMIN_GROUP_KILL_AFTER_MS="${group_kill_after_ms}" \
    "${FLEET_ADMIN_NODE}" -e '
      const { spawn } = require("node:child_process");
      const command = process.argv[1];
      const groupKillAfterMs = Number(process.env.FLEET_ADMIN_GROUP_KILL_AFTER_MS);
      if (!Number.isSafeInteger(groupKillAfterMs) || groupKillAfterMs < 100) {
        console.error("invalid browser process-group kill timeout");
        process.exit(2);
      }
      const child = spawn(command, process.argv.slice(2), {
        detached: true,
        stdio: "inherit",
      });
      let exited = false;
      let killTimer;
      const forward = (signal) => {
        if (exited || !child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      };
      process.on("SIGINT", () => forward("SIGINT"));
      process.on("SIGTERM", () => {
        forward("SIGTERM");
        if (killTimer) return;
        killTimer = setTimeout(() => forward("SIGKILL"), groupKillAfterMs);
      });
      child.once("error", (error) => {
        console.error(error.message);
        process.exit(126);
      });
      child.once("exit", (code, signal) => {
        exited = true;
        if (killTimer) clearTimeout(killTimer);
        const signalExit = { SIGINT: 130, SIGTERM: 143, SIGKILL: 137 };
        process.exit(code ?? signalExit[signal] ?? 1);
      });
    ' env \
    PLAYWRIGHT_NO_WEBSERVER=1 \
    PAPRIKA_E2E_ADMIN_SESSION_STUB=0 \
    PAPRIKA_E2E_BASE_URL="${FLEET_ADMIN_PROXY_URL}" \
    PAPRIKA_E2E_RUN_ID="${FLEET_ADMIN_RUN_ID}" \
    PAPRIKA_E2E_FIXTURE_MODE=live \
    PAPRIKA_E2E_RUN_NAMESPACE="${FLEET_ADMIN_NAMESPACE}" \
    PAPRIKA_E2E_ADMIN_SUBJECT="${reviewed_subject}" \
    PAPRIKA_E2E_EXPECTED_APPLICATION_IDS="${stable_ids}" \
    PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT=6 \
    PAPRIKA_E2E_EXPECTED_APPLICATION_DIGEST="${expected_digest}" \
    PAPRIKA_E2E_EXPECTED_PROJECT="${FLEET_ADMIN_NAMESPACE}/finance" \
    PAPRIKA_E2E_EXPECTED_CLUSTER="${FLEET_ADMIN_NAMESPACE}/cluster-west" \
    PAPRIKA_E2E_EXPECTED_STAGE=production \
    PAPRIKA_E2E_DETAIL_APPLICATION=checkout \
    PAPRIKA_E2E_TRACE=on \
    PAPRIKA_E2E_OUTPUT_DIR="${playwright_artifacts}" \
    "${FLEET_ADMIN_NPM}" --prefix "${FLEET_ADMIN_ROOT}/ui" \
    run test:e2e -- \
    e2e/fleet-admin-live.spec.ts \
    --project=chromium
}

fleet_admin_preflight() {
  local kube=(
    "${FLEET_ADMIN_KUBECTL}"
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}"
    --context "${FLEET_ADMIN_CONTEXT}"
    --request-timeout="${FLEET_ADMIN_REQUEST_TIMEOUT}"
  )
  fleet_admin_run_recorded preflight-can-i \
    "${kube[@]}" auth can-i create pods/portforward \
    --namespace "${FLEET_ADMIN_TARGET_NAMESPACE}"
  grep -Fxq 'yes' "${FLEET_ADMIN_WORK_DIR}/preflight-can-i.raw"
  # Helm status has no command-level --timeout flag. Keep this one-shot read
  # bounded externally so the invocation remains valid across supported Helm
  # versions while a stalled Kubernetes read still cannot block the harness.
  fleet_admin_run_recorded_bounded \
    preflight-helm-status "${FLEET_ADMIN_REQUEST_TIMEOUT}" \
    "${FLEET_ADMIN_HELM}" status "${FLEET_ADMIN_TARGET_RELEASE}" \
    --namespace "${FLEET_ADMIN_TARGET_NAMESPACE}" \
    --kube-context "${FLEET_ADMIN_CONTEXT}" \
    --kubeconfig "${FLEET_ADMIN_KUBECONFIG}"
  fleet_admin_run_recorded preflight-nodes "${kube[@]}" get nodes
}

fleet_admin_initialize() {
  # Runtime ownership state is never accepted from the environment. Only PIDs
  # started below may be signalled, and only paths created below may be removed.
  FLEET_ADMIN_CLI_PID=""
  FLEET_ADMIN_FORWARD_PID=""
  FLEET_ADMIN_BOUNDED_PID=""
  FLEET_ADMIN_NAMESPACE=""
  FLEET_ADMIN_NAMESPACE_UID=""
  FLEET_ADMIN_SUITE_LABEL="paprika.io/e2e-suite=fleet-admin-dashboard"
  FLEET_ADMIN_ARTIFACT_DIR=""
  FLEET_ADMIN_WORK_DIR=""
  FLEET_ADMIN_OVERLAY_DIR=""
  FLEET_ADMIN_FINALIZED=0

  FLEET_ADMIN_ROOT="${FLEET_ADMIN_ROOT:-$(
    cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
  )}"
  FLEET_ADMIN_KUBECTL="${FLEET_ADMIN_KUBECTL:-kubectl}"
  FLEET_ADMIN_HELM="${FLEET_ADMIN_HELM:-helm}"
  FLEET_ADMIN_CURL="${FLEET_ADMIN_CURL:-curl}"
  FLEET_ADMIN_GO="${FLEET_ADMIN_GO:-go}"
  FLEET_ADMIN_NODE="${FLEET_ADMIN_NODE:-node}"
  FLEET_ADMIN_NPM="${FLEET_ADMIN_NPM:-npm}"
  FLEET_ADMIN_MAKE="${FLEET_ADMIN_MAKE:-make}"
  FLEET_ADMIN_PAPRIKA_BIN="${FLEET_ADMIN_PAPRIKA_BIN:-${FLEET_ADMIN_ROOT}/bin/paprika}"
  FLEET_ADMIN_REQUEST_TIMEOUT="${FLEET_ADMIN_REQUEST_TIMEOUT:-60s}"

  fleet_admin_require_value FLEET_ADMIN_KUBECONFIG "${FLEET_ADMIN_KUBECONFIG:-}"
  fleet_admin_require_value FLEET_ADMIN_CONTEXT "${FLEET_ADMIN_CONTEXT:-}"
  fleet_admin_require_value FLEET_ADMIN_TARGET_NAMESPACE \
    "${FLEET_ADMIN_TARGET_NAMESPACE:-}"
  fleet_admin_require_value FLEET_ADMIN_TARGET_RELEASE \
    "${FLEET_ADMIN_TARGET_RELEASE:-}"
  fleet_admin_require_value FLEET_ADMIN_PUBLIC_URL "${FLEET_ADMIN_PUBLIC_URL:-}"
  fleet_admin_require_value FLEET_ADMIN_ARTIFACT_ROOT "${FLEET_ADMIN_ARTIFACT_ROOT:-}"
  [[ -f "${FLEET_ADMIN_KUBECONFIG}" ]] || {
    fleet_admin_log "kubeconfig does not exist: ${FLEET_ADMIN_KUBECONFIG}"
    return 2
  }

  if [[ -z "${FLEET_ADMIN_RUN_ID}" ]]; then
    FLEET_ADMIN_RUN_ID="$(
      printf '%s-%s' "$(date -u +%Y%m%d%H%M%S)" "$$" |
        tr '[:upper:]_' '[:lower:]-'
    )"
  fi
  fleet_admin_validate_run_id_local "${FLEET_ADMIN_RUN_ID}"
  fleet_admin_validate_positive_duration \
    FLEET_ADMIN_REQUEST_TIMEOUT "${FLEET_ADMIN_REQUEST_TIMEOUT}"
  FLEET_ADMIN_RUN_LABEL="paprika.io/e2e-run=${FLEET_ADMIN_RUN_ID}"
  FLEET_ADMIN_ARTIFACT_DIR="${FLEET_ADMIN_ARTIFACT_ROOT%/}/${FLEET_ADMIN_RUN_ID}"
  [[ ! -e "${FLEET_ADMIN_ARTIFACT_DIR}" ]] || {
    fleet_admin_log "artifact directory already exists; refusing to overwrite it"
    return 2
  }
  mkdir -p "${FLEET_ADMIN_ARTIFACT_DIR}"
  FLEET_ADMIN_WORK_DIR="$(mktemp -d \
    "${FLEET_ADMIN_ARTIFACT_DIR}/.work.XXXXXX")"
}

fleet_admin_exit_trap() {
  local status=$?
  trap - EXIT INT TERM
  local final_status=${status}
  fleet_admin_finalize "${status}" || final_status=$?
  exit "${final_status}"
}

fleet_admin_main() {
  fleet_admin_initialize
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap fleet_admin_exit_trap EXIT

  fleet_admin_build_guard
  fleet_admin_validate_run_id
  fleet_admin_preflight
  fleet_admin_create_namespace
  fleet_admin_prepare_fixture_documents
  fleet_admin_apply_fixtures

  if [[ "${FLEET_ADMIN_SKIP_CLI_BUILD:-0}" != "1" ]]; then
    (
      cd "${FLEET_ADMIN_ROOT}" || exit
      "${FLEET_ADMIN_MAKE}" build-cli
    )
  fi
  [[ -x "${FLEET_ADMIN_PAPRIKA_BIN}" ]] || {
    fleet_admin_log "Paprika CLI is not executable: ${FLEET_ADMIN_PAPRIKA_BIN}"
    return 1
  }
  fleet_admin_start_cli
  fleet_admin_query_exact_snapshot
  fleet_admin_prove_auth_boundaries
  fleet_admin_run_live_playwright
  fleet_admin_log "validated fleet admin dashboard; artifacts: ${FLEET_ADMIN_ARTIFACT_DIR}"
}
