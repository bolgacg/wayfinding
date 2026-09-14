# What do you do when the route you know is closed?

A two-minute navigation experiment on the real footpath network of the DTU Lyngby campus,
fitted in the visitor's own browser, with an honest account of what fourteen days of one
person's choices can and cannot measure.

Live page: https://bolgacg.github.io/wayfinding/

Built for PhD scholarship 7860 at DTU Management, Human Navigation, Artificial Intelligence
and Neuroscience, around the sentence in its own advertisement: "current models of navigation
and route choice often assume stable preferences and near-perfect knowledge of the
environment. As a result, they provide limited insights into how people learn to move through
cities over time."

## What it does

You walk the same campus trip fourteen times, choosing between three real routes. You learn
the travel time only of the route you took, which is the situation a person is actually in.
On day eight a path closes and the route you have settled into disappears. The page then fits
two numbers to your choices, how fast you update a belief and how decisively you act on it,
and then tells you what those two numbers are worth.

That last part is the point of the exercise. Before anyone visits, simulated people with
known numbers walked the same experiment and were fitted by the same code. At fourteen days
the fitter pins the learning rate for 14 percent of them and the decisiveness for 3 percent.
Reaching 48 percent on the learning rate takes 120 days of commuting per person. The page
reports that curve rather than the two numbers alone.

## Layout

| Path | What it does |
|---|---|
| `study/fetch_graph.py` | Pulls the walkable network and named buildings from OpenStreetMap through Overpass and builds a routing graph |
| `study/build_scenario.py` | Picks the endpoints, finds three genuinely different routes, gives every segment a hidden true walking time, writes the map slice the page carries |
| `study/recovery.py` | The recovery study: known agents, the same fitter, at 14, 30, 60 and 120 days |
| `study/build_page_data.py` | Writes `docs/data.js` |
| `study/verify_page.js` | Renders the page headless, screenshots it, walks every tour step, checks overflow and script errors |
| `study/verify_experiment.js` | Plays all fourteen days at two widths and checks that everything downstream actually fills in |
| `docs/` | The page |

## Running it

```
python3 study/fetch_graph.py        # caches the Overpass answers under data/
python3 study/build_scenario.py
python3 study/recovery.py           # a few minutes
python3 study/build_page_data.py
node study/verify_page.js
node study/verify_experiment.js
```

## Method, and the choices inside it

Each route carries a believed travel time starting at its length divided by 1.35 metres per
second, which is what a map alone lets you guess. After a walk, the belief for the route taken
moves toward the observed time by the learning rate, and no other belief moves. A choice is
drawn from a softmax over the negative believed times with decisiveness as its scale. Both
numbers come from a grid search for the maximum likelihood of the actual choices, and the
range quoted beside each is every grid value within two log-likelihood units of the best.

Three things in that paragraph are choices rather than findings, and the page says so:

- The true travel times are not field measurements. They are real path lengths and real path
  types with a hidden per-segment friction drawn once from a seeded log-normal, standing for
  what a map cannot show. The learning problem is real; the minutes are plausible rather than
  observed.
- "Pinned down" means a learning rate whose interval is narrower than a quarter of its range,
  or a decisiveness whose interval spans less than a factor of four. Both cut-offs are mine.
- Response time is recorded and deliberately not fitted. Doing that properly needs a
  sequential sampling model of the kind Rico Krueger's own work builds, and the recovery study
  is the evidence that fourteen trials from one person cannot support one.

Nothing the visitor does leaves their browser. There is no server, no storage and no
analytics, which also means the page cannot pool across visitors.

## Sources

- Footpaths, buildings and names: OpenStreetMap contributors via Overpass, 14 September 2026,
  Open Database License.
- PhD scholarship 7860, DTU Management, advertisement read 24 August 2026.

Bolgaç Gülen, September 2026.
