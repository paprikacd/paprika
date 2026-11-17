#!/usr/bin/env python3
"""Export the committed Widget Lab source into this repository, with hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "labs" / "widget-lab"
MANIFEST = ROOT / "labs" / "widget-lab-export.json"
EXCLUDED_PREFIXES = (".openai/", ".sites/", "node_modules/", "dist/", "coverage/")


def git(source: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", "-C", str(source), *arguments]).decode()


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Widget Lab checkout")
    parser.add_argument("--check", action="store_true", help="Verify without writing")
    parser.add_argument("--allow-dirty", action="store_true", help="Prepare an explicitly uncommitted checkpoint")
    args = parser.parse_args()
    source = args.source.resolve()
    if source == DESTINATION or source in DESTINATION.parents:
        parser.error("source must be the separate Widget Lab checkout")

    dirty = bool(git(source, "status", "--porcelain").strip())
    if dirty and not args.allow_dirty:
        parser.error("commit the Widget Lab source first, or use --allow-dirty for preparation only")
    names = set(git(source, "ls-files", "-z").split("\0")) - {""}
    if args.allow_dirty:
        names.update(set(git(source, "ls-files", "--others", "--exclude-standard", "-z").split("\0")) - {""})

    files: dict[str, dict[str, str | int]] = {}
    contents: dict[str, bytes] = {}
    excluded: list[str] = []
    for name in sorted(names):
        if name.startswith(EXCLUDED_PREFIXES):
            excluded.append(name)
            continue
        path = source / name
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(source):
            parser.error(f"expected an ordinary source file: {name}")
        content = path.read_bytes()
        contents[name] = content
        files[name] = {"sha256": digest(content), "bytes": len(content), "mode": "100755" if path.stat().st_mode & 0o111 else "100644"}

    manifest = {
        "project": "paprika-widget-lab",
        "source_commit": git(source, "rev-parse", "HEAD").strip(),
        "source_dirty": dirty,
        "destination": "labs/widget-lab",
        "excluded_paths": excluded,
        "files": files,
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"files": {}}
    stale = set(previous["files"]) - set(files)
    discrepancies = [name for name, content in contents.items() if not (DESTINATION / name).is_file() or (DESTINATION / name).read_bytes() != content]
    discrepancies.extend(name for name in stale if (DESTINATION / name).exists())
    manifest_matches = MANIFEST.exists() and MANIFEST.read_bytes() == manifest_bytes
    if args.check:
        if discrepancies or not manifest_matches:
            print(json.dumps({"matches": False, "different_files": discrepancies, "manifest_matches": manifest_matches}))
            return 1
        print(f"Export matches {manifest['source_commit']}: {len(files)} files, {sum(item['bytes'] for item in files.values())} bytes.")
        return 0

    # Refuse to overwrite edits made independently in the exported copy.
    for name in set(files) | stale:
        target = DESTINATION / name
        if not target.exists():
            continue
        existing_hash = digest(target.read_bytes())
        old_hash = previous["files"].get(name, {}).get("sha256")
        new_hash = files.get(name, {}).get("sha256")
        if existing_hash not in (old_hash, new_hash):
            parser.error(f"destination has an independent edit: {name}")
    for name, content in contents.items():
        target = DESTINATION / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(0o755 if files[name]["mode"] == "100755" else 0o644)
    for name in stale:
        target = DESTINATION / name
        if target.is_file():
            target.unlink()
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_bytes(manifest_bytes)
    print(f"Exported {len(files)} files ({sum(item['bytes'] for item in files.values())} bytes) from {manifest['source_commit']}; source_dirty={dirty}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
