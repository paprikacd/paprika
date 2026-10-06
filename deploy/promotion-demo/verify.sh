#!/usr/bin/env bash
# Read-only assertions; never applies, annotates, deletes, or starts containers.
set -euo pipefail
mode="${1:?usage: verify.sh awaiting-approval|complete <40-character Git SHA>}"
revision="${2:?expected immutable Git commit SHA is required}"
case "$mode" in awaiting-approval|complete) ;; *) echo "Invalid mode: $mode" >&2; exit 2 ;; esac
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full lowercase Git SHA' >&2; exit 2; }
: "${PAPRIKA_DEMO_CONTEXT:?Set PAPRIKA_DEMO_CONTEXT to the intended Vultr context}"
: "${PAPRIKA_OPERATOR_NAMESPACE:?Set the namespace where Paprika executes Pipeline Jobs}"
current="$(kubectl config current-context)"
[[ "$current" == "$PAPRIKA_DEMO_CONTEXT" ]] || { echo "Wrong context: $current" >&2; exit 1; }

check_healthy() {
  local env="$1" ns="paprika-promotion-$1" app release_name release
  app="$(kubectl -n "$ns" get application promotion-demo -o json)"
  jq -e --arg sha "$revision" '
    .status.phase == "Healthy" and .status.health == "Healthy" and
    .status.synced == true and .status.outOfSync == 0 and
    .status.sourceRevision == $sha and .status.revision == $sha and
    .status.deploymentObservation.revision == $sha and
    .status.deploymentObservation.observedGeneration == .metadata.generation and
    (.status.resourceHealth | length) == 3 and
    all(.status.resourceHealth[]; .health == "Healthy") and
    any(.status.healthChecks[]; .name == "internal-http" and .status == "Healthy" and .httpStatusCode == 200 and .httpBody == "ok") and
    (now - (.status.deploymentObservation.observedAt | fromdateiso8601)) >= 0 and
    (now - (.status.deploymentObservation.observedAt | fromdateiso8601)) <= 120
  ' <<< "$app" >/dev/null
  release_name="$(jq -r '.status.releaseRef' <<< "$app")"
  release="$(kubectl -n "$ns" get release "$release_name" -o json)"
  jq -e --arg sha "$revision" --arg uid "$(jq -r '.metadata.uid' <<< "$app")" '
    .status.phase == "Complete" and .metadata.annotations["paprika.io/source-revision"] == $sha and
    any(.metadata.ownerReferences[]; .kind == "Application" and .uid == $uid and .controller == true)
  ' <<< "$release" >/dev/null
  jq -e --arg uid "$(jq -r '.metadata.uid' <<< "$release")" '
    .status.deploymentObservation.releaseUID == $uid
  ' <<< "$app" >/dev/null
  kubectl -n "$ns" get configmap promotion-demo-content -o json     | jq -e --arg env "$env" '.data.environment == $env and .data.version == "v0.3.0" and .data.healthz == "ok"' >/dev/null
  if [[ "$env" != dev ]]; then
    jq -e '.status.promotion.phase == "Complete" and .status.acceptedDeployment.trigger.type == "Promotion"' <<< "$app" >/dev/null
  fi
  printf '%s: Healthy, synced, live observation and owned completed Release at %s\n' "$env" "$revision"
}

check_verification() {
  local env="$1" upstream="$2" ns="paprika-promotion-$1" app source source_release pipeline pipeline_name
  app="$(kubectl -n "$ns" get application promotion-demo -o json)"
  source="$(kubectl -n "paprika-promotion-$upstream" get application promotion-demo -o json)"
  source_release="$(kubectl -n "paprika-promotion-$upstream" get release "$(jq -r '.status.releaseRef' <<< "$source")" -o json)"
  jq -e --arg ns "paprika-promotion-$upstream" --arg app_uid "$(jq -r '.metadata.uid' <<< "$source")"     --arg release_uid "$(jq -r '.metadata.uid' <<< "$source_release")" --arg sha "$revision" '
      .status.promotion.sourceApplication.name == "promotion-demo" and
      .status.promotion.sourceApplication.namespace == $ns and
      .status.promotion.sourceApplicationUID == $app_uid and
      .status.promotion.sourceReleaseUID == $release_uid and .status.promotion.revision == $sha
    ' <<< "$app" >/dev/null
  pipeline_name="$(jq -er '.status.promotion.verificationPipelineRef' <<< "$app")"
  pipeline="$(kubectl -n "$ns" get pipeline "$pipeline_name" -o json)"
  jq -e '.status.phase == "Succeeded" and (.status.stepStatuses | length) == 2 and all(.status.stepStatuses[]; .phase == "Succeeded")' <<< "$pipeline" >/dev/null
  kubectl -n "$PAPRIKA_OPERATOR_NAMESPACE" get jobs -l "paprika.io/pipeline=$pipeline_name" -o json     | jq -e '.items as $jobs | all(["upstream-health", "upstream-identity"][]; . as $step | any($jobs[]; .metadata.labels["paprika.io/step"] == $step and .status.succeeded >= 1))' >/dev/null
  printf '%s: exact upstream Application/Release UIDs and two successful HTTP verification Jobs\n' "$env"
}

check_healthy dev
check_healthy stg
check_verification stg dev
check_verification prod stg
if [[ "$mode" == awaiting-approval ]]; then
  kubectl -n paprika-promotion-prod get application promotion-demo -o json | jq -e '
    .status.promotion.phase == "AwaitingApproval" and
    (.status.releaseRef // "") == "" and (.status.sourceRevision // "") == ""
  ' >/dev/null
  for resource in deployments services configmaps; do
    kubectl -n paprika-promotion-prod get "$resource" -o json       | jq -e '[.items[] | select(.metadata.name == "promotion-demo" or .metadata.name == "promotion-demo-content")] | length == 0' >/dev/null
  done
  echo 'prod: awaiting exact upstream Release UID approval; no demo workload deployed'
else
  check_healthy prod
fi
