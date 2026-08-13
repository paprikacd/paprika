#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="${repo_root}/hack/verify-release-archives.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT
mkdir -p "${test_root}/bin" "${test_root}/assets"

cat >"${test_root}/bin/file" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  *darwin_amd64*) echo 'Mach-O 64-bit executable x86_64' ;;
  *darwin_arm64*) echo 'Mach-O 64-bit executable arm64' ;;
  *linux_amd64*) echo 'ELF 64-bit LSB executable, x86-64' ;;
  *linux_arm64*) echo 'ELF 64-bit LSB executable, ARM aarch64' ;;
esac
MOCK
chmod +x "${test_root}/bin/file"

make_archives() {
  rm -rf -- "${test_root}/assets" "${test_root}/payload"
  mkdir -p "${test_root}/assets" "${test_root}/payload"
  printf '#!/bin/sh\nexit 0\n' >"${test_root}/payload/paprika"
  chmod 0755 "${test_root}/payload/paprika"
  for target in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
    tar -czf "${test_root}/assets/paprika_0.1.0_${target}.tar.gz" -C "${test_root}/payload" paprika
  done
}

make_archives
PATH="${test_root}/bin:${PATH}" bash "${verifier}" "${test_root}/assets" 0.1.0

make_archives
rm "${test_root}/payload/paprika"
ln -s target "${test_root}/payload/paprika"
tar -czf "${test_root}/assets/paprika_0.1.0_linux_arm64.tar.gz" -C "${test_root}/payload" paprika
if PATH="${test_root}/bin:${PATH}" bash "${verifier}" "${test_root}/assets" 0.1.0 >/dev/null 2>&1; then
  printf 'symlink archive unexpectedly passed\n' >&2
  exit 1
fi

make_archives
cat >"${test_root}/bin/file" <<'MOCK'
#!/usr/bin/env bash
echo 'ELF 64-bit LSB executable, x86-64'
MOCK
chmod +x "${test_root}/bin/file"
if PATH="${test_root}/bin:${PATH}" bash "${verifier}" "${test_root}/assets" 0.1.0 >/dev/null 2>&1; then
  printf 'wrong architecture unexpectedly passed\n' >&2
  exit 1
fi

printf 'release archive verifier tests passed.\n'
