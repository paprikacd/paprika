#!/usr/bin/env bash
# Offline synthetic rendering; refuse every Helm command that could contact a cluster.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
real_helm=$(command -v helm)
cat > "$work/helm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == template ]] || { echo 'Only offline helm template is allowed' >&2; exit 99; }
printf '%s\n' "$1" >> "$HELM_CALL_LOG"
exec "$REAL_HELM" "$@"
SH
chmod +x "$work/helm"
export HELM_BIN="$work/helm" REAL_HELM="$real_helm" HELM_CALL_LOG="$work/helm-calls"
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
observabilityGateway:
  serviceAccountName: preapproved-observe-reader
  extraEnv:
    - name: PAPRIKA_AUTH_TOKEN_SECRET
      valueFrom:
        secretKeyRef: {name: preexisting-auth, key: token-secret}
  ingress: {enabled: true}
apiServer:
  ingress:
    gateway:
      hostname: paprika.example.test
      gatewayRef: {name: preexisting-gateway, namespace: paprika-system}
YAML
image=ghcr.io/paprikacd/paprika@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
render() {
  bash "$root/hack/render-observability-addon.sh" --namespace paprika-system \
    --release paprika-observe --context synthetic-offline-context --image "$image" \
    --values "$work/values.yaml" "$@"
}
render --output-dir "$work/private" > "$work/private-command"
python3 - "$work/private" "$image" <<'PY'
import json, pathlib, re, sys
out = pathlib.Path(sys.argv[1]); image = sys.argv[2]
manifest = (out / "manifests.yaml").read_text()
assert sorted(re.findall(r"^kind: (\S+)$", manifest, re.M)) == ["Deployment", "NetworkPolicy", "Service"]
assert re.findall(r"^        image: \"([^\"]+)\"$", manifest, re.M) == [image]
assert "--observability-discovery-enabled=false" in manifest
assert "serviceAccountName: preapproved-observe-reader" in manifest
assert "type: ClusterIP" in manifest
assert "app.kubernetes.io/name: paprika-observe" in manifest
assert "name: paprika-observe-observability-gateway" in manifest
assert "kind: HTTPRoute" not in manifest
provenance = json.loads((out / "provenance.json").read_text())
assert provenance["image"] == image and not provenance["publicRouteIncluded"]
assert len(provenance["manifestSHA256"]) == len(provenance["sourceTemplatesSHA256"]) == 64
assert len(provenance["sourceCommit"]) == 40
PY
rg -q -- '--atomic --wait' "$work/private-command"
rg -q -- '--kube-context synthetic-offline-context' "$work/private-command"
grep -Eq -- '--mcp-oauth-client-id=synthetic-render-client$' "$work/private/manifests.yaml"
grep -Eq -- '--mcp-oauth-redirect-uris=http://localhost:8791/callback$' "$work/private/manifests.yaml"
cat > "$work/dcr-only.yaml" <<'YAML'
mcp:
  enabled: false
  oauth:
    clientId: ""
    redirectUris: []
YAML
render --values "$work/dcr-only.yaml" --output-dir "$work/dcr-only" > "$work/dcr-only-command"
if grep -Eq -- '--mcp-enabled=true|--mcp-oauth-(client-id|redirect-uris)=' "$work/dcr-only/manifests.yaml"; then
  echo 'DCR-only add-on unexpectedly enabled fleet MCP or configured a static OAuth client' >&2; exit 1
fi
for partial in 'clientId: ""' 'redirectUris: []'; do
  printf 'mcp:\n  oauth:\n    %s\n' "$partial" > "$work/partial-oauth.yaml"
  if render --values "$work/partial-oauth.yaml" --output-dir "$work/partial-oauth" > "$work/partial-oauth-error" 2>&1; then
    echo 'Add-on accepted a partial static OAuth client configuration' >&2; exit 1
  fi
  grep -Fq 'must both be configured or both omitted' "$work/partial-oauth-error"
done
for invalid in auth.enabled=false mcp.publicURL=; do
  case "$invalid" in
    auth.enabled=false) printf 'auth: {enabled: false}\n' > "$work/invalid-auth.yaml" ;;
    mcp.publicURL=) printf 'mcp: {publicURL: ""}\n' > "$work/invalid-auth.yaml" ;;
  esac
  if render --values "$work/dcr-only.yaml" --values "$work/invalid-auth.yaml" --output-dir "$work/invalid-auth" > "$work/error" 2>&1; then
    echo 'DCR-only add-on accepted missing authentication or public URL' >&2; exit 1
  fi
done
if "$HELM_BIN" template other-release "$work/private/chart" --namespace paprika-system > "$work/wrong-release" 2>&1; then
  echo 'Frozen chart accepted another release identity' >&2; exit 1
fi
if "$HELM_BIN" template paprika-observe "$work/private/chart" --namespace other-namespace > "$work/wrong-namespace" 2>&1; then
  echo 'Frozen chart accepted another namespace' >&2; exit 1
fi
render --include-route --output-dir "$work/public" > "$work/public-command"
[[ $(rg -c '^kind: HTTPRoute$' "$work/public/manifests.yaml") -eq 1 ]]
if render --image ghcr.io/paprikacd/paprika:latest --output-dir "$work/mutable" > "$work/error" 2>&1; then
  echo 'Mutable image was accepted' >&2; exit 1
fi
if render --output-dir "$work/private" > "$work/error" 2>&1; then
  echo 'Existing evidence directory was overwritten' >&2; exit 1
fi
cat > "$work/inline.yaml" <<'YAML'
observabilityGateway:
  extraEnv: [{name: PAPRIKA_AUTH_TOKEN_SECRET, value: synthetic-forbidden-inline-value}]
YAML
if render --values "$work/inline.yaml" --output-dir "$work/inline" > "$work/error" 2>&1; then
  echo 'Inline credential was accepted' >&2; exit 1
fi
cat > "$work/identity.yaml" <<'YAML'
observabilityGateway:
  serviceAccountName: ""
YAML
if render --values "$work/identity.yaml" --output-dir "$work/no-identity" > "$work/error" 2>&1; then
  echo 'Implicit identity was accepted' >&2; exit 1
fi
for unsafe in --mode=operator --observability-discovery-enabled=true --auth-enabled=false --k8s-token-file=/unapproved; do
  printf 'observabilityGateway:\n  args: ["%s"]\n' "$unsafe" > "$work/args.yaml"
  if render --values "$work/args.yaml" --output-dir "$work/unsafe-args" > "$work/error" 2>&1; then
    echo 'Unsafe gateway argument was accepted' >&2; exit 1
  fi
done
[[ $(sort -u "$HELM_CALL_LOG") == template ]]
printf 'Observability add-on renders only approved kinds, freezes identity/image, and performs no cluster commands.\n'
