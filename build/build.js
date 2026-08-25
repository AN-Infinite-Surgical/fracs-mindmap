#!/usr/bin/env node
// Nightly build: Notion REST API -> docs/data/graph.json (+ meta.json), with an
// incremental cache so a typical night re-walks only the pages that changed.
const fs = require('fs');
const path = require('path');
const N = require('./notion');
const X = require('./extract');
const { assemble, sanityCheck } = require('./graph');

const ROOT = path.join(__dirname, '..');

function hueOverrides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hue-overrides.json'), 'utf8')).overrides || {};
  } catch { return {}; }
}
const NOTES_DB = process.env.NOTES_DB || '987321e4-3669-83fb-aab5-81063258e984';
const COURSES_DB = process.env.COURSES_DB || '655321e4-3669-82c2-a744-816071911be4';
const FULL = /^(1|true|yes)$/i.test(process.env.FULL_REBUILD || '');
const LIMIT = Number(process.env.LIMIT || 0);           // dry-run helper
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

const CACHE = path.join(ROOT, 'cache', 'pages.json');
const OUT = path.join(ROOT, 'docs', 'data', 'graph.json');
const META = path.join(ROOT, 'docs', 'data', 'meta.json');

const flat = (id) => String(id || '').replace(/-/g, '').toLowerCase();

function prop(page, type) {
  for (const [name, p] of Object.entries(page.properties || {})) {
    if (p.type === type) return { name, p };
  }
  return null;
}
function titleOf(page) {
  const t = prop(page, 'title');
  return t ? X.plain(t.p.title) : '(untitled)';
}
function multi(page, name) {
  const p = page.properties && page.properties[name];
  return p && p.multi_select ? p.multi_select.map((o) => o.name) : [];
}
function selectOf(page, name) {
  const p = page.properties && page.properties[name];
  return p && p.select ? p.select.name : null;
}
function relationOf(page, name) {
  const p = page.properties && page.properties[name];
  return p && p.relation && p.relation.length ? flat(p.relation[0].id) : null;
}

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.extractorVersion !== X.EXTRACTOR_VERSION || c.notionVersion !== N.VERSION) {
      console.log('cache: extractor/API version changed -> full re-walk');
      return { pages: {} };
    }
    return c;
  } catch { return { pages: {} }; }
}

async function main() {
  const t0 = Date.now();
  console.log('resolving data sources…');
  const [notesDs, coursesDs] = await Promise.all([
    N.dataSourceId(NOTES_DB), N.dataSourceId(COURSES_DB),
  ]);

  const [noteRows, courseRows] = await Promise.all([
    N.queryAll(notesDs), N.queryAll(coursesDs),
  ]);
  console.log('rows: ' + noteRows.length + ' notes, ' + courseRows.length + ' courses');

  const courses = courseRows.map((r) => ({ id: flat(r.id), title: titleOf(r) }));

  let notes = noteRows.map((r) => ({
    id: flat(r.id),
    title: titleOf(r),
    courseId: relationOf(r, 'Course'),
    tags: {
      class: multi(r, 'Class of Knowledge'),
      path: multi(r, 'Pathology'),
      loc: multi(r, 'Anatomical Location'),
      vessel: multi(r, 'Vessel Type'),
      op: multi(r, 'Operative Type'),
    },
    algorithm: !!selectOf(r, 'Algorithm'),
    modified: r.last_edited_time,
  }));
  if (LIMIT) notes = notes.slice(0, LIMIT);

  const noteIds = new Set(notes.map((n) => n.id));
  const cache = FULL ? { pages: {} } : loadCache();
  let walked = 0, reused = 0, depthHits = 0;

  for (const n of notes) {
    const hit = cache.pages[n.id];
    if (hit && hit.edited === n.modified) { reused++; continue; }
    const r = await X.walkPage(n.id, N.children);
    cache.pages[n.id] = {
      edited: n.modified,
      words: r.words,
      links: r.links.map((l) => ({ to: flat(l.to), section: l.section })),
    };
    if (r.depthHit) depthHits++;
    walked++;
    if (walked % 20 === 0) console.log('  walked ' + walked + '…');
  }
  for (const id of Object.keys(cache.pages)) if (!noteIds.has(id)) delete cache.pages[id];

  // links -> edges, keeping only note-to-note, deduped with a section label
  const links = [];
  let dropped = 0;
  for (const n of notes) {
    const seen = new Set();
    for (const l of (cache.pages[n.id] || {}).links || []) {
      if (l.to === n.id) continue;
      if (!noteIds.has(l.to)) { dropped++; continue; }     // nested child page or a course
      if (seen.has(l.to)) continue;
      seen.add(l.to);
      links.push({ s: n.id, t: l.to, type: l.section });
    }
  }

  const graph = assemble(notes, courses, JSON.parse(
    fs.readFileSync(path.join(ROOT, 'bootstrap', 'course_hues.json'), 'utf8')
  ), links, { source: 'notion-api', crosslinks: true, dropped, hueOverrides: hueOverrides() });

  const s = N.stats();
  graph.meta.build = {
    walked, reused, dropped, depthHits,
    requests: s.requests, retries: s.retries, softFails: s.soft,
    durationMs: Date.now() - t0,
    mode: FULL ? 'full' : 'incremental',
  };

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const errs = sanityCheck(graph, prev);
  if (prev && prev.meta.crosslinks && graph.meta.counts.crosslinks < prev.meta.counts.crosslinks * 0.6) {
    errs.push('cross-links fell from ' + prev.meta.counts.crosslinks +
              ' to ' + graph.meta.counts.crosslinks + ' (>40% drop)');
  }
  if (s.requests && s.soft / s.requests > 0.05) {
    errs.push(s.soft + ' of ' + s.requests + ' requests soft-failed (>5%) — check integration access');
  }
  if (errs.length) {
    console.error('REFUSING TO WRITE — the live map keeps its last good version:');
    errs.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }

  console.log(JSON.stringify(graph.meta, null, 2));
  if (DRY) { console.log('dry run: nothing written'); return; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(graph));
  fs.writeFileSync(META, JSON.stringify({
    builtAt: graph.meta.built, counts: graph.meta.counts, build: graph.meta.build,
  }, null, 2));
  cache.extractorVersion = X.EXTRACTOR_VERSION;
  cache.notionVersion = N.VERSION;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
