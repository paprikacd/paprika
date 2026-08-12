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
grep -Fq -- '--from-literal=client-secret="${VKE_OIDC_CLIENT_SECRET}"' "${WORKFLOW}" || fail 'VKE workflow does not source the Secret from VKE_OIDC_CLIENT_SECRET'
grep -Fq -- '--dry-run=client -o yaml | kubectl apply -f -' "${WORKFLOW}" || fail 'VKE workflow does not safely apply the OIDC Secret'
grep -Fq -- '--set-string auth.oidc.existingSecretName=paprika-oidc' "${WORKFLOW}" || fail 'VKE workflow does not configure the OIDC Secret name'
grep -Fq -- '--set-string auth.oidc.existingSecretKey=client-secret' "${WORKFLOW}" || fail 'VKE workflow does not configure the OIDC Secret key'

workflow_secret_uses="$(grep -Fc '${VKE_OIDC_CLIENT_SECRET}' "${WORKFLOW}")"
[[ "${workflow_secret_uses}" == 1 ]] || fail 'VKE_OIDC_CLIENT_SECRET is interpolated outside Secret creation'
grep -Eq '(^|[[:space:]])set[[:space:]]+-[^[:space:]]*x' "${WORKFLOW}" && fail 'VKE workflow enables shell tracing near secret handling'
grep -E 'echo|printf' "${WORKFLOW}" | grep -Fq 'VKE_OIDC_CLIENT_SECRET' && fail 'VKE workflow prints the OIDC client secret'

grep -Fq 'kubectl --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" create secret generic paprika-oidc' "${VULTR}" || fail 'Vultr deploy does not create the paprika-oidc Secret'
grep -Fq -- '--from-literal=client-secret="${PAPRIKA_OIDC_CLIENT_SECRET}"' "${VULTR}" || fail 'Vultr deploy does not source the Secret from PAPRIKA_OIDC_CLIENT_SECRET'
grep -Fq -- '--dry-run=client -o yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f -' "${VULTR}" || fail 'Vultr deploy does not safely apply the OIDC Secret'
grep -Fq 'auth.oidc.existingSecretName=paprika-oidc' "${VULTR}" || fail 'Vultr deploy does not configure the OIDC Secret name'
grep -Fq 'auth.oidc.existingSecretKey=client-secret' "${VULTR}" || fail 'Vultr deploy does not configure the OIDC Secret key'

printf 'OIDC deployment migration checks passed\n'
