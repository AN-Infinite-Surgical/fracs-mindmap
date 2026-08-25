# FRACS Atlas Map

An interactive map of the FRACS (VASC) 2027 Notion **Notes** database — 181 notes across 21
active courses — rebuilt nightly and embedded back into the Notion workbook.

Live: https://an-infinite-surgical.github.io/fracs-mindmap/

## What it shows

- **Course hierarchy** — each note sits with its Rutherford-numbered course. Courses are placed
  on a ring in course-number order, so the geography is fixed and learnable.
- **Cross-links** — the inline mentions written between pages: the real conceptual web.
- **Shared labels** — notes in *different* courses that share a Pathology, Anatomical Location,
  Vessel Type, Operative Type or Class of Knowledge. Weighted by inverse document frequency
  (a shared "Arterial" means little, a shared "Mesenteric Vascular Disease" means a lot) and
  capped by mutual top-3, so no page blooms into a starburst.
- **Orphans** — notes with no cross-links in or out. A revision gap-finder.

Colours are the Dark Atlas cover hues. The seven largest courses keep their exact signature hue;
smaller ones are relaxed into the gaps, because the raw sampled hues collide badly
(13 of 20 adjacent active-course pairs sat within 15 degrees).

## Rebuilding

Nightly by GitHub Actions (`.github/workflows/rebuild.yml`), incremental against
`cache/pages.json`; full rebuild on Sundays. Manual run: Actions → rebuild-map → Run workflow.

Locally:

    export NOTION_TOKEN=ntn_...
    node build/build.js            # add DRY_RUN=1 LIMIT=20 to probe without writing

The build **refuses to write** if the graph looks broken — fewer than 100 notes, a >20% drop in
note count, a >40% drop in cross-links, or more than 5% of requests soft-failing. The last good
map stays live and the workflow fails loudly instead.

`build/bootstrap.js` is the no-token path: it rebuilds nodes, hierarchy and tags from the TSVs in
`bootstrap/`, but cannot produce cross-links (those need page bodies).

## Token

A Notion **internal integration** token, stored as the repo secret `NOTION_TOKEN`.
The integration must be connected to the Notes and Courses databases — connecting it at the
workbook root covers both, since access inherits down the page tree.

To rotate: `gh secret set NOTION_TOKEN --repo AN-Infinite-Surgical/fracs-mindmap`

## Layout

    build/     notion.js (REST client) · extract.js (link parsing) · graph.js (assembly)
               palette.js (hue re-spacing) · build.js (nightly) · bootstrap.js (no-token)
    docs/      the site GitHub Pages serves — index.html, app.js, style.css, vendor/, data/
    bootstrap/ TSV export + course_hues.json
    cache/     pages.json — per-page last_edited_time and extracted links

No npm dependencies. The only vendored code is four d3 modules (17 KB) under `docs/vendor/`.
