#!/usr/bin/env python3
"""Can this experiment recover what it claims to measure?

The page fits two numbers to whoever runs it: how fast they update a belief
after one walk, and how sharply they act on the belief they hold. This script
asks the prior question. It builds agents whose numbers are known, runs them
through exactly the experiment the page runs, fits them with exactly the same
fitter, and reports how far the fitted numbers land from the true ones at that
number of trials.

Writes data/recovery.json, which the page shows next to the visitor's own fit,
so nobody reads two numbers off fourteen trials without being told what fourteen
trials can carry.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SEED = 20260914
N_AGENTS = 250
DAYS = 14
DAY_SWEEP = [14, 30, 60, 120]
CLOSURE_DAY = 8          # one-based; from this day the first route is shut
DAY_NOISE = 0.10         # a walk is never the same twice
MAP_SPEED = 1.35         # what a map lets you guess, metres per second

ALPHA_GRID = [round(0.02 + 0.04 * i, 3) for i in range(25)]        # 0.02 to 0.98
BETA_GRID = [round(0.002 * (1.28 ** i), 5) for i in range(22)]      # 0.002 to ~0.35 per second


def priors(routes: list[dict]) -> list[float]:
    """What you would believe from the map alone, before walking anything."""
    return [r["m"] / MAP_SPEED for r in routes]


def available(day: int, n: int) -> list[int]:
    """Route 0 is closed from the closure day onward."""
    return list(range(n)) if day < CLOSURE_DAY else list(range(1, n))


def simulate(routes, alpha, beta, rng, days: int = DAYS) -> list[dict]:
    b = priors(routes)
    out = []
    for day in range(1, days + 1):
        opts = available(day, len(routes))
        w = [math.exp(-beta * b[i]) for i in opts]
        s = sum(w) or 1.0
        r, acc, choice = rng.random(), 0.0, opts[-1]
        for i, wi in zip(opts, w):
            acc += wi / s
            if r <= acc:
                choice = i
                break
        observed = routes[choice]["true_s"] * math.exp(rng.gauss(0.0, DAY_NOISE))
        out.append({"day": day, "options": opts, "choice": choice, "observed": round(observed, 2)})
        b[choice] += alpha * (observed - b[choice])
    return out


def loglik(routes, trials, alpha, beta) -> float:
    b = priors(routes)
    ll = 0.0
    for t in trials:
        opts = t["options"]
        z = [-beta * b[i] for i in opts]
        m = max(z)
        ex = [math.exp(v - m) for v in z]
        s = sum(ex)
        p = ex[opts.index(t["choice"])] / s
        ll += math.log(max(p, 1e-12))
        b[t["choice"]] += alpha * (t["observed"] - b[t["choice"]])
    return ll


def fit(routes, trials) -> dict:
    best = None
    for a in ALPHA_GRID:
        for be in BETA_GRID:
            ll = loglik(routes, trials, a, be)
            if best is None or ll > best[0]:
                best = (ll, a, be)
    ll, a, be = best
    # A flat likelihood means the data does not pin the number down. The width
    # reported here is the range of values within 2 log-likelihood units of the
    # best, which is the usual rule of thumb for "not meaningfully worse".
    ok_a = [a2 for a2 in ALPHA_GRID if loglik(routes, trials, a2, be) > ll - 2]
    ok_b = [b2 for b2 in BETA_GRID if loglik(routes, trials, a, b2) > ll - 2]
    return {
        "alpha": a,
        "beta": be,
        "loglik": round(ll, 4),
        "alpha_range": [min(ok_a), max(ok_a)],
        "beta_range": [min(ok_b), max(ok_b)],
    }


def corr(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs) / n) or 1e-9
    sy = math.sqrt(sum((y - my) ** 2 for y in ys) / n) or 1e-9
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (n * sx * sy)


def run_one(routes, days: int, rng) -> dict:
    """How well the fitter recovers known agents when each walks `days` days."""
    rows = []
    for _ in range(N_AGENTS):
        true_a = rng.choice(ALPHA_GRID)
        true_b = rng.choice(BETA_GRID)
        trials = simulate(routes, true_a, true_b, rng, days)
        got = fit(routes, trials)
        rows.append({
            "true_alpha": true_a, "true_beta": true_b,
            "fit_alpha": got["alpha"], "fit_beta": got["beta"],
            "alpha_width": got["alpha_range"][1] - got["alpha_range"][0],
            "beta_ratio": (got["beta_range"][1] / got["beta_range"][0]) if got["beta_range"][0] > 0 else None,
        })
    widths = sorted(r["alpha_width"] for r in rows)
    ratios = sorted(r["beta_ratio"] for r in rows if r["beta_ratio"])
    return {
        "days": days,
        "alpha_recovery": round(corr([r["true_alpha"] for r in rows], [r["fit_alpha"] for r in rows]), 3),
        "beta_recovery_log": round(corr([math.log(r["true_beta"]) for r in rows],
                                        [math.log(r["fit_beta"]) for r in rows]), 3),
        "alpha_median_width": round(widths[len(widths) // 2], 3),
        "beta_median_ratio": round(ratios[len(ratios) // 2], 2) if ratios else None,
        "alpha_pinned_share": round(sum(1 for w in widths if w < 0.25) / len(widths), 3),
        "beta_pinned_share": round(sum(1 for r in ratios if r < 4) / len(ratios), 3) if ratios else None,
    }


def main() -> int:
    scen = json.loads((DATA / "scenario.json").read_text())
    routes = scen["routes"]

    sweep = []
    for days in DAY_SWEEP:
        rng = random.Random(SEED + days)
        row = run_one(routes, days, rng)
        sweep.append(row)
        print(f"{days:4d} days: learning rate r={row['alpha_recovery']:.2f} "
              f"(pinned on {row['alpha_pinned_share'] * 100:3.0f}%), "
              f"decisiveness r={row['beta_recovery_log']:.2f} "
              f"(within a factor of four on {(row['beta_pinned_share'] or 0) * 100:3.0f}%, "
              f"median factor {row['beta_median_ratio']})", flush=True)

    here = [r for r in sweep if r["days"] == DAYS][0]
    rng2 = random.Random(SEED + 1)
    ex_trials = simulate(routes, 0.30, 0.0328, rng2, DAYS)
    ex_fit = fit(routes, ex_trials)

    out = {
        "seed": SEED, "agents": N_AGENTS, "days": DAYS, "sweep": sweep,
        "closure_day": CLOSURE_DAY, "day_noise": DAY_NOISE,
        "alpha_grid": [ALPHA_GRID[0], ALPHA_GRID[-1], len(ALPHA_GRID)],
        "beta_grid": [BETA_GRID[0], BETA_GRID[-1], len(BETA_GRID)],
        "map_speed": MAP_SPEED,
        "example": {"true_alpha": 0.30, "true_beta": 0.0328, "trials": ex_trials, "fit": ex_fit},
    }
    out.update({k: here[k] for k in
                ("alpha_recovery", "beta_recovery_log", "alpha_median_width",
                 "beta_median_ratio", "alpha_pinned_share", "beta_pinned_share")})
    (DATA / "recovery.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"\nworked example at {DAYS} days: true 0.30 / 0.0328, fitted {ex_fit['alpha']} / {ex_fit['beta']}")
    print("wrote data/recovery.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
