// POST /api/mediathek — Hybrid-Backend.
//
// Eigener Crawler-Index (D1 "ard-index", Binding INDEX_DB) beantwortet alles aus der
// ARD/ZDF-Familie (~85% der Inhalte, ~0,3s statt ~6s MVW). MediathekViewWeb bleibt
// zuständig für ARTE/3sat/ORF/SRF/DW und ist KOMPLETT-FALLBACK bei jedem Fehler —
// fehlt das INDEX_DB-Binding oder wirft D1, läuft alles exakt wie vorher über MVW.
//
// MVW-Query-Semantik (empirisch verifiziert): innerhalb einer queries[]-Gruppe mit
// gleichen fields gilt OR, zwischen Gruppen mit verschiedenen fields gilt AND.
// Darum kann der MVW-Zweig bei "Alle Sender" per 5 Kanal-Queries auf die
// Nicht-Index-Sender eingeschränkt werden (keine Dubletten mit dem Index-Zweig).

const MVW_API = 'https://mediathekviewweb.de/api/query';

// Sender, die NUR MVW hat (Werte wie im <select id="filterChannel"> der App).
const MVW_ONLY = ['ARTE.DE', '3Sat', 'ORF', 'SRF', 'DW'];

// App-Kanalwert -> Kanalnamen im eigenen Index (entries.channel, case-insensitiv).
// exact = exakte Namen, prefix = Namenspräfixe (Regionalvarianten wie "SWR BW", "NDR Hamburg").
const INDEX_CHANNELS = {
  'ARD': { exact: ['ard', 'das erste', 'ard kultur', 'sportschau', 'tagesschau', 'tagesschau24', 'one', 'ard alpha', 'funk'], prefix: [] },
  'ZDF': { exact: [], prefix: ['zdf'] },
  'SWR': { exact: [], prefix: ['swr'] },
  'NDR': { exact: [], prefix: ['ndr'] },
  'WDR': { exact: [], prefix: ['wdr'] },
  'MDR': { exact: [], prefix: ['mdr'] },
  'BR': { exact: ['br'], prefix: [] },
  'HR': { exact: ['hr'], prefix: [] },
  'RBB': { exact: ['rbb'], prefix: [] },
  'SR': { exact: ['sr'], prefix: [] },
  'PHOENIX': { exact: ['phoenix'], prefix: [] },
  'KiKA': { exact: ['kika'], prefix: [] },
  'Radio Bremen TV': { exact: ['radio bremen'], prefix: [] },
};

// Edge-Cache: identische Anfragen (gleicher Body) 5 Minuten aus dem Cloudflare-Cache.
// Nutzer-Feedback 24.09.: „die gleiche Suche dauert beim zweiten Mal genauso lang".
const EDGE_TTL = 300;

export async function onRequestPost(context) {
  const bodyText = await context.request.text();
  if (bodyText.length > 10000) return new Response('Payload zu gross', { status: 413 });

  let cacheKey = null;
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText));
    const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    cacheKey = new Request('https://mm-cache.local/mediathek/v1/' + hex);
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      return new Response(hit.body, { status: 200, headers: {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        'x-mm-backend': hit.headers.get('x-mm-backend') || '', 'x-mm-cache': 'hit',
      } });
    }
  } catch (e) { cacheKey = null; }

  let payload = null;
  try { payload = JSON.parse(bodyText); } catch { /* kein JSON -> MVW entscheiden lassen */ }

  let text = null, backend = 'mvw';
  if (payload && context.env.INDEX_DB) {
    try {
      const hybrid = Array.isArray(payload.titleBatch)
        ? await titleBatchQuery(context.env, payload)
        : await hybridQuery(context.env, payload);
      if (hybrid) { const { _backend, ...clean } = hybrid; text = JSON.stringify(clean); backend = _backend || 'index'; }
    } catch (err) {
      // bewusst still: jeder Index-Fehler fällt auf den bewährten MVW-Weg zurück
    }
  }
  if (text === null) {
    if (payload && Array.isArray(payload.titleBatch)) {
      // Batch ohne Index: nur MVW-Teil, gleiche Antwortform
      try { const r = await titleBatchQuery(null, payload); const { _backend, ...clean } = r; text = JSON.stringify(clean); backend = 'mvw'; }
      catch (e) { return new Response(JSON.stringify({ result: { results: [], queryInfo: { totalResults: 0, resultCount: 0, batch: true } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    } else {
      const upstream = await fetch(MVW_API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bodyText });
      if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'x-mm-backend': 'mvw' } });
      text = await upstream.text();
    }
  }
  if (cacheKey) {
    try {
      context.waitUntil(caches.default.put(cacheKey, new Response(text, { headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + EDGE_TTL, 'x-mm-backend': backend,
      } })));
    } catch (e) {}
  }
  return new Response(text, { status: 200, headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
    'x-mm-backend': backend, 'x-mm-cache': 'miss',
  } });
}

// Personensuche: bis zu 12 Titel in EINER Anfrage (statt 50 Einzelanfragen à ~4 s).
// D1: ein einziger Scan mit OR über alle Titel, je Titel die neuesten N Treffer
// (ROW_NUMBER). MVW: gleiche fields = OR, also eine Anfrage für alle Titel.
async function titleBatchQuery(env, p) {
  const titles = p.titleBatch.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 12);
  const per = Math.max(1, Math.min(p.perTitle || 5, 10));
  if (!titles.length) return { result: { results: [], queryInfo: { totalResults: 0, resultCount: 0, batch: true } }, _backend: 'index' };
  const now = Math.floor(Date.now() / 1000) + 3600;

  const d1Part = async () => {
    if (!env || !env.INDEX_DB) return [];
    const conds = [], condBinds = [];
    for (const t of titles) {
      const words = t.split(/\s+/).filter(Boolean).slice(0, 8);
      conds.push('(' + words.map(() => '(e.title LIKE ? OR e.topic LIKE ?)').join(' AND ') + ')');
      const b = [];
      for (const w of words) b.push(`%${w}%`, `%${w}%`);
      condBinds.push(b);
    }
    const caseSql = 'CASE ' + conds.map((c, i) => `WHEN ${c} THEN ${i}`).join(' ') + ' END';
    const where = ['(' + conds.join(' OR ') + ')', "lower(e.channel) NOT IN ('3sat','arte.de','srf')"];
    const binds = [...condBinds.flat(), ...condBinds.flat()];
    if (!p.future) { where.push('e.timestamp <= ?'); binds.push(now); }
    if (p.duration_min > 0) { where.push('e.duration >= ?'); binds.push(p.duration_min); }
    const sql = `SELECT * FROM (
        SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x._ti ORDER BY x.timestamp DESC) AS _rn FROM (
          SELECT e.*, en.gattung AS _gattung, en.konfidenz AS _konfidenz, en.facets AS _facets, ${caseSql} AS _ti
          FROM entries e LEFT JOIN enrichment en ON en.topic = e.topic
          WHERE ${where.join(' AND ')}
        ) x
      ) WHERE _rn <= ?`;
    const r = await env.INDEX_DB.prepare(sql).bind(...binds, per).all();
    return (r.results || []).map((row) => ({ ...mapRow(row), _ti: row._ti }));
  };
  const mvwPart = async () => {
    const r = await mvwFetch({
      queries: [...titles.map((t) => ({ fields: ['title', 'topic'], query: t })), ...MVW_ONLY.map((c) => ({ fields: ['channel'], query: c }))],
      sortBy: 'timestamp', sortOrder: 'desc', future: !!p.future, offset: 0, size: Math.min(titles.length * per * 2, 200),
      duration_min: p.duration_min || 0,
    });
    return r?.result?.results || [];
  };
  const [a, b] = await Promise.allSettled([d1Part(), mvwPart()]);
  const items = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
  if (a.status !== 'fulfilled' && b.status !== 'fulfilled') throw new Error('Batch fehlgeschlagen');
  return {
    result: { results: items, queryInfo: { totalResults: items.length, resultCount: items.length, batch: true } },
    _backend: a.status === 'fulfilled' && b.status === 'fulfilled' ? 'hybrid' : (a.status === 'fulfilled' ? 'index-only' : 'mvw'),
  };
}

// Entscheidet die Route. Gibt null zurück, wenn MVW komplett übernehmen soll.
async function hybridQuery(env, p) {
  const queries = Array.isArray(p.queries) ? p.queries : [];
  const chanQs = queries.filter((q) => Array.isArray(q.fields) && q.fields.length === 1 && q.fields[0] === 'channel');
  const gatQs = queries.filter((q) => Array.isArray(q.fields) && q.fields.length === 1 && q.fields[0] === 'gattung');
  const textQs = queries.filter((q) => !chanQs.includes(q) && !gatQs.includes(q));
  if (chanQs.length > 1 || gatQs.length > 1) return null; // baut die App nie — sicherheitshalber MVW

  // Gattungs-Query (Rubrik-Hubs): nur der eigene Index kennt die LLM-Gattung.
  // MVW kann hier nichts beitragen — reine Index-Route, Sender-Filter kombinierbar.
  const gattungen = gatQs.length
    ? String(gatQs[0].query || '').split(',').map((g) => g.trim()).filter(Boolean)
    : null;

  const size = Math.max(1, Math.min(p.size || 30, 200));
  const offset = Math.max(0, Math.min(p.offset || 0, 2000));
  const sortBy = p.sortBy || 'timestamp';
  const sortOrder = p.sortOrder === 'asc' ? 'asc' : 'desc';

  const ch = chanQs.length ? String(chanQs[0].query || '').trim() : '';

  if (gattungen && gattungen.length) {
    let spec = null;
    if (ch) {
      spec = INDEX_CHANNELS[ch] || null;
      if (!spec) {
        // Sender, den der Index (noch) nicht führt (arte/3sat/ORF/SRF/DW):
        // ehrliches leeres Ergebnis statt falscher MVW-Volltexttreffer
        return { result: { results: [], queryInfo: { totalResults: 0, resultCount: 0 } }, _backend: 'index' };
      }
    }
    const r = await d1Search(env, textQs, spec, p, size, offset, sortBy, sortOrder, gattungen);
    return { result: { results: r.items, queryInfo: { totalResults: r.total, resultCount: r.items.length } }, _backend: 'index' };
  }

  if (ch) {
    if (MVW_ONLY.some((c) => c.toLowerCase() === ch.toLowerCase())) return null; // arte/3sat/ORF/SRF/DW -> MVW
    const spec = INDEX_CHANNELS[ch];
    if (!spec) return null; // unbekannter Sender -> MVW (sicher)
    // Nur-Index-Route: Pagination direkt in SQL, kein Merge nötig.
    const r = await d1Search(env, textQs, spec, p, size, offset, sortBy, sortOrder);
    return { result: { results: r.items, queryInfo: { totalResults: r.total, resultCount: r.items.length } }, _backend: 'index' };
  }

  // "Alle Sender": Index-Zweig + MVW-Zweig (nur Nicht-Index-Sender) parallel, dann Merge.
  const need = Math.min(offset + size, 400);
  const [idx, mvw] = await Promise.allSettled([
    d1Search(env, textQs, null, p, need, 0, sortBy, sortOrder),
    mvwFetch({
      ...p,
      queries: [...textQs, ...MVW_ONLY.map((c) => ({ fields: ['channel'], query: c }))],
      offset: 0,
      size: Math.min(need, 200),
    }),
  ]);
  if (idx.status !== 'fulfilled') throw new Error('Index-Zweig fehlgeschlagen'); // -> MVW-Komplett-Fallback
  const idxItems = idx.value.items;
  const mvwItems = mvw.status === 'fulfilled' ? (mvw.value?.result?.results || []) : [];
  const mvwTotal = mvw.status === 'fulfilled' ? (mvw.value?.result?.queryInfo?.totalResults || 0) : 0;

  const merged = [...idxItems, ...mvwItems].sort(comparator(sortBy, sortOrder)).slice(offset, offset + size);
  return {
    result: {
      results: merged,
      queryInfo: { totalResults: idx.value.total + mvwTotal, resultCount: merged.length },
    },
    _backend: mvw.status === 'fulfilled' ? 'hybrid' : 'index-only',
  };
}

// Suche im eigenen Index. chanSpec null = alle Index-Inhalte (dann 3sat-Streuner
// ausschließen, die kommen im "Alle"-Fall schon vom MVW-Zweig).
async function d1Search(env, textQs, chanSpec, p, limit, offset, sortBy, sortOrder, gattungen = null) {
  const COL = { title: 'e.title', topic: 'e.topic', description: 'e.description' };
  const where = [];
  const binds = [];

  for (const q of textQs) {
    const fields = (Array.isArray(q.fields) ? q.fields : []).filter((f) => COL[f]);
    const use = fields.length ? fields : ['title', 'topic'];
    const words = String(q.query || '').trim().split(/\s+/).filter(Boolean);
    for (const w of words) {
      where.push('(' + use.map((f) => `${COL[f]} LIKE ?`).join(' OR ') + ')');
      for (const _ of use) binds.push(`%${w}%`);
    }
  }

  if (gattungen && gattungen.length) {
    where.push(`en.gattung IN (${gattungen.map(() => '?').join(',')})`);
    binds.push(...gattungen);
  }

  if (chanSpec) {
    const parts = [];
    if (chanSpec.exact.length) {
      parts.push(`lower(e.channel) IN (${chanSpec.exact.map(() => '?').join(',')})`);
      binds.push(...chanSpec.exact);
    }
    for (const pre of chanSpec.prefix) { parts.push('lower(e.channel) LIKE ?'); binds.push(pre + '%'); }
    where.push('(' + parts.join(' OR ') + ')');
  } else if (!gattungen) {
    // Nur im "Alle Sender"-Merge nötig (Dubletten mit dem MVW-Zweig vermeiden):
    // alles ausschließen, was der MVW-Zweig dort schon liefert und was inzwischen
    // AUCH im Index steht (3sat-Streuner aus dem ZDF-Crawl, arte- und SRF-Crawl).
    // Die Gattungs-Route hat keinen MVW-Zweig und zeigt bewusst alles im Index.
    where.push("lower(e.channel) NOT IN ('3sat','arte.de','srf')");
  }

  // future:false — wie MVW mit etwas Toleranz für heutige Ausstrahlungen (MVW lässt
  // trotz future:false ~1h Zukunft durch); hält v.a. Wochen voraus datierte Previews raus.
  if (!p.future) { where.push('e.timestamp <= ?'); binds.push(Math.floor(Date.now() / 1000) + 3600); }
  if (p.duration_min > 0) { where.push('e.duration >= ?'); binds.push(p.duration_min); }
  if (p.duration_max > 0) { where.push('e.duration <= ?'); binds.push(p.duration_max); }

  const SORT = { timestamp: 'e.timestamp', duration: 'e.duration', channel: 'e.channel', topic: 'e.topic' };
  const sortCol = SORT[sortBy] || 'e.timestamp';
  const ord = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const from = 'FROM entries e LEFT JOIN enrichment en ON en.topic = e.topic';

  // Performance (Feedback 24.09., Personensuche ~60 s): D1 arbeitet Anfragen einer
  // Datenbank nacheinander ab; ein LIKE-Scan über ~320k Zeilen kostet bis ~0,4 s.
  // Früher lief pro Anfrage IMMER ein zweiter Voll-Scan fürs COUNT. Jetzt:
  // weniger Treffer als das Limit → Gesamtzahl steht schon fest (kein COUNT);
  // sonst ein gedeckeltes COUNT (bricht nach COUNT_CAP Treffern ab).
  const COUNT_CAP = 5000;
  const rows = await env.INDEX_DB.prepare(
    `SELECT e.*, en.gattung AS _gattung, en.konfidenz AS _konfidenz, en.facets AS _facets ${from} ${whereSql} ORDER BY ${sortCol} ${ord} LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  const got = (rows.results || []).length;
  let total;
  if (got < limit) {
    total = offset + got;
  } else {
    const cntFrom = gattungen && gattungen.length ? from : 'FROM entries e';
    // Ohne Textsuche ist das COUNT billig (kein LIKE) → exakt; mit Textsuche gedeckelt
    const capSql = textQs.length ? ` LIMIT ${COUNT_CAP}` : '';
    const cnt = await env.INDEX_DB.prepare(`SELECT COUNT(*) c FROM (SELECT 1 ${cntFrom} ${whereSql}${capSql})`).bind(...binds).first();
    total = cnt ? cnt.c : offset + got;
  }

  return { items: (rows.results || []).map(mapRow), total };
}

function mapRow(r) {
  return {
    channel: r.channel, topic: r.topic, title: r.title, description: r.description || '',
    timestamp: r.timestamp, duration: r.duration,
    url_website: r.url_website, url_video: '', url_video_hd: '',
    available_to: r.available_to, image: r.image || '', id: r.id,
    gattung: r._gattung ?? null, konfidenz: r._konfidenz ?? null,
    facets: r._facets ? safeParse(r._facets) : null,
  };
}

function comparator(sortBy, sortOrder) {
  const dir = sortOrder === 'asc' ? 1 : -1;
  if (sortBy === 'channel' || sortBy === 'topic') {
    return (a, b) => dir * String(a[sortBy] || '').localeCompare(String(b[sortBy] || ''), 'de');
  }
  const k = sortBy === 'duration' ? 'duration' : 'timestamp';
  return (a, b) => dir * ((a[k] || 0) - (b[k] || 0));
}

async function mvwFetch(payload) {
  const res = await fetch(MVW_API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`MVW HTTP ${res.status}`);
  return res.json();
}

// Unveränderter Alt-Weg: 1:1-Proxy zu MVW (auch Komplett-Fallback des Hybrids).
async function mvwProxy(bodyText) {
  const upstream = await fetch(MVW_API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bodyText,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'x-mm-backend': 'mvw',
    },
  });
}

function jsonResp(obj, backend) {
  const { _backend, ...clean } = obj;
  return new Response(JSON.stringify(clean), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'x-mm-backend': backend || 'index',
    },
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
