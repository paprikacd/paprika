#!/usr/bin/env bash
# Assemble the public GitHub Pages site without checking generated chart assets into Git.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-}"
if [[ -z "$output" ]]; then
  echo "Usage: $0 <staging-output-directory>" >&2
  exit 2
fi
output="$(node "$repo_root/landing/build-content.mjs" --validate-output "$output")"
if [[ "$output" == "$repo_root" || "$output" == "$repo_root/landing" || "$output" == "$repo_root/labs/widget-lab" ]]; then
  echo "Refusing to overwrite a source directory: $output" >&2
  exit 2
fi

npm run build --prefix "$repo_root/labs/widget-lab"
mkdir -p "$output/charts"
node --input-type=module - "$repo_root/landing" "$output" <<'NODE'
import { cpSync } from 'node:fs';
import { basename } from 'node:path';

const excluded = new Set([
  'node_modules', 'content', 'package.json', 'package-lock.json',
  'build-content.mjs', 'build-content.test.mjs', 'analytics.test.mjs', 'verify-browser.mjs',
  'structured-data.mjs', 'structured-data.test.mjs', 'article-demos.test.mjs',
  'DESIGN.md', 'README.md',
]);
cpSync(process.argv[2], process.argv[3], {
  recursive: true,
  filter: (source) => !excluded.has(basename(source)),
});
NODE
cp -a "$repo_root/labs/widget-lab/dist/." "$output/charts/"
touch "$output/.nojekyll"

node "$repo_root/landing/build-content.mjs" "$output"
node "$repo_root/hack/verify-landing-charts.mjs" "$output"
node "$repo_root/hack/verify-landing-content.mjs" "$output"

