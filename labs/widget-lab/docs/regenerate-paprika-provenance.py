#!/usr/bin/env python3
"""Rebuild the lab's exact upstream-to-local renderer patch and file hashes.

This only reads the upstream Git repository. It writes the local patch and
PROVENANCE.json, or checks them without writing when --check is supplied.
"""

import argparse
from collections import Counter
import difflib
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "src/vendor/paprika"
MANIFEST = VENDOR / "PROVENANCE.json"
PATCH = ROOT / "docs/paprika-reference-renderer.patch"
ATTRIBUTION = (
    "LICENSE",
    "DESIGN.md",
    "docs/design/insights/UX-CONTRACT.md",
    "docs/design/insights/gamma-source-catalogue.json",
    "ui/src/features/insights/gamma/README.md",
)


def digest(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def run_git(upstream: Path, *arguments: str, check: bool = True):
    return subprocess.run(
        ["git", "-C", str(upstream), *arguments],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check,
    )


def source_blob(upstream: Path, commit: str, path: str):
    exists = run_git(upstream, "cat-file", "-e", f"{commit}:{path}", check=False)
    if exists.returncode:
        return None
    return run_git(upstream, "show", f"{commit}:{path}").stdout


def safe_path(path: str) -> str:
    parsed = PurePosixPath(path)
    if parsed.is_absolute() or ".." in parsed.parts:
        raise ValueError(f"Unexpected provenance path: {path}")
    return parsed.as_posix()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True,
                        help="A local Paprika clone containing the recorded base commit.")
    parser.add_argument("--check", action="store_true",
                        help="Report stale patch/provenance without writing files.")
    args = parser.parse_args()
    original = json.loads(MANIFEST.read_text())
    commit = original["commit"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("The upstream base must be an exact 40-character Git commit.")
    run_git(args.upstream, "rev-parse", "--verify", f"{commit}^{{commit}}")

    paths = {safe_path(entry["path"]) for entry in original["files"]}
    paths.update(path.relative_to(VENDOR).as_posix() for path in VENDOR.rglob("*")
                 if path.is_file() and path != MANIFEST)
    files, patch_sections = [], []
    external_imports = set()
    for path in sorted(paths):
        base = source_blob(args.upstream, commit, path)
        local_path = VENDOR / path
        local = local_path.read_bytes() if local_path.is_file() else None
        if base is None and local is None:
            continue
        status = "added" if base is None else "deleted" if local is None else "unchanged" if base == local else "modified"
        files.append({
            "path": path,
            "status": status,
            "upstream_sha256": digest(base) if base is not None else None,
            "local_sha256": digest(local) if local is not None else None,
            # Retain the original manifest key, now explicitly the local file.
            "sha256": digest(local) if local is not None else None,
        })
        if path in ATTRIBUTION and status != "unchanged":
            raise ValueError(f"Preserved license/attribution file differs: {path}")
        if local is not None and local_path.suffix in {".ts", ".tsx"}:
            imports = re.findall(r'(?:from\s*|import\s*)[\'"]([^\'"]+)[\'"]', local.decode())
            external_imports.update(item for item in imports if not item.startswith((".", "/")))
        if status == "unchanged":
            continue
        relative = f"src/vendor/paprika/{path}"
        section = [f"diff --git a/{relative} b/{relative}\n"]
        if status == "added":
            section.append("new file mode 100644\n")
        elif status == "deleted":
            section.append("deleted file mode 100644\n")
        section.extend(difflib.unified_diff(
            (base or b"").decode().splitlines(keepends=True),
            (local or b"").decode().splitlines(keepends=True),
            fromfile=f"a/{relative}" if base is not None else "/dev/null",
            tofile=f"b/{relative}" if local is not None else "/dev/null",
        ))
        patch_sections.extend(section)

    patch_bytes = "".join(patch_sections).encode()
    package = json.loads((ROOT / "package.json").read_text())
    manifest = {
        "repository": original["repository"],
        "commit": commit,
        "retrieved": original["retrieved"],
        "license_file": original["license_file"],
        "modifications": "Local reference-renderer owner patch. Original base is retained per file; the copied renderer is not byte-for-byte unchanged. No upstream/production repository files are modified by this lab.",
        "scope": original["scope"],
        "upstream_gamma_provenance": original["upstream_gamma_provenance"],
        "preserved_license_and_attribution": list(ATTRIBUTION),
        "local_extensions": [
            "Opt-in gridX and calendar X scale with Date render channels; numeric exact timestamps remain unchanged.",
            "Opt-in axisUnit caption, signed zero-anchored gradient fill, showZeroLine and labelled referenceLines.",
            "Rich same-time observation inspector with exact UTC timestamps, bounded gap-preserving histories, source-population statistics and accessible details.",
            "Shared local time-window state, timestamp-preserving filtering and horizontal pointer brushing, with exact UTC range inputs, Undo and Reset.",
            "Shared focus-ring and tick-label presentation refinements; svgAnimation remains disabled.",
            "Optional registry-owned validateInput(result, config) and intrinsic/fill layout metadata for loaded-data editor acceptance and compound chart hosts.",
            "Optional config-field binding metadata declares accepted source types, units, semantic roles and explicit unbound values for the shared editor.",
            "Host-owned WidgetLoadingProvider supplies presentation-only initial and refresh states without changing Widget or QueryResult. Retained empty results also show refresh status.",
            "Shared ObservationTooltip and WidgetTooltipProvider own pointer/focus anchoring, viewport collision and bounded scrolling across canonical and lab chart families, with strict common tooltip placement and size options.",
        ],
        "patch": {
            "path": "docs/paprika-reference-renderer.patch",
            "sha256": digest(patch_bytes),
            "path_root": "lab project root",
            "generator": "docs/regenerate-paprika-provenance.py",
            "basis": "Exact blobs at the recorded upstream commit, compared with the current copied files.",
        },
        "hash_algorithm": "SHA-256",
        "sha256_field_meaning": "Current local file hash; upstream_sha256 preserves the pinned base hash. Added files have a null upstream_sha256.",
        "file_status_counts": dict(sorted(Counter(item["status"] for item in files).items())),
        "declared_runtime_dependencies": package["dependencies"],
        "local_dependency_additions": {
            "d3-scale": package["dependencies"]["d3-scale"],
            "@types/d3-scale": package["devDependencies"]["@types/d3-scale"],
        },
        "package_lock_sha256": digest((ROOT / "package-lock.json").read_bytes()),
        "external_imports": sorted(external_imports),
        "files": files,
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode()
    expected = ((PATCH, patch_bytes), (MANIFEST, manifest_bytes))
    stale = [str(path.relative_to(ROOT)) for path, contents in expected
             if not path.exists() or path.read_bytes() != contents]
    if args.check:
        if stale:
            print("Stale provenance: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"Provenance current: {len(files)} files; patch SHA-256 {digest(patch_bytes)}")
        return 0
    for path, contents in expected:
        path.write_bytes(contents)
    print(f"Regenerated {PATCH.relative_to(ROOT)} and {MANIFEST.relative_to(ROOT)}")
    print(json.dumps(manifest["file_status_counts"], sort_keys=True))
    print(f"Patch SHA-256: {digest(patch_bytes)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
