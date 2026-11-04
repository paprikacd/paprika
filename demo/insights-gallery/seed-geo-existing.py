"""Add the synthetic geo observations to one existing local gallery stack.

This is additive and leaves a populated table untouched; it never resets data.
Pass the state directory printed by start.py, never a Kubernetes/remote host.
"""
import json
from pathlib import Path
import re
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 demo/insights-gallery/seed-geo-existing.py artifacts/insights/gallery-live-<id>")
state = Path(sys.argv[1]).resolve()
container = json.loads((state / "state.json").read_text())["names"]["postgres"]
if not re.fullmatch(r"paprika-gallery-postgres-[0-9a-f]{8}", container):
    raise SystemExit("Not an isolated local gallery postgres container")
source = (Path(__file__).parent / "seed.sql").read_text()
start = source.index("CREATE TABLE gallery.geo_events")
# Bound the migration to the geo section. Other sample tables after this
# section may already exist in an active local stack and must never be touched.
end = source.index("-- Documentation-only network addresses", start)
sql = source[start:end].replace("CREATE TABLE gallery.geo_events", "CREATE TABLE IF NOT EXISTS gallery.geo_events")
sql = sql.replace("WHERE sample_index = i\nUNION ALL", "WHERE sample_index = i AND NOT EXISTS (SELECT 1 FROM gallery.geo_events)\nUNION ALL")
sql = sql.replace("WHERE sample_index = i + 8;", "WHERE sample_index = i + 8 AND NOT EXISTS (SELECT 1 FROM gallery.geo_events);")
sql += "\nGRANT SELECT ON gallery.geo_events TO gallery_reader;\n"
subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "gallery_demo", "-v", "ON_ERROR_STOP=1"], input=sql, text=True, check=True)
