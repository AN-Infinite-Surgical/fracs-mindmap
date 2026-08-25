#!/usr/bin/env node
// First-build path: assembles the graph from TSVs exported via the Notion MCP connector.
// Produces every layer except cross-links (which need page bodies -> build.js + a token).
const fs = require('fs');
const path = require('path');
const { bareId, assemble } = require('./graph');

const ROOT = path.join(__dirname, '..');

function hueOverrides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hue-overrides.json'), 'utf8')).overrides || {};
  } catch { return {}; }
}
const B = path.join(ROOT, 'bootstrap');

const jsonArr = (s) => {
  if (!s || !s.trim()) return [];
  try { return JSON.parse(s); } catch { return []; }
};

const noteRows = fs.readFileSync(path.join(B, 'notes.tsv'), 'utf8')
  .split('\n').filter((l) => l.trim());
const courseRows = fs.readFileSync(path.join(B, 'courses.tsv'), 'utf8')
  .split('\n').filter((l) => l.trim());
const hues = JSON.parse(fs.readFileSync(path.join(B, 'course_hues.json'), 'utf8'));

const courses = courseRows.map((l) => {
  const [id, title] = l.split('\t');
  return { id: bareId(id), title };
});

const notes = noteRows.map((l) => {
  const f = l.split('\t');
  const [id, title, course, klass, pathology, loc, vessel, op, algo, modified] = f;
  return {
    id: bareId(id),
    title,
    courseId: bareId(jsonArr(course)[0]),
    tags: {
      class: jsonArr(klass),
      path: jsonArr(pathology),
      loc: jsonArr(loc),
      vessel: jsonArr(vessel),
      op: jsonArr(op),
    },
    algorithm: !!(algo && algo.trim()),
    modified: modified ? modified.trim() : null,
  };
});

const graph = assemble(notes, courses, hues, [], {
  source: 'bootstrap-mcp',
  crosslinks: false,
  hueOverrides: hueOverrides(),
});

const out = path.join(ROOT, 'docs', 'data', 'graph.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(graph));
console.log('wrote', out);
console.log(JSON.stringify(graph.meta.counts, null, 2));
