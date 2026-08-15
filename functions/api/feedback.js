// POST /api/feedback — nimmt Nutzer-Feedback, automatische Fehlerberichte und Event-Batches an.
// GET  /api/feedback — Auslesen mit Admin-Key (Pages-Secret FEEDBACK_ADMIN_KEY).
// Speicher: Cloudflare D1, Binding "DB" (Datenbank z. B. "metamediathek-feedback", Schema: siehe schema.sql).
// Ohne DB-Binding antwortet POST trotzdem mit 200 {stored:false}, damit der Client nie an Feedback scheitert.

const MAX_BODY = 64 * 1024; // 64 KB pro Einsendung
const TYPES = ['feedback', 'error', 'events'];

export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
    let data;
    try { data = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

    const type = TYPES.includes(data.type) ? data.type : 'other';
    const sid = String(data.sid || '').slice(0, 40);
    const ua = (request.headers.get('user-agent') || '').slice(0, 200);
    // App-Version aus der Einsendung — eigene Spalte, damit sich Feedback und
    // Fehler pro Version aggregieren lassen (GROUP BY build)
    const build = String(data.build || '').slice(0, 40);
    const body = JSON.stringify(data);

    if (!env.DB) return json({ ok: true, stored: false, note: 'D1-Binding DB fehlt' });

    try {
      await env.DB.prepare(
        'INSERT INTO feedback (ts, type, sid, ua, build, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(Date.now(), type, sid, ua, build, body).run();
    } catch (e) {
      // Fallback, falls die build-Spalte (ALTER TABLE) noch fehlt — Feedback darf nie verloren gehen
      await env.DB.prepare(
        'INSERT INTO feedback (ts, type, sid, ua, body) VALUES (?1, ?2, ?3, ?4, ?5)'
      ).bind(Date.now(), type, sid, ua, body).run();
    }

    return json({ ok: true, stored: true });
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = request.headers.get('x-admin-key') || url.searchParams.get('key');
  if (!env.FEEDBACK_ADMIN_KEY || key !== env.FEEDBACK_ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.DB) return json({ error: 'no_db_binding' }, 503);

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
  const type = url.searchParams.get('type');
  const build = url.searchParams.get('build');
  let sql = 'SELECT id, ts, type, sid, ua, build, body FROM feedback';
  const conds = [], binds = [];
  if (type) { conds.push('type = ?' + (binds.length + 1)); binds.push(type); }
  if (build) { conds.push('build = ?' + (binds.length + 1)); binds.push(build); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?' + (binds.length + 1);
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ count: rows.results.length, results: rows.results });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
