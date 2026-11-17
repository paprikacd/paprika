#!/usr/bin/env python3
"""Check the demo's fixed sample points against pinned Natural Earth land.

Pass a downloaded, unmodified ne_50m_land.geojson. This independent audit uses
only the Python standard library and never contacts a network or cluster.
"""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

SHA256 = "e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b"
CENTERS = {
    "Melbourne": (-37.81, 144.96), "Singapore": (1.35, 103.82),
    "Tokyo": (35.68, 139.69), "Sydney": (-33.87, 151.21),
    "Frankfurt": (50.11, 8.68), "London": (51.50, -.12),
    "Paris": (48.86, 2.35), "Virginia": (37.43, -78.65),
    "San Francisco": (37.77, -122.42), "Toronto": (43.65, -79.38),
    "São Paulo": (-23.55, -46.63), "Cape Town": (-33.92, 18.42),
}


def inside_ring(x, y, ring):
    inside = False
    x1, y1 = ring[-1][:2]
    for point in ring:
        x2, y2 = point[:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        x1, y1 = x2, y2
    return inside


def polygons(document):
    for feature in document["features"]:
        geometry = feature["geometry"]
        raw = geometry["coordinates"]
        if geometry["type"] == "Polygon": raw = [raw]
        elif geometry["type"] != "MultiPolygon": raise ValueError("Unexpected land geometry")
        for poly in raw:
            xs, ys = zip(*(point[:2] for point in poly[0]))
            yield min(xs), min(ys), max(xs), max(ys), poly


def on_land(x, y, land):
    return any(left <= x <= right and bottom <= y <= top and inside_ring(x, y, poly[0]) and
               not any(inside_ring(x, y, hole) for hole in poly[1:])
               for left, bottom, right, top, poly in land)


def main():
    if len(sys.argv) != 2: raise SystemExit("Usage: python3 verify-geography-land.py ne_50m_land.geojson")
    raw = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256: raise SystemExit("Natural Earth file does not match the pinned digest")
    land = list(polygons(json.loads(raw)))
    source = (Path(__file__).parent / "seed.sql").read_text(encoding="utf-8")
    section = source.split("WITH coordinates(city_index,city,sample_index,latitude,longitude) AS (VALUES", 1)[1].split("\n)\nSELECT cluster", 1)[0]
    pattern = r"\((\d+),'([^']+)',(\d+),(-?\d+\.\d+)::double precision,(-?\d+\.\d+)::double precision\)"
    observations = re.findall(pattern, section)
    if len(observations) != len(CENTERS) * 24: raise SystemExit(f"Expected 288 fixed coordinates; found {len(observations)}")
    seen = set()
    for index, city, sample, lat, lon in observations:
        sample, lat, lon = int(sample), float(lat), float(lon)
        if city not in CENTERS or not 1 <= sample <= 24 or (city, sample) in seen: raise SystemExit(f"Invalid or duplicate sample {city}/{sample}")
        seen.add((city, sample))
        center_lat, center_lon = CENTERS[city]
        distance = math.hypot(lat - center_lat, lon - center_lon)
        if distance > (0.18 if sample <= 8 else 2.2): raise SystemExit(f"{city}/{sample} is outside its labelled region")
        if not on_land(lon, lat, land): raise SystemExit(f"{city}/{sample} is outside the simplified land polygons")
    section = source.split("WITH global_coordinates(sample_index,latitude,longitude) AS (VALUES", 1)[1].split("\n)\nSELECT cluster", 1)[0]
    global_points = re.findall(r"\((\d+),(-?\d+\.\d+)::double precision,(-?\d+\.\d+)::double precision\)", section)
    if len(global_points) != 144: raise SystemExit(f"Expected 144 globally distributed coordinates; found {len(global_points)}")
    coordinates = set()
    for sample, lat, lon in global_points:
        lat, lon = float(lat), float(lon)
        if (lat, lon) in coordinates or not on_land(lon, lat, land): raise SystemExit(f"Global sample {sample} is duplicate or outside land")
        coordinates.add((lat, lon))
    if len({int((lon + 180) // 30) for lat, lon in coordinates}) < 8: raise SystemExit("Global samples are insufficiently distributed in longitude")
    print(f"PASS {len(observations)} fixed coordinates near named centers and {len(global_points)} distributed samples on Natural Earth 1:50m land")


if __name__ == "__main__": main()
