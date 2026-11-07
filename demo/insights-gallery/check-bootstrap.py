#!/usr/bin/env python3
"""Check a gallery stack's history-to-live join through real Prometheus."""
import argparse
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("state", type=Path)
args = parser.parse_args()
state = json.loads((args.state / "state.json").read_text())
endpoint = urllib.parse.urlparse(state["prometheus"])
if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.username or endpoint.password:
    raise SystemExit("Only an isolated loopback Prometheus is supported")


def query(path, **parameters):
    url = f"{state['prometheus']}/api/v1/{path}?{urllib.parse.urlencode(parameters)}"
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = json.load(response)
    if payload["status"] != "success":
        raise AssertionError(f"Prometheus query failed: {payload['status']}")
    data = payload["data"]
    return data["result"] if isinstance(data, dict) else data


needle = 'paprika_demo_pipeline_items_total{cluster="omega",pipeline="collect",signal="metrics"}'
last_backfill = None
keys = set()
with (args.state / "metrics.openmetrics").open() as stream:
    for line in stream:
        if not line.startswith("#") and line.strip():
            keys.add(line.rsplit(" ", 2)[0])
        if line.startswith(needle + " "):
            _, value, stamp = line.rsplit(" ", 2)
            last_backfill = (float(stamp), float(value))
assert last_backfill, "The backfill must contain the selected counter"
now = time.time()
inspection_end = min(now, last_backfill[0] + 600)
lookback = math.ceil(inspection_end - last_backfill[0]) + 120
raw = query("query", query=f"{needle}[{lookback}s]", time=inspection_end)
assert len(raw) == 1, "Scraped and backfilled series must retain one identity"
points = [(float(stamp), float(value)) for stamp, value in raw[0]["values"]]
joined = [point for point in points if point[0] >= last_backfill[0]]
assert len(joined) >= 3, "Expected backfill and multiple continuation scrapes"
assert joined[0] == last_backfill, "The original backfill sample must remain unchanged"
assert all(math.isfinite(value) and stamp <= now for stamp, value in joined), "No future or non-finite samples"
gaps = [b[0] - a[0] for a, b in zip(joined, joined[1:])]
assert all(0 < gap <= 65 for gap in gaps), f"Expected ordered, at-most-minute sample spacing: {gaps}"
assert all(b[1] >= a[1] for a, b in zip(joined, joined[1:])), "The counter must never reset"

def canonical(key):
    name, _, raw = key.partition("{")
    labels = re.findall(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"', raw)
    return (name, tuple(sorted((name, json.loads('"' + value + '"')) for name, value in labels)))

expected = {canonical(key) for key in keys}
live = query("series", **{"match[]": '{__name__=~"paprika_demo_.*"}', "start": now-120, "end": now})
actual = {(series["__name__"], tuple(sorted((name, value) for name, value in series.items() if name != "__name__"))) for series in live if series["__name__"] != "paprika_demo_bootstrap_complete"}
assert actual == expected, f"Live series differ from backfill: {len(expected - actual)} missing, {len(actual - expected)} extra"

rates = query("query_range", query=f"rate({needle}[5m])", start=last_backfill[0]-240, end=inspection_end, step=60)
assert len(rates) == 1
values = [float(value) for _, value in rates[0]["values"]]
assert len(values) >= 5 and all(math.isfinite(value) and value > 0 for value in values)
changes = [b / a for a, b in zip(values, values[1:])]
assert all(.65 <= change <= 1.45 for change in changes), f"Unexpected rate jump at history join: {changes}"
print(f"PASS synthetic history join: {len(joined)} ordered samples, max gap {max(gaps):.1f}s; {len(actual)} series retained; 5-minute rate remains continuous")
