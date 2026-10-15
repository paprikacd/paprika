#!/usr/bin/env bash
# Render-only gateway boundary checks; synthetic config and Secret references.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/values.yaml" <<'YAML'
deploymentMode: split
mcp:
  enabled: true
  publicURL: https://paprika.example.test
  oauth:
    clientId: synthetic-render-client
    redirectUris: [http://localhost:8791/callback]
auth:
  enabled: true
apiServer:
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
observabilityGateway:
  enabled: true
  serviceAccountName: preapproved-observe-reader
  discovery: {enabled: false}
  image:
    repository: ghcr.io/paprikacd/paprika@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    tag: ""
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
  additionalEgress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: monitoring}
          podSelector:
            matchLabels: {app: prometheus}
      ports: [{protocol: TCP, port: 9090}]
networkPolicy:
  enabled: true
YAML
render() { helm template paprika "$root/charts/chart" -n paprika-system -f "$work/values.yaml" "$@"; }
render --show-only templates/observability-gateway/deployment.yaml > "$work/deployment.yaml"
grep -Eq -- '--observability-discovery-enabled=false' "$work/deployment.yaml"
grep -Eq 'serviceAccountName: preapproved-observe-reader$' "$work/deployment.yaml"
grep -Eq 'image: "ghcr.io/paprikacd/paprika@sha256:a{64}"$' "$work/deployment.yaml"
grep -Eq 'name: preexisting-auth$' "$work/deployment.yaml"
grep -Eq -- '--mcp-oauth-client-id=synthetic-render-client$' "$work/deployment.yaml"
grep -Eq -- '--mcp-oauth-redirect-uris=http://localhost:8791/callback$' "$work/deployment.yaml"
if grep -Eq '^kind: (Secret|ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding)$' "$work/deployment.yaml"; then
  echo 'Custom identity must not implicitly grant permissions' >&2; exit 1
fi
cat > "$work/dcr-only.yaml" <<'YAML'
mcp:
  enabled: false
  oauth:
    clientId: ""
    redirectUris: []
YAML
# Render the whole chart: a standalone gateway must not enable the fleet MCP
# surface or register a static client in either Deployment.
render -f "$work/dcr-only.yaml" > "$work/dcr-only-chart.yaml"
grep -Eq -- '--mode=observability-gateway$' "$work/dcr-only-chart.yaml"
if grep -Eq -- '--mcp-enabled=true|--mcp-oauth-(client-id|redirect-uris)=' "$work/dcr-only-chart.yaml"; then
  echo 'DCR-only gateway unexpectedly enabled fleet MCP or configured a static OAuth client' >&2; exit 1
fi
for partial in 'clientId: ""' 'redirectUris: []'; do
  printf 'mcp:\n  enabled: false\n  oauth:\n    %s\n' "$partial" > "$work/partial-oauth.yaml"
  if render -f "$work/partial-oauth.yaml" > "$work/partial-oauth-error" 2>&1; then
    echo 'Partial static OAuth client configuration unexpectedly rendered' >&2; exit 1
  fi
  grep -Fq 'must both be configured or both omitted' "$work/partial-oauth-error"
done
render --show-only templates/observability-gateway/httproute.yaml --set observabilityGateway.ingress.enabled=true --set apiServer.ingress.gateway.hostname=paprika.example.test --set apiServer.ingress.gateway.gatewayRef.name=preexisting-gateway --set apiServer.ingress.gateway.gatewayRef.namespace=paprika-system > "$work/route.yaml"
for path in /observe /.well-known/oauth-authorization-server/observe /.well-known/oauth-protected-resource/observe/mcp; do
  grep -Fq "value: $path" "$work/route.yaml"
done
render --show-only templates/networkpolicy/observability-gateway.yaml > "$work/policy.yaml"
grep -Eq 'port: 9090' "$work/policy.yaml"
grep -Eq 'kubernetes.io/metadata.name: monitoring' "$work/policy.yaml"
grep -Eq 'app: prometheus' "$work/policy.yaml"
render --set observabilityGateway.additionalEgress=null --show-only templates/networkpolicy/observability-gateway.yaml > "$work/default-policy.yaml"
if grep -Eq 'port: 9090' "$work/default-policy.yaml"; then
  echo 'Unapproved nonstandard backend egress appeared' >&2; exit 1
fi
for invalid in auth.enabled=false mcp.publicURL= deploymentMode=monolith observabilityGateway.replicas=2 observabilityGateway.hpa.enabled=true observabilityGateway.strategy.type=RollingUpdate; do
  if render -f "$work/dcr-only.yaml" --set "$invalid" > "$work/invalid.yaml" 2>&1; then
    echo "Unsafe gateway configuration unexpectedly rendered: $invalid" >&2; exit 1
  fi
done
printf 'Observability chart auth, identity, discovery routing and egress checks passed.\n'
