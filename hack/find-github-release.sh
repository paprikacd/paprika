#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s OWNER/REPOSITORY TAG\n' "$0" >&2
  exit 2
fi

repository="$1"
tag="$2"
if [[ ! "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || -z "${tag}" || "${tag}" == *$'\n'* ]]; then
  printf 'invalid GitHub release lookup input\n' >&2
  exit 2
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT
response_file="${work_dir}/releases.json"

if ! gh api --paginate --slurp \
  "repos/${repository}/releases?per_page=100" \
  >"${response_file}" 2>"${work_dir}/api.stderr"; then
  printf 'failed to list GitHub releases\n' >&2
  exit 1
fi

if ! result="$(jq -cer --arg tag "${tag}" '
  if type != "array" or any(.[]; type != "array") then
    error("expected a list of release pages")
  else
    [.[][] | select(type == "object" and .tag_name == $tag)] as $matches |
    ($matches | length) as $count |
    if $count == 0 then
      {state: "absent", id: null}
    elif $count == 1 then
      $matches[0] as $release |
      if ($release.id | type) != "number" or $release.id <= 0 or ($release.id | floor) != $release.id then
        error("release ID must be a positive integer")
      elif ($release.draft | type) != "boolean" then
        error("release draft state must be boolean")
      elif $release.draft then
        {state: "draft", id: $release.id}
      else
        {state: "public", id: $release.id}
      end
    else
      error("multiple releases have the exact tag")
    end
  end
' "${response_file}" 2>"${work_dir}/jq.stderr")"; then
  printf 'invalid GitHub releases response\n' >&2
  exit 1
fi

printf '%s\n' "${result}"
