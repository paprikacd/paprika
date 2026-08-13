#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
resolver="${repo_root}/hack/find-github-release.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT
mkdir -p "${test_root}/bin"

cat >"${test_root}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != 'api --paginate --slurp repos/paprikacd/paprika/releases?per_page=100' ]]; then
  printf 'unexpected gh arguments\n' >&2
  exit 64
fi
if [[ "${MOCK_STATUS:-0}" != 0 ]]; then
  printf '%s\n' "${MOCK_STDERR:-mock API failure}" >&2
  exit "${MOCK_STATUS}"
fi
printf '%s\n' "${MOCK_RESPONSE}"
MOCK
chmod +x "${test_root}/bin/gh"

run_success() {
  name="$1"
  response="$2"
  want_state="$3"
  want_id="$4"
  output="$(PATH="${test_root}/bin:${PATH}" MOCK_RESPONSE="${response}" \
    bash "${resolver}" paprikacd/paprika v0.1.0)"
  jq -e --arg state "${want_state}" --argjson id "${want_id}" \
    '.state == $state and .id == $id' <<<"${output}" >/dev/null
  printf 'ok - %s\n' "${name}"
}

run_failure() {
  name="$1"
  response="$2"
  secret="sensitive-${name// /-}"
  stdout="${test_root}/${name// /-}.stdout"
  stderr="${test_root}/${name// /-}.stderr"
  if PATH="${test_root}/bin:${PATH}" MOCK_RESPONSE="${response}" \
    MOCK_STDERR="remote failure contains ${secret}" \
    bash "${resolver}" paprikacd/paprika v0.1.0 >"${stdout}" 2>"${stderr}"; then
    printf '%s unexpectedly succeeded\n' "${name}" >&2
    exit 1
  fi
  if grep -Fq "${secret}" "${stdout}" "${stderr}"; then
    printf '%s leaked remote error content\n' "${name}" >&2
    exit 1
  fi
  printf 'ok - %s\n' "${name}"
}

run_success "absent exact tag" '[[]]' absent null
run_success "one draft" '[[{"id":101,"tag_name":"v0.1.0","draft":true}]]' draft 101
run_success "one public" '[[{"id":102,"tag_name":"v0.1.0","draft":false}]]' public 102
run_success "other tags ignored" '[[{"id":103,"tag_name":"v0.1.00","draft":true},{"id":104,"tag_name":"v0.2.0","draft":false}]]' absent null
run_success "paginated exact draft" '[[{"id":105,"tag_name":"v0.0.9","draft":false}],[{"id":106,"tag_name":"v0.1.0","draft":true}]]' draft 106
run_failure "duplicate exact tags" '[[{"id":107,"tag_name":"v0.1.0","draft":true}],[{"id":108,"tag_name":"v0.1.0","draft":false}]]'
run_failure "malformed JSON" 'not-json-sensitive-malformed-JSON'
run_failure "malformed release schema" '[[{"id":"not-an-integer","tag_name":"v0.1.0","draft":true}]]'

api_stdout="${test_root}/api.stdout"
api_stderr="${test_root}/api.stderr"
api_secret="sensitive-api-failure"
if PATH="${test_root}/bin:${PATH}" MOCK_STATUS=22 MOCK_RESPONSE='[[]]' \
  MOCK_STDERR="remote failure contains ${api_secret}" \
  bash "${resolver}" paprikacd/paprika v0.1.0 >"${api_stdout}" 2>"${api_stderr}"; then
  printf 'API failure unexpectedly succeeded\n' >&2
  exit 1
fi
if grep -Fq "${api_secret}" "${api_stdout}" "${api_stderr}"; then
  printf 'API failure leaked remote error content\n' >&2
  exit 1
fi
printf 'ok - API failure is generic and redacted\n'

printf 'GitHub release resolver tests passed.\n'
