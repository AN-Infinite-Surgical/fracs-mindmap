// The sampled Dark Atlas cover hues collide badly as a categorical palette:
// 13 of 20 adjacent active-course pairs sit within 15 degrees (courses 10 and 6 are 0.7 apart).
// Large courses keep their true signature hue as anchors; smaller ones relax into the gaps,
// preserving hue order so warm courses stay warm relative to each other.

const ANCHOR_MIN_NOTES = 8;   // a course this size owns its hue outright

function circDiff(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * @param {Array} courses  assembled course objects: {num, hue, count}
 * @param {Object} overrides  optional {courseNum: hue} to force a colour by hand
 * @returns {Map} courseNum -> respaced hue
 */
function respace(courses, overrides) {
  overrides = overrides || {};
  var active = courses.filter(function (c) { return c.count > 0; });
  var out = new Map();
  if (!active.length) return out;

  var pts = active.map(function (c) {
    return {
      num: c.num,
      hue: ((((overrides[c.num] != null ? overrides[c.num] : c.hue) % 360) + 360) % 360),
      fixed: overrides[c.num] != null || c.count >= ANCHOR_MIN_NOTES,
    };
  });

  var anchors = pts.filter(function (p) { return p.fixed; }).sort(function (a, b) { return a.hue - b.hue; });
  var loose = pts.filter(function (p) { return !p.fixed; });

  // No anchors: spread everything evenly, keeping hue order.
  if (!anchors.length) {
    loose.sort(function (a, b) { return a.hue - b.hue; });
    loose.forEach(function (p, i) { out.set(p.num, Math.round((i * 360 / loose.length) * 10) / 10); });
    return fill(courses, out);
  }

  anchors.forEach(function (a) { out.set(a.num, Math.round(a.hue * 10) / 10); });

  // Assign each loose course to the arc its original hue already falls in, then
  // space that arc's members evenly between its two anchors.
  var arcs = anchors.map(function (a, i) {
    var b = anchors[(i + 1) % anchors.length];
    return { a: a.hue, width: anchors.length === 1 ? 360 : (b.hue - a.hue + 360) % 360, members: [] };
  });
  loose.forEach(function (p) {
    var best = 0, bestOff = Infinity;
    arcs.forEach(function (arc, i) {
      var off = (p.hue - arc.a + 360) % 360;
      if (off < arc.width && off < bestOff) { bestOff = off; best = i; }
    });
    if (bestOff === Infinity) {                       // fell outside every arc: widest one
      best = arcs.reduce(function (m, arc, i, all) { return arc.width > all[m].width ? i : m; }, 0);
    }
    arcs[best].members.push(p);
  });

  arcs.forEach(function (arc) {
    arc.members.sort(function (x, y) {
      return ((x.hue - arc.a + 360) % 360) - ((y.hue - arc.a + 360) % 360);
    });
    var k = arc.members.length;
    arc.members.forEach(function (p, i) {
      var h = (arc.a + (arc.width * (i + 1)) / (k + 1)) % 360;
      out.set(p.num, Math.round(h * 10) / 10);
    });
  });

  return fill(courses, out);
}

function fill(courses, out) {
  courses.forEach(function (c) { if (!out.has(c.num)) out.set(c.num, c.hue); });
  return out;
}

function report(courses, map) {
  var active = courses.filter(function (c) { return c.count > 0; })
    .map(function (c) { return { num: c.num, was: c.hue, now: map.get(c.num), n: c.count }; })
    .sort(function (a, b) { return a.now - b.now; });
  var worst = 360;
  for (var i = 0; i < active.length; i++) {
    var d = circDiff(active[i].now, active[(i + 1) % active.length].now);
    if (active.length > 1) worst = Math.min(worst, d);
  }
  return { active: active, minSeparation: Math.round(worst * 10) / 10 };
}

module.exports = { respace, report, circDiff };
