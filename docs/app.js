/* FRACS Atlas Map — an interactive map of the Notion Notes database.
   Canvas rendering, d3-force layout, hand-rolled pan/zoom so only 17 KB of d3 is vendored. */
(function () {
'use strict';

var PUBLIC_BASE  = 'https://ananthavascular.notion.site/';
var PRIVATE_BASE = 'https://app.notion.com/p/';

var cv = document.getElementById('stage');
var ctx = cv.getContext('2d');
var tip = document.getElementById('tooltip');
var $ = function (id) { return document.getElementById(id); };

var G = null;                 // raw graph.json
var nodes = [], byId = {};
var hierEdges = [], linkEdges = [], tagEdges = [];
var sim = null, sprites = {};
var view = { k: 1, x: 0, y: 0 };
var mode = 'map', dest = 'public';
var focusNode = null, focusTrail = [], focusEdges = [], affinityIdx = {};
var prevMode = 'map';
var hover = null, dragNode = null;
var W = 0, H = 0, DPR = 1;

var state = {
  hier: true, link: true, tag: false, tagFacet: 'path',
  fClass: '', fPath: '', fLoc: '', algo: false, orphan: false, empty: false, q: ''
};

/* ---------- helpers ---------- */
function hsl(h, s, l, a) {
  return 'hsla(' + h + ',' + Math.round(s * 100) + '%,' + l + '%,' + (a === undefined ? 1 : a) + ')';
}
function courseOf(n) { return n.course ? byId[n.course] : null; }

/* Deterministic per-id pseudo-random, so the map's geography is identical on every
   load and can actually be memorised. Math.random() would reshuffle it each visit. */
function rnd(id, salt) {
  var h = 2166136261;
  var s = id + (salt || '');
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
function hueOf(n) {
  if (n.type === 'c') return n.hue;
  var c = courseOf(n);
  return c ? c.hue : 210;
}
function satOf(n) {
  if (n.type === 'c') return n.sat;
  var c = courseOf(n);
  return c ? c.sat : 0.3;
}

/* Pre-render one glow sprite per hue: far cheaper than a gradient per node per frame. */
function sprite(h, s) {
  var key = Math.round(h) + '_' + Math.round(s * 100);
  if (sprites[key]) return sprites[key];
  var R = 48, c = document.createElement('canvas');
  c.width = c.height = R * 2;
  var g = c.getContext('2d');
  var grad = g.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0.00, hsl(h, Math.min(1, s + 0.15), 86, 1));
  grad.addColorStop(0.18, hsl(h, Math.min(1, s + 0.10), 68, 0.95));
  grad.addColorStop(0.42, hsl(h, s, 52, 0.34));
  grad.addColorStop(1.00, hsl(h, s, 45, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, R * 2, R * 2);
  sprites[key] = c;
  return c;
}

/* ---------- build ---------- */
function build(g) {
  G = g;
  nodes = []; byId = {};

  g.courses.forEach(function (c) {
    var n = { id: c.id, type: 'c', title: c.title, num: c.num, hue: c.hue, sat: c.sat,
              count: c.count, deg: 0, on: true };
    n.r = 6 + Math.sqrt(c.count) * 1.7;
    nodes.push(n); byId[c.id] = n;
  });
  g.notes.forEach(function (p) {
    var n = { id: p.id, type: 'n', title: p.title, course: p.course, tags: p.tags,
              algorithm: p.algorithm, deg: 0, on: true };
    nodes.push(n); byId[p.id] = n;
  });

  hierEdges = [];
  g.notes.forEach(function (p) {
    if (p.course && byId[p.course]) hierEdges.push({ source: byId[p.course], target: byId[p.id] });
  });

  linkEdges = [];
  (g.links || []).forEach(function (l) {
    var a = byId[l.s], b = byId[l.t];
    if (!a || !b) return;
    a.deg++; b.deg++;
    linkEdges.push({ source: a, target: b, type: l.type });
  });

  nodes.forEach(function (n) {
    if (n.type === 'n') n.r = 3.1 + Math.min(n.deg, 14) * 0.34;
  });

  layoutAnchors();
  affinityIdx = computeAffinity(['path', 'loc', 'op', 'vessel', 'class']).byNode;
  computeTagEdges();
  startSim();
}

/* Course anchors sit on a ring, each course given angular room proportional to its size,
   so 42 notes in "8. Techniques" do not swamp a course holding one. */
function layoutAnchors() {
  var active = nodes.filter(function (n) { return n.type === 'c' && (n.count > 0 || state.empty); });
  active.sort(function (a, b) { return (a.num || 999) - (b.num || 999); });
  var weights = active.map(function (c) { return Math.sqrt(c.count) + 0.9; });
  var total = weights.reduce(function (a, b) { return a + b; }, 0);
  var R = 250 + total * 9;
  var acc = 0;
  active.forEach(function (c, i) {
    var frac = (acc + weights[i] / 2) / total;
    acc += weights[i];
    var a = frac * Math.PI * 2 - Math.PI / 2;
    c.ax = Math.cos(a) * R;
    c.ay = Math.sin(a) * R;
    if (c.x === undefined) { c.x = c.ax; c.y = c.ay; }
  });
  nodes.forEach(function (n) {
    if (n.type !== 'n') return;
    var c = courseOf(n);
    if (n.x === undefined) {
      var base = c ? { x: c.ax || 0, y: c.ay || 0 } : { x: 0, y: 0 };
      n.x = base.x + (rnd(n.id, 'x') - 0.5) * 90;
      n.y = base.y + (rnd(n.id, 'y') - 0.5) * 90;
    }
  });
}

/* Shared-label edges: computed client-side so switching facet is instant, and drawn only
   between notes in DIFFERENT courses — within-course affinity is already the hierarchy. */
/* Pairwise affinity over the tag facets. Shared values are weighted by inverse document
   frequency (a shared "Arterial" means little; a shared "Mesenteric Vascular Disease" means
   a lot), then capped by mutual top-K so no hub blooms into a starburst. */
function computeAffinity(facets, K) {
  K = K || 3;
  var notes = nodes.filter(function (n) { return n.type === 'n'; });
  var N = notes.length;

  var idf = {};
  facets.forEach(function (f) {
    var df = {};
    notes.forEach(function (n) {
      (n.tags[f] || []).forEach(function (v) { df[f + ':' + v] = (df[f + ':' + v] || 0) + 1; });
    });
    Object.keys(df).forEach(function (k) { idf[k] = Math.log(N / df[k]); });
  });

  var best = notes.map(function () { return []; });
  function push(list, j, w) {
    list.push({ j: j, w: w });
    list.sort(function (a, b) { return b.w - a.w; });
    if (list.length > K) list.length = K;
  }

  for (var a = 0; a < N; a++) {
    for (var b = a + 1; b < N; b++) {
      var A = notes[a], B = notes[b];
      if (A.course && B.course && A.course === B.course) continue;   // hierarchy says this already
      var w = 0;
      for (var fi = 0; fi < facets.length; fi++) {
        var f = facets[fi], av = A.tags[f] || [], bv = B.tags[f] || [];
        for (var vi = 0; vi < av.length; vi++) {
          if (bv.indexOf(av[vi]) >= 0) w += idf[f + ':' + av[vi]] || 0;
        }
      }
      if (w > 0) { push(best[a], b, w); push(best[b], a, w); }
    }
  }

  var edges = [], byNode = {}, seen = {};
  for (var i = 0; i < N; i++) {
    best[i].forEach(function (e) {
      if (!best[e.j].some(function (x) { return x.j === i; })) return;   // must be mutual
      var k = Math.min(i, e.j) + '_' + Math.max(i, e.j);
      if (seen[k]) return;
      seen[k] = 1;
      var edge = { source: notes[i], target: notes[e.j], w: e.w };
      edges.push(edge);
      (byNode[notes[i].id] = byNode[notes[i].id] || []).push({ node: notes[e.j], w: e.w });
      (byNode[notes[e.j].id] = byNode[notes[e.j].id] || []).push({ node: notes[i], w: e.w });
    });
  }
  return { edges: edges, byNode: byNode };
}

function computeTagEdges() {
  tagEdges = [];
  if (!state.tag) return;
  var facets = state.tagFacet === 'all' ? ['path', 'loc', 'op', 'vessel', 'class'] : [state.tagFacet];
  tagEdges = computeAffinity(facets).edges;
}

function startSim() {
  var hier = d3.forceLink(hierEdges).distance(function (l) {
    return 26 + Math.sqrt(l.source.count || 1) * 3;
  }).strength(0.62);
  var cross = d3.forceLink(linkEdges).distance(90).strength(0.045);

  sim = d3.forceSimulation(nodes)
    .force('hier', hier)
    .force('cross', cross)
    .force('charge', d3.forceManyBody().strength(function (n) {
      return n.type === 'c' ? -260 : -46;
    }).distanceMax(700))
    .force('collide', d3.forceCollide().radius(function (n) {
      return n.r + (n.type === 'c' ? 16 : 4.5);
    }).strength(0.85))
    .force('anchorX', d3.forceX(function (n) {
      return n.type === 'c' ? (n.ax || 0) : (courseOf(n) ? courseOf(n).x : 0);
    }).strength(function (n) { return n.type === 'c' ? 0.34 : 0.012; }))
    .force('anchorY', d3.forceY(function (n) {
      return n.type === 'c' ? (n.ay || 0) : (courseOf(n) ? courseOf(n).y : 0);
    }).strength(function (n) { return n.type === 'c' ? 0.34 : 0.012; }))
    .alpha(1).alphaDecay(0.018)
    .on('tick', draw);
}

/* ---------- tree view ---------- */
function treeTargets() {
  var active = nodes.filter(function (n) { return n.type === 'c' && (n.count > 0 || state.empty); });
  active.sort(function (a, b) { return (a.num || 999) - (b.num || 999); });
  var weights = active.map(function (c) { return Math.max(c.count, 1); });
  var total = weights.reduce(function (a, b) { return a + b; }, 0);
  var acc = 0, R1 = 300, R2 = 560;
  active.forEach(function (c, i) {
    var a0 = (acc / total) * Math.PI * 2, a1 = ((acc + weights[i]) / total) * Math.PI * 2;
    acc += weights[i];
    var mid = (a0 + a1) / 2 - Math.PI / 2;
    c.tx = Math.cos(mid) * R1; c.ty = Math.sin(mid) * R1;
    var kids = nodes.filter(function (n) { return n.type === 'n' && n.course === c.id; });
    kids.forEach(function (n, j) {
      var pad = (a1 - a0) * 0.10;
      var t = kids.length === 1 ? 0.5 : j / (kids.length - 1);
      var ang = (a0 + pad) + t * ((a1 - pad) - (a0 + pad)) - Math.PI / 2;
      var ring = R2 + (j % 3) * 34;
      n.tx = Math.cos(ang) * ring; n.ty = Math.sin(ang) * ring;
    });
  });
  var loose = nodes.filter(function (n) { return n.type === 'n' && !n.course; });
  loose.forEach(function (n, j) { n.tx = -60 + j * 80; n.ty = 0; });
}

var treeRAF = null;
function animateTree() {
  var moving = false;
  nodes.forEach(function (n) {
    if (n.tx === undefined) return;
    n.x += (n.tx - n.x) * 0.14;
    n.y += (n.ty - n.y) * 0.14;
    if (Math.abs(n.tx - n.x) > 0.4 || Math.abs(n.ty - n.y) > 0.4) moving = true;
  });
  if (camTarget) {
    view.k += (camTarget.k - view.k) * 0.16;
    view.x += (camTarget.x - view.x) * 0.16;
    view.y += (camTarget.y - view.y) * 0.16;
    if (Math.abs(camTarget.k - view.k) > 0.002 ||
        Math.abs(camTarget.x - view.x) > 0.6 ||
        Math.abs(camTarget.y - view.y) > 0.6) moving = true;
    else camTarget = null;
  }
  draw();
  if (moving) treeRAF = requestAnimationFrame(animateTree);
  else treeRAF = null;
}

var snapTimer = null;

function startAnim() {
  if (treeRAF) cancelAnimationFrame(treeRAF);
  treeRAF = requestAnimationFrame(animateTree);
  /* requestAnimationFrame does not fire in a backgrounded tab, and a Notion embed
     scrolled out of view is exactly that. Without this the layout would stall
     half-finished, so snap to the destination if the animation has not got there. */
  if (snapTimer) clearTimeout(snapTimer);
  snapTimer = setTimeout(snapTargets, 1500);
}

function snapTargets() {
  snapTimer = null;
  var changed = false;
  nodes.forEach(function (n) {
    if (n.tx === undefined) return;
    if (Math.abs(n.tx - n.x) > 0.4 || Math.abs(n.ty - n.y) > 0.4) changed = true;
    n.x = n.tx; n.y = n.ty;
  });
  if (camTarget) {
    view.k = camTarget.k; view.x = camTarget.x; view.y = camTarget.y;
    camTarget = null; changed = true;
  }
  if (changed) draw();
}

/* ---------- focus: fly to a node and ring it with everything it connects to ---------- */

function neighboursOf(n) {
  var out = [], seen = {};
  function add(node, rel, w) {
    if (!node || node === n || seen[node.id]) return;
    seen[node.id] = 1;
    out.push({ node: node, rel: rel, w: w || 0 });
  }

  if (n.type === 'c') {                       // focusing a course rings it with its notes
    nodes.forEach(function (m) { if (m.type === 'n' && m.course === n.id) add(m, 'child'); });
    return out;
  }

  add(courseOf(n), 'course');                 // the hierarchy-associated page
  linkEdges.forEach(function (e) {
    if (e.source === n) add(e.target, 'out');
    else if (e.target === n) add(e.source, 'in');
  });
  (affinityIdx[n.id] || []).forEach(function (a) { add(a.node, 'shared', a.w); });
  return out;
}

var REL_ORDER = { course: 0, out: 1, in: 2, child: 2, shared: 3 };

function focusTargets() {
  var n = focusNode;
  n.tx = 0; n.ty = 0;

  var nb = neighboursOf(n);
  nb.sort(function (a, b) {
    var d = (REL_ORDER[a.rel] || 9) - (REL_ORDER[b.rel] || 9);
    return d || (b.w - a.w);
  });

  // one ring while it stays legible, then concentric rings outward
  var PER = 16;
  var rings = Math.max(1, Math.ceil(nb.length / PER));
  var placed = 0;
  for (var r = 0; r < rings; r++) {
    var count = Math.min(nb.length - placed, Math.ceil(nb.length / rings));
    var radius = 250 + r * 165;
    for (var i = 0; i < count; i++) {
      var m = nb[placed + i];
      var ang = (i / count) * Math.PI * 2 - Math.PI / 2;
      m.node.tx = Math.cos(ang) * radius;
      m.node.ty = Math.sin(ang) * radius;
    }
    placed += count;
  }

  // visibility: the focused node and its neighbourhood, nothing else
  var keep = {};
  keep[n.id] = 1;
  nb.forEach(function (m) { keep[m.node.id] = 1; });
  nodes.forEach(function (m) { m.on = !!keep[m.id]; });

  // edges: spokes from the centre, plus any cross-links among the neighbours themselves,
  // which is what shows you when two of your neighbours are also related to each other
  focusEdges = nb.map(function (m) { return { source: n, target: m.node, rel: m.rel, spoke: true }; });
  linkEdges.forEach(function (e) {
    if (e.source === n || e.target === n) return;
    if (keep[e.source.id] && keep[e.target.id]) {
      focusEdges.push({ source: e.source, target: e.target, rel: 'peer', spoke: false });
    }
  });
  return nb;
}

function setFocus(n, push) {
  if (!n) return;
  if (!focusNode) {
    prevMode = mode;
    // stash the map's geography so coming back restores it exactly rather than
    // re-running the simulation, which would shuffle the layout you memorised
    nodes.forEach(function (m) { m.mx = m.x; m.my = m.y; });
  }
  if (push && focusNode && focusNode !== n) focusTrail.push(focusNode);
  focusNode = n;
  if (sim) sim.stop();
  nodes.forEach(function (m) { m.fx = m.fy = null; });
  var nb = focusTargets();
  renderFocusCard(n, nb);
  flyTo();
  startAnim();
}

function exitFocus() {
  focusNode = null; focusTrail = []; focusEdges = [];
  $('focus').hidden = true;
  mode = prevMode;
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.classList.toggle('on', b.dataset.view === mode);
  });
  if (mode === 'tree') {
    treeTargets();
  } else {
    nodes.forEach(function (m) {                    // restore the remembered map positions
      if (m.mx !== undefined) { m.tx = m.mx; m.ty = m.my; }
    });
  }
  applyFilters();
  flyTo();
  startAnim();
}

function focusBack() {
  if (focusTrail.length) setFocus(focusTrail.pop(), false);
  else exitFocus();
}

function renderFocusCard(n, nb) {
  var el = $('focus');
  var c = n.type === 'c' ? n : courseOf(n);
  var by = { course: 0, out: 0, in: 0, shared: 0, child: 0 };
  nb.forEach(function (m) { by[m.rel] = (by[m.rel] || 0) + 1; });

  var rows = [];
  if (by.child) rows.push(['child', by.child + ' notes in this course']);
  if (by.course) rows.push(['course', 'its course']);
  if (by.out) rows.push(['out', by.out + ' link' + (by.out === 1 ? '' : 's') + ' out']);
  if (by['in']) rows.push(['in', by['in'] + ' link' + (by['in'] === 1 ? '' : 's') + ' in']);
  if (by.shared) rows.push(['shared', by.shared + ' by shared labels']);

  var tags = n.type === 'n'
    ? [].concat(n.tags.class, n.tags.path, n.tags.loc, n.tags.op).filter(Boolean) : [];

  el.innerHTML =
    '<button type="button" id="focus-back">' + (focusTrail.length ? 'Back' : 'Whole map') + '</button>' +
    '<div class="ft">' + esc(n.title) + '</div>' +
    (c && c !== n ? '<div class="fc" style="color:' + hsl(c.hue, c.sat, 74) + '">' + esc(c.title) + '</div>' : '') +
    (tags.length ? '<div class="ftags">' + esc(tags.join(' \u00b7 ')) + '</div>' : '') +
    '<ul class="frel">' + rows.map(function (r) {
      return '<li><i class="dot ' + r[0] + '"></i>' + esc(r[1]) + '</li>';
    }).join('') + '</ul>' +
    (nb.length ? '<div class="fhint">Click any surrounding node to travel there.</div>'
               : '<div class="fhint">Nothing connects to this page yet.</div>') +
    (n.type === 'n' ? '<button type="button" id="focus-open">Open in Notion</button>' : '');

  el.hidden = false;
  $('focus-back').onclick = focusBack;
  if ($('focus-open')) $('focus-open').onclick = function () { openInNotion(n); };
}

function setMode(m) {
  mode = m;
  if (m === 'tree') {
    if (sim) sim.stop();
    treeTargets();
    flyTo();
    startAnim();
  } else {
    nodes.forEach(function (n) { n.fx = n.fy = null; });
    layoutAnchors();
    if (sim) sim.alpha(0.7).restart();
  }
}

/* ---------- filtering ---------- */
function applyFilters() {
  var q = state.q.trim().toLowerCase();
  nodes.forEach(function (n) {
    if (n.type === 'c') { n.on = n.count > 0 || state.empty; n.hit = false; return; }
    var ok = true;
    if (state.fClass && n.tags.class.indexOf(state.fClass) < 0) ok = false;
    if (state.fPath && n.tags.path.indexOf(state.fPath) < 0) ok = false;
    if (state.fLoc && n.tags.loc.indexOf(state.fLoc) < 0) ok = false;
    if (state.algo && !n.algorithm) ok = false;
    if (state.orphan && n.deg > 0) ok = false;
    if (!state.empty && n.course && byId[n.course] && byId[n.course].count === 0) ok = false;
    n.on = ok;
    n.hit = !!(q && n.title.toLowerCase().indexOf(q) >= 0);
  });
  updateCounts();
  draw();
}

function updateCounts() {
  var shown = nodes.filter(function (n) { return n.type === 'n' && n.on; }).length;
  var cs = nodes.filter(function (n) { return n.type === 'c' && n.on; }).length;
  var orph = nodes.filter(function (n) { return n.type === 'n' && n.deg === 0; }).length;
  var bits = [shown + ' of ' + G.meta.counts.notes + ' notes', cs + ' courses'];
  bits.push(G.meta.crosslinks ? G.meta.counts.crosslinks + ' cross-links' : 'cross-links pending');
  $('counts').innerHTML = bits.join(' &middot; ');
  $('orphan-hint').textContent = G.meta.crosslinks ? '(' + orph + ')' : '(needs link build)';
}

/* ---------- render ---------- */
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  draw();
}
function toScreen(x, y) { return [x * view.k + view.x, y * view.k + view.y]; }

/* The control panel overlays the canvas, so the usable area starts to its right. */
function usable() {
  var pnl = $('panel');
  var hidden = pnl.classList.contains('hidden');
  var left = hidden ? 8 : pnl.getBoundingClientRect().width + 10;
  var card = $('focus');
  var right = W - 8 - (card && !card.hidden ? card.getBoundingClientRect().width + 12 : 0);
  return { left: left, top: 8, right: right, bottom: H - 8 };
}
function toWorld(px, py) { return [(px - view.x) / view.k, (py - view.y) / view.k]; }

function edgeVisible(e) { return e.source.on && e.target.on; }

function draw() {
  if (!G) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  var dim = !!state.q.trim();

  if (focusNode) {
    var REL_COL = {
      course:  'rgba(190,205,235,.55)',
      out:     'rgba(120,170,255,.75)',
      in:      'rgba(120,170,255,.45)',
      child:   'rgba(190,205,235,.42)',
      shared:  'rgba(150,170,205,.32)',
      peer:    'rgba(120,170,255,.22)',
    };
    focusEdges.forEach(function (e) {
      if (!e.source.on || !e.target.on) return;
      ctx.lineWidth = (e.spoke ? 1.1 : 0.8) / view.k;
      ctx.strokeStyle = REL_COL[e.rel] || REL_COL.peer;
      if (e.rel === 'shared') ctx.setLineDash([4 / view.k, 4 / view.k]);
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // shared-label edges (faint, behind everything)
  if (!focusNode && state.tag) {
    ctx.lineWidth = 0.55 / view.k;
    tagEdges.forEach(function (e) {
      if (!edgeVisible(e)) return;
      ctx.strokeStyle = 'rgba(150,170,205,' + Math.min(0.07 + e.w * 0.03, 0.26) + ')';
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
    });
  }

  // hierarchy
  if (!focusNode && state.hier) {
    ctx.lineWidth = 0.7 / view.k;
    hierEdges.forEach(function (e) {
      if (!edgeVisible(e)) return;
      ctx.strokeStyle = hsl(e.source.hue, e.source.sat, 52, dim ? 0.10 : 0.22);
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
    });
  }

  // cross-links
  if (!focusNode && state.link) {
    ctx.lineWidth = 0.9 / view.k;
    linkEdges.forEach(function (e) {
      if (!edgeVisible(e)) return;
      var lit = hover && (e.source === hover || e.target === hover);
      ctx.strokeStyle = lit ? 'rgba(190,214,255,.85)' : 'rgba(126,150,190,' + (dim ? 0.10 : 0.30) + ')';
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
    });
  }

  // nodes
  ctx.globalCompositeOperation = 'lighter';
  nodes.forEach(function (n) {
    if (!n.on) return;
    var faded = (dim && !n.hit) ? 0.22 : 1;
    var g = sprite(hueOf(n), satOf(n));
    var s = n.r * (n.type === 'c' ? 5.4 : 6.2) * (n.hit ? 1.5 : 1) * (n === focusNode ? 2.1 : 1);
    ctx.globalAlpha = faded * (n.type === 'c' ? 0.95 : 0.8);
    ctx.drawImage(g, n.x - s / 2, n.y - s / 2, s, s);
  });
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  nodes.forEach(function (n) {
    if (!n.on) return;
    var faded = (dim && !n.hit) ? 0.25 : 1;
    ctx.globalAlpha = faded;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = hsl(hueOf(n), satOf(n), n.type === 'c' ? 80 : 70, 1);
    ctx.fill();
    if (n === hover || n.hit) {
      ctx.lineWidth = 1.6 / view.k;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }
    if (n.algorithm && n.type === 'n') {           // algorithm pages get a ring
      ctx.lineWidth = 1 / view.k;
      ctx.strokeStyle = hsl(hueOf(n), satOf(n), 86, 0.8);
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });

  // labels: screen space, fanned outward from the ring, greedy collision rejection
  ctx.restore();
  ctx.save();
  ctx.textBaseline = 'middle';
  var boxes = [];
  function fits(x, y, w, h) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return false;
    }
    boxes.push({ x: x, y: y, w: w, h: h });
    return true;
  }

  var cand = nodes.filter(function (n) { return n.on; }).sort(function (a, b) {
    var pa = (a === hover ? 40 : 0) + (a.hit ? 30 : 0) + (a.type === 'c' ? 20 + Math.min(a.count, 45) / 5 : 0) + Math.min(a.deg, 9) / 10;
    var pb = (b === hover ? 40 : 0) + (b.hit ? 30 : 0) + (b.type === 'c' ? 20 + Math.min(b.count, 45) / 5 : 0) + Math.min(b.deg, 9) / 10;
    return pb - pa;
  });

  cand.forEach(function (n) {
    var isC = n.type === 'c';
    if (!isC && !(focusNode || view.k > 1.3 || n === hover || n.hit)) return;
    var p = toScreen(n.x, n.y);
    var vp = usable();
    if (p[0] < vp.left - 150 || p[0] > vp.right + 150 || p[1] < -30 || p[1] > H + 30) return;

    var label = n.title;
    if (isC) { if (label.length > 34) label = label.slice(0, 32) + '\u2026'; }
    else if (label.length > 40) label = label.slice(0, 38) + '\u2026';

    var fs = isC ? 12 : 10.5;
    ctx.font = (isC ? '600 ' : '') + fs + 'px ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif';
    var tw = ctx.measureText(label).width;

    // Fan outward from the ring; if that would fall off-canvas or under the panel,
    // flip to the other side, then fall back to centred-below.
    var rad = Math.hypot(n.x, n.y) || 1;
    var outward = n.x / rad;
    var pad = n.r * view.k + 7;
    var tries = [];
    if (isC) {
      var right = { x: p[0] + pad, y: p[1] };
      var left  = { x: p[0] - pad - tw, y: p[1] };
      tries = outward >= 0 ? [right, left] : [left, right];
      tries.push({ x: p[0] - tw / 2, y: p[1] + n.r * view.k + 10 });
    } else {
      tries = [{ x: p[0] - tw / 2, y: p[1] + n.r * view.k + 9 },
               { x: p[0] + pad, y: p[1] }];
    }

    var placed = null;
    for (var ti = 0; ti < tries.length; ti++) {
      var c = tries[ti];
      if (c.x < vp.left || c.x + tw > vp.right) continue;
      if (c.y < vp.top || c.y > vp.bottom) continue;
      if (!fits(c.x - 2, c.y - fs / 2 - 2, tw + 4, fs + 4)) continue;
      placed = c; break;
    }
    if (!placed) return;
    var x = placed.x, y = placed.y, align = 'left';

    ctx.globalAlpha = (dim && !n.hit && !isC) ? 0.3 : 1;
    ctx.textAlign = align;
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = 'rgba(5,6,10,.94)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = isC ? hsl(n.hue, n.sat, 88, 1) : 'rgba(214,224,238,.94)';
    ctx.fillText(label, x, y);
    ctx.globalAlpha = 1;
  });

  ctx.restore();

}

/* ---------- interaction ---------- */
function pick(px, py) {
  var w = toWorld(px, py), best = null, bd = Infinity;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!n.on) continue;
    var dx = n.x - w[0], dy = n.y - w[1], d = dx * dx + dy * dy;
    var rr = Math.pow(n.r + 7 / view.k, 2);
    if (d < rr && d < bd) { bd = d; best = n; }
  }
  return best;
}

var ptrs = {}, panning = false, last = null, moved = 0, pinch = null;

cv.addEventListener('pointerdown', function (e) {
  cv.setPointerCapture(e.pointerId);
  ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
  var n = Object.keys(ptrs).length;
  if (n === 2) {
    var k = Object.keys(ptrs);
    pinch = { d: dist(ptrs[k[0]], ptrs[k[1]]), k: view.k,
              c: mid(ptrs[k[0]], ptrs[k[1]]) };
    panning = false; dragNode = null;
    return;
  }
  moved = 0; last = { x: e.clientX, y: e.clientY };
  var hitNode = pick(e.clientX, e.clientY);
  if (hitNode) {
    dragNode = hitNode;
    if (mode === 'map' && !focusNode && sim) sim.alphaTarget(0.16).restart();
  } else { panning = true; cv.classList.add('dragging'); }
});

function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

cv.addEventListener('pointermove', function (e) {
  if (ptrs[e.pointerId]) { ptrs[e.pointerId].x = e.clientX; ptrs[e.pointerId].y = e.clientY; }
  var keys = Object.keys(ptrs);
  if (pinch && keys.length === 2) {
    var d = dist(ptrs[keys[0]], ptrs[keys[1]]);
    var k = Math.max(0.12, Math.min(7, pinch.k * (d / pinch.d)));
    zoomAbout(pinch.c.x, pinch.c.y, k);
    return;
  }
  if (dragNode) {
    var w = toWorld(e.clientX, e.clientY);
    dragNode.fx = w[0]; dragNode.fy = w[1];
    dragNode.x = w[0]; dragNode.y = w[1];
    if (focusNode || mode === 'tree') { dragNode.tx = w[0]; dragNode.ty = w[1]; }
    moved += 4;
    if (mode === 'tree' || focusNode) draw();
    return;
  }
  if (panning && last) {
    view.x += e.clientX - last.x; view.y += e.clientY - last.y;
    moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
    draw();
    return;
  }
  var n = pick(e.clientX, e.clientY);
  if (n !== hover) { hover = n; showTip(n, e.clientX, e.clientY); draw(); }
  else if (n) moveTip(e.clientX, e.clientY);
  cv.classList.toggle('overnode', !!n);
});

function endPointer(e) {
  delete ptrs[e.pointerId];
  if (Object.keys(ptrs).length < 2) pinch = null;
  if (dragNode) {
    if (moved < 6) activate(dragNode);
    if (mode === 'map' && !focusNode && sim) { sim.alphaTarget(0); dragNode.fx = dragNode.fy = null; }
    dragNode = null;
  }
  panning = false; last = null;
  cv.classList.remove('dragging');
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', function () { hover = null; tip.hidden = true; draw(); });

cv.addEventListener('wheel', function (e) {
  e.preventDefault();
  var k = view.k * Math.pow(1.0022, -e.deltaY);
  zoomAbout(e.clientX, e.clientY, Math.max(0.12, Math.min(7, k)));
}, { passive: false });

function zoomAbout(px, py, k) {
  var w = toWorld(px, py);
  view.k = k;
  view.x = px - w[0] * k; view.y = py - w[1] * k;
  draw();
}

function activate(n) {
  if (focusNode && n === focusNode) { openInNotion(n); return; }   // second click on the centre
  setFocus(n, true);
}

function openInNotion(n) {
  var base = dest === 'public' ? PUBLIC_BASE : PRIVATE_BASE;
  var url = base + n.id;
  // A real anchor survives iframe sandboxes that silently drop window.open().
  var a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  var opened = true;
  try { a.click(); } catch (e) { opened = false; }
  a.remove();
  if (!opened) toast(url);
  else setTimeout(function () { if (document.hasFocus()) toast(url); }, 700);
}

/* If the embed blocked the new tab, show the URL so it can still be reached. */
var toastEl = null;
function toast(url) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.id = 'toast';
  toastEl.innerHTML = '<span>Open manually:</span> <a href="' + esc(url) +
    '" target="_blank" rel="noopener noreferrer">' + esc(url.replace(/^https:\/\//, '')) + '</a>';
  document.body.appendChild(toastEl);
  setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 6000);
}

function showTip(n, x, y) {
  if (!n) { tip.hidden = true; return; }
  var html = '';
  if (n.type === 'c') {
    html = '<div class="t">' + esc(n.title) + '</div>' +
           '<div class="c" style="color:' + hsl(n.hue, n.sat, 74) + '">' + n.count + ' notes</div>' +
           '<div class="go">Click to explore this course</div>';
  } else {
    var c = courseOf(n);
    var tg = [].concat(n.tags.class, n.tags.path, n.tags.loc, n.tags.op).filter(Boolean);
    html = '<div class="t">' + esc(n.title) + '</div>' +
      (c ? '<div class="c" style="color:' + hsl(c.hue, c.sat, 74) + '">' + esc(c.title) + '</div>'
         : '<div class="c" style="color:#7c8798">unfiled</div>') +
      (tg.length ? '<div class="tags">' + esc(tg.join(' · ')) + '</div>' : '') +
      (G.meta.crosslinks ? '<div class="tags">' + n.deg + ' cross-links</div>' : '') +
      '<div class="go">' + (focusNode === n ? 'Click again to open in Notion'
                                             : 'Click to centre \u00b7 double-click to open') + '</div>';
  }
  tip.innerHTML = html; tip.hidden = false; moveTip(x, y);
}
function moveTip(x, y) {
  var r = tip.getBoundingClientRect();
  var nx = Math.min(x + 14, window.innerWidth - r.width - 8);
  var ny = Math.min(y + 14, window.innerHeight - r.height - 8);
  tip.style.left = nx + 'px'; tip.style.top = ny + 'px';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

var camTarget = null;

/* Desired view for the visible nodes. useTargets reads the layout's destination
   coordinates (tx/ty), so the camera can start flying before the nodes arrive. */
function computeFit(useTargets) {
  var xs = nodes.filter(function (n) {
    if (!n.on) return false;
    return useTargets ? n.tx !== undefined : true;
  });
  if (!xs.length) return null;
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  xs.forEach(function (n) {
    var x = useTargets ? n.tx : n.x, y = useTargets ? n.ty : n.y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  var vp = usable();
  var pad = 96;                                   // room for the outward-fanned labels
  var aw = Math.max(vp.right - vp.left - pad * 2, 120);
  var ah = Math.max(vp.bottom - vp.top - pad * 2, 120);
  var k = Math.min(aw / Math.max(maxX - minX, 1), ah / Math.max(maxY - minY, 1));
  k = Math.max(0.12, Math.min(2, k));
  return {
    k: k,
    x: (vp.left + vp.right) / 2 - ((minX + maxX) / 2) * k,
    y: (vp.top + vp.bottom) / 2 - ((minY + maxY) / 2) * k,
  };
}

function fit() {
  var f = computeFit(false);
  if (!f) return;
  camTarget = null;
  view.k = f.k; view.x = f.x; view.y = f.y;
  draw();
}

/* Ease the camera to wherever the current layout is heading. */
/* Deferred fits must not clobber a navigation the user has already started. */
function fitIfIdle() { if (!focusNode && !camTarget) fit(); }

function flyTo() {
  var f = computeFit(true);
  if (f) camTarget = f;
}

/* ---------- UI ---------- */
function fillFacet(sel, values, label) {
  values.sort();
  values.forEach(function (v) {
    var o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}
function wireUI() {
  var cls = {}, pth = {}, loc = {};
  G.notes.forEach(function (n) {
    n.tags.class.forEach(function (v) { cls[v] = 1; });
    n.tags.path.forEach(function (v) { pth[v] = 1; });
    n.tags.loc.forEach(function (v) { loc[v] = 1; });
  });
  fillFacet($('f-class'), Object.keys(cls));
  fillFacet($('f-path'), Object.keys(pth));
  fillFacet($('f-loc'), Object.keys(loc));

  $('search').addEventListener('input', function (e) { state.q = e.target.value; applyFilters(); });
  $('f-class').addEventListener('change', function (e) { state.fClass = e.target.value; applyFilters(); });
  $('f-path').addEventListener('change', function (e) { state.fPath = e.target.value; applyFilters(); });
  $('f-loc').addEventListener('change', function (e) { state.fLoc = e.target.value; applyFilters(); });
  $('f-algo').addEventListener('change', function (e) { state.algo = e.target.checked; applyFilters(); });
  $('f-orphan').addEventListener('change', function (e) { state.orphan = e.target.checked; applyFilters(); });
  $('f-empty').addEventListener('change', function (e) {
    state.empty = e.target.checked;
    layoutAnchors();
    if (mode === 'tree') { treeTargets(); flyTo(); startAnim(); }
    else if (sim) sim.alpha(0.5).restart();
    applyFilters();
  });

  $('l-hier').addEventListener('change', function (e) { state.hier = e.target.checked; draw(); });
  $('l-link').addEventListener('change', function (e) { state.link = e.target.checked; draw(); });
  $('l-tag').addEventListener('change', function (e) {
    state.tag = e.target.checked; computeTagEdges(); draw();
  });
  $('tag-facet').addEventListener('change', function (e) {
    state.tagFacet = e.target.value;
    if (state.tag) { computeTagEdges(); draw(); }
  });

  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      setMode(b.dataset.view);
      if (b.dataset.view === 'map') setTimeout(fitIfIdle, 900);   // tree flies itself into place
    });
  });
  document.querySelectorAll('[data-dest]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-dest]').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on'); dest = b.dataset.dest;
    });
  });

  $('reset').addEventListener('click', function () {
    if (focusNode) { exitFocus(); return; }
    nodes.forEach(function (n) { n.on = true; });
    state.q = ''; $('search').value = '';
    ['f-class', 'f-path', 'f-loc'].forEach(function (id) { $(id).value = ''; });
    ['f-algo', 'f-orphan'].forEach(function (id) { $(id).checked = false; });
    state.fClass = state.fPath = state.fLoc = ''; state.algo = state.orphan = false;
    applyFilters(); fit();
  });

  $('panel-toggle').addEventListener('click', function () {
    document.body.classList.toggle('panel-hidden');
    $('panel').classList.toggle('hidden');
    setTimeout(fitIfIdle, 220);
  });
  if (window.innerWidth < 900) {
    document.body.classList.add('panel-hidden');
    $('panel').classList.add('hidden');
  }

  var d = new Date(G.meta.built);
  $('stamp').textContent = 'updated ' + d.toLocaleDateString('en-NZ',
    { day: 'numeric', month: 'short', year: 'numeric' });
  $('fullscreen').href = window.location.href.split('#')[0];
}

/* Minimal handle for debugging and for driving the map from the console. */
window.__atlas = {
  view: view,
  fit: function () { fit(); },
  state: function () {
    return { mode: mode, focus: focusNode && focusNode.title, k: view.k,
             visible: nodes.filter(function (n) { return n.on; }).length,
             usable: usable(), edges: focusEdges.length };
  },
  want: function () { return computeFit(true); },
  focusByTitle: function (t) {
    var n = nodes.filter(function (m) { return m.title.toLowerCase().indexOf(t.toLowerCase()) >= 0; })[0];
    if (n) setFocus(n, true);
    return n && n.title;
  },
};

/* ---------- go ---------- */
window.addEventListener('resize', resize);

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && focusNode) { e.preventDefault(); focusBack(); }
});

cv.addEventListener('dblclick', function (e) {
  var n = pick(e.clientX, e.clientY);
  if (n && n.type === 'n') { e.preventDefault(); openInNotion(n); }
});

fetch('data/graph.json?t=' + Date.now())
  .then(function (r) { return r.json(); })
  .then(function (g) {
    $('loading').remove();
    build(g);
    wireUI();
    resize();
    applyFilters();
    setTimeout(fitIfIdle, 1400);
  })
  .catch(function (err) {
    $('loading').textContent = 'Could not load the atlas data.';
    console.error(err);
  });
})();
