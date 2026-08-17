// POST /api/embed — Text-Embeddings für das semantische Geschmacks-Matching.
//
// Warum: Das Schlagwort-Matching des Profils ist wörtlich („düstere
// Zukunftsvisionen" findet keine „Dystopie"). Embeddings übersetzen Profil
// und Filmtexte in Bedeutungsvektoren; Ähnlichkeit wird zum Zahlenvergleich.
// Modell @cf/baai/bge-m3 ist mehrsprachig — deutsches Profil matcht auch
// englische TMDB-Keywords.
//
// Aufwandsprofil (bewusst so gebaut):
//   Einmalig pro Film:  Workers-AI-Aufruf, Ergebnis landet im D1-Cache.
//   Wiederkehrend:      nur D1-Lookups; der Cosine-Vergleich läuft im Client.
//
// Request:  { items: [ { hash: "<sha256-hex des Texts>", text: "…" } ] }
//           text darf fehlen, wenn nur der Cache gefragt wird (Probe).
// Response: { vectors: { "<hash>": { v: "<base64 Int8>", s: <scale> } },
//             missing: ["<hash>", …] }   — missing = kein Text geliefert und
//                                          nicht im Cache.
//
// Quantisierung: Int8 (Vektor / maxAbs * 127) — ~1 KB statt ~9 KB pro Film,
// für Ranking-Zwecke verlustfrei genug. Client rechnet Cosine auf Int8*scale.
//
// D1-Tabelle (einmalig in der Konsole anlegen — siehe schema.sql):
//   CREATE TABLE IF NOT EXISTS embeddings (
//     hash TEXT PRIMARY KEY, model TEXT NOT NULL, v TEXT NOT NULL,
//     s REAL NOT NULL, ts INTEGER NOT NULL );

const MODEL = '@cf/baai/bge-m3';
const MAX_ITEMS = 20;          // pro Request — Enrichment ruft batchweise auf
const MAX_TEXT = 1200;         // Zeichen; reicht für Titel+Beschreibung+Keywords

function quantize(vec) {
  let maxAbs = 1e-9;
  for (const x of vec) { const a = Math.abs(x); if (a > maxAbs) maxAbs = a; }
  const scale = maxAbs / 127;
  const bytes = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    // Int8 als vorzeichenbehaftetes Byte ablegen
    let q = Math.round(vec[i] / scale);
    if (q < -127) q = -127; if (q > 127) q = 127;
    bytes[i] = q & 0xff;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { v: btoa(bin), s: scale };
}

export async function onRequestPost(context) {
  const env = context.env;
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  if (!env.AI) return new Response(JSON.stringify({ error: 'AI-Binding fehlt' }), { status: 503, headers: cors });

  let body;
  try { body = await context.request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'JSON erwartet' }), { status: 400, headers: cors });
  }
  const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (items.length === 0) return new Response(JSON.stringify({ vectors: {}, missing: [] }), { headers: cors });

  const hashes = items
    .map(it => String(it.hash || '').toLowerCase())
    .filter(h => /^[0-9a-f]{16,64}$/.test(h));

  const vectors = {};
  const cached = new Set();

  // 1) Cache-Treffer aus D1 holen (Batch über IN-Liste)
  if (env.DB && hashes.length > 0) {
    try {
      const qs = hashes.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT hash, v, s FROM embeddings WHERE model = ? AND hash IN (${qs})`
      ).bind(MODEL, ...hashes).all();
      for (const r of (rows?.results || [])) {
        vectors[r.hash] = { v: r.v, s: r.s };
        cached.add(r.hash);
      }
    } catch (e) { /* Tabelle fehlt evtl. noch — dann eben alles frisch rechnen */ }
  }

  // 2) Fehlende mit Text einbetten, Rest als missing melden
  const toEmbed = [];
  const missing = [];
  for (const it of items) {
    const h = String(it.hash || '').toLowerCase();
    if (!/^[0-9a-f]{16,64}$/.test(h) || cached.has(h)) continue;
    const text = typeof it.text === 'string' ? it.text.slice(0, MAX_TEXT).trim() : '';
    if (text) toEmbed.push({ hash: h, text });
    else missing.push(h);
  }

  if (toEmbed.length > 0) {
    try {
      const res = await env.AI.run(MODEL, { text: toEmbed.map(it => it.text) });
      // bge-m3 liefert { data: [ [floats], … ] } (bei manchen Versionen
      // { response: … } — beide Formen akzeptieren)
      const data = res?.data || res?.response || [];
      const inserts = [];
      for (let i = 0; i < toEmbed.length; i++) {
        const vec = data[i];
        if (!Array.isArray(vec) || vec.length === 0) { missing.push(toEmbed[i].hash); continue; }
        const q = quantize(vec);
        vectors[toEmbed[i].hash] = q;
        inserts.push({ hash: toEmbed[i].hash, ...q });
      }
      // 3) In D1 ablegen (best effort — Fehler hier dürfen die Antwort nicht kippen)
      if (env.DB && inserts.length > 0) {
        try {
          const stmt = env.DB.prepare(
            'INSERT OR REPLACE INTO embeddings (hash, model, v, s, ts) VALUES (?, ?, ?, ?, ?)'
          );
          await env.DB.batch(inserts.map(it => stmt.bind(it.hash, MODEL, it.v, it.s, Date.now())));
        } catch (e) { /* Cache-Miss beim nächsten Mal — verkraftbar */ }
      }
    } catch (e) {
      // Workers-AI-Fehler (Limit erschöpft o.ä.): ehrlich melden, Client
      // fällt aufs Schlagwort-Scoring zurück
      for (const it of toEmbed) missing.push(it.hash);
    }
  }

  return new Response(JSON.stringify({ vectors, missing }), { headers: cors });
}
