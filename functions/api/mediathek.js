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

export async function onRequestPost(context) {
  const bodyText = await context.request.text();
  if (bodyText.length > 10000) return new Response('Payload zu gross', { status: 413 });

  let payload = null;
  try { payload = JSON.parse(bodyText); } catch { /* kein JSON -> MVW entscheiden lassen */ }

  if (payload && context.env.INDEX_DB) {
    try {
      const hybrid = await hybridQuery(context.env, payload);
      if (hybrid) return jsonResp(hybrid, hybrid._backend);
    } catch (err) {
      // bewusst still: jeder Index-Fehler fällt auf den bewährten MVW-Weg zurück
    }
  }
  return mvwProxy(bodyText);
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
    // Nur im "Alle Sender"-Merge nötig (Dubletten mit dem MVW-Zweig vermeiden);
    // die Gattungs-Route hat keinen MVW-Zweig und zeigt bewusst alles im Index.
    where.push("lower(e.channel) <> '3sat'");
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

  const [rows, cnt] = await env.INDEX_DB.batch([
    env.INDEX_DB.prepare(
      `SELECT e.*, en.gattung AS _gattung, en.konfidenz AS _konfidenz, en.facets AS _facets ${from} ${whereSql} ORDER BY ${sortCol} ${ord} LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset),
    env.INDEX_DB.prepare(`SELECT COUNT(*) c ${from} ${whereSql}`).bind(...binds),
  ]);

  return {
    items: (rows.results || []).map((r) => ({
      channel: r.channel, topic: r.topic, title: r.title, description: r.description || '',
      timestamp: r.timestamp, duration: r.duration,
      url_website: r.url_website, url_video: '', url_video_hd: '',
      available_to: r.available_to, image: r.image || '', id: r.id,
      gattung: r._gattung ?? null, konfidenz: r._konfidenz ?? null,
      facets: r._facets ? safeParse(r._facets) : null,
    })),
    total: cnt.results?.[0]?.c ?? 0,
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
