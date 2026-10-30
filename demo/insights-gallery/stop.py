#!/usr/bin/env python3
"""Stop only the resources created by an explicitly selected gallery run."""
import argparse
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("state_dir", type=Path)
parser.add_argument("--delete-data", action="store_true", help="Also delete this run's synthetic Prometheus volume")
args = parser.parse_args()
state = json.loads((args.state_dir / "state.json").read_text(encoding="utf-8"))
names = state["names"]
suffix = names["prometheus"].removeprefix("paprika-gallery-prometheus-")
if not re.fullmatch(r"[0-9a-f]{8}", suffix):
    raise SystemExit("Invalid gallery resource identity")
for kind in ("postgres", "prometheus", "tempo", "exporter"):
    if names.get(kind) != f"paprika-gallery-{kind}-{suffix}":
        raise SystemExit("Mismatched gallery resource identity")
if state.get("network") != f"paprika-gallery-network-{suffix}" or state.get("volume") != f"paprika-gallery-prometheus-{suffix}":
    raise SystemExit("Mismatched gallery network or volume")
for name in names.values():
    subprocess.run(["docker", "stop", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
subprocess.run(["docker", "network", "rm", state["network"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
if args.delete_data:
    subprocess.run(["docker", "volume", "rm", state["volume"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
print("Stopped selected gallery containers." + (" Synthetic Prometheus data removed." if args.delete_data else " Prometheus volume retained."))
