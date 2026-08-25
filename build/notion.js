// Minimal Notion REST client: no npm dependencies, Node 18+ fetch.
const TOKEN = process.env.NOTION_TOKEN;
const VERSION = '2025-09-03';   // data-source model; 2022-06-28 breaks if a DB gains a 2nd source

const GAP = 360;                // ms between requests ~= 2.8 req/s (Notion's stated average is 3)
let nextSlot = 0;

class HardFail extends Error {}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function slot() {
  const now = Date.now();
  const t = Math.max(now, nextSlot);
  nextSlot = t + GAP;
  if (t > now) await sleep(t - now);
}

let stats = { requests: 0, retries: 0, soft: 0 };

async function call(path, init = {}, attempt = 0) {
  if (!TOKEN) throw new HardFail('NOTION_TOKEN is not set');
  await slot();
  stats.requests++;
  let res;
  try {
    res = await fetch('https://api.notion.com' + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
    });
  } catch (e) {
    if (attempt >= 5) throw new HardFail('network: ' + e.message);
    await sleep(2 ** attempt * 600);
    return call(path, init, attempt + 1);
  }

  if (res.status === 401) throw new HardFail('401 — NOTION_TOKEN rejected (revoked or wrong)');
  if (res.status === 429 || res.status === 529 || res.status >= 500) {
    if (attempt >= 6) throw new HardFail(res.status + ' after 6 attempts on ' + path);
    stats.retries++;
    const ra = Number(res.headers.get('retry-after')) || 0;
    const back = Math.max(ra * 1000, 2 ** attempt * 700) + Math.random() * 400;
    nextSlot = Date.now() + back;      // stall the whole bucket, not just this request
    return call(path, init, attempt + 1);
  }
  // A page the integration was never shared with, or a link to a deleted page: soft-fail.
  if (res.status === 403 || res.status === 404) { stats.soft++; return null; }
  if (!res.ok) throw new HardFail(res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}

/** A database may expose several data sources; the notes/courses DBs each have one. */
async function dataSourceId(dbId) {
  const db = await call('/v1/databases/' + dbId);
  if (!db) throw new HardFail('database ' + dbId + ' not visible — share it with the integration');
  const ds = db.data_sources && db.data_sources[0];
  if (!ds) throw new HardFail('database ' + dbId + ' exposed no data source');
  return ds.id;
}

async function queryAll(dsId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await call('/v1/data_sources/' + dsId + '/query', {
      method: 'POST', body: JSON.stringify(body),
    });
    if (!r) throw new HardFail('data source ' + dsId + ' returned nothing');
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

async function children(blockId) {
  const out = [];
  let cursor;
  do {
    const q = '/v1/blocks/' + blockId + '/children?page_size=100' +
      (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const r = await call(q);
    if (!r) return out;                       // soft-failed: treat as empty
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

module.exports = { call, dataSourceId, queryAll, children, HardFail, VERSION,
  stats: () => stats, resetStats: () => { stats = { requests: 0, retries: 0, soft: 0 }; } };
