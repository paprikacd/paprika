#!/bin/sh

set -uf

PROGRAM=paprika
GITHUB_BASE=https://github.com/paprikacd/paprika
LATEST_URL=$GITHUB_BASE/releases/latest
LOGIN_COMMAND='paprika login --server https://paprika.benebsworth.com'
work_dir=
destination_tmp=
path_note=0

die() {
	printf 'paprika installer: %s\n' "$1" >&2
	exit 1
}

cleanup() {
	[ -z "$destination_tmp" ] || rm -f "$destination_tmp" >/dev/null 2>&1 || :
	[ -z "$work_dir" ] || rm -rf "$work_dir" >/dev/null 2>&1 || :
}

interrupted() {
	trap - HUP INT TERM
	cleanup
	printf 'paprika installer: interrupted\n' >&2
	exit 130
}

require_tool() {
	command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

path_contains_dir() {
	case ":${PATH-}:" in
		*:"$1":*) return 0 ;;
		*) return 1 ;;
	esac
}

is_digits() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
		*) return 0 ;;
	esac
}

is_semver_number() {
	is_digits "$1" || return 1
	case "$1" in
		0|[1-9]*) return 0 ;;
		*) return 1 ;;
	esac
}

validate_version() {
	version_input=$1
	[ -n "$version_input" ] || return 1
	case "$version_input" in
		v*) version_value=${version_input#v} ;;
		*) version_value=$version_input ;;
	esac
	[ -n "$version_value" ] || return 1
	case "$version_value" in *[!0-9.]*|.*|*.) return 1 ;; esac
	major=${version_value%%.*}
	version_remainder=${version_value#*.}
	[ "$version_remainder" != "$version_value" ] || return 1
	minor=${version_remainder%%.*}
	patch=${version_remainder#*.}
	[ "$patch" != "$version_remainder" ] || return 1
	is_semver_number "$major" &&
		is_semver_number "$minor" &&
		is_semver_number "$patch" || return 1
	VERSION=$version_value
	TAG=v$version_value
	return 0
}

for required_tool in curl tar gzip mktemp mv chmod cp mkdir rm tr uname; do
	require_tool "$required_tool"
done

if command -v sha256sum >/dev/null 2>&1; then
	checksum_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
	checksum_tool=shasum
else
	die 'required checksum tool not found: sha256sum or shasum'
fi

explicit_version=0
if [ "${PAPRIKA_VERSION+x}" = x ]; then
	explicit_version=1
	validate_version "$PAPRIKA_VERSION" ||
		die 'PAPRIKA_VERSION must be v?X.Y.Z'
fi

system_name=$(uname -s 2>/dev/null) || die 'could not detect operating system'
case "$system_name" in
	Darwin) target_os=darwin ;;
	Linux) target_os=linux ;;
	*) die "unsupported operating system: $system_name" ;;
esac
machine_name=$(uname -m 2>/dev/null) || die 'could not detect architecture'
case "$machine_name" in
	x86_64|amd64) target_arch=amd64 ;;
	arm64|aarch64) target_arch=arm64 ;;
	*) die "unsupported architecture: $machine_name" ;;
esac

umask 077
temp_parent=${TMPDIR:-/tmp}
work_dir=$(mktemp -d "$temp_parent/paprika-install.XXXXXX" 2>/dev/null) ||
	die 'could not create private temporary directory'
trap cleanup 0
trap interrupted HUP INT TERM
chmod 0700 "$work_dir" 2>/dev/null || die 'could not secure temporary directory'
extract_dir=$work_dir/extract
mkdir "$extract_dir" 2>/dev/null || die 'could not create extraction directory'
chmod 0700 "$extract_dir" 2>/dev/null || die 'could not secure extraction directory'

if [ "$explicit_version" -eq 0 ]; then
	if ! effective_url=$(curl -q --proto '=https' --proto-redir '=https' -f -s -S -L -o /dev/null -w '%{url_effective}' "$LATEST_URL" 2>/dev/null); then
		die 'could not resolve the latest Paprika release'
	fi
	tag_prefix=$GITHUB_BASE/releases/tag/
	case "$effective_url" in
		"$tag_prefix"*) latest_tag=${effective_url#"$tag_prefix"} ;;
		*) die 'latest release redirected outside the canonical GitHub release path' ;;
	esac
	case "$latest_tag" in */*) die 'latest release returned an invalid tag' ;; esac
	validate_version "$latest_tag" || die 'latest release returned an invalid tag'
fi

asset=paprika_${VERSION}_${target_os}_${target_arch}.tar.gz
download_base=$GITHUB_BASE/releases/download/$TAG
checksums_file=$work_dir/checksums.txt
archive_file=$work_dir/$asset
curl -q --proto '=https' --proto-redir '=https' -f -s -S -L -o "$checksums_file" "$download_base/checksums.txt" 2>/dev/null ||
	die 'could not download release checksums'
curl -q --proto '=https' --proto-redir '=https' -f -s -S -L -o "$archive_file" "$download_base/$asset" 2>/dev/null ||
	die 'could not download the Paprika archive'

checksum_count=0
expected_checksum=
checksum_file_valid=1
while IFS= read -r checksum_line || [ -n "$checksum_line" ]; do
	case "$checksum_line" in
		*"  "*)
			checksum_value=${checksum_line%%  *}
			checksum_name=${checksum_line#*  }
			;;
		*)
			checksum_file_valid=0
			continue
			;;
	esac
	if [ "$checksum_line" != "$checksum_value  $checksum_name" ]; then
		checksum_file_valid=0
		continue
	fi
	if [ "${#checksum_value}" -ne 64 ]; then
		checksum_file_valid=0
		continue
	fi
	case "$checksum_value" in *[!0-9A-Fa-f]*) checksum_file_valid=0; continue ;; esac
	case "$checksum_name" in ''|*[!0-9A-Za-z._-]*) checksum_file_valid=0; continue ;; esac
	if [ "$checksum_name" = "$asset" ]; then
		checksum_count=$((checksum_count + 1))
		expected_checksum=$checksum_value
	fi
done <"$checksums_file"
[ "$checksum_file_valid" -eq 1 ] || die 'release checksum file is malformed'
[ "$checksum_count" -eq 1 ] || die 'release checksum entry is missing or duplicated'

if [ "$checksum_tool" = sha256sum ]; then
	actual_output=$(sha256sum "$archive_file" 2>/dev/null) ||
		die 'could not calculate archive checksum'
else
	actual_output=$(shasum -a 256 "$archive_file" 2>/dev/null) ||
		die 'could not calculate archive checksum'
fi
actual_checksum=${actual_output%% *}
[ "${#actual_checksum}" -eq 64 ] || die 'checksum tool returned an invalid result'
case "$actual_checksum" in *[!0-9A-Fa-f]*) die 'checksum tool returned an invalid result' ;; esac
expected_checksum=$(printf '%s' "$expected_checksum" | tr 'A-F' 'a-f')
actual_checksum=$(printf '%s' "$actual_checksum" | tr 'A-F' 'a-f')
[ "$actual_checksum" = "$expected_checksum" ] || die 'archive checksum verification failed'

entries_file=$work_dir/archive-entries
COPYFILE_DISABLE=1 TAR_OPTIONS='' tar -tzf "$archive_file" >"$entries_file" 2>/dev/null ||
	die 'could not inspect the Paprika archive'
entry_count=0
archive_names_valid=1
while IFS= read -r archive_entry || [ -n "$archive_entry" ]; do
	entry_count=$((entry_count + 1))
	[ "$archive_entry" = paprika ] || archive_names_valid=0
done <"$entries_file"
[ "$archive_names_valid" -eq 1 ] && [ "$entry_count" -eq 1 ] ||
	die 'archive must contain exactly one root paprika file'

verbose_file=$work_dir/archive-verbose
COPYFILE_DISABLE=1 TAR_OPTIONS='' tar -tvzf "$archive_file" >"$verbose_file" 2>/dev/null ||
	die 'could not inspect the Paprika archive type'
verbose_count=0
regular_entry=1
while IFS= read -r verbose_line || [ -n "$verbose_line" ]; do
	verbose_count=$((verbose_count + 1))
	entry_type=${verbose_line%"${verbose_line#?}"}
	[ "$entry_type" = - ] || regular_entry=0
done <"$verbose_file"
[ "$regular_entry" -eq 1 ] && [ "$verbose_count" -eq 1 ] ||
	die 'archive paprika entry must be a regular file'

COPYFILE_DISABLE=1 TAR_OPTIONS='' tar -xzf "$archive_file" -C "$extract_dir" >/dev/null 2>&1 ||
	die 'could not extract the Paprika archive'
[ -f "$extract_dir/paprika" ] && [ ! -L "$extract_dir/paprika" ] ||
	die 'extracted paprika entry is not a regular file'

if [ -n "${PAPRIKA_INSTALL_DIR:-}" ]; then
	install_dir=$PAPRIKA_INSTALL_DIR
else
	test_root=${PAPRIKA_TEST_DEFAULT_ROOT:-}
	if [ -n "$test_root" ]; then
		case "$test_root" in /*) ;; *) die 'PAPRIKA_TEST_DEFAULT_ROOT must be absolute' ;; esac
		homebrew_dir=$test_root/opt/homebrew/bin
		local_dir=$test_root/usr/local/bin
	else
		homebrew_dir=/opt/homebrew/bin
		local_dir=/usr/local/bin
	fi
	user_dir=${HOME:?HOME must be set}/.local/bin
	install_dir=
	for candidate_dir in "$homebrew_dir" "$local_dir" "$user_dir"; do
		if [ -d "$candidate_dir" ] && [ -w "$candidate_dir" ] && path_contains_dir "$candidate_dir"; then
			install_dir=$candidate_dir
			break
		fi
	done
	if [ -z "$install_dir" ]; then
		install_dir=$user_dir
		path_note=1
	fi
fi

if [ ! -d "$install_dir" ]; then
	mkdir -p "$install_dir" 2>/dev/null || die 'could not create the installation directory'
fi
[ -w "$install_dir" ] || die 'installation directory is not writable'
destination=$install_dir/$PROGRAM
if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
	die 'installation destination exists and is not a regular file'
fi
destination_tmp=$(mktemp "$install_dir/.paprika.install.XXXXXX" 2>/dev/null) ||
	die 'could not create destination-local temporary file'
COPYFILE_DISABLE=1 cp "$extract_dir/paprika" "$destination_tmp" 2>/dev/null ||
	die 'could not copy paprika into the installation directory'
chmod 0755 "$destination_tmp" 2>/dev/null ||
	die 'could not make the installed binary executable'
mv -f "$destination_tmp" "$destination" 2>/dev/null ||
	die 'could not atomically replace the installed binary'
destination_tmp=

printf 'Installed paprika %s to %s\n' "$TAG" "$destination"
if [ "$path_note" -eq 1 ]; then
	printf 'Add %s to your PATH:\n' "$install_dir"
	printf '  export PATH="%s:%s"\n' "$install_dir" "\$PATH"
fi
printf 'Next step:\n'
printf '%s\n' "$LOGIN_COMMAND"
