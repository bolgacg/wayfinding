#!/usr/bin/env python3
"""Pull the walkable network around DTU Lyngby from OpenStreetMap and turn it
into a small routing graph the page can carry.

Overpass is queried once and the raw answer cached, so the page is reproducible
without hammering a public service. The output is data/graph.json: nodes with
coordinates, edges with length and the road type they came from, plus the named
and numbered buildings that make the destinations recognisable.

Usage:
    python3 study/fetch_graph.py          # uses the cache if present
    python3 study/fetch_graph.py --refresh
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# The campus and the walk in from Lyngby station, which is the trip a person
# arriving by train actually makes.
BBOX = (55.766, 12.500, 55.794, 12.534)  # south, west, north, east

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

WALKABLE = (
    "footway|path|pedestrian|steps|living_street|residential|service|"
    "unclassified|tertiary|secondary|cycleway|track|corridor"
)

QUERY = f"""
[out:json][timeout:180];
(
  way["highway"~"^({WALKABLE})$"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out body geom;
"""

BUILDINGS = f"""
[out:json][timeout:180];
(
  way["building"]["name"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  way["building"]["ref"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out center tags;
"""


def ask(query: str, cache: Path, refresh: bool) -> dict:
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())
    last = None
    for ep in ENDPOINTS:
        try:
            req = urllib.request.Request(
                ep,
                data=urllib.parse.urlencode({"data": query}).encode(),
                headers={"User-Agent": "wayfinding study (github.com/bolgacg/wayfinding)"},
            )
            with urllib.request.urlopen(req, timeout=240) as r:
                payload = json.load(r)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(payload))
            print(f"  fetched from {ep.split('//')[1].split('/')[0]}")
            return payload
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  {ep.split('//')[1].split('/')[0]} failed: {type(exc).__name__}")
            last = exc
            time.sleep(4)
    raise SystemExit(f"every Overpass endpoint failed: {last}")


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance on the ground, good enough over a campus."""
    lat = math.radians((a[0] + b[0]) / 2)
    dx = (b[1] - a[1]) * 111320 * math.cos(lat)
    dy = (b[0] - a[0]) * 110540
    return math.hypot(dx, dy)


def main() -> int:
    refresh = "--refresh" in sys.argv
    DATA.mkdir(parents=True, exist_ok=True)

    print("walkable ways:")
    ways = ask(QUERY, DATA / "overpass_ways.json", refresh)
    print("buildings:")
    bld = ask(BUILDINGS, DATA / "overpass_buildings.json", refresh)

    # "out body geom" hands back each way with its node ids and the matching
    # coordinates inline, which is far lighter on the public server than asking
    # it to recurse down to every node.
    coords: dict[int, tuple[float, float]] = {}
    for el in ways["elements"]:
        if el["type"] != "way":
            continue
        for nid, pt in zip(el.get("nodes", []), el.get("geometry", []) or []):
            if pt:
                coords[nid] = (pt["lat"], pt["lon"])

    # How many ways touch each node. A node used by two or more ways, or an end
    # of a way, is a junction; everything between junctions is geometry and gets
    # collapsed into one edge.
    use: dict[int, int] = {}
    lines: list[tuple[list[int], dict]] = []
    for el in ways["elements"]:
        if el["type"] != "way":
            continue
        nds = [n for n in el.get("nodes", []) if n in coords]
        if len(nds) < 2:
            continue
        lines.append((nds, el.get("tags", {})))
        for n in nds:
            use[n] = use.get(n, 0) + 1
        use[nds[0]] = use.get(nds[0], 0) + 2
        use[nds[-1]] = use.get(nds[-1], 0) + 2

    junction = {n for n, c in use.items() if c >= 3}
    edges: list[dict] = []
    for nds, tags in lines:
        highway = tags.get("highway", "path")
        start = 0
        for i in range(1, len(nds)):
            if nds[i] in junction or i == len(nds) - 1:
                seg = nds[start : i + 1]
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    length = sum(metres(coords[seg[k]], coords[seg[k + 1]]) for k in range(len(seg) - 1))
                    if length > 0:
                        edges.append({
                            "a": seg[0],
                            "b": seg[-1],
                            "m": round(length, 1),
                            "hw": highway,
                            "geom": [[round(coords[n][0], 6), round(coords[n][1], 6)] for n in seg],
                            "lit": tags.get("lit"),
                            "surface": tags.get("surface"),
                            "indoor": tags.get("indoor"),
                            "name": tags.get("name"),
                        })
                start = i

    used_nodes = {e["a"] for e in edges} | {e["b"] for e in edges}
    nodes = {str(n): [round(coords[n][0], 6), round(coords[n][1], 6)] for n in used_nodes}

    buildings = []
    for el in bld["elements"]:
        c = el.get("center")
        t = el.get("tags", {})
        if not c:
            continue
        buildings.append({
            "id": el["id"],
            "lat": round(c["lat"], 6),
            "lon": round(c["lon"], 6),
            "name": t.get("name"),
            "ref": t.get("ref"),
        })

    out = {
        "bbox": BBOX,
        "source": "OpenStreetMap contributors, via Overpass",
        "licence": "ODbL 1.0",
        "nodes": nodes,
        "edges": edges,
        "buildings": buildings,
    }
    (DATA / "graph.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"\nnodes {len(nodes)}, edges {len(edges)}, buildings {len(buildings)}")
    print(f"wrote data/graph.json ({(DATA / 'graph.json').stat().st_size // 1024} KB)")
    named = [b for b in buildings if b.get("ref")]
    print(f"buildings carrying a number: {len(named)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
