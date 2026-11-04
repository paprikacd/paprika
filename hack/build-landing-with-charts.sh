#!/usr/bin/env bash
# Assemble the public GitHub Pages site without checking generated chart assets into Git.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-}"
if [[ -z "$output" ]]; then
  echo "Usage: $0 <staging-output-directory>" >&2
  exit 2
fi
output="$(mkdir -p "$output" && cd "$output" && pwd -P)"
if [[ "$output" == "$repo_root" || "$output" == "$repo_root/landing" || "$output" == "$repo_root/labs/widget-lab" ]]; then
  echo "Refusing to overwrite a source directory: $output" >&2
  exit 2
fi

npm run build --prefix "$repo_root/labs/widget-lab"
mkdir -p "$output/charts"
cp -a "$repo_root/landing/." "$output/"
cp -a "$repo_root/labs/widget-lab/dist/." "$output/charts/"
touch "$output/.nojekyll"

node "$repo_root/hack/verify-landing-charts.mjs" "$output"

