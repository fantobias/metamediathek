// /api/stream — Stream-Auflösung für den In-App-Player (seit v2026-09-24.2)
//
// POST {url_website, id?, channel?, alts?:[{variant,url_video,url_video_hd,url_subtitle}]}
//   → { ok, source, title?, variants:[{id,label,hls?,mp4:[{q,url}]}], subtitles:[{lang,label,url}],
//       blocked?:'fsk'|'geo', message? }
// GET  ?sub=<url>  → Untertitel als WebVTT (TTML/EBU-TT wird konvertiert), gleicher Origin,
//                    damit das <video> ohne crossorigin-Attribut auskommt.
//
// Quellen (empirisch geprüft 24.09.2026):
//   ARD  api.ardmediathek.de page-gateway item → mediaCollection (MP4+HLS je Tonspur, WebVTT)
//   ZDF  api.zdf.de content (profile=player2) → ptmd (HLS/MP4 je Tonspur-Klasse, WebVTT)
//   SRF  il.srgssr.ch mediaComposition byUrn (HLS, VTT)
//   arte api.arte.tv player/v2/config (HLS je Sprachfassung; UT eingebrannt) — ohne CORS,
//        deshalb nur serverseitig; geo-abhängig von der Edge-IP
//   sonst: Direktlinks aus MVW (url_video/_hd/url_subtitle), inkl. Fassungen (alts)
// Jeder Fehler endet in {ok:false} bzw. Direktlink-Fallback — der Client öffnet dann die
// Sender-Seite wie bisher.

const UA = 'Mozilla/5.0 (compatible; MetaMediathek/1.0; +https://metamediathek.pages.dev)';
const ZDF_TOKENS = ['aa3noh4ohz9eeboo8shiesheec9ciequ9Quah7el', 'ahBaeMeekaiy5ohsai4bee4ki6Oopoi5quailieb'];

const SUB_HOSTS = ['ardmediathek.de', 'zdf.de', 'srf.ch', 'orf.at', 'arte.tv', '3sat.de', 'daserste.de',
  'br.de', 'ndr.de', 'wdr.de', 'swr.de', 'mdr.de', 'hr.de', 'rbb-online.de', 'kika.de', 'phoenix.de', 'dw.com'];

const VARIANT_LABELS = {
  standard: 'Standard', main: 'Standard', ad: 'Audiodeskription', 'audio-description': 'Audiodeskription',
  ot: 'Originalton', ov: 'Originalton', 'original-language': 'Originalton', ks: 'Klare Sprache',
  dgs: 'Gebärdensprache', 'sign-language': 'Gebärdensprache', ut: 'Mit Untertiteln', omu: 'OmU (Original mit UT)',
  leicht: 'Leichte Sprache'
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });
}

function hostOk(h, list) { return list.some((a) => h === a || h.endsWith('.' + a)); }

async function getJson(url, init = {}, ttl = 300) {
  const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${new URL(url).hostname}`); e.status = r.status; throw e; }
  return r.json();
}

const subProxy = (u) => (u ? '/api/stream?sub=' + encodeURIComponent(u) : '');
const qLabel = (px) => (px >= 1080 ? '1080p' : px >= 720 ? '720p' : px >= 540 ? '540p' : px >= 360 ? '360p' : px ? px + 'p' : 'Standard');

// ─── ARD ───────────────────────────────────────────────────────────────
async function resolveArd(id) {
  const d = await getJson(`https://api.ardmediathek.de/page-gateway/pages/ard/item/${encodeURIComponent(id)}?devicetype=pc&embedded=true&mcV6=true`);
  const w = (d.widgets || []).find((x) => x && ('mediaCollection' in x)) || (d.widgets || [])[0] || {};
  const mc = w.mediaCollection && (w.mediaCollection.embedded || w.mediaCollection);
  if (!mc || !Array.isArray(mc.streams)) {
    if (w.blockedByFsk) return { ok: false, blocked: 'fsk', message: 'Aus Jugendschutzgründen nur zwischen 22 und 6 Uhr abrufbar.' };
    if (w.geoblocked) return { ok: false, blocked: 'geo', message: 'Nur in Deutschland abrufbar.' };
    return { ok: false, message: 'Kein Stream verfügbar.' };
  }
  const byKind = new Map();
  for (const st of mc.streams) {
    const streamKind = st.kind || 'main'; // main | sign-language | ...
    for (const m of st.media || []) {
      const audio = (m.audios && m.audios[0] && m.audios[0].kind) || 'standard';
      const vid = streamKind === 'main' ? (audio === 'audio-description' ? 'ad' : audio === 'original-language' ? 'ot' : 'standard') : (streamKind === 'sign-language' ? 'dgs' : streamKind);
      if (!byKind.has(vid)) byKind.set(vid, { id: vid, label: VARIANT_LABELS[vid] || vid, hls: '', mp4: [] });
      const v = byKind.get(vid);
      if (/mpegurl/i.test(m.mimeType || '')) { if (!v.hls) v.hls = m.url; }
      else if (/mp4/i.test(m.mimeType || '')) v.mp4.push({ q: qLabel(m.maxHResolutionPx ? Math.round(m.maxHResolutionPx * 9 / 16) : 0), px: m.maxHResolutionPx || 0, url: m.url });
    }
  }
  const variants = [...byKind.values()].map((v) => ({ ...v, mp4: v.mp4.sort((a, b) => b.px - a.px).map(({ q, url }) => ({ q, url })) }));
  variants.sort((a, b) => (a.id === 'standard' ? -1 : b.id === 'standard' ? 1 : 0));
  const subtitles = [];
  for (const s of mc.subtitles || []) {
    const src = (s.sources || []).find((x) => x.kind === 'webvtt') || (s.sources || [])[0];
    if (src && src.url) subtitles.push({ lang: (s.languageCode || 'deu').slice(0, 2), label: 'Deutsch', url: subProxy(src.url) });
  }
  return { ok: variants.length > 0, source: 'ard', variants, subtitles, title: w.title || '' };
}

// ─── ZDF ───────────────────────────────────────────────────────────────
async function zdfGet(url) {
  let last;
  for (const t of ZDF_TOKENS) {
    try { return await getJson(url, { headers: { 'Api-Auth': 'Bearer ' + t } }); } catch (e) { last = e; }
  }
  throw last;
}
async function resolveZdf(canonical) {
  const doc = await zdfGet(`https://api.zdf.de/content/documents/${encodeURIComponent(canonical)}.json?profile=player2`);
  const tpl = doc?.mainVideoContent?.['http://zdf.de/rels/target']?.['http://zdf.de/rels/streams/ptmd-template'];
  if (!tpl) return { ok: false, message: 'Kein ZDF-Stream gefunden.' };
  const p = await zdfGet('https://api.zdf.de' + tpl.replace('{playerId}', 'ngplayer_2_4'));
  const QRANK = { fhd: 5, uhd: 6, hd: 4, veryhigh: 3, high: 2, med: 1, low: 0, auto: 7 };
  const byClass = new Map();
  for (const pl of p.priorityList || []) {
    for (const f of pl.formitaeten || []) {
      const isHls = /mpegurl/i.test(f.mimeType || '');
      const isMp4 = /video\/mp4/i.test(f.mimeType || '');
      if (!isHls && !isMp4) continue;
      for (const q of f.qualities || []) {
        for (const t of (q.audio && q.audio.tracks) || []) {
          const cls = t.class === 'main' ? 'standard' : t.class; // main | ad | ot | ks | dgs
          if (!byClass.has(cls)) byClass.set(cls, { id: cls, label: VARIANT_LABELS[cls] || cls, hls: '', hlsRank: -1, mp4: [] });
          const v = byClass.get(cls);
          const rank = QRANK[q.quality] ?? 0;
          if (isHls && rank > v.hlsRank) { v.hls = t.uri; v.hlsRank = rank; }
          if (isMp4) v.mp4.push({ q: ({ uhd: 'UHD', fhd: 'Full HD', hd: 'HD', veryhigh: 'Sehr hoch', high: 'Hoch', med: 'Mittel', low: 'Niedrig' })[q.quality] || q.quality, rank, url: t.uri });
        }
      }
    }
  }
  const variants = [...byClass.values()].map((v) => ({ id: v.id, label: v.label, hls: v.hls, mp4: v.mp4.sort((a, b) => b.rank - a.rank).map(({ q, url }) => ({ q, url })) }));
  variants.sort((a, b) => (a.id === 'standard' ? -1 : b.id === 'standard' ? 1 : 0));
  const subtitles = (p.captions || []).filter((c) => /vtt/i.test(c.format || '')).map((c) => ({
    lang: (c.language || 'deu').slice(0, 2), label: c.class === 'hoh' ? 'Deutsch (für Hörgeschädigte)' : 'Deutsch', url: subProxy(c.uri)
  }));
  return { ok: variants.length > 0, source: 'zdf', variants, subtitles };
}

// ─── SRF ───────────────────────────────────────────────────────────────
async function resolveSrf(urn) {
  const d = await getJson(`https://il.srgssr.ch/integrationlayer/2.0/mediaComposition/byUrn/${encodeURIComponent(urn)}.json`);
  const ch = (d.chapterList || []).find((c) => c.urn === urn) || (d.chapterList || [])[0];
  if (!ch) return { ok: false, message: 'Kein SRF-Stream gefunden.' };
  if (ch.blockReason) return { ok: false, blocked: /GEO/i.test(ch.blockReason) ? 'geo' : 'other', message: /GEO/i.test(ch.blockReason) ? 'Nur in der Schweiz abrufbar.' : 'Beim Sender derzeit gesperrt.' };
  const res = (ch.resourceList || []).filter((r) => !r.drmList || !r.drmList.length);
  const hls = res.filter((r) => r.streaming === 'HLS').sort((a, b) => (b.quality === 'HD') - (a.quality === 'HD'))[0];
  const mp4 = res.filter((r) => r.streaming === 'PROGRESSIVE').map((r) => ({ q: r.quality === 'HD' ? '720p' : '360p', url: (r.url || '').replace(/^http:/, 'https:') }));
  const subtitles = (ch.subtitleList || []).filter((s) => s.format === 'VTT').map((s) => ({ lang: (s.locale || 'de').slice(0, 2), label: s.locale === 'de' ? 'Deutsch' : (s.locale || 'Untertitel'), url: subProxy(s.url) }));
  const variants = (hls || mp4.length) ? [{ id: 'standard', label: 'Standard', hls: hls ? hls.url : '', mp4 }] : [];
  return { ok: variants.length > 0, source: 'srf', variants, subtitles };
}

// ─── arte ──────────────────────────────────────────────────────────────
async function resolveArte(programId) {
  const d = await getJson(`https://api.arte.tv/api/player/v2/config/de/${encodeURIComponent(programId)}`);
  const att = (d.data && d.data.attributes) || {};
  const streams = att.streams || [];
  if (!streams.length) {
    const geo = att.restriction && att.restriction.geoblocking;
    return { ok: false, blocked: geo && geo.restrictedArea ? 'geo' : 'other', message: geo && geo.restrictedArea ? 'arte gibt dieses Video für den aktuellen Standort nicht frei.' : 'Kein arte-Stream verfügbar.' };
  }
  const variants = [];
  const seen = new Set();
  for (const s of streams) {
    if (!/hls/i.test(s.protocol || '') && !/m3u8/.test(s.url || '')) continue;
    const v = (s.versions && s.versions[0]) || {};
    const id = (v.eStat && v.eStat.ml5) || v.shortLabel || v.label || String(variants.length);
    if (seen.has(id)) continue;
    seen.add(id);
    variants.push({ id, label: v.label || v.shortLabel || id, hls: s.url, mp4: [] });
  }
  return { ok: variants.length > 0, source: 'arte', variants, subtitles: [] };
}

// ─── Direktlinks (MVW) ────────────────────────────────────────────────
function resolveDirect(body) {
  const alts = Array.isArray(body.alts) && body.alts.length ? body.alts : [body];
  const variants = [];
  const subtitles = [];
  for (const a of alts.slice(0, 8)) {
    const hd = a.url_video_hd || '', sd = a.url_video || '';
    const urls = [hd, sd].filter((u, i, arr) => /^https?:\/\//.test(u) && arr.indexOf(u) === i);
    if (!urls.length) continue;
    const vid = a.variant || 'standard';
    const isHls = (u) => /\.m3u8(\?|$)/i.test(u);
    const hls = urls.find(isHls) || '';
    const mp4 = urls.filter((u) => !isHls(u)).map((u, i) => ({ q: i === 0 && hd && u === hd ? 'HD' : 'SD', url: u.replace(/^http:/, 'https:') }));
    variants.push({ id: vid, label: VARIANT_LABELS[vid] || a.variantLabel || vid, hls, mp4 });
    if (a.url_subtitle && !subtitles.length) subtitles.push({ lang: 'de', label: 'Deutsch', url: subProxy(a.url_subtitle) });
  }
  return { ok: variants.length > 0, source: 'direct', variants, subtitles };
}

// ─── Untertitel: TTML/EBU-TT → WebVTT ─────────────────────────────────
function ttmlTime(t, tickRate, frameRate) {
  if (!t) return 0;
  let m;
  if ((m = t.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +('0.' + m[4]) : 0);
  if ((m = t.match(/^(\d+):(\d{2}):(\d{2}):(\d+)$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / frameRate;
  if ((m = t.match(/^([\d.]+)(h|m|s|ms|t|f)$/))) {
    const v = +m[1];
    return { h: v * 3600, m: v * 60, s: v, ms: v / 1000, t: v / tickRate, f: v / frameRate }[m[2]];
  }
  return 0;
}
function vttTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), mi = Math.floor(ms / 60000) % 60, se = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
}
export function ttmlToVtt(xml) {
  const tick = +(xml.match(/tickRate="(\d+)"/) || [])[1] || 10000000;
  const fps = +(xml.match(/frameRate="(\d+)"/) || [])[1] || 25;
  const out = ['WEBVTT', ''];
  const re = /<(?:tt:)?p\b([^>]*)>([\s\S]*?)<\/(?:tt:)?p>/g;
  let m, n = 0;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const b = (attrs.match(/\bbegin="([^"]+)"/) || [])[1];
    const e = (attrs.match(/\bend="([^"]+)"/) || [])[1];
    const dur = (attrs.match(/\bdur="([^"]+)"/) || [])[1];
    if (!b) continue;
    const start = ttmlTime(b, tick, fps);
    const end = e ? ttmlTime(e, tick, fps) : start + ttmlTime(dur, tick, fps);
    const text = decodeEntities(m[2].replace(/<(?:tt:)?br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/<br\s*\/?>/gi, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    if (!text || end <= start) continue;
    out.push(String(++n), `${vttTime(start)} --> ${vttTime(end)}`, text, '');
  }
  return out.join('\n');
}

async function serveSubtitle(context, target) {
  let t;
  try { t = new URL(target); } catch (e) { return new Response('Ungültige URL', { status: 400 }); }
  if (!/^https?:$/.test(t.protocol) || !hostOk(t.hostname, SUB_HOSTS) && !/\.akamaihd\.net$|\.akamaized\.net$|amazonaws\.com$/.test(t.hostname)) {
    return new Response('Host nicht erlaubt', { status: 403 });
  }
  // ARD liefert dieselbe Untertitel-URN auch als WebVTT — spart die Konvertierung
  if (/api\.ardmediathek\.de$/.test(t.hostname) && t.pathname.includes('/subtitle/ebutt/')) {
    t = new URL(t.toString().replace('/subtitle/ebutt/', '/subtitle/webvtt/') + (t.pathname.endsWith('.vtt') ? '' : '.vtt'));
  }
  const cache = caches.default;
  const key = new Request('https://mm-cache.local/sub?u=' + encodeURIComponent(t.toString()));
  const hit = await cache.match(key);
  if (hit) return hit;
  let body = '';
  try {
    const r = await fetch(t.toString().replace(/^http:/, 'https:'), { headers: { 'User-Agent': UA } });
    if (!r.ok) return new Response('Untertitel nicht abrufbar', { status: 502 });
    body = await r.text();
  } catch (e) { return new Response('Untertitel nicht abrufbar', { status: 502 }); }
  const vtt = /^﻿?WEBVTT/.test(body) ? body : ttmlToVtt(body);
  const res = new Response(vtt, { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  try { context.waitUntil(cache.put(key, res.clone())); } catch (e) {}
  return res;
}

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const sub = u.searchParams.get('sub');
  if (sub) return serveSubtitle(context, sub);
  return json({ ok: false, message: 'POST erwartet' }, 405);
}

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch (e) { return json({ ok: false, message: 'Ungültige Anfrage' }, 400); }
  const web = String(body.url_website || '');
  let host = '', url = null;
  try { url = new URL(web); host = url.hostname; } catch (e) {}

  let resolved = null, tried = '';
  try {
    if (/(^|\.)ardmediathek\.de$/.test(host)) {
      const m = url.pathname.match(/\/video\/(?:[^/]+\/)*([A-Za-z0-9_-]{20,})\/?$/);
      if (m) {
        tried = 'ard';
        try { resolved = await resolveArd(m[1]); }
        catch (e) {
          if (e.status !== 404) throw e;
          // Beitrag existiert bei der ARD nicht mehr (depubliziert/zurückgezogen, Feedback
          // 24.09. „läuft weder über Abspielen noch über Sender"). Ehrliche Meldung und den
          // toten Eintrag aus dem eigenen Index entfernen — der tägliche Depub-Sweep kommt
          // sonst erst Stunden später; taucht der Beitrag wieder auf, crawlt ihn der Crawler neu.
          resolved = { ok: false, blocked: 'gone', message: 'Dieser Beitrag ist in der ARD-Mediathek nicht mehr verfügbar.' };
          const db = context.env && context.env.INDEX_DB;
          if (db) { try { context.waitUntil(db.prepare('DELETE FROM entries WHERE id = ?').bind(m[1]).run().catch(() => {})); } catch (e2) {} }
        }
      }
    } else if (/(^|\.)zdf\.de$/.test(host)) {
      const seg = url.pathname.replace(/\.html$/, '').split('/').filter(Boolean).pop();
      const canonical = /^[a-z0-9-]+$/.test(String(body.id || '')) ? body.id : seg;
      if (canonical) { tried = 'zdf'; resolved = await resolveZdf(canonical); }
    } else if (/(^|\.)srf\.ch$/.test(host)) {
      const urn = (String(body.id || '').startsWith('urn:srf:') ? body.id : '') || url.searchParams.get('urn') || '';
      if (urn) { tried = 'srf'; resolved = await resolveSrf(urn); }
    } else if (/(^|\.)arte\.tv$/.test(host)) {
      const m = url.pathname.match(/\/videos\/(\d{6}-\d{3}-[A-Z])\//);
      if (m) { tried = 'arte'; resolved = await resolveArte(m[1]); }
    }
  } catch (e) {
    resolved = { ok: false, message: String(e.message || e).slice(0, 120) };
  }

  // Direktlinks als Rettungsanker (MVW-Items, oder wenn die Sender-API scheitert)
  if (!resolved || !resolved.ok) {
    const direct = resolveDirect(body);
    if (direct.ok) {
      if (resolved && resolved.message) direct.note = resolved.message;
      return json(direct, 200, { 'x-mm-stream': 'direct' + (tried ? '-after-' + tried : '') });
    }
  }
  if (!resolved) resolved = { ok: false, message: 'Für diese Quelle ist noch kein In-App-Abspielen möglich.' };
  return json(resolved, 200, { 'x-mm-stream': tried || 'none' });
}
