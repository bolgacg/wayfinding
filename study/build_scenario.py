#!/usr/bin/env python3
"""Turn the campus graph into the experiment the page runs.

Picks two real named places on the DTU Lyngby campus, finds three genuinely
different walking routes between them, gives every path segment a true walking
time the participant cannot see, and writes the small slice of the map the page
needs.

The true time of a segment is its length divided by a walking speed that depends
on what kind of path it is, multiplied by a hidden friction drawn once from a
seeded distribution. The friction stands for everything a map does not tell you:
a door that sticks, a stretch that floods, a corridor full of people between
lectures. It is the thing a person can only learn by walking, which is the whole
subject of the experiment.

Writes data/scenario.json.
"""
from __future__ import annotations

import heapq
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SEED = 20260914
START_NAME = "DTU Science Park"
GOAL_NAME = "Demant Salen"

# Metres per second on foot, by what OpenStreetMap calls the path.
SPEED = {
    "steps": 0.55,
    "footway": 1.35,
    "path": 1.25,
    "pedestrian": 1.35,
    "corridor": 1.25,
    "living_street": 1.35,
    "residential": 1.35,
    "service": 1.30,
    "unclassified": 1.30,
    "tertiary": 1.30,
    "secondary": 1.25,
    "cycleway": 1.35,
    "track": 1.10,
}
DEFAULT_SPEED = 1.3


def metres(a, b):
    lat = math.radians((a[0] + b[0]) / 2)
    return math.hypot((b[1] - a[1]) * 111320 * math.cos(lat), (b[0] - a[0]) * 110540)


def load():
    return json.loads((DATA / "graph.json").read_text())


def nearest_node(nodes: dict, lat: float, lon: float) -> str:
    best, bd = None, 1e18
    for nid, (la, lo) in nodes.items():
        d = metres((la, lo), (lat, lon))
        if d < bd:
            best, bd = nid, d
    return best


def dijkstra(adj, src, dst, cost_of, blocked=frozenset()):
    dist = {src: 0.0}
    prev: dict[str, tuple[str, int]] = {}
    pq = [(0.0, src)]
    seen = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u == dst:
            break
        for v, ei in adj.get(u, ()):
            if ei in blocked:
                continue
            nd = d + cost_of(ei)
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = (u, ei)
                heapq.heappush(pq, (nd, v))
    if dst not in dist:
        return None, None
    path, node = [], dst
    while node != src:
        u, ei = prev[node]
        path.append(ei)
        node = u
    path.reverse()
    return path, dist[dst]


def main() -> int:
    g = load()
    nodes = {k: tuple(v) for k, v in g["nodes"].items()}
    edges = g["edges"]

    rng = random.Random(SEED)
    true_time = []
    for e in edges:
        sp = SPEED.get(e.get("hw"), DEFAULT_SPEED)
        friction = math.exp(rng.gauss(0.0, 0.16))  # median 1, mostly within 0.75 to 1.35
        true_time.append(round(e["m"] / sp * friction, 2))

    adj: dict[str, list[tuple[str, int]]] = {}
    for i, e in enumerate(edges):
        a, b = str(e["a"]), str(e["b"])
        if a not in nodes or b not in nodes:
            continue
        adj.setdefault(a, []).append((b, i))
        adj.setdefault(b, []).append((a, i))

    bl = {(x.get("name") or ""): x for x in g["buildings"]}
    start_b, goal_b = bl.get(START_NAME), bl.get(GOAL_NAME)
    if not start_b or not goal_b:
        raise SystemExit("the named endpoints are not in the building list")
    src = nearest_node(nodes, start_b["lat"], start_b["lon"])
    dst = nearest_node(nodes, goal_b["lat"], goal_b["lon"])
    print(f"start {START_NAME} -> node {src}, goal {GOAL_NAME} -> node {dst}")

    # Three routes that are actually different. The first is the quickest by the
    # true times; each next one is found again with the previous routes' middle
    # sections made expensive, so it has to go another way rather than shuffle a
    # few metres.
    routes = []
    penalty = {}

    def cost(ei):
        return true_time[ei] * penalty.get(ei, 1.0)

    for k in range(3):
        path, _ = dijkstra(adj, src, dst, cost)
        if not path:
            break
        t = round(sum(true_time[i] for i in path), 1)
        d = round(sum(edges[i]["m"] for i in path), 1)
        routes.append({"edges": path, "true_s": t, "m": d})
        core = path[len(path) // 6 : -max(1, len(path) // 6)] or path
        for ei in core:
            penalty[ei] = penalty.get(ei, 1.0) * 6.0

    if len(routes) < 3:
        raise SystemExit(f"only found {len(routes)} routes; widen the graph")

    # How different are they, in the share of length they do not share.
    for i, r in enumerate(routes):
        others = set()
        for j, o in enumerate(routes):
            if j != i:
                others |= set(o["edges"])
        uniq = sum(edges[e]["m"] for e in r["edges"] if e not in others)
        r["unique_share"] = round(uniq / r["m"], 3)
        print(f"  route {i + 1}: {r['m'] / 1000:.2f} km, true {r['true_s'] / 60:.1f} min, "
              f"{r['unique_share'] * 100:.0f}% of its length not shared")

    # The closure: the busiest segment of the quickest route, so the day it
    # appears the habit has to break.
    shared = [e for e in routes[0]["edges"] if all(e in r["edges"] for r in routes[1:])]
    candidates = [e for e in routes[0]["edges"] if e not in set(routes[1]["edges"]) | set(routes[2]["edges"])]
    closure = max(candidates or routes[0]["edges"], key=lambda e: edges[e]["m"])
    print(f"  closure on edge {closure} ({edges[closure]['m']} m, {edges[closure].get('hw')})")

    keep = sorted({e for r in routes for e in r["edges"]})
    idx = {e: i for i, e in enumerate(keep)}
    slim_edges = []
    for e in keep:
        src_e = edges[e]
        slim_edges.append({
            "m": src_e["m"],
            "hw": src_e.get("hw"),
            "geom": src_e["geom"],
            "true_s": true_time[e],
            "name": src_e.get("name"),
        })

    # The rest of the campus footpaths around the three routes, so the map shows
    # a real network rather than three lines in space. Only geometry is kept.
    pts = [p for r in routes for e in r["edges"] for p in edges[e]["geom"]]
    lat0 = min(p[0] for p in pts) - 0.0012
    lat1 = max(p[0] for p in pts) + 0.0012
    lon0 = min(p[1] for p in pts) - 0.0020
    lon1 = max(p[1] for p in pts) + 0.0020
    route_set = {e for r in routes for e in r["edges"]}
    context = []
    for i, e in enumerate(edges):
        if i in route_set:
            continue
        gm = e["geom"]
        if not all(lat0 <= p[0] <= lat1 and lon0 <= p[1] <= lon1 for p in gm):
            continue
        if e["m"] < 12:
            continue
        step = max(1, len(gm) // 8)
        context.append([[p[0], p[1]] for p in gm[::step]] + [gm[-1]])
    print(f"  context: {len(context)} further path segments inside the view")

    out = {
        "seed": SEED,
        "context": context,
        "source": g["source"],
        "licence": g["licence"],
        "start": {"name": START_NAME, "lat": start_b["lat"], "lon": start_b["lon"]},
        "goal": {"name": GOAL_NAME, "ref": goal_b.get("ref"), "lat": goal_b["lat"], "lon": goal_b["lon"]},
        "edges": slim_edges,
        "routes": [
            {
                "edges": [idx[e] for e in r["edges"]],
                "true_s": r["true_s"],
                "m": r["m"],
                "unique_share": r["unique_share"],
            }
            for r in routes
        ],
        "closure_edge": idx[closure],
        "landmarks": [
            b for b in g["buildings"]
            if b.get("name") and not b["name"].isdigit()
            and min(metres((b["lat"], b["lon"]), tuple(p)) for r in routes for e in r["edges"] for p in edges[e]["geom"][::4]) < 130
        ][:14],
    }
    (DATA / "scenario.json").write_text(json.dumps(out, separators=(",", ":")))
    kb = (DATA / "scenario.json").stat().st_size // 1024
    print(f"\nwrote data/scenario.json ({kb} KB), {len(slim_edges)} segments, {len(out['landmarks'])} landmarks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
