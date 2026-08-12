#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="${ROOT_DIR}/.github/workflows/deploy-vke.yml"
VULTR="${ROOT_DIR}/hack/e2e-vultr.sh"
VALUES="${ROOT_DIR}/deploy/test-values.yaml"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

if grep -Fq 'auth.oidc.clientSecret' "${WORKFLOW}" "${VULTR}" "${VALUES}"; then
  fail 'active deployment configuration still contains auth.oidc.clientSecret'
fi

grep -Fq 'kubectl -n "${VKE_NAMESPACE}" create secret generic paprika-oidc' "${WORKFLOW}" || fail 'VKE workflow does not create the paprika-oidc Secret'
grep -Fq "printf '%s' \"\${VKE_OIDC_CLIENT_SECRET}\"" "${WORKFLOW}" || fail 'VKE workflow does not send the OIDC Secret through stdin'
grep -Fq -- '--from-file=client-secret=/dev/stdin' "${WORKFLOW}" || fail 'VKE workflow does not create the Secret from stdin'
grep -Fq -- '--from-literal' "${WORKFLOW}" && fail 'VKE workflow exposes the OIDC Secret through kubectl arguments'
grep -Fq -- '--dry-run=client -o yaml | kubectl apply -f -' "${WORKFLOW}" || fail 'VKE workflow does not safely apply the OIDC Secret'
grep -Fq -- '--set-string auth.oidc.existingSecretName=paprika-oidc' "${WORKFLOW}" || fail 'VKE workflow does not configure the OIDC Secret name'
grep -Fq -- '--set-string auth.oidc.existingSecretKey=client-secret' "${WORKFLOW}" || fail 'VKE workflow does not configure the OIDC Secret key'
grep -Fq 'oidc_secret_result="$(' "${WORKFLOW}" || fail 'VKE workflow does not capture the OIDC Secret apply result'
grep -Fq '"secret/paprika-oidc created"|"secret/paprika-oidc configured"|"secret/paprika-oidc unchanged")' "${WORKFLOW}" || fail 'VKE workflow does not accept created, configured, or unchanged for the OIDC Secret'
workflow_deploy_block="$(sed -n '/- name: Deploy Paprika chart/,/- name: Verify Helm release/p' "${WORKFLOW}")"
grep -Fq 'set -o pipefail' <<<"${workflow_deploy_block}" || fail 'VKE workflow does not enable pipefail for OIDC Secret creation'

workflow_secret_uses="$(grep -Fc '${VKE_OIDC_CLIENT_SECRET}' "${WORKFLOW}")"
[[ "${workflow_secret_uses}" == 1 ]] || fail 'VKE_OIDC_CLIENT_SECRET is interpolated outside Secret creation'
grep -Eq '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "${WORKFLOW}" && fail 'VKE workflow enables shell tracing near secret handling'
grep -E 'echo' "${WORKFLOW}" | grep -Fq 'VKE_OIDC_CLIENT_SECRET' && fail 'VKE workflow logs the OIDC client secret'

grep -Fq 'kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" create secret generic paprika-oidc' "${VULTR}" || fail 'Vultr deploy does not create the paprika-oidc Secret'
grep -Fq "printf '%s' \"\${PAPRIKA_OIDC_CLIENT_SECRET}\"" "${VULTR}" || fail 'Vultr deploy does not send the OIDC Secret through stdin'
grep -Fq -- '--from-file=client-secret=/dev/stdin' "${VULTR}" || fail 'Vultr deploy does not create the Secret from stdin'
grep -Fq -- '--from-literal' "${VULTR}" && fail 'Vultr deploy exposes the OIDC Secret through kubectl arguments'
grep -Fq -- '--dry-run=client -o yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f -' "${VULTR}" || fail 'Vultr deploy does not safely apply the OIDC Secret'
grep -Fq 'auth.oidc.existingSecretName=paprika-oidc' "${VULTR}" || fail 'Vultr deploy does not configure the OIDC Secret name'
grep -Fq 'auth.oidc.existingSecretKey=client-secret' "${VULTR}" || fail 'Vultr deploy does not configure the OIDC Secret key'
grep -Fq 'oidc_secret_result="$(' "${VULTR}" || fail 'Vultr deploy does not capture the OIDC Secret apply result'
grep -Fq '"secret/paprika-oidc created"|"secret/paprika-oidc configured"|"secret/paprika-oidc unchanged")' "${VULTR}" || fail 'Vultr deploy does not accept created, configured, or unchanged for the OIDC Secret'
vultr_secret_uses="$(grep -Fc '${PAPRIKA_OIDC_CLIENT_SECRET}' "${VULTR}")"
[[ "${vultr_secret_uses}" == 1 ]] || fail 'PAPRIKA_OIDC_CLIENT_SECRET is interpolated outside Secret creation'
grep -Eq '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "${VULTR}" && fail 'Vultr deploy enables shell tracing near secret handling'
grep -E 'echo' "${VULTR}" | grep -Fq 'PAPRIKA_OIDC_CLIENT_SECRET' && fail 'Vultr deploy logs the OIDC client secret'

grep -Eq '^[[:space:]]+existingSecretName:[[:space:]]+paprika-oidc$' "${VALUES}" || fail 'production values do not reference the paprika-oidc Secret'
grep -Eq '^[[:space:]]+existingSecretKey:[[:space:]]+client-secret$' "${VALUES}" || fail 'production values do not reference the client-secret key'

printf 'OIDC deployment migration checks passed\n'
