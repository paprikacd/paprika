#!/usr/bin/env bash
# Render a frozen gateway-only Helm add-on. Never contacts a cluster.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
usage() {
  cat <<'USAGE'
Usage: hack/render-observability-addon.sh --namespace NS --release ADDON_RELEASE
  --context VERIFIED_CONTEXT --image ghcr.io/OWNER/IMAGE@sha256:DIGEST
  --output-dir DIRECTORY --values NONSECRET_VALUES [--values NONSECRET_VALUES ...]
  [--include-route]

Render only. Values must contain configuration and existing Secret references,
never secret payloads. An existing observabilityGateway.serviceAccountName is
required. Public routing requires --include-route and separately approved values.
The output is a frozen standalone Helm chart plus provenance and manifests.
USAGE
}
fail() { printf 'error: %s\n' "$*" >&2; exit 2; }
namespace= release= context= image= output= include_route=false
values=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|--release|--context|--image|--output-dir|--values)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 needs a value"
      case "$1" in
        --namespace) namespace=$2 ;; --release) release=$2 ;;
        --context) context=$2 ;; --image) image=$2 ;;
        --output-dir) output=$2 ;; --values) values+=("$2") ;;
      esac
      shift 2 ;;
    --include-route) include_route=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || fail 'explicit DNS-label namespace required'
[[ "$release" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#release} -le 53 ]] || fail 'explicit Helm add-on release required (max 53 characters)'
[[ -n "$context" && "$context" != *$'\n'* ]] || fail 'explicit verified kube context required (stored only; never contacted)'
[[ "$image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ && "$image" != *..* && "$image" != *//* ]] || fail 'image must be a GHCR repository pinned by a lowercase sha256 digest'
[[ -n "$output" && ${#values[@]} -gt 0 ]] || fail 'output directory and at least one nonsecret values file required'
[[ ! -e "$output" ]] || fail 'output directory already exists; choose a new path to preserve prior render evidence'
for file in "${values[@]}"; do [[ -f "$file" ]] || fail 'a values file does not exist'; done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source/templates" "$work/result/chart/templates" "$work/result/chart/files"
# This allowlist is the only chart source copied. The main release, CRDs, RBAC,
# ServiceAccounts, Secrets, HPAs and other components cannot enter the add-on.
templates=(observability-gateway/deployment.yaml observability-gateway/service.yaml networkpolicy/observability-gateway.yaml)
if [[ "$include_route" == true ]]; then templates+=(observability-gateway/httproute.yaml); fi
cp "$root/charts/chart/Chart.yaml" "$root/charts/chart/values.yaml" "$work/source/"
cp "$root/charts/chart/templates/_helpers.tpl" "$work/source/templates/"
for template in "${templates[@]}"; do
  cp "$root/charts/chart/templates/$template" "$work/source/templates/$(echo "$template" | tr / -)"
done
cat > "$work/source/templates/000-addon-guard.yaml" <<'HELM'
{{- if not .Values.observabilityGateway.serviceAccountName }}
{{- fail "add-on requires an explicit existing observabilityGateway.serviceAccountName; no identity or permissions are created" }}
{{- end }}
{{- if or .Values.auth.tokenSecret .Values.auth.basic.passwordHash .Values.auth.oidc.clientSecret .Values.redis.password .Values.otel.headers }}
{{- fail "add-on values must use existing Secret references, never inline credentials" }}
{{- end }}
{{- if or .Values.observabilityGateway.initContainers .Values.observabilityGateway.extraContainers }}
{{- fail "add-on permits only the digest-pinned gateway container" }}
{{- end }}
{{- range .Values.observabilityGateway.args }}
{{- if not (or (eq . "--ui-bind-address=:8090") (regexMatch "^--api-max-conns=[1-9][0-9]*$" .) (regexMatch "^--pprof-bind-address=(127\\.0\\.0\\.1|localhost):[0-9]+$" .)) }}
{{- fail "add-on args permit only the fixed gateway listener, a connection limit, and loopback profiling; mode/discovery overrides are forbidden" }}
{{- end }}
{{- end }}
{{- range .Values.observabilityGateway.extraEnv }}
{{- if and (hasKey . "value") (regexMatch "(?i)(token|password|secret|credential|authorization|api.?key)" .name) }}
{{- fail "credential environment variables must use valueFrom with an existing Secret reference" }}
{{- end }}
{{- end }}
{{- range $key, $_ := .Values.commonLabels }}
{{- if or (hasPrefix "app.kubernetes.io/" $key) (eq $key "helm.sh/chart") }}
{{- fail "commonLabels must not override add-on ownership or selector labels" }}
{{- end }}
{{- end }}
HELM
python3 - "$work/overrides.json" "$namespace" "$release" "$image" "$include_route" <<'PY'
import json, sys
path, namespace, release, image, route = sys.argv[1:]
overrides = {
    "nameOverride": release, "fullnameOverride": release,
    "deploymentMode": "split", "networkPolicy": {"enabled": True},
    "mcp": {"enabled": False},
    "observabilityGateway": {
        "enabled": True, "discovery": {"enabled": False},
        "image": {"repository": image, "tag": ""},
        "service": {"type": "ClusterIP"},
        "ingress": {"enabled": route == "true"},
    },
}
with open(path, "w") as stream:
    json.dump(overrides, stream)
PY
helm_args=(template "$release" "$work/source" --namespace "$namespace")
for file in "${values[@]}"; do helm_args+=(--values "$file"); done
helm_args+=(--values "$work/overrides.json")
"${HELM_BIN:-helm}" "${helm_args[@]}" > "$work/result/manifests.yaml"

python3 - "$root" "$work/result" "$namespace" "$release" "$context" "$image" "$include_route" "${values[@]}" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
root, out = map(pathlib.Path, sys.argv[1:3])
namespace, release, context, image, route = sys.argv[3:8]
values = [pathlib.Path(path) for path in sys.argv[8:]]
manifest = (out / "manifests.yaml").read_text()
kinds = sorted(re.findall(r"^kind: (\S+)$", manifest, re.M))
expected = ["Deployment", "NetworkPolicy", "Service"] + (["HTTPRoute"] if route == "true" else [])
if kinds != sorted(expected):
    raise SystemExit("rendered add-on has unexpected resource kinds or counts")
if re.findall(r"^        image: \"([^\"]+)\"$", manifest, re.M) != [image]:
    raise SystemExit("rendered add-on must contain exactly the requested immutable gateway image")
for flag in ["--mode=observability-gateway", "--observability-discovery-enabled=false"]:
    if re.findall(r"^        - (" + re.escape(flag.split("=")[0]) + r"[^\n]*)$", manifest, re.M) != [flag]:
        raise SystemExit("rendered gateway mode/discovery arguments escaped their fixed query-only configuration")
if re.findall(r"^  namespace: (\S+)$", manifest, re.M) != [namespace] * len(expected):
    raise SystemExit("rendered add-on escaped its explicit namespace")
source_paths = ["charts/chart/Chart.yaml", "charts/chart/values.yaml", "charts/chart/templates/_helpers.tpl",
                "charts/chart/templates/observability-gateway/deployment.yaml",
                "charts/chart/templates/observability-gateway/service.yaml",
                "charts/chart/templates/networkpolicy/observability-gateway.yaml"]
if route == "true":
    source_paths.append("charts/chart/templates/observability-gateway/httproute.yaml")
source_hash = hashlib.sha256()
for path in sorted(source_paths):
    source_hash.update(path.encode() + b"\0" + (root / path).read_bytes() + b"\0")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root))
manifest_hash = hashlib.sha256(manifest.encode()).hexdigest()
provenance = {"sourceCommit": commit, "sourceWorktreeDirty": dirty,
              "sourceTemplatesSHA256": source_hash.hexdigest(), "manifestSHA256": manifest_hash,
              "image": image, "namespace": namespace, "release": release, "context": context,
              "publicRouteIncluded": route == "true", "resourceKinds": expected,
              "valuesSHA256": [hashlib.sha256(path.read_bytes()).hexdigest() for path in values]}
(out / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
# Freeze the rendered bytes, not a second maintained chart implementation.
# .Files.Get emits literal YAML without evaluating template syntax in values.
(out / "chart/files/resources.yaml").write_text(manifest)
(out / "chart/templates/resources.yaml").write_text(
    '{{- if or (ne .Release.Name ' + json.dumps(release) + ') (ne .Release.Namespace ' + json.dumps(namespace) + ') }}\n'
    '{{- fail "frozen add-on release/namespace mismatch; render a new artifact" }}\n{{- end }}\n'
    '{{ .Files.Get "files/resources.yaml" }}\n')
(out / "chart/Chart.yaml").write_text(
    'apiVersion: v2\nname: paprika-observability-addon\ntype: application\n'
    'description: Frozen gateway-only render from the Paprika source chart\n'
    'version: 0.0.0+' + manifest_hash[:12] + '\nappVersion: ' + json.dumps(commit) + '\nannotations:\n'
    '  observability.paprika.io/source-commit: ' + json.dumps(commit) + '\n'
    '  observability.paprika.io/source-templates-sha256: ' + json.dumps(source_hash.hexdigest()) + '\n'
    '  observability.paprika.io/image: ' + json.dumps(image) + '\n'
    '  observability.paprika.io/manifest-sha256: ' + json.dumps(manifest_hash) + '\n')
PY
"${HELM_BIN:-helm}" template "$release" "$work/result/chart" --namespace "$namespace" > "$work/frozen.yaml"
# Helm adds its own Source comment; the semantic payload must stay frozen.
sed '/^# Source:/d; /^$/d' "$work/result/manifests.yaml" > "$work/before.yaml"
sed '/^# Source:/d; /^$/d' "$work/frozen.yaml" > "$work/after.yaml"
cmp "$work/before.yaml" "$work/after.yaml" || fail 'frozen chart did not reproduce the source render'
mkdir -p "$(dirname "$output")"
mv "$work/result" "$output"
printf 'Rendered only: %s\nReview manifests.yaml and provenance.json. At deployment time, verify the exact context:\n' "$output"
printf '  kubectl config current-context\n  # Confirm the returned context equals %q; all writes below also target it explicitly.\n' "$context"
printf 'Then, after approval of the rendered resources, install the separate add-on release:\n  '
printf '%q ' helm install "$release" "$output/chart" --namespace "$namespace" --kube-context "$context" --atomic --wait --timeout 5m
printf '\nNo cluster operation was executed. No RBAC, ServiceAccount, Secret, or CRD is included.\n'
