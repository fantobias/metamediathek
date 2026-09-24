// GET /api/tipps — Empfehlungen aus Filmkritik & Community, abgeglichen mit den Mediatheken.
//
// Quellen (öffentliche RSS-Feeds, Stand 24.09.2026 geprüft):
//   • filmdienst.de „Sehenswert in Mediatheken" (Filmkritik, ~20 aktuelle Tipps)
//   • Mediathekperlen (Blog auf nexxtpress.de, fast täglich neue Film-Tipps)
// Übernommen werden NUR Titel, Jahr, Datum und der Link zur Kritik — keine fremden
// Texte (Urheberrecht). Jeder Tipp wird gegen den eigenen Index + MVW abgeglichen;
// ausgeliefert werden nur Tipps, die gerade tatsächlich abrufbar sind (Vorgabe Tobi, 24.09.).
//
// Cache: fertiges Ergebnis 24 h am Cloudflare-Rand; älter als 3 h → sofort die alte
// Fassung ausliefern und im Hintergrund neu bauen (stale-while-revalidate).

import { titleBatchQuery } from './mediathek.js';

const SOURCES = [
  { id: 'filmdienst', name: 'filmdienst', home: 'https://www.filmdienst.de/heimkino/tv-mediatheken', feed: 'https://www.filmdienst.de/rss/mediatheken', max: 20 },
  { id: 'perlen', name: 'Mediathekperlen', home: 'https://nexxtpress.de/author/mediathekperlen/', feed: 'https://nexxtpress.de/author/mediathekperlen/feed/', max: 28 },
];
const CACHE_KEY = 'https://mm-cache.local/tipps/v2';
const FRESH_MS = 3 * 3600 * 1000;
const MIN_DURATION = 25 * 60; // Trailer/Clips raus, Dokus (ab ~30 min) bleiben drin

export async function onRequestGet(context) {
  const cache = caches.default;
  const key = new Request(CACHE_KEY);
  const force = new URL(context.request.url).searchParams.has('refresh');
  let hit = null;
  try { hit = force ? null : await cache.match(key); } catch (e) {}
  if (hit) {
    const age = Date.now() - Number(hit.headers.get('x-mm-built') || 0);
    if (age > FRESH_MS) context.waitUntil(build(context.env).then((b) => store(cache, key, b)).catch(() => {}));
    return out(await hit.text(), age > FRESH_MS ? 'stale' : 'hit');
  }
  const body = await build(context.env);
  context.waitUntil(store(cache, key, body));
  return out(body, 'miss');
}

function out(text, state) {
  return new Response(text, { status: 200, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-mm-cache': state,
  } });
}
async function store(cache, key, body) {
  // Leere Ergebnisse (beide Feeds weg) nur kurz halten
  const n = (() => { try { return JSON.parse(body).items.length; } catch { return 0; } })();
  await cache.put(key, new Response(body, { headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + (n ? 86400 : 600), 'x-mm-built': String(Date.now()),
  } }));
}

// ─── Feeds lesen ───
async function fetchText(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MetaMediathek/1.0 (+https://metamediathek.pages.dev)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unent(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? unent(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim() : '';
}
function parseFeed(xml, src) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, src.max);
  return items.map((it) => {
    const raw = tag(it, 'title');
    const link = tag(it, 'link');
    const date = Date.parse(tag(it, 'pubDate')) || 0;
    const cats = [...it.matchAll(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g)].map((m) => unent(m[1]).trim());
    let title = raw, year = 0, serie = false;
    if (src.id === 'perlen') {
      // Format: „Regie – „Titel" (Jahr)"
      const m = raw.match(/„(.+?)“/);
      if (m) title = m[1];
      const y = raw.match(/\((\d{4})\)\s*$/);
      if (y) year = +y[1];
      serie = cats.some((c) => /^(mini)?serie$/i.test(c));
    } else {
      serie = /-serie-/.test(link);
    }
    return { title: title.trim(), year, serie, src: src.id, link, date };
  }).filter((t) => t.title && /^https:\/\//.test(t.link));
}

// ─── Abgleich ───
// Titel-Schlüssel: Kleinbuchstaben, ß→ss, Anführungszeichen/Gedankenstriche vereinheitlicht
export function tkey(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[„“”"«»‹›‚‘’']/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}
const VARIANT_RE = /\s*\((mit\s+)?(untertiteln?|audiodeskription|h(ö|oe)rfassung|originalversion|originalfassung|original|omu|ov|dgs|geb(ä|ae)rdensprache|leichte\s+sprache|englisch|english|franz(ö|oe)sisch)[^)]*\)\s*$/i;
function isVariant(title) { return VARIANT_RE.test(title || ''); }
// Fassung mit Audiodeskription steckt bei 3sat/ZDF oft nur im Dateinamen ("…_mit_ad_…")
function variantRank(r) { return (isVariant(r.title) ? 2 : 0) + (/_mit_ad_|audiodeskription/i.test(String(r.url_video || '')) ? 1 : 0); }
// Passt der Sendungstitel zum Tipp? Exakt, oder der Tipp-Titel gefolgt von einem
// Trenner (" - Spielfilm, USA 1974", " (Audiodeskription)", " | …"). SRF: «Titel» – …
export function titleMatches(tippKey, itemTitle) {
  let t = String(itemTitle || '');
  const srf = t.match(/^«(.+?)»/);
  if (srf) t = srf[1];
  const k = tkey(t);
  if (k === tippKey) return true;
  if (!k.startsWith(tippKey)) return false;
  const rest = k.slice(tippKey.length);
  return /^( - | \(| \| |: )/.test(rest);
}
function yearOk(tipp, item) {
  if (!tipp.year) return true;
  const years = (String(item.title || '') + ' ' + String(item.description || '')).match(/\b(19[0-9]{2}|20[0-2][0-9])\b/g);
  if (!years) return true; // keine Jahresangabe → nicht widerlegbar
  return years.some((y) => Math.abs(+y - tipp.year) <= 1);
}
function pickMatch(tipp, pool) {
  const k = tkey(tipp.title);
  let c;
  if (tipp.serie) {
    c = pool.filter((r) => tkey(r.topic) === k || titleMatches(k, r.topic));
    // Serie: älteste Folge zuerst (meist Folge 1)
    c.sort((a, b) => (variantRank(a) - variantRank(b)) || ((a.timestamp || 0) - (b.timestamp || 0)));
  } else {
    c = pool.filter((r) => (r.duration || 0) >= MIN_DURATION && titleMatches(k, r.title) && yearOk(tipp, r));
    c.sort((a, b) => (variantRank(a) - variantRank(b)) || ((b.timestamp || 0) - (a.timestamp || 0)));
  }
  return c[0] || null;
}
const KEEP = ['channel', 'topic', 'title', 'timestamp', 'duration', 'url_website', 'url_video', 'url_video_hd', 'url_video_low', 'url_subtitle', 'id', 'image', 'available_to'];

async function tmdbImage(env, t) {
  if (!env || !env.TMDB_API_KEY) return undefined;
  try {
    const kind = t.serie ? 'tv' : 'movie';
    const u = new URL('https://api.themoviedb.org/3/search/' + kind);
    u.searchParams.set('api_key', env.TMDB_API_KEY);
    u.searchParams.set('language', 'de-DE');
    u.searchParams.set('query', t.title);
    if (t.year) u.searchParams.set(kind === 'tv' ? 'first_air_date_year' : 'year', String(t.year));
    const d = JSON.parse(await fetchText(u.toString(), 5000));
    const hit = (d.results || []).find((r) => tkey(r.title || r.name) === tkey(t.title) || tkey(r.original_title || r.original_name) === tkey(t.title));
    const p = hit && (hit.backdrop_path || hit.poster_path);
    return p ? 'https://image.tmdb.org/t/p/w500' + p : undefined;
  } catch (e) { return undefined; }
}

async function build(env) {
  const srcState = {};
  const lists = await Promise.all(SOURCES.map(async (s) => {
    try { const l = parseFeed(await fetchText(s.feed), s); srcState[s.id] = l.length; return l; }
    catch (e) { srcState[s.id] = 'Fehler: ' + String(e.message || e).slice(0, 60); return []; }
  }));
  // Zusammenführen: gleicher Titel aus beiden Quellen = ein Tipp mit zwei Belegen
  const byKey = new Map();
  for (const t of lists.flat()) {
    const k = tkey(t.title);
    const cur = byKey.get(k);
    const ref = { id: t.src, link: t.link, date: t.date };
    if (cur) { if (!cur.refs.some((r) => r.id === t.src)) cur.refs.push(ref); cur.date = Math.max(cur.date, t.date); cur.year ||= t.year; cur.serie ||= t.serie; }
    else byKey.set(k, { title: t.title, year: t.year, serie: t.serie, date: t.date, refs: [ref] });
  }
  const tipps = [...byKey.values()].sort((a, b) => b.date - a.date);

  // Kandidaten holen: je 10 Titel eine Batch-Abfrage (Index + MVW), 3 gleichzeitig
  const chunks = [];
  for (let i = 0; i < tipps.length; i += 10) chunks.push(tipps.slice(i, i + 10));
  const pools = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += 3) {
    await Promise.all(chunks.slice(i, i + 3).map(async (ch, j) => {
      try {
        const r = await titleBatchQuery(env, { titleBatch: ch.map((t) => t.title), perTitle: 8, future: false, duration_min: 0 });
        pools[i + j] = r.result.results || [];
      } catch (e) { pools[i + j] = []; }
    }));
  }
  const items = [];
  chunks.forEach((ch, ci) => {
    for (const t of ch) {
      const m = pickMatch(t, pools[ci] || []);
      if (!m) continue;
      const item = {};
      for (const f of KEEP) if (m[f] !== undefined && m[f] !== null && m[f] !== '') item[f] = m[f];
      items.push({ title: t.title, year: t.year || null, serie: t.serie, date: t.date, refs: t.refs, item });
    }
  });
  // Bild für Treffer ohne Sender-Bild (3sat-Seiten liefern oft kein og:image):
  // TMDB-Szenenbild (16:9) über Titel + Jahr. Fail-soft — ohne Key/Treffer bleibt der Platzhalter.
  const needImg = items.filter((x) => !x.item.image).slice(0, 20);
  for (let i = 0; i < needImg.length; i += 6) {
    await Promise.all(needImg.slice(i, i + 6).map(async (x) => { x.img = await tmdbImage(env, x); }));
  }
  return JSON.stringify({
    built: Date.now(),
    sources: SOURCES.map((s) => ({ id: s.id, name: s.name, home: s.home, read: srcState[s.id] })),
    total: tipps.length,
    items,
  });
}
