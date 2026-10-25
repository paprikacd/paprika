#!/usr/bin/env bash
# Public provider installation plus plan-only tests with every provider mocked.
set -euo pipefail
umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
terraform_bin="$(command -v terraform)"
if [[ "$terraform_bin" != /* || ! -x "$terraform_bin" ]]; then
  printf 'terraform must resolve to an executable absolute path\n' >&2
  exit 1
fi

terraform_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paprika-terraform-tests.XXXXXX")"
trap 'rm -rf -- "$terraform_test_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$terraform_test_dir/module/tests" "$terraform_test_dir/home" "$terraform_test_dir/tmp"

# Never copy the whole module directory: it may contain live state, tfvars,
# kubeconfigs, provider caches or CLI configuration from an operator's checkout.
for source_file in main.tf omega_ha.tf .terraform.lock.hcl \
  tests/provider_inputs.tftest.hcl; do
  cp "$repo_dir/terraform/$source_file" "$terraform_test_dir/module/$source_file"
done
printf 'disable_checkpoint = true\n' >"$terraform_test_dir/terraform.rc"

run_terraform() {
  # The parent environment/home is unchanged. The child cannot inherit cloud
  # credentials, TF_VAR_*, TF_CLI_ARGS*, provider mirrors or login credentials.
  env -i PATH="$PATH" HOME="$terraform_test_dir/home" \
    TMPDIR="$terraform_test_dir/tmp" LANG=C \
    TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1 \
    TF_CLI_CONFIG_FILE="$terraform_test_dir/terraform.rc" \
    TF_DATA_DIR="$terraform_test_dir/data" \
    "$terraform_bin" "$@"
}

cd "$terraform_test_dir/module"
run_terraform fmt -check -diff main.tf omega_ha.tf tests/provider_inputs.tftest.hcl
run_terraform init -backend=false -lockfile=readonly -input=false -no-color
run_terraform validate -no-color
run_terraform test -no-color
