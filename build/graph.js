// Shared graph assembly + JSON schema.
// Used by bootstrap.js (TSV, no cross-links) and build.js (Notion REST API, full).

const HEX32 = /[0-9a-f]{32}/g;
const { respace, report } = require('./palette');

/** Normalise any Notion id/url form to bare 32-hex. */
function bareId(v) {
  if (!v) return null;
  const m = String(v).replace(/-/g, '').match(HEX32);
  return m ? m[0] : null;
}

/** Parse a leading Rutherford section number out of a course title ("20. Mesenteric..." -> 20). */
function courseNumber(title) {
  const m = /^\s*(\d+)\s*\./.exec(title || '');
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {Array} notes   [{id,title,courseId,tags:{class,path,loc,vessel,op},algorithm,modified}]
 * @param {Array} courses [{id,title}]
 * @param {Object} hues   course_hues.json, keyed by course number as string
 * @param {Array} links   [{s,t,type}] cross-links; may be empty
 * @param {Object} opts   {source, crosslinks:boolean, dropped:number}
 */
function assemble(notes, courses, hues, links, opts) {
  const courseById = new Map();
  for (const c of courses) {
    const num = courseNumber(c.title);
    const h = num != null && hues[String(num)] ? hues[String(num)] : null;
    courseById.set(c.id, {
      id: c.id,
      num,
      title: c.title,
      // fall back to a neutral steel hue so a new, unmeasured course still renders
      hue: h ? Math.round(h.hue * 10) / 10 : 210,
      sat: h ? Math.round(h.sat * 100) / 100 : 0.35,
      measured: !!h,
      count: 0,
    });
  }

  const noteIds = new Set(notes.map((n) => n.id));
  const out = [];
  for (const n of notes) {
    const c = n.courseId && courseById.get(n.courseId) ? n.courseId : null;
    if (c) courseById.get(c).count++;
    out.push({
      id: n.id,
      title: n.title,
      course: c,
      tags: n.tags,
      algorithm: !!n.algorithm,
      modified: n.modified || null,
    });
  }

  // keep only edges whose endpoints are both real notes, drop self-loops, dedupe
  const seen = new Set();
  const edges = [];
  for (const l of links || []) {
    if (!noteIds.has(l.s) || !noteIds.has(l.t) || l.s === l.t) continue;
    const k = l.s + '>' + l.t;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ s: l.s, t: l.t, type: l.type || 'prose' });
  }

  const courseList = [...courseById.values()].sort(
    (a, b) => (a.num ?? 999) - (b.num ?? 999)
  );

  // Re-space colliding hues now that note counts are known (large courses keep theirs).
  const hueMap = respace(courseList, opts.hueOverrides || {});
  courseList.forEach((c) => {
    c.hueRaw = c.hue;
    c.hue = hueMap.get(c.num) ?? c.hue;
  });
  const pal = report(courseList, hueMap);

  return {
    meta: {
      built: new Date().toISOString(),
      source: opts.source,
      crosslinks: !!opts.crosslinks,
      counts: {
        notes: out.length,
        courses: courseList.length,
        coursesActive: courseList.filter((c) => c.count > 0).length,
        uncoursed: out.filter((n) => !n.course).length,
        algorithms: out.filter((n) => n.algorithm).length,
        crosslinks: edges.length,
        droppedTargets: opts.dropped || 0,
      },
      minHueSeparation: pal.minSeparation,
    },
    courses: courseList,
    notes: out,
    links: edges,
  };
}

/** Refuse to publish a graph that would poison the live map. */
function sanityCheck(graph, prev) {
  const c = graph.meta.counts;
  const errs = [];
  if (c.notes < 100) errs.push(`only ${c.notes} notes (expected >=100)`);
  if (c.courses < 20) errs.push(`only ${c.courses} courses (expected >=20)`);
  if (prev && prev.meta && prev.meta.counts) {
    const was = prev.meta.counts.notes;
    if (was && c.notes < was * 0.8)
      errs.push(`note count fell from ${was} to ${c.notes} (>20% drop)`);
  }
  return errs;
}

module.exports = { bareId, courseNumber, assemble, sanityCheck, HEX32 };
