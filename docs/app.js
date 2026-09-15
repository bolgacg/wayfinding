/* wayfinding: the experiment, the fit, and the honest account of what the fit
   is worth. Every number comes from data.js or from the visitor's own choices.
   Nothing is sent anywhere. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var C = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, text) {
    var n = document.createElementNS(C, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  function mins(s) { return (s / 60).toFixed(1); }
  function pct(x, d) { return x == null ? 'n/a' : (100 * x).toFixed(d == null ? 0 : d) + '%'; }

  var COLOURS = ['#b03a3a', '#2c4a6b', '#2f7d54'];
  var LABELS = ['Route A', 'Route B', 'Route C'];

  /* ---------- the fitter, mirroring study/recovery.py exactly ---------- */
  var MAP_SPEED = 1.35;
  var ALPHA_GRID = [], BETA_GRID = [];
  for (var i = 0; i < 25; i++) ALPHA_GRID.push(Math.round((0.02 + 0.04 * i) * 1000) / 1000);
  for (var j = 0; j < 22; j++) BETA_GRID.push(Math.round(0.002 * Math.pow(1.28, j) * 100000) / 100000);

  function priors() { return D.routes.map(function (r) { return r.m / MAP_SPEED; }); }

  function loglik(trials, alpha, beta) {
    var b = priors(), ll = 0;
    for (var t = 0; t < trials.length; t++) {
      var tr = trials[t], opts = tr.options;
      var z = opts.map(function (i) { return -beta * b[i]; });
      var m = Math.max.apply(null, z);
      var ex = z.map(function (v) { return Math.exp(v - m); });
      var s = ex.reduce(function (a, c) { return a + c; }, 0);
      var p = ex[opts.indexOf(tr.choice)] / s;
      ll += Math.log(Math.max(p, 1e-12));
      b[tr.choice] += alpha * (tr.observed - b[tr.choice]);
    }
    return ll;
  }

  function fit(trials) {
    var best = null;
    ALPHA_GRID.forEach(function (a) {
      BETA_GRID.forEach(function (be) {
        var ll = loglik(trials, a, be);
        if (!best || ll > best.ll) best = { ll: ll, alpha: a, beta: be };
      });
    });
    var okA = ALPHA_GRID.filter(function (a) { return loglik(trials, a, best.beta) > best.ll - 2; });
    var okB = BETA_GRID.filter(function (b) { return loglik(trials, best.alpha, b) > best.ll - 2; });
    return {
      alpha: best.alpha, beta: best.beta, loglik: best.ll,
      alpha_range: [Math.min.apply(null, okA), Math.max.apply(null, okA)],
      beta_range: [Math.min.apply(null, okB), Math.max.apply(null, okB)]
    };
  }

  function fitNoLearning(trials) {
    var best = null;
    BETA_GRID.forEach(function (be) {
      var ll = loglik(trials, 0.0, be);
      if (!best || ll > best.ll) best = { ll: ll, beta: be };
    });
    return best;
  }

  function beliefPath(trials, alpha) {
    var b = priors(), out = [b.slice()];
    trials.forEach(function (tr) {
      b[tr.choice] += alpha * (tr.observed - b[tr.choice]);
      out.push(b.slice());
    });
    return out;
  }

  /* ---------- the map ---------- */
  var proj = null;
  function setupProjection(W, H, pad) {
    var lat0 = 1e9, lat1 = -1e9, lon0 = 1e9, lon1 = -1e9;
    var seen = function (p) {
      lat0 = Math.min(lat0, p[0]); lat1 = Math.max(lat1, p[0]);
      lon0 = Math.min(lon0, p[1]); lon1 = Math.max(lon1, p[1]);
    };
    D.edges.forEach(function (e) { e.geom.forEach(seen); });
    [D.start, D.goal].forEach(function (m) { seen([m.lat, m.lon]); });
    var k = Math.cos((lat0 + lat1) / 2 * Math.PI / 180);
    var w = (lon1 - lon0) * k, h = (lat1 - lat0);
    var s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    var ox = (W - w * s) / 2, oy = (H - h * s) / 2;
    proj = function (lat, lon) {
      return [ox + (lon - lon0) * k * s, H - (oy + (lat - lat0) * s)];
    };
  }

  // An edge's geom is stored in the direction the way was drawn in OpenStreetMap,
  // which is not the direction a route walks it. Emitting it as stored sent the pen
  // to the far end of every edge entered from its b side, drew that segment
  // backwards and jumped back, which is what made the routes double back on
  // themselves. The node ids say which way the walk goes, so orient by them: no
  // distance guess, and the join between two edges is exact by construction.
  function routeNodes(ri) {
    var ids = D.routes[ri].edges;
    if (!ids.length) return [];
    var first = D.edges[ids[0]];
    var at;
    if (ids.length === 1) {
      at = first.a;
    } else {
      var second = D.edges[ids[1]];
      // The first edge starts at whichever of its ends the second edge does NOT touch.
      at = (first.b === second.a || first.b === second.b) ? first.a : first.b;
    }
    return ids.map(function (ei) {
      var e = D.edges[ei], forward = e.a === at;
      at = forward ? e.b : e.a;
      return { e: e, forward: forward };
    });
  }

  function routePath(ri) {
    var pts = [];
    routeNodes(ri).forEach(function (step, k) {
      var g = step.forward ? step.e.geom : step.e.geom.slice().reverse();
      // The shared node is the previous edge's last point, so skip it.
      g.forEach(function (p, i) { if (k === 0 || i > 0) pts.push(proj(p[0], p[1])); });
    });
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
  }

  var state = {
    day: 0, trials: [], started: false, shownAt: 0, hover: {}, done: false, pending: false
  };

  function optionsFor(day) {
    return day < D.closure_day ? [0, 1, 2] : [1, 2];
  }

  function drawMap() {
    var host = $('#map');
    host.innerHTML = '';
    var W = 900, H = 520;
    setupProjection(W, H, 30);
    var s = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Three walking routes across the DTU Lyngby campus' });

    // every segment faintly, so the routes sit on a real network
    var faint = el('g', {});
    (D.context || []).forEach(function (gm) {
      var d = gm.map(function (p, i) { var q = proj(p[0], p[1]); return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' ');
      faint.appendChild(el('path', { d: d, fill: 'none', stroke: '#e2e0dc', 'stroke-width': 1.6 }));
    });
    s.appendChild(faint);

    var opts = state.started && !state.done ? optionsFor(state.day) : [0, 1, 2];
    D.routes.forEach(function (r, ri) {
      var open = opts.indexOf(ri) >= 0;
      var g = el('g', { class: 'rt' + (open ? '' : ' off'), 'data-r': ri, role: 'button', tabindex: '0',
        'aria-label': LABELS[ri] + (open ? '' : ', closed') });
      g.appendChild(el('path', { class: 'hit', d: routePath(ri) }));
      g.appendChild(el('path', { class: 'line', d: routePath(ri), stroke: open ? COLOURS[ri] : '#9aa3ad', 'stroke-width': open ? 5 : 3.5 }));
      if (open && state.started && !state.done && !state.pending) {
        g.addEventListener('click', function () { choose(ri); });
        g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(ri); } });
        g.addEventListener('mouseenter', function () { state.hover[ri] = (state.hover[ri] || 0) + 1; });
      }
      s.appendChild(g);
    });

    // the closure, once it applies
    if (state.started && state.day >= D.closure_day) {
      var ce = D.edges[D.closure_edge];
      var mid = ce.geom[Math.floor(ce.geom.length / 2)];
      var q = proj(mid[0], mid[1]);
      s.appendChild(el('circle', { cx: q[0], cy: q[1], r: 9, fill: '#fff', stroke: '#b03a3a', 'stroke-width': 3 }));
      s.appendChild(el('line', { x1: q[0] - 5, y1: q[1] - 5, x2: q[0] + 5, y2: q[1] + 5, stroke: '#b03a3a', 'stroke-width': 2.5 }));
      s.appendChild(el('line', { x1: q[0] + 5, y1: q[1] - 5, x2: q[0] - 5, y2: q[1] + 5, stroke: '#b03a3a', 'stroke-width': 2.5 }));
      var tx = el('text', { x: q[0], y: q[1] - 16, 'text-anchor': 'middle',
        'font-family': "'IBM Plex Sans',sans-serif", 'font-size': 12.5, 'font-weight': 600, fill: '#b03a3a' }, 'path closed');
      s.appendChild(tx);
    }

    [D.start, D.goal].forEach(function (m) {
      var q = proj(m.lat, m.lon);
      var label = m.name + (m.ref ? ' (building ' + m.ref + ')' : '');
      // Labels are placed inward from whichever edge the marker sits nearest,
      // so a name never runs off the drawing.
      var right = q[0] < W * 0.55;
      s.appendChild(el('circle', { cx: q[0], cy: q[1], r: 6, fill: '#1a1d21' }));
      var t = el('text', {
        x: q[0] + (right ? 11 : -11), y: q[1] + 4,
        'text-anchor': right ? 'start' : 'end',
        'font-family': "'Newsreader',Georgia,serif", 'font-size': 15, 'font-weight': 600, fill: '#1a1d21'
      }, label);
      s.appendChild(t);
    });
    host.appendChild(s);

    drawRouteButtons(opts);
    $('#maplegend').innerHTML = D.routes.map(function (r, ri) {
      return '<span><i style="border-color:' + COLOURS[ri] + '"></i>' + LABELS[ri] + ', ' +
        (r.m / 1000).toFixed(2) + ' km</span>';
    }).join('') + '<span class="hint">Faint lines are the rest of the campus footpath network, from OpenStreetMap.</span>';
  }

  function drawRouteButtons(opts) {
    var host = $('#routebtns'); if (!host) return;
    host.innerHTML = '';
    D.routes.forEach(function (r, ri) {
      var open = opts.indexOf(ri) >= 0;
      var b = document.createElement('button');
      b.className = 'chip';
      b.id = 'take' + ri;
      b.disabled = !(open && state.started && !state.done && !state.pending);
      b.style.borderColor = open ? COLOURS[ri] : '';
      b.style.color = open ? COLOURS[ri] : '';
      b.textContent = open
        ? 'Take ' + LABELS[ri] + ', ' + (r.m / 1000).toFixed(2) + ' km'
        : LABELS[ri] + ' is closed';
      if (!b.disabled) {
        b.onclick = function () { choose(ri); };
        b.onmouseenter = function () { state.hover[ri] = (state.hover[ri] || 0) + 1; };
      }
      host.appendChild(b);
    });
  }

  function drawDays() {
    var bar = $('#daybar');
    var out = '';
    for (var d = 1; d <= D.recovery.days; d++) {
      var cls = d < state.day || (state.done && d <= D.recovery.days) ? 'done'
        : d === state.day ? 'now' : '';
      if (d === D.closure_day) cls += ' shut';
      out += '<i class="' + cls.trim() + '" title="day ' + d + '">' + d + '</i>';
    }
    bar.innerHTML = out;
  }

  function beginDay() {
    state.day++;
    state.pending = false;
    state.hover = {};
    state.shownAt = performance.now();
    drawMap(); drawDays();
    var opts = optionsFor(state.day);
    $('#readout').innerHTML = 'Day ' + state.day + ' of ' + D.recovery.days + '. ' +
      (state.day === D.closure_day ? '<b>' + LABELS[0] + ' is closed from today.</b> ' : '') +
      'Choose a route.';
  }

  function choose(ri) {
    if (state.pending || state.done) return;
    state.pending = true;
    var rt = (performance.now() - state.shownAt) / 1000;
    var observed = D.routes[ri].true_s * Math.exp(gauss() * D.recovery.day_noise);
    state.trials.push({
      day: state.day, options: optionsFor(state.day), choice: ri,
      observed: Math.round(observed * 100) / 100, rt: Math.round(rt * 1000) / 1000,
      hovered: Object.keys(state.hover).length
    });
    var prev = state.trials.filter(function (t) { return t.choice === ri; });
    var before = prev.length > 1 ? prev[prev.length - 2].observed : null;
    $('#readout').innerHTML = LABELS[ri] + ' took <b>' + mins(observed) + ' minutes</b> today' +
      (before ? ', against ' + mins(before) + ' the last time you took it' : '') +
      '. You decided in ' + rt.toFixed(1) + ' seconds.';
    drawMap();
    if (state.day >= D.recovery.days) {
      state.done = true;
      drawDays();
      $('#skip').hidden = true;
      $('#begin').hidden = true;
      $('#reset').hidden = false;
      $('#readout').innerHTML += ' <b>That is fourteen days. The rest of the page is now about you.</b>';
      renderFit();
      document.getElementById('act2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTimeout(beginDay, 850);
    }
  }

  var spare = null;
  function gauss() {
    if (spare !== null) { var v = spare; spare = null; return v; }
    var u = 0, v2 = 0, s = 0;
    do { u = Math.random() * 2 - 1; v2 = Math.random() * 2 - 1; s = u * u + v2 * v2; } while (s >= 1 || s === 0);
    var m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v2 * m;
    return u * m;
  }

  function autoplay() {
    // Fills the remaining days by picking with a middling learning rate, for a
    // reader who wants the rest of the page without walking fourteen times.
    var a = 0.3, be = 0.03;
    while (!state.done) {
      var opts = optionsFor(state.day);
      var b = beliefPath(state.trials, a).slice(-1)[0];
      var z = opts.map(function (i) { return -be * b[i]; });
      var m = Math.max.apply(null, z);
      var ex = z.map(function (v) { return Math.exp(v - m); });
      var s = ex.reduce(function (x, y) { return x + y; }, 0);
      var r = Math.random(), acc = 0, pick = opts[opts.length - 1];
      for (var k = 0; k < opts.length; k++) { acc += ex[k] / s; if (r <= acc) { pick = opts[k]; break; } }
      var observed = D.routes[pick].true_s * Math.exp(gauss() * D.recovery.day_noise);
      state.trials.push({ day: state.day, options: opts, choice: pick,
        observed: Math.round(observed * 100) / 100, rt: null, hovered: 0, auto: true });
      if (state.day >= D.recovery.days) { state.done = true; break; }
      state.day++;
    }
    state.pending = true;
    drawMap(); drawDays();
    $('#begin').hidden = true; $('#skip').hidden = true; $('#reset').hidden = false;
    $('#readout').innerHTML = '<b>The remaining days were filled in by a simulated walker</b>, so the fit below describes it rather than you. Press start again to do it yourself.';
    renderFit();
  }

  /* ---------- acts two and four ---------- */
  function renderFit() {
    var f = fit(state.trials);
    var nl = fitNoLearning(state.trials);
    var auto = state.trials.some(function (t) { return t.auto; });
    var rts = state.trials.filter(function (t) { return t.rt != null; }).map(function (t) { return t.rt; });
    var medRt = rts.length ? rts.slice().sort(function (a, b) { return a - b; })[Math.floor(rts.length / 2)] : null;

    var bp = beliefPath(state.trials, f.alpha);
    var card = $('#fitcard');
    card.innerHTML =
      '<div class="fitgrid">' +
      '<div class="fitbox"><div class="k">Learning rate</div><div class="n">' + f.alpha.toFixed(2) +
      '</div><div class="s">Every value from ' + f.alpha_range[0].toFixed(2) + ' to ' + f.alpha_range[1].toFixed(2) +
      ' fits your choices about as well.</div></div>' +
      '<div class="fitbox"><div class="k">Decisiveness</div><div class="n">' + f.beta.toFixed(3) +
      '</div><div class="s">Anything from ' + f.beta_range[0].toFixed(3) + ' to ' + f.beta_range[1].toFixed(3) +
      ' fits about as well, a factor of ' + (f.beta_range[1] / Math.max(f.beta_range[0], 1e-9)).toFixed(1) + '.</div></div>' +
      '<div class="fitbox"><div class="k">Best route found</div><div class="n">' +
      (function () {
        var after = state.trials.filter(function (t) { return t.day > D.closure_day; });
        if (!after.length) return 'n/a';
        var best = after[0].options.reduce(function (a, b) { return D.routes[a].true_s < D.routes[b].true_s ? a : b; });
        return pct(after.filter(function (t) { return t.choice === best; }).length / after.length);
      })() +
      '</div><div class="s">Share of days after the closure on the quickest remaining route.</div></div>' +
      (medRt ? '<div class="fitbox"><div class="k">Median decision</div><div class="n">' + medRt.toFixed(1) +
        ' s</div><div class="s">Recorded, and deliberately not fitted. The coda says why.</div></div>' : '') +
      '</div>' +
      (auto ? '<p class="note">Part of this was filled in automatically, so it describes the simulated walker.</p>' : '') +
      '<div class="viz" id="beliefviz"></div>' +
      '<p class="hint">What the best-fitting version of you believed each route cost, day by day. ' +
      'Only the route walked on a day moves, because that is all you learned. The dashed lines are the true times.</p>';

    drawBeliefs(bp);

    var d = f.loglik - nl.ll;
    $('#cmpcard').innerHTML =
      '<div class="fitgrid">' +
      '<div class="fitbox"><div class="k">Beliefs that move</div><div class="n">' + f.loglik.toFixed(2) +
      '</div><div class="s">Log-likelihood of your choices, two free numbers.</div></div>' +
      '<div class="fitbox"><div class="k">Stable preference</div><div class="n">' + nl.ll.toFixed(2) +
      '</div><div class="s">Learning switched off, one free number.</div></div>' +
      '<div class="fitbox"><div class="k">Difference</div><div class="n">' + (d >= 0 ? '+' : '') + d.toFixed(2) +
      '</div><div class="s">In favour of learning. Two units is the usual line for "meaningfully better".</div></div>' +
      '</div>';
    $('#v4').innerHTML = '<b>' + (d > 2
      ? 'On your data the moving belief earns its extra parameter.'
      : 'On your data the stable-preference model is not meaningfully worse.') + '</b> ' +
      'The learning model fits ' + Math.abs(d).toFixed(2) + ' log-likelihood units ' + (d >= 0 ? 'better' : 'worse') +
      ' while spending one more free number. ' +
      (d > 2
        ? 'That is one person on fourteen days, so it is a hint and not evidence about anybody else.'
        : 'That is exactly the situation the advertisement describes: a model that assumes stable preferences survives, not because preferences are stable, but because this much data cannot tell.');

    $('#v2').innerHTML = '<b>Two numbers now sit next to your name, and the ranges beside them are the point.</b> ' +
      'Your decisiveness is pinned only to within a factor of ' +
      (f.beta_range[1] / Math.max(f.beta_range[0], 1e-9)).toFixed(1) +
      ', and your learning rate to a band ' + (f.alpha_range[1] - f.alpha_range[0]).toFixed(2) + ' wide out of a possible 0.96. ' +
      'Act three says whether that is you being hard to read or the experiment being too short.';
  }

  function drawBeliefs(bp) {
    var host = $('#beliefviz'); if (!host) return;
    host.innerHTML = '';
    var W = 860, H = 240, P = { l: 52, r: 14, t: 16, b: 34 };
    var all = [];
    bp.forEach(function (row) { row.forEach(function (v) { all.push(v); }); });
    D.routes.forEach(function (r) { all.push(r.true_s); });
    var lo = Math.min.apply(null, all) * 0.97, hi = Math.max.apply(null, all) * 1.03;
    var s = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Believed travel time for each route, day by day' });
    var X = function (d) { return P.l + d / (bp.length - 1) * (W - P.l - P.r); };
    var Y = function (v) { return H - P.b - (v - lo) / (hi - lo) * (H - P.t - P.b); };
    [lo, (lo + hi) / 2, hi].forEach(function (g) {
      s.appendChild(el('line', { x1: P.l, y1: Y(g), x2: W - P.r, y2: Y(g), stroke: '#e2e0dc' }));
      s.appendChild(el('text', { x: P.l - 7, y: Y(g) + 4, 'text-anchor': 'end',
        'font-family': "'IBM Plex Mono',monospace", 'font-size': 10, fill: '#8b95a1' }, mins(g) + ' m'));
    });
    s.appendChild(el('line', { x1: X(D.closure_day - 1), y1: P.t, x2: X(D.closure_day - 1), y2: H - P.b,
      stroke: '#b03a3a', 'stroke-dasharray': '4 4' }));
    s.appendChild(el('text', { x: X(D.closure_day - 1) + 6, y: P.t + 11, 'font-family': "'IBM Plex Sans',sans-serif",
      'font-size': 11, fill: '#b03a3a' }, 'path closes'));
    D.routes.forEach(function (r, ri) {
      s.appendChild(el('line', { x1: P.l, y1: Y(r.true_s), x2: W - P.r, y2: Y(r.true_s),
        stroke: COLOURS[ri], 'stroke-dasharray': '2 5', 'stroke-width': 1.4, opacity: .8 }));
      var d = bp.map(function (row, k) { return (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(row[ri]).toFixed(1); }).join(' ');
      s.appendChild(el('path', { d: d, fill: 'none', stroke: COLOURS[ri], 'stroke-width': 2.2 }));
    });
    state.trials.forEach(function (t, k) {
      var q = [X(k + 1), Y(bp[k + 1][t.choice])];
      s.appendChild(el('circle', { cx: q[0], cy: q[1], r: 3.2, fill: COLOURS[t.choice] }));
    });
    s.appendChild(el('text', { x: P.l, y: H - 8, 'font-family': "'IBM Plex Sans',sans-serif", 'font-size': 11, fill: '#5b6470' },
      'Day 0 is what the map alone implied. A dot marks the route walked that day.'));
    host.appendChild(s);
  }

  /* ---------- act three ---------- */
  function drawRecovery() {
    var host = $('#recviz'); if (!host) return;
    var sw = D.recovery.sweep;
    var W = 860, H = 300, P = { l: 62, r: 48, t: 18, b: 44 };
    var s = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'How well the fitter recovers known numbers as the number of days grows' });
    var maxD = sw[sw.length - 1].days;
    var X = function (d) { return P.l + Math.log(d / sw[0].days) / Math.log(maxD / sw[0].days) * (W - P.l - P.r); };
    var Y = function (v) { return H - P.b - v * (H - P.t - P.b); };
    for (var g = 0; g <= 1.001; g += 0.25) {
      s.appendChild(el('line', { x1: P.l, y1: Y(g), x2: W - P.r, y2: Y(g), stroke: '#e2e0dc' }));
      s.appendChild(el('text', { x: P.l - 8, y: Y(g) + 4, 'text-anchor': 'end',
        'font-family': "'IBM Plex Mono',monospace", 'font-size': 10, fill: '#8b95a1' }, pct(g)));
    }
    sw.forEach(function (r, i) {
      var anchor = i === 0 ? 'start' : i === sw.length - 1 ? 'end' : 'middle';
      s.appendChild(el('text', { x: X(r.days), y: H - P.b + 16, 'text-anchor': anchor,
        'font-family': "'IBM Plex Mono',monospace", 'font-size': 10.5, fill: '#8b95a1' }, r.days + ' days'));
    });
    [['alpha_pinned_share', '#b03a3a'], ['beta_pinned_share', '#2c4a6b']].forEach(function (k) {
      var d = sw.map(function (r, i) { return (i ? 'L' : 'M') + X(r.days).toFixed(1) + ' ' + Y(r[k[0]] || 0).toFixed(1); }).join(' ');
      s.appendChild(el('path', { d: d, fill: 'none', stroke: k[1], 'stroke-width': 2.4 }));
      sw.forEach(function (r) {
        s.appendChild(el('circle', { cx: X(r.days), cy: Y(r[k[0]] || 0), r: 4, fill: k[1] }));
      });
    });
    var here = sw.filter(function (r) { return r.days === D.recovery.days; })[0];
    if (here) {
      s.appendChild(el('line', { x1: X(here.days), y1: P.t, x2: X(here.days), y2: H - P.b,
        stroke: '#1a1d21', 'stroke-dasharray': '3 4' }));
      s.appendChild(el('text', { x: X(here.days) + 7, y: P.t + 12, 'font-family': "'IBM Plex Sans',sans-serif",
        'font-size': 11.5, fill: '#1a1d21' }, 'this page'));
    }
    var yl = H / 2;
    s.appendChild(el('text', { x: 14, y: yl, 'text-anchor': 'middle', 'font-family': "'IBM Plex Sans',sans-serif",
      'font-size': 11.5, fill: '#5b6470', transform: 'rotate(-90 14 ' + yl + ')' },
      'share of people whose number is pinned down'));
    s.appendChild(el('text', { x: P.l, y: H - 6, 'font-family': "'IBM Plex Sans',sans-serif", 'font-size': 11.5, fill: '#5b6470' },
      'Days of commuting per person, on a logarithmic scale'));
    host.innerHTML = '';
    host.appendChild(s);
    $('#reclegend').innerHTML =
      '<span><i style="border-color:#b03a3a"></i>learning rate, pinned to better than a quarter of its range</span>' +
      '<span><i style="border-color:#2c4a6b"></i>decisiveness, pinned to within a factor of four</span>';

    var last = sw[sw.length - 1];
    $('#recstat').innerHTML =
      '<div><div class="k">At ' + here.days + ' days</div><div class="n">' + pct(here.alpha_pinned_share) +
      '</div><div class="s">learning rates pinned down</div></div>' +
      '<div><div class="k">At ' + here.days + ' days</div><div class="n">' + pct(here.beta_pinned_share) +
      '</div><div class="s">decisiveness pinned down</div></div>' +
      '<div><div class="k">At ' + last.days + ' days</div><div class="n">' + pct(last.alpha_pinned_share) +
      '</div><div class="s">learning rates pinned down</div></div>' +
      '<div><div class="k">Simulated people</div><div class="n">' + D.recovery.agents +
      '</div><div class="s">per point on the curve</div></div>';

    $('#v3').innerHTML = '<b>Fourteen days is not enough, and the page will not pretend otherwise.</b> ' +
      'On simulated people whose numbers were known, fourteen days pinned the learning rate for ' +
      pct(here.alpha_pinned_share) + ' of them and the decisiveness for ' + pct(here.beta_pinned_share) +
      '. The ordering survives, so the fit can say who is more decisive than whom, with a correlation of ' +
      here.beta_recovery_log.toFixed(2) + ' on a logarithmic scale. Reaching ' + pct(last.alpha_pinned_share) +
      ' on the learning rate takes ' + last.days + ' days of commuting per person, which is the honest design cost ' +
      'of asking this question with this kind of experiment.';

    $('#lim1').textContent = 'The headline limitation is in act three and is not hidden here: at the length this ' +
      'page runs, the two fitted numbers are an ordering rather than a measurement. Any claim beyond ' +
      '"more decisive than" or "less decisive than" would be more than the data carries.';
  }

  /* ---------- the page checking its own fitter ---------- */
  function selfCheck() {
    var host = $('#selfcheck'); if (!host) return;
    var ex = D.recovery.example;
    if (!ex) { host.textContent = 'No worked example shipped.'; return; }
    var got = fit(ex.trials);
    var same = got.alpha === ex.fit.alpha && Math.abs(got.beta - ex.fit.beta) < 1e-9 &&
      Math.abs(got.loglik - ex.fit.loglik) < 1e-6;
    host.innerHTML = (same ? '<b class="pos">Matched.</b> ' : '<b class="neg">MISMATCH.</b> ') +
      'On the shipped example, whose true numbers were ' + ex.true_alpha + ' and ' + ex.true_beta +
      ', the Python run fitted ' + ex.fit.alpha + ' and ' + ex.fit.beta +
      '; this browser just fitted ' + got.alpha + ' and ' + got.beta + '. ' +
      (same
        ? 'Worth noticing on its own: the fitted decisiveness there is off from the truth by a factor of ' +
          (ex.fit.beta / ex.true_beta).toFixed(0) + ', which is act three in one line.'
        : 'The two fitters disagree, so nothing on this page should be believed until that is fixed.');
  }

  function fillProse() {
    var sw = D.recovery.sweep;
    var here = sw.filter(function (r) { return r.days === D.recovery.days; })[0];
    var last = sw[sw.length - 1];
    $('#startname').textContent = D.start.name;
    $('#goalname').textContent = D.goal.name + (D.goal.ref ? ', building ' + D.goal.ref : '');
    $('#dek').innerHTML =
      'A two-minute experiment on the real footpath network of the DTU Lyngby campus, fitted in your own browser. ' +
      '<strong>It measures how fast you update a belief and how decisively you act on it, and then it tells you that ' +
      'fourteen days of one person pins the first of those down ' + pct(here.alpha_pinned_share) + ' of the time.</strong> ' +
      'Getting to ' + pct(last.alpha_pinned_share) + ' takes ' + last.days + ' days per person. ' +
      'That second number is the one worth having.';
    $('#maptext').innerHTML = 'The three routes are real chains of footpath, cycleway and service road between ' +
      D.start.name + ' and ' + D.goal.name + (D.goal.ref ? ' (building ' + D.goal.ref + ')' : '') +
      ', taken from OpenStreetMap on 14 September 2026. They run ' +
      D.routes.map(function (r) { return (r.m / 1000).toFixed(2); }).join(', ') + ' kilometres, and each one keeps at least ' +
      pct(Math.min.apply(null, D.routes.map(function (r) { return r.unique_share; }))) +
      ' of its length to itself, so they are genuinely different ways to go rather than the same way with a detour. ' +
      'The closure is placed on the longest segment that belongs to the quickest route alone, so when it shuts, the habit has to break.';
  }

  /* ---------- the walkthrough ---------- */
  function tour() {
    var root = $('#tour'), hl = $('.tour-hl', root), card = $('.tour-card', root), idx = 0;
    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var STEPS = [
      { sel: 'header h1', k: 'Welcome · 1 of 6', html: 'This page runs a small navigation experiment on you and then spends most of its length explaining what the result is worth. Everything stays in your browser.' },
      { sel: '#mapwrap', k: 'The walk · 2 of 6', html: 'Three real routes across the DTU Lyngby campus. <b>Press begin and click a route</b> for each of fourteen days. You only learn the time of the route you take, and one day a path closes.' },
      { sel: '#fitcard', k: 'Your numbers · 3 of 6', html: 'Two numbers fitted to your choices: how fast you update a belief, and how decisively you act on it. The ranges printed beside them matter more than the numbers.' },
      { sel: '#recviz', k: 'What it is worth · 4 of 6', html: 'Simulated people whose numbers were known walked this same experiment and were fitted by this same code. The curve is how often the fitter gets them back, against how many days they walked.' },
      { sel: '#cmpcard', k: 'The advertisement · 5 of 6', html: 'The same fit with learning switched off, which is the stable-preference assumption the project sets out to question. On fourteen days of one person it usually survives, and that is the point.' },
      { sel: '#selfcheckcard', k: 'Checking itself · 6 of 6', html: 'The recovery study ran in Python and the live fit runs in JavaScript. The page refits a shipped example in front of you and prints whether the two agree.' }
    ];
    function place() {
      var st = STEPS[idx], elm = document.querySelector(st.sel);
      if (!elm) { next(); return; }
      var r = elm.getBoundingClientRect(), sx = window.scrollX, sy = window.scrollY;
      var docTop = r.top + sy, docLeft = r.left + sx;
      root.style.height = document.documentElement.scrollHeight + 'px';
      var maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      var target = Math.max(0, Math.min(docTop - 14, maxScroll)), vTop = docTop - target;
      var cw = Math.min(400, innerWidth - 32), ch = 250;
      var fitsRight = r.left + r.width + 18 + cw <= innerWidth - 16;
      var hh = fitsRight ? r.height : Math.max(120, Math.min(r.height, innerHeight - vTop - ch - 40));
      hl.style.left = (docLeft - 8) + 'px'; hl.style.top = (docTop - 8) + 'px';
      hl.style.width = (r.width + 16) + 'px'; hl.style.height = (hh + 16) + 'px';
      var dots = STEPS.map(function (_, i) { return '<i class="' + (i === idx ? 'on' : '') + '"></i>'; }).join('');
      card.innerHTML = '<div class="tk">' + st.k + '</div><p>' + st.html + '</p><div class="tour-nav"><div class="dots">' + dots + '</div>' +
        (idx > 0 ? '<button class="tour-btn" id="tprev">Back</button>' : '') +
        '<button class="tour-btn" id="tskip">Close</button><button class="tour-btn primary" id="tnext">' +
        (idx < STEPS.length - 1 ? 'Next' : 'Done') + '</button></div>';
      var cx, cy;
      if (fitsRight) { cx = docLeft + r.width + 18; cy = docTop; }
      else { cx = Math.min(docLeft, sx + innerWidth - 16 - cw); cy = docTop + hh + 22; }
      card.style.left = Math.max(sx + 16, cx) + 'px';
      card.style.top = Math.max(target + 16, cy) + 'px';
      $('#tnext').onclick = next; $('#tskip').onclick = stop;
      var pv = $('#tprev'); if (pv) pv.onclick = function () { idx = Math.max(0, idx - 1); place(); };
      window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
    }
    function next() { if (idx >= STEPS.length - 1) { stop(); return; } idx++; place(); }
    function stop() { root.classList.remove('on'); try { localStorage.setItem('wf-tour', 'seen'); } catch (e) { } }
    function start() { idx = 0; root.classList.add('on'); place(); }
    $('#tourbtn').addEventListener('click', start);
    var replace = function () { if (root.classList.contains('on')) place(); };
    window.addEventListener('resize', replace);
    window.addEventListener('load', replace);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(replace);
    if (!location.search.includes('tour=off')) setTimeout(start, 700);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (typeof D === 'undefined') return;
    fillProse();
    drawMap();
    drawDays();
    drawRecovery();
    selfCheck();
    $('#begin').addEventListener('click', function () {
      state.started = true; $('#begin').hidden = true; $('#skip').hidden = false; $('#reset').hidden = false;
      beginDay();
    });
    $('#skip').addEventListener('click', function () { if (!state.started) { state.started = true; state.day = 1; } autoplay(); });
    $('#reset').addEventListener('click', function () {
      state = { day: 0, trials: [], started: false, shownAt: 0, hover: {}, done: false, pending: false };
      $('#begin').hidden = false; $('#skip').hidden = true; $('#reset').hidden = true;
      $('#fitcard').innerHTML = '<p class="small">Finish act one and this fills in.</p>';
      $('#cmpcard').innerHTML = '<p class="small">Finish act one and this fills in.</p>';
      $('#v2').innerHTML = ''; $('#v4').innerHTML = '';
      $('#readout').textContent = 'Press begin.';
      drawMap(); drawDays();
    });
    $('#v1').innerHTML = '<b>Only the route you walk reports back.</b> That is the difference between this and a map: ' +
      'a map tells you about every route at once, and walking tells you about one. Everything the rest of the page ' +
      'measures follows from that asymmetry.';
    tour();
  });
})();
