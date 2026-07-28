#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart_dir="${root_dir}/charts/chart"
render_args=(
  metrics-check "${chart_dir}"
  --namespace paprika-e2e
  --set deploymentMode=split
  --set metrics.bindAddress=:8080
  --set metrics.secure=false
  --set metrics.enable=true
  --set prometheus.enable=true
  --set networkPolicy.enabled=true
  --set apiServer.enabled=true
  --set repoServer.enabled=true
  --set webhookReceiver.enabled=true
)

render() {
  helm template "${render_args[@]}" --show-only "$1"
}

render_with_secure_controller_metrics() {
  helm template "${render_args[@]}" --set metrics.secure=true --show-only "$1"
}

render_with_mtls() {
  helm template "${render_args[@]}" --set mtls.enabled=true --show-only "$1"
}

render_with_metrics_disabled() {
  helm template "${render_args[@]}" --set metrics.bindAddress=:0 --show-only "$1"
}

render_with_controller_metrics_disabled() {
  helm template "${render_args[@]}" --set metrics.enable=false --show-only "$1"
}

render_with_numeric_zero() {
  helm template "${render_args[@]}" --set metrics.bindAddress=0 --show-only "$1"
}

render_all_with_metrics_disabled() {
  helm template "${render_args[@]}" --set metrics.bindAddress=:0
}

render_all_with_numeric_zero() {
  helm template "${render_args[@]}" --set metrics.bindAddress=0
}

render_with_bind_address() {
  local bind_address="$1"
  local template="$2"
  helm template "${render_args[@]}" --set-string "metrics.bindAddress=${bind_address}" --show-only "${template}"
}

require_text() {
  local rendered="$1"
  local expected="$2"
  local description="$3"
  if ! grep -Fq -- "${expected}" <<<"${rendered}"; then
    echo "missing ${description}: ${expected}" >&2
    return 1
  fi
}

require_no_text() {
  local rendered="$1"
  local unexpected="$2"
  local description="$3"
  if grep -Fq -- "${unexpected}" <<<"${rendered}"; then
    echo "unexpected ${description}: ${unexpected}" >&2
    return 1
  fi
}

webhook_deployment="$(render templates/webhook-receiver/deployment.yaml)"
require_text "${webhook_deployment}" '--webhook-bind-address=:8080' 'webhook listener'
require_text "${webhook_deployment}" '--metrics-bind-address=:8082' 'dedicated metrics listener'

webhook_metrics_container_port="$(
  awk '
    /containerPort: 8082/ { capture = 1; lines = 0 }
    capture { print; lines++ }
    capture && lines == 4 { exit }
  ' <<<"${webhook_deployment}"
)"
require_text "${webhook_metrics_container_port}" 'name: metrics' 'webhook metrics container port'

disabled_webhook_deployment="$(render_with_metrics_disabled templates/webhook-receiver/deployment.yaml)"
require_text "${disabled_webhook_deployment}" '--metrics-bind-address=0' 'disabled webhook metrics listener'

numeric_zero_webhook_deployment="$(render_with_numeric_zero templates/webhook-receiver/deployment.yaml)"
require_text "${numeric_zero_webhook_deployment}" '--metrics-bind-address=0' 'numeric-zero webhook metrics listener'

ipv4_webhook_deployment="$(render_with_bind_address '127.0.0.1:8080' templates/webhook-receiver/deployment.yaml)"
require_text "${ipv4_webhook_deployment}" '--metrics-bind-address=127.0.0.1:8082' 'IPv4-specific webhook metrics listener'

ipv6_webhook_deployment="$(render_with_bind_address '[::1]:8080' templates/webhook-receiver/deployment.yaml)"
require_text "${ipv6_webhook_deployment}" '--metrics-bind-address=[::1]:8082' 'IPv6-specific webhook metrics listener'

mtls_webhook_deployment="$(render_with_mtls templates/webhook-receiver/deployment.yaml)"
require_text "${mtls_webhook_deployment}" '--webhook-bind-address=:8080' 'mTLS webhook listener'
require_text "${mtls_webhook_deployment}" '--metrics-bind-address=:8082' 'mTLS-safe dedicated metrics listener'

controller_metrics_disabled_webhook="$(render_with_controller_metrics_disabled templates/webhook-receiver/deployment.yaml)"
require_text "${controller_metrics_disabled_webhook}" '--metrics-bind-address=:8082' 'split metrics listener when controller metrics are disabled'

webhook_service="$(render templates/webhook-receiver/service.yaml)"
webhook_metrics_port="$(
  awk '
    /- name: metrics/ { capture = 1; lines = 0 }
    capture { print; lines++ }
    capture && lines == 5 { exit }
  ' <<<"${webhook_service}"
)"
require_text "${webhook_metrics_port}" 'port: 8082' 'unique webhook metrics service port'
require_text "${webhook_metrics_port}" 'targetPort: 8082' 'webhook metrics target port'

for component in api-server repo-server webhook-receiver; do
  monitor="$(render "templates/prometheus/${component}-metrics-monitor.yaml")"
  require_text "${monitor}" 'port: metrics' "${component} ServiceMonitor port"
  require_text "${monitor}" 'scheme: http' "${component} ServiceMonitor scheme"

  controller_disabled_monitor="$(render_with_controller_metrics_disabled "templates/prometheus/${component}-metrics-monitor.yaml")"
  require_text "${controller_disabled_monitor}" 'port: metrics' "${component} ServiceMonitor with controller metrics disabled"

  secure_monitor="$(render_with_secure_controller_metrics "templates/prometheus/${component}-metrics-monitor.yaml")"
  require_text "${secure_monitor}" 'port: metrics' "${component} secure-mode ServiceMonitor port"
  require_text "${secure_monitor}" 'scheme: http' "${component} secure-mode ServiceMonitor scheme"
  if grep -Eq 'bearerTokenFile:|tlsConfig:' <<<"${secure_monitor}"; then
    echo "${component} split-plane ServiceMonitor must remain HTTP when controller metrics are secure" >&2
    exit 1
  fi

  mtls_monitor="$(render_with_mtls "templates/prometheus/${component}-metrics-monitor.yaml")"
  require_text "${mtls_monitor}" 'scheme: http' "${component} mTLS-mode ServiceMonitor scheme"
  if grep -Eq 'bearerTokenFile:|tlsConfig:' <<<"${mtls_monitor}"; then
    echo "${component} split-plane ServiceMonitor must not inherit webhook mTLS" >&2
    exit 1
  fi
done

disabled_chart="$(render_all_with_metrics_disabled)"
numeric_zero_chart="$(render_all_with_numeric_zero)"
for component in api-server repo-server webhook-receiver; do
  require_no_text "${disabled_chart}" "${component}-metrics-monitor" "${component} ServiceMonitor while metrics are disabled"
  require_no_text "${numeric_zero_chart}" "${component}-metrics-monitor" "${component} ServiceMonitor with numeric-zero metrics"
done

components=(api-server repo-server webhook-receiver)
metrics_ports=(8080 8080 8082)
for index in "${!components[@]}"; do
  component="${components[index]}"
  metrics_port="${metrics_ports[index]}"
  policy="$(render "templates/networkpolicy/${component}.yaml")"
  require_text "${policy}" "port: ${metrics_port}" "${component} metrics network policy port"

  controller_disabled_policy="$(render_with_controller_metrics_disabled "templates/networkpolicy/${component}.yaml")"
  require_text "${controller_disabled_policy}" "port: ${metrics_port}" "${component} metrics port with controller metrics disabled"

  disabled_policy="$(render_with_metrics_disabled "templates/networkpolicy/${component}.yaml")"
  require_no_text "${disabled_policy}" "port: ${metrics_port}" "${component} metrics port while disabled"

  numeric_zero_policy="$(render_with_numeric_zero "templates/networkpolicy/${component}.yaml")"
  require_no_text "${numeric_zero_policy}" "port: ${metrics_port}" "${component} metrics port with numeric zero"
done

echo 'split-plane metrics wiring verified'
