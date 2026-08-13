#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo_root/install.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
passes=0
failures=0

fail() { printf 'not ok - %s\n' "$1" >&2; return 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_eq() {
	local want="$1" got="$2" message="$3"
	[[ "$got" == "$want" ]] || { fail "$message (want '$want', got '$got')"; return 1; }
}
assert_contains() {
	local file="$1" needle="$2" message="$3"
	grep -Fq -- "$needle" "$file" || { fail "$message (missing '$needle')"; return 1; }
}
assert_not_contains() {
	local file="$1" needle="$2" message="$3"
	! grep -Fq -- "$needle" "$file" || { fail "$message (unexpected '$needle')"; return 1; }
}
sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
	else shasum -a 256 "$1" | awk '{print $1}'; fi
}
file_mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"
	else stat -c '%a' "$1"; fi
}
make_binary() {
	local path="$1" marker="$2"
	printf '#!/bin/sh\nprintf "%%s\\n" %q\n' "$marker" >"$path"
	chmod 0755 "$path"
}

release_root="$test_root/releases"
mkdir -p "$release_root/download/v0.1.0"
checksums="$release_root/download/v0.1.0/checksums.txt"
: >"$checksums"
for os in darwin linux; do
	for arch in amd64 arm64; do
		build_dir="$test_root/build-$os-$arch"
		mkdir -p "$build_dir"
		make_binary "$build_dir/paprika" "fixture-$os-$arch"
		asset="paprika_0.1.0_${os}_${arch}.tar.gz"
		tar -czf "$release_root/download/v0.1.0/$asset" -C "$build_dir" paprika
		printf '%s  %s\n' "$(sha256_file "$release_root/download/v0.1.0/$asset")" "$asset" >>"$checksums"
	done
done

real_stat="$(command -v stat)"
real_chmod="$(command -v chmod)"
real_mkdir="$(command -v mkdir)"
real_mv="$(command -v mv)"
real_gzip="$(command -v gzip)"
if command -v sha256sum >/dev/null 2>&1; then
	real_hash_tool="$(command -v sha256sum)"
	real_hash_kind=sha256sum
else
	real_hash_tool="$(command -v shasum)"
	real_hash_kind=shasum
fi
tool_names=(awk basename dirname grep mktemp rm sed tr)

make_toolbox() {
	local bin="$1" tool real
	mkdir -p "$bin"
	for tool in "${tool_names[@]}"; do
		real="$(command -v "$tool")"
		ln -s "$real" "$bin/$tool"
	done

	cat >"$bin/uname" <<'EOF'
#!/bin/sh
case "${1-}" in
	-s) printf '%s\n' "${TEST_UNAME_S:-Darwin}" ;;
	-m) printf '%s\n' "${TEST_UNAME_M:-x86_64}" ;;
	*) exit 2 ;;
esac
EOF
	chmod 0755 "$bin/uname"

	cat >"$bin/curl" <<'EOF'
#!/bin/sh
if [ "${1-}" != -q ] && [ "${1-}" != --disable ]; then
	[ ! -f "$HOME/.curlrc" ] || : >"$CURL_CONFIG_MARKER"
	exit 94
fi
shift
output= write_format= url= proto= proto_redir=
fail_flag= silent_flag= show_error_flag= location_flag=
while [ "$#" -gt 0 ]; do
	case "$1" in
		-o) shift; output=${1-} ;;
		-w) shift; write_format=${1-} ;;
		--proto) shift; proto=${1-} ;;
		--proto-redir) shift; proto_redir=${1-} ;;
		-f) fail_flag=1 ;;
		-s) silent_flag=1 ;;
		-S) show_error_flag=1 ;;
		-L) location_flag=1 ;;
		-*) ;;
		*) url=$1 ;;
	esac
	shift
done
[ "$proto" = '=https' ] && [ "$proto_redir" = '=https' ] || exit 93
[ -n "$fail_flag" ] && [ -n "$silent_flag" ] && [ -n "$show_error_flag" ] && [ -n "$location_flag" ] || exit 95
printf '%s\n' "$url" >>"$CURL_LOG"
case "$url" in
	https://github.com/paprikacd/paprika/releases/latest)
		[ "${CURL_MODE-}" = latest_fail ] && exit 22
		[ -n "$write_format" ] || exit 90
		printf '%s' "${LATEST_EFFECTIVE_URL:-https://github.com/paprikacd/paprika/releases/tag/v0.1.0}"
		exit 0 ;;
	https://github.com/paprikacd/paprika/releases/download/*) ;;
	*) exit 91 ;;
esac
[ "${CURL_MODE-}" = download_fail ] && exit 22
if [ "${CURL_MODE-}" = interrupt ]; then kill -TERM "$PPID"; exit 143; fi
parent=${output%/*}
if mode=$("$PAPRIKA_REAL_STAT" -f '%Lp' "$parent" 2>/dev/null); then :; else
	mode=$("$PAPRIKA_REAL_STAT" -c '%a' "$parent")
fi
extract_mode=missing
if [ -d "$parent/extract" ]; then
	if extract_mode=$("$PAPRIKA_REAL_STAT" -f '%Lp' "$parent/extract" 2>/dev/null); then :; else
		extract_mode=$("$PAPRIKA_REAL_STAT" -c '%a' "$parent/extract")
	fi
fi
printf 'download-dir=%s extract-dir=%s\n' "$mode" "$extract_mode" >>"$MODE_LOG"
if [ "${CURL_MODE-}" = malicious_body ]; then
	case "$url" in
		*/checksums.txt)
			printf 'MALICIOUS_DOWNLOADED_MARKER secret=%s\n' "${PAPRIKA_SUPER_SECRET-}" >"$output"
			exit 0
			;;
	esac
fi
relative=${url#https://github.com/paprikacd/paprika/releases/}
source_path="$FAKE_RELEASE_ROOT/$relative"
[ -f "$source_path" ] || exit 92
"$PAPRIKA_REAL_CP" "$source_path" "$output"
EOF
	chmod 0755 "$bin/curl"

	cat >"$bin/cp" <<'EOF'
#!/bin/sh
[ -z "${CP_LOG-}" ] || printf '%s\n' "$*" >>"$CP_LOG"
[ "${COPYFILE_DISABLE-}" = 1 ] || exit 99
[ "${FAIL_TOOL-}" = cp ] && exit 1
exec "$PAPRIKA_REAL_CP" "$@"
EOF
	chmod 0755 "$bin/cp"

	cat >"$bin/tar" <<'EOF'
#!/bin/sh
[ -z "${TAR_LOG-}" ] || printf '%s\n' "${TAR_OPTIONS-unset}" >>"$TAR_LOG"
if [ -n "${TAR_OPTIONS-}" ]; then
	: >"$TAR_EXEC_MARKER"
	exit 96
fi
[ "${COPYFILE_DISABLE-}" = 1 ] || exit 99
case " $* " in *' -x'*|*' x'*) [ "${FAIL_TOOL-}" = tar_extract ] && exit 1 ;; esac
exec "$PAPRIKA_REAL_TAR" "$@"
EOF
	chmod 0755 "$bin/tar"

	cat >"$bin/gzip" <<'EOF'
#!/bin/sh
exec "$PAPRIKA_REAL_GZIP" "$@"
EOF
	chmod 0755 "$bin/gzip"

	cat >"$bin/mv" <<'EOF'
#!/bin/sh
[ -z "${MV_LOG-}" ] || printf '%s\n' "$*" >>"$MV_LOG"
[ "${FAIL_TOOL-}" = mv ] && exit 1
exec "$PAPRIKA_REAL_MV" "$@"
EOF
	chmod 0755 "$bin/mv"

	cat >"$bin/chmod" <<'EOF'
#!/bin/sh
last_arg=
for last_arg do :; done
if [ "${FAIL_TOOL-}" = chmod_work ]; then
	case "$last_arg" in
		*/paprika-install.*/*) ;;
		*/paprika-install.*) exit 1 ;;
	esac
fi
exec "$PAPRIKA_REAL_CHMOD" "$@"
EOF
	chmod 0755 "$bin/chmod"

	cat >"$bin/mkdir" <<'EOF'
#!/bin/sh
last_arg=
for last_arg do :; done
if [ "${FAIL_TOOL-}" = mkdir_work ]; then
	case "$last_arg" in
		*/paprika-install.*/extract) exit 1 ;;
	esac
fi
exec "$PAPRIKA_REAL_MKDIR" "$@"
EOF
	chmod 0755 "$bin/mkdir"

	cat >"$bin/sha256sum" <<'EOF'
#!/bin/sh
[ "$#" -eq 1 ] || exit 97
printf 'sha256sum:%s\n' "$*" >>"$HASH_LOG"
[ "${FAIL_TOOL-}" = checksum ] && exit 1
if [ "$PAPRIKA_REAL_HASH_KIND" = sha256sum ]; then
	exec "$PAPRIKA_REAL_HASH_TOOL" "$1"
fi
exec "$PAPRIKA_REAL_HASH_TOOL" -a 256 "$1"
EOF
	chmod 0755 "$bin/sha256sum"

	cat >"$bin/shasum" <<'EOF'
#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = -a ] && [ "$2" = 256 ] || exit 98
printf 'shasum:%s\n' "$*" >>"$HASH_LOG"
[ "${FAIL_TOOL-}" = checksum ] && exit 1
if [ "$PAPRIKA_REAL_HASH_KIND" = sha256sum ]; then
	exec "$PAPRIKA_REAL_HASH_TOOL" "$3"
fi
exec "$PAPRIKA_REAL_HASH_TOOL" -a 256 "$3"
EOF
	chmod 0755 "$bin/shasum"
}

toolbox_template="$test_root/toolbox-template"
make_toolbox "$toolbox_template"

case_dir=''
case_release=''
case_bin=''
case_home=''
case_tmp=''
case_install=''
case_output=''
case_curl_log=''
case_mode_log=''
case_cp_log=''
case_mv_log=''
case_tar_log=''
case_hash_log=''
case_curl_config_marker=''
case_tar_exec_marker=''
status=0

new_case() {
	local name="$1"
	case_dir="$test_root/case-$name"
	case_release="$case_dir/releases"
	case_bin="$case_dir/bin"
	case_home="$case_dir/home"
	case_tmp="$case_dir/tmp"
	case_install="$case_dir/install"
	case_output="$case_dir/output"
	case_curl_log="$case_dir/curl.log"
	case_mode_log="$case_dir/modes.log"
	case_cp_log="$case_dir/cp.log"
	case_mv_log="$case_dir/mv.log"
	case_tar_log="$case_dir/tar.log"
	case_hash_log="$case_dir/hash.log"
	case_curl_config_marker="$case_dir/curl-config-executed"
	case_tar_exec_marker="$case_dir/tar-options-executed"
	mkdir -p "$case_dir" "$case_home" "$case_tmp" "$case_install"
	cp -R "$release_root" "$case_release"
	: >"$case_curl_log"; : >"$case_mode_log"; : >"$case_cp_log"; : >"$case_mv_log"
	: >"$case_tar_log"; : >"$case_hash_log"
	cp -R "$toolbox_template" "$case_bin"
}

run_case() {
	local -a environment
	environment=(
		PATH="$case_bin${TEST_PATH_SUFFIX:+:$TEST_PATH_SUFFIX}" HOME="$case_home" TMPDIR="$case_tmp"
		PAPRIKA_INSTALL_DIR="${PAPRIKA_INSTALL_DIR-$case_install}"
		PAPRIKA_TEST_DEFAULT_ROOT="${PAPRIKA_TEST_DEFAULT_ROOT-}"
		TEST_UNAME_S="${TEST_UNAME_S:-Darwin}" TEST_UNAME_M="${TEST_UNAME_M:-x86_64}"
		LATEST_EFFECTIVE_URL="${LATEST_EFFECTIVE_URL-}" CURL_MODE="${CURL_MODE-}"
		FAIL_TOOL="${FAIL_TOOL-}" FAKE_RELEASE_ROOT="$case_release"
		CURL_LOG="$case_curl_log" MODE_LOG="$case_mode_log" CP_LOG="$case_cp_log"
		MV_LOG="$case_mv_log" TAR_LOG="$case_tar_log" HASH_LOG="$case_hash_log"
		CURL_CONFIG_MARKER="$case_curl_config_marker" TAR_EXEC_MARKER="$case_tar_exec_marker"
		PAPRIKA_REAL_CP="$(command -v cp)" PAPRIKA_REAL_TAR="$(command -v tar)"
		PAPRIKA_REAL_STAT="$real_stat" PAPRIKA_REAL_CHMOD="$real_chmod"
		PAPRIKA_REAL_MKDIR="$real_mkdir" PAPRIKA_REAL_MV="$real_mv"
		PAPRIKA_REAL_GZIP="$real_gzip"
		PAPRIKA_REAL_HASH_TOOL="$real_hash_tool" PAPRIKA_REAL_HASH_KIND="$real_hash_kind"
	)
	if [[ ${PAPRIKA_VERSION+x} ]]; then
		environment+=(PAPRIKA_VERSION="$PAPRIKA_VERSION")
	fi
	if [[ ${PAPRIKA_SUPER_SECRET+x} ]]; then
		environment+=(PAPRIKA_SUPER_SECRET="$PAPRIKA_SUPER_SECRET")
	fi
	if [[ ${TAR_OPTIONS+x} ]]; then
		environment+=(TAR_OPTIONS="$TAR_OPTIONS")
	fi
	if [[ ${COPYFILE_DISABLE+x} ]]; then
		environment+=(COPYFILE_DISABLE="$COPYFILE_DISABLE")
	fi
	set +e
	env -i "${environment[@]}" /bin/sh "$installer" >"$case_output" 2>&1
	status=$?
	set -e
}

assert_clean() {
	local message="$1"
	if find "$case_tmp" -mindepth 1 -print -quit | grep -q .; then
		fail "$message (installer temp directory remains)"; return 1
	fi
	if [[ -d "$case_install" ]] && find "$case_install" -name '.paprika.install.*' -print -quit | grep -q .; then
		fail "$message (destination-local temp file remains)"; return 1
	fi
}
assert_preserved() {
	[[ "$(cat "$case_install/paprika")" == ORIGINAL ]] || { fail "$1 (destination content changed)"; return 1; }
}
seed_destination() { printf 'ORIGINAL\n' >"$case_install/paprika"; chmod 0640 "$case_install/paprika"; }
rewrite_checksum() {
	local asset="$1"
	printf '%s  %s\n' "$(sha256_file "$case_release/download/v0.1.0/$asset")" "$asset" >"$case_release/download/v0.1.0/checksums.txt"
}

select_hash_backend() {
	case "$1" in
		sha256sum) rm -f "$case_bin/shasum" ;;
		shasum) rm -f "$case_bin/sha256sum" ;;
		*) fail "unknown hash backend: $1" ;;
	esac
}

test_explicit_versions() {
	local input
	for input in v0.1.0 0.1.0; do
		new_case "version-${input//./-}"
		PAPRIKA_VERSION="$input" run_case
		assert_eq 0 "$status" "$input installs" || return 1
		assert_contains "$case_curl_log" '/download/v0.1.0/checksums.txt' "$input uses canonical tag" || return 1
		assert_contains "$case_curl_log" '/download/v0.1.0/paprika_0.1.0_darwin_amd64.tar.gz' "$input uses unprefixed asset version" || return 1
		assert_eq fixture-darwin-amd64 "$("$case_install/paprika")" "$input runs fixture" || return 1
		assert_eq 755 "$(file_mode "$case_install/paprika")" "$input mode is 0755" || return 1
		assert_contains "$case_output" 'paprika login --server https://paprika.benebsworth.com' "$input prints next step" || return 1
		assert_clean "$input cleans temps" || return 1
		pass "explicit version $input normalizes and installs"
	done
}

test_latest_resolution() {
	new_case latest
	unset PAPRIKA_VERSION
	run_case
	assert_eq 0 "$status" 'latest installs' || return
	assert_eq 'https://github.com/paprikacd/paprika/releases/latest' "$(head -n 1 "$case_curl_log")" 'latest uses fixed HTTPS endpoint' || return
	assert_contains "$case_curl_log" '/download/v0.1.0/paprika_0.1.0_darwin_amd64.tar.gz' 'latest tag normalizes' || return
	pass 'unpinned install follows canonical HTTPS GitHub latest redirect'
	new_case latest-untrusted
	unset PAPRIKA_VERSION
	LATEST_EFFECTIVE_URL='https://evil.example/releases/tag/v0.1.0' run_case
	[[ "$status" -ne 0 ]] || { fail 'untrusted latest redirect fails'; return 1; }
	assert_eq 1 "$(wc -l <"$case_curl_log" | tr -d ' ')" 'untrusted redirect stops downloads' || return
	pass 'unpinned install rejects redirect outside fixed GitHub release path'
}

test_platform_mappings() {
	local system machine expected
	while read -r system machine expected; do
		new_case "platform-$system-$machine"
		PAPRIKA_VERSION=v0.1.0 TEST_UNAME_S="$system" TEST_UNAME_M="$machine" run_case
		assert_eq 0 "$status" "$system/$machine installs" || return
		assert_eq "$expected" "$("$case_install/paprika")" "$system/$machine asset mapping" || return
	done <<'EOF'
Darwin x86_64 fixture-darwin-amd64
Darwin arm64 fixture-darwin-arm64
Linux amd64 fixture-linux-amd64
Linux aarch64 fixture-linux-arm64
EOF
	pass 'supported OS and architecture mappings select all four release assets'
	for pair in 'FreeBSD x86_64' 'Linux i686'; do
		new_case "unsupported-${pair// /-}"
		PAPRIKA_VERSION=v0.1.0 TEST_UNAME_S="${pair%% *}" TEST_UNAME_M="${pair#* }" run_case
		[[ "$status" -ne 0 ]] || { fail "$pair must fail"; return 1; }
		assert_eq 0 "$(wc -l <"$case_curl_log" | tr -d ' ')" "$pair fails before download" || return
	done
	pass 'unsupported OS and architecture fail before download'
}

test_versions_rejected_before_download() {
	local value label
	while IFS='|' read -r label value; do
		new_case "bad-version-$label"
		PAPRIKA_VERSION="$value" run_case
		[[ "$status" -ne 0 ]] || { fail "version $label must fail"; return 1; }
		assert_eq 0 "$(wc -l <"$case_curl_log" | tr -d ' ')" "version $label fails before download" || return
	done <<'EOF'
empty|
malformed|1.2
leading-zero|01.2.3
prerelease|1.2.3-rc.1
traversal|../1.2.3
shell|1.2.3;echo-pwned
build-metadata|1.2.3+secret
empty-prerelease|1.2.3-
double-dot|1.2.3-rc..1
EOF
	pass 'empty, unsafe, and malformed explicit versions fail before download'
}

test_checksum_failures() {
	local asset='paprika_0.1.0_darwin_amd64.tar.gz' kind
	for kind in missing duplicate malformed mismatch tool-failure; do
		new_case "checksum-$kind"; seed_destination
		case "$kind" in
			missing) grep -v "$asset" "$case_release/download/v0.1.0/checksums.txt" >"$case_release/new"; mv "$case_release/new" "$case_release/download/v0.1.0/checksums.txt" ;;
			duplicate)
				checksum_line="$(grep "$asset" "$case_release/download/v0.1.0/checksums.txt")"
				printf '%s\n' "$checksum_line" >>"$case_release/download/v0.1.0/checksums.txt"
				;;
			malformed) printf 'not-a-checksum  %s\n' "$asset" >"$case_release/download/v0.1.0/checksums.txt" ;;
			mismatch) printf '%064d  %s\n' 0 "$asset" >"$case_release/download/v0.1.0/checksums.txt" ;;
			tool-failure) FAIL_TOOL=checksum ;;
		esac
		PAPRIKA_VERSION=v0.1.0 FAIL_TOOL="${FAIL_TOOL-}" run_case; unset FAIL_TOOL
		[[ "$status" -ne 0 ]] || { fail "checksum $kind must fail"; return 1; }
		assert_preserved "checksum $kind preserves destination" || return
		assert_clean "checksum $kind cleans temps" || return
	done
	pass 'missing, duplicate, malformed, mismatched, and failed checksum checks are rejected'
}

make_hostile_archive() {
	local kind="$1" archive="$2" source="$case_dir/hostile"
	rm -rf "$source"; mkdir -p "$source"
	case "$kind" in
		missing) printf 'other\n' >"$source/other"; tar -czf "$archive" -C "$source" other ;;
		duplicate) make_binary "$source/paprika" hostile; tar -czf "$archive" -C "$source" paprika paprika ;;
		path-qualified) mkdir -p "$source/nested"; make_binary "$source/nested/paprika" hostile; tar -czf "$archive" -C "$source" nested/paprika ;;
		symlink) printf 'target\n' >"$source/target"; ln -s target "$source/paprika"; tar -czf "$archive" -C "$source" paprika ;;
		non-regular) mkdir "$source/paprika"; tar -czf "$archive" -C "$source" paprika ;;
	esac
}

test_archive_failures() {
	local asset='paprika_0.1.0_darwin_amd64.tar.gz' kind archive
	for kind in missing duplicate path-qualified symlink non-regular; do
		new_case "archive-$kind"; seed_destination
		archive="$case_release/download/v0.1.0/$asset"
		make_hostile_archive "$kind" "$archive"; rewrite_checksum "$asset"
		PAPRIKA_VERSION=v0.1.0 run_case
		[[ "$status" -ne 0 ]] || { fail "archive $kind must fail"; return 1; }
		assert_preserved "archive $kind preserves destination" || return
		assert_clean "archive $kind cleans temps" || return
	done
	pass 'archives require exactly one root regular paprika entry'
}

test_failure_atomicity() {
	local kind
	for kind in download extract copy mv interrupt; do
		new_case "atomic-$kind"; seed_destination
		case "$kind" in download) CURL_MODE=download_fail ;; extract) FAIL_TOOL=tar_extract ;; copy) FAIL_TOOL='cp' ;; mv) FAIL_TOOL='mv' ;; interrupt) CURL_MODE=interrupt ;; esac
		PAPRIKA_VERSION=v0.1.0 CURL_MODE="${CURL_MODE-}" FAIL_TOOL="${FAIL_TOOL-}" run_case
		unset CURL_MODE FAIL_TOOL
		[[ "$status" -ne 0 ]] || { fail "$kind failure must fail"; return 1; }
		assert_preserved "$kind failure preserves destination" || return
		assert_clean "$kind failure cleans temps" || return
	done
	pass 'download, extraction, copy, final mv failures, and interruption preserve destination'
}

test_private_temps_and_success_replace() {
	new_case private-temp; seed_destination
	PAPRIKA_VERSION=v0.1.0 run_case
	assert_eq 0 "$status" 'valid replacement succeeds' || return
	assert_contains "$case_mode_log" 'download-dir=700 extract-dir=700' 'remote content only enters private directories' || return
	assert_eq 1 "$(wc -l <"$case_mv_log" | tr -d ' ')" 'success uses one final promotion rename' || return
	assert_contains "$case_mv_log" "$case_install/.paprika.install." 'promotion source is destination-local' || return
	assert_contains "$case_mv_log" "$case_install/paprika" 'promotion rename targets the final destination' || return
	assert_contains "$case_cp_log" "/extract/paprika $case_install/.paprika.install." 'copy only stages into a destination-local temp file' || return
	if grep -Fq " $case_install/paprika" "$case_cp_log"; then
		fail 'copy must not promote directly to the final destination'
	fi
	assert_eq fixture-darwin-amd64 "$("$case_install/paprika")" 'success replaces destination' || return
	assert_eq 755 "$(file_mode "$case_install/paprika")" 'replacement mode is 0755' || return
	assert_clean 'success cleans temps' || return
	pass 'private 0700 temp directories precede downloads and success replaces atomically'
}

test_environment_option_hardening() {
	new_case environment-options
	printf '%s\n' '--insecure' >"$case_home/.curlrc"
	TAR_OPTIONS='--paprika-test-exec' COPYFILE_DISABLE=0 PAPRIKA_VERSION=v0.1.0 run_case
	assert_eq 0 "$status" 'hostile curl and tar environment options are neutralized' || return
	[[ ! -e "$case_curl_config_marker" ]] || fail 'curl read the malicious HOME/.curlrc before -q'
	[[ ! -e "$case_tar_exec_marker" ]] || fail 'tar observed hostile TAR_OPTIONS'
	assert_eq 3 "$(wc -l <"$case_tar_log" | tr -d ' ')" 'all three tar invocations are observed' || return
	if grep -q '[^[:space:]]' "$case_tar_log"; then
		fail 'TAR_OPTIONS was nonempty for a tar invocation'
	fi
	pass 'curl config parsing is disabled first and archive metadata environment is neutralized'
}

test_nonregular_destinations() {
	new_case destination-directory
	mkdir "$case_install/paprika"
	printf 'KEEP\n' >"$case_install/paprika/sentinel"
	PAPRIKA_VERSION=v0.1.0 run_case
	[[ "$status" -ne 0 ]] || { fail 'destination directory must be rejected'; return 1; }
	assert_eq KEEP "$(tr -d '\n' <"$case_install/paprika/sentinel")" 'destination directory contents remain unchanged' || return
	assert_clean 'destination directory rejection cleans temporary files' || return

	new_case destination-symlink-directory
	mkdir "$case_dir/linked-directory"
	printf 'KEEP\n' >"$case_dir/linked-directory/sentinel"
	ln -s "$case_dir/linked-directory" "$case_install/paprika"
	PAPRIKA_VERSION=v0.1.0 run_case
	[[ "$status" -ne 0 ]] || { fail 'destination symlink to directory must be rejected'; return 1; }
	[[ -L "$case_install/paprika" ]] || fail 'destination symlink was replaced'
	assert_eq KEEP "$(tr -d '\n' <"$case_dir/linked-directory/sentinel")" 'symlink target directory contents remain unchanged' || return
	assert_clean 'destination symlink rejection cleans temporary files' || return

	new_case destination-fifo
	mkfifo "$case_install/paprika"
	PAPRIKA_VERSION=v0.1.0 run_case
	[[ "$status" -ne 0 ]] || { fail 'FIFO destination must be rejected'; return 1; }
	[[ -p "$case_install/paprika" ]] || fail 'FIFO destination was replaced'
	assert_clean 'FIFO destination rejection cleans temporary files' || return
	pass 'directory, symlink-to-directory, and other non-regular destinations are rejected without mutation'
}

test_hash_backends() {
	local backend asset='paprika_0.1.0_darwin_amd64.tar.gz'
	for backend in sha256sum shasum; do
		new_case "hash-$backend-success"
		select_hash_backend "$backend"
		PAPRIKA_VERSION=v0.1.0 run_case
		assert_eq 0 "$status" "$backend valid checksum succeeds" || return
		assert_contains "$case_hash_log" "$backend:" "$backend is exercised" || return
		assert_clean "$backend success cleans temporary files" || return

		new_case "hash-$backend-mismatch"; seed_destination
		select_hash_backend "$backend"
		printf '%064d  %s\n' 0 "$asset" >"$case_release/download/v0.1.0/checksums.txt"
		PAPRIKA_VERSION=v0.1.0 run_case
		[[ "$status" -ne 0 ]] || { fail "$backend mismatch must fail"; return 1; }
		assert_contains "$case_hash_log" "$backend:" "$backend mismatch invokes selected tool" || return
		assert_preserved "$backend mismatch preserves destination" || return
		assert_clean "$backend mismatch cleans temporary files" || return

		new_case "hash-$backend-error"; seed_destination
		select_hash_backend "$backend"
		PAPRIKA_VERSION=v0.1.0 FAIL_TOOL=checksum run_case
		[[ "$status" -ne 0 ]] || { fail "$backend execution error must fail"; return 1; }
		assert_contains "$case_hash_log" "$backend:" "$backend error invokes selected tool with valid args" || return
		assert_preserved "$backend error preserves destination" || return
		assert_clean "$backend error cleans temporary files" || return
	done
	pass 'sha256sum and shasum exact invocation paths cover success, mismatch, and tool error'
}

test_early_cleanup_trap() {
	local kind
	for kind in chmod-failure mkdir-failure; do
		new_case "early-cleanup-$kind"
		case "$kind" in
			chmod-failure) FAIL_TOOL=chmod_work ;;
			mkdir-failure) FAIL_TOOL=mkdir_work ;;
		esac
		PAPRIKA_VERSION=v0.1.0 FAIL_TOOL="$FAIL_TOOL" run_case
		unset FAIL_TOOL
		[[ "$status" -ne 0 ]] || { fail "$kind must fail"; return 1; }
		assert_eq 0 "$(wc -l <"$case_curl_log" | tr -d ' ')" "$kind happens before download" || return
		assert_clean "$kind cleans a newly created private work directory" || return
	done
	pass 'cleanup trap covers chmod and mkdir failures immediately after private temp creation'
}

test_destination_selection() {
	new_case destination-order; rm -rf "$case_install"
	default_root="$case_dir/default-root"
	mkdir -p "$default_root/opt/homebrew/bin" "$default_root/usr/local/bin" "$case_home/.local/bin"
	path_candidates="$case_home/.local/bin:$default_root/usr/local/bin:$default_root/opt/homebrew/bin"
	PAPRIKA_INSTALL_DIR='' PAPRIKA_VERSION=v0.1.0 PAPRIKA_TEST_DEFAULT_ROOT="$default_root" TEST_PATH_SUFFIX="$path_candidates" run_case
	assert_eq 0 "$status" 'default candidate install succeeds' || return
	[[ -x "$default_root/opt/homebrew/bin/paprika" ]] || { fail 'first writable existing candidate not selected'; return 1; }
	[[ ! -e "$default_root/usr/local/bin/paprika" && ! -e "$case_home/.local/bin/paprika" ]] || { fail 'later default candidate selected'; return 1; }

	new_case destination-path-filter; rm -rf "$case_install"
	default_root="$case_dir/default-root"
	mkdir -p "$default_root/opt/homebrew/bin" "$default_root/usr/local/bin" "$case_home/.local/bin"
	PAPRIKA_INSTALL_DIR='' PAPRIKA_VERSION=v0.1.0 PAPRIKA_TEST_DEFAULT_ROOT="$default_root" TEST_PATH_SUFFIX="$default_root/usr/local/bin" run_case
	assert_eq 0 "$status" 'PATH-filtered candidate install succeeds' || return
	[[ -x "$default_root/usr/local/bin/paprika" ]] || { fail 'first candidate present on PATH not selected'; return 1; }
	[[ ! -e "$default_root/opt/homebrew/bin/paprika" && ! -e "$case_home/.local/bin/paprika" ]] || { fail 'off-PATH candidate selected'; return 1; }

	new_case destination-fallback; rm -rf "$case_install"
	default_root="$case_dir/default-root"; mkdir -p "$default_root"
	mkdir -p "$default_root/opt/homebrew/bin" "$default_root/usr/local/bin" "$case_home/.local/bin"
	PAPRIKA_INSTALL_DIR='' PAPRIKA_VERSION=v0.1.0 PAPRIKA_TEST_DEFAULT_ROOT="$default_root" run_case
	assert_eq 0 "$status" 'home fallback succeeds' || return
	[[ -x "$case_home/.local/bin/paprika" ]] || { fail 'home fallback not created'; return 1; }
	assert_contains "$case_output" "Add $case_home/.local/bin to your PATH:" 'fallback PATH heading' || return
	assert_contains "$case_output" "export PATH=\"$case_home/.local/bin:\$PATH\"" 'fallback exact PATH command' || return
	pass 'default destination considers PATH candidates in priority order and falls back safely'
}

test_missing_tools() {
	local tool
	for tool in curl tar gzip mktemp mv chmod; do
		new_case "missing-tool-$tool"; seed_destination; rm "$case_bin/$tool"
		PAPRIKA_VERSION=v0.1.0 run_case
		[[ "$status" -ne 0 ]] || { fail "missing $tool must fail"; return 1; }
		assert_preserved "missing $tool does not mutate destination" || return
		assert_eq 0 "$(wc -l <"$case_curl_log" | tr -d ' ')" "missing $tool fails before download" || return
		assert_contains "$case_output" "paprika installer: required tool not found: $tool" "missing $tool prints concise preflight error" || return
	done
	new_case missing-hash-tools; seed_destination; rm -f "$case_bin/sha256sum" "$case_bin/shasum"
	PAPRIKA_VERSION=v0.1.0 run_case
	[[ "$status" -ne 0 ]] || { fail 'missing checksum tools must fail'; return 1; }
	assert_preserved 'missing checksum tools do not mutate destination' || return
	assert_eq 0 "$(wc -l <"$case_curl_log" | tr -d ' ')" 'missing checksum tools fail before download' || return
	pass 'missing required tools fail before downloads and destination mutation'
}

test_http_failures_and_redaction() {
	new_case latest-http-failure; seed_destination
	unset PAPRIKA_VERSION
	CURL_MODE=latest_fail run_case
	[[ "$status" -ne 0 ]] || { fail 'latest HTTP failure must fail'; return 1; }
	assert_preserved 'latest HTTP failure preserves destination' || return
	if grep -Ev '^https://github\.com/paprikacd/paprika/releases/(latest|download/)' "$case_curl_log" | grep -q .; then
		fail 'installer attempted noncanonical or insecure URL'; return
	fi

	new_case downloaded-content-redaction; seed_destination
	PAPRIKA_VERSION=v0.1.0 CURL_MODE=malicious_body PAPRIKA_SUPER_SECRET='do-not-print-this-secret' run_case
	[[ "$status" -ne 0 ]] || { fail 'malicious downloaded checksum body must fail'; return 1; }
	assert_preserved 'malicious downloaded body preserves destination' || return
	assert_contains "$case_curl_log" '/checksums.txt' 'redaction failure occurs after checksum body download' || return
	assert_contains "$case_curl_log" '/paprika_0.1.0_darwin_amd64.tar.gz' 'redaction failure occurs after archive download' || return
	assert_not_contains "$case_output" 'do-not-print-this-secret' 'errors redact forwarded secret environment values' || return
	assert_not_contains "$case_output" 'MALICIOUS_DOWNLOADED_MARKER' 'errors hide malicious downloaded content' || return
	assert_clean 'malicious downloaded body failure cleans temporary files' || return
	pass 'HTTP failures stay HTTPS and post-download errors redact secrets and remote content'
}

fail_fast_fixture() {
	: >"$1"
	false
	: >"$2"
}

test_harness_fail_fast() {
	local before="$test_root/fail-fast-before" after="$test_root/fail-fast-after" fixture_status
	set +e
	(
		set -e
		fail_fast_fixture "$before" "$after"
	)
	fixture_status=$?
	set -e
	[[ "$fixture_status" -ne 0 ]] || fail 'intentional failing fixture unexpectedly succeeded'
	[[ -e "$before" ]] || fail 'intentional failing fixture did not start'
	[[ ! -e "$after" ]] || fail 'test runner continued after the intentional fixture failure'
	pass 'test subshells retain errexit and stop at their first unhandled failure'
}

run_test() {
	local test_name="$1" test_status
	set +e
	(
		set -e
		"$test_name"
	)
	test_status=$?
	set -e
	if [[ "$test_status" -eq 0 ]]; then
		passes=$((passes + 1))
	else
		printf 'not ok - test group %s failed\n' "$test_name" >&2
		failures=$((failures + 1))
	fi
}

if [[ ! -f "$installer" ]]; then
	printf 'installer test prerequisite missing: %s\n' "$installer" >&2
	exit 1
fi

test_groups=(
	test_harness_fail_fast
	test_explicit_versions
	test_latest_resolution
	test_platform_mappings
	test_versions_rejected_before_download
	test_checksum_failures
	test_archive_failures
	test_failure_atomicity
	test_private_temps_and_success_replace
	test_environment_option_hardening
	test_nonregular_destinations
	test_destination_selection
	test_hash_backends
	test_missing_tools
	test_http_failures_and_redaction
	test_early_cleanup_trap
)
if [[ -n ${PAPRIKA_INSTALLER_TEST_GROUP-} ]]; then
	case " ${test_groups[*]} " in
		*" $PAPRIKA_INSTALLER_TEST_GROUP "*) test_groups=("$PAPRIKA_INSTALLER_TEST_GROUP") ;;
		*) printf 'unknown installer test group: %s\n' "$PAPRIKA_INSTALLER_TEST_GROUP" >&2; exit 2 ;;
	esac
fi
for test_group in "${test_groups[@]}"; do
	run_test "$test_group"
done
printf '%s passed; %s failed\n' "$passes" "$failures"
[[ "$failures" -eq 0 ]]
