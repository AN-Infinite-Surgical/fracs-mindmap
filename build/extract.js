// Link extraction from Notion blocks.
// The REST API exposes links as structure, so no regex over rendered prose is needed.

const EXTRACTOR_VERSION = 1;   // bump to force a full re-walk after changing this file

/** Blocks that can hold children AND can hold links worth following. */
const DESCEND = new Set([
  'paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'callout',
  'quote', 'column_list', 'column', 'table', 'table_row', 'synced_block',
  'heading_1', 'heading_2', 'heading_3', 'template',
]);

/** Yield every rich-text item anywhere inside a block payload (covers captions, table cells). */
function* richText(o) {
  if (Array.isArray(o)) { for (const v of o) yield* richText(v); return; }
  if (o && typeof o === 'object') {
    if (typeof o.plain_text === 'string') { yield o; return; }
    for (const v of Object.values(o)) yield* richText(v);
  }
}

function plain(rt) {
  return (rt || []).map((t) => t.plain_text).join('').trim();
}

const DASHED = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/;
const dash = (h) => h.replace(DASHED, '$1-$2-$3-$4-$5');

/**
 * Pull a page id out of a Notion URL.
 * Guards three real traps: `?pvs=25` and `?v=<viewId>` (a view id is also 32 hex),
 * `#<blockId>` fragments, and slugged URLs where stripping dashes merges slug words
 * into the id — so the match is anchored at end-of-string.
 */
function pageIdFromUrl(u) {
  if (!u) return null;
  let s = String(u);
  if (!/notion\.(so|site)|app\.notion\.com|^\//.test(s)) return null;
  s = s.split('#')[0].split('?')[0].replace(/\/$/, '');
  const m = s.replace(/-/g, '').match(/([0-9a-f]{32})$/i);
  return m ? dash(m[1].toLowerCase()) : null;
}

/** Normalise a house `## heading` to a fixed edge-type vocabulary. */
const SECTIONS = [
  ['foundation', 'Foundations'], ['exposure', 'Exposures'], ['operation', 'Operations'],
  ['operative', 'Operations'], ['evidence', 'Evidence'], ['trial', 'Evidence'],
  ['source', 'Sources'], ['reference', 'Sources'],
];
function sectionOf(heading) {
  if (!heading) return 'prose';
  const h = heading.toLowerCase();
  for (const [needle, label] of SECTIONS) if (h.indexOf(needle) === 0) return label;
  for (const [needle, label] of SECTIONS) if (h.indexOf(needle) >= 0) return label;
  return 'prose';
}

/** Every link a single block carries, without caring which block type it is. */
function linksIn(b) {
  const out = [];
  const body = b[b.type] || {};
  if (b.type === 'link_to_page' && body.type === 'page_id') {
    out.push({ id: body.page_id, via: 'link_to_page' });
  }
  if (b.type === 'child_page') out.push({ id: b.id, via: 'child_page' });
  for (const rt of richText(body)) {
    if (rt.type === 'mention' && rt.mention && rt.mention.type === 'page' && rt.mention.page) {
      out.push({ id: rt.mention.page.id, via: 'mention' });
    } else if (rt.href) {
      const id = pageIdFromUrl(rt.href);
      if (id) out.push({ id, via: 'href' });
    }
  }
  return out;
}

/**
 * Walk one page's blocks, collecting typed links.
 * @returns {{links: Array<{to:string, section:string}>, words:number, depthHit:boolean}}
 */
async function walkPage(pageId, getChildren, maxDepth = 4) {
  const links = [];
  let words = 0, depthHit = false;
  const syncedSeen = new Set();

  async function walk(blockId, section, depth) {
    if (depth > maxDepth) { depthHit = true; return; }
    const blocks = await getChildren(blockId);
    for (const b of blocks) {
      if (b.type === 'heading_2' && depth === 0) {
        section = sectionOf(plain(b.heading_2 && b.heading_2.rich_text));
      }
      if (b.type === 'synced_block') {
        const from = b.synced_block && b.synced_block.synced_from;
        const key = from ? from.block_id : b.id;
        if (syncedSeen.has(key)) continue;      // a mirror: its children duplicate the original
        syncedSeen.add(key);
      }
      for (const l of linksIn(b)) links.push({ to: dash(l.id.replace(/-/g, '')), section, via: l.via });
      for (const rt of richText(b[b.type] || {})) words += rt.plain_text.split(/\s+/).length;

      // child_page / child_database are separate pages: never inline them into the parent
      if (b.has_children && DESCEND.has(b.type)) await walk(b.id, section, depth + 1);
    }
  }

  await walk(pageId, 'prose', 0);
  return { links, words, depthHit };
}

module.exports = { walkPage, pageIdFromUrl, sectionOf, linksIn, plain, dash, EXTRACTOR_VERSION };
