#!/usr/bin/env bash
# Regenerate the chart's CRD templates from config/crd/bases.
#
# controller-gen emits bare manifests into config/crd/bases; the chart copies
# need two wrappers to be correct:
#   - {{- if .Values.crd.enable }} around the whole document so installs with
#     crd.enable=false (CRDs already managed, e.g. by make install) don't try
#     to adopt existing CRDs and fail on missing Helm ownership metadata
#   - "helm.sh/resource-policy": keep under metadata.annotations when
#     .Values.crd.keep is set, so helm uninstall doesn't delete the CRDs
#
# Chart files are named <crd-name>.yaml (the CRD's metadata.name, i.e.
# <plural>.<group>). Stale chart CRD files that no longer correspond to a
# generated base are removed.
#
# Usage: hack/chart-crds.sh   (run after regenerating config/crd/bases)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASES="$REPO_ROOT/config/crd/bases"
OUT="$REPO_ROOT/charts/chart/templates/crd"

declare -A written=()

for base in "$BASES"/*.yaml; do
  crd_name="$(sed -n 's/^  name: \(.*\)/\1/p' "$base" | head -1)"
  [[ -n "$crd_name" ]] || { echo "error: no metadata.name in $base" >&2; exit 1; }
  out="$OUT/$crd_name.yaml"
  written["$crd_name.yaml"]=1

  {
    echo '{{- if .Values.crd.enable }}'
    awk '
      NR == 1 && /^---$/ { next }
      /^  annotations:$/ && !done {
        print
        print "    {{- if .Values.crd.keep }}"
        print "    \"helm.sh/resource-policy\": keep"
        print "    {{- end }}"
        done = 1
        next
      }
      { print }
      END {
        if (!done) {
          print "error: no metadata.annotations block in input" > "/dev/stderr"
          exit 1
        }
      }
    ' "$base"
    echo '{{- end }}'
  } > "$out"

  echo "wrote $out"
done

for existing in "$OUT"/*.yaml; do
  name="$(basename "$existing")"
  if [[ -z "${written[$name]:-}" ]]; then
    echo "removing stale chart CRD $existing"
    rm "$existing"
  fi
done
