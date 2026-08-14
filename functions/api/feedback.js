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
    const body = JSON.stringify(data);

    if (!env.DB) return json({ ok: true, stored: false, note: 'D1-Binding DB fehlt' });

    await env.DB.prepare(
      'INSERT INTO feedback (ts, type, sid, ua, body) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(Date.now(), type, sid, ua, body).run();

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
  const stmt = type
    ? env.DB.prepare('SELECT id, ts, type, sid, ua, body FROM feedback WHERE type = ?1 ORDER BY id DESC LIMIT ?2').bind(type, limit)
    : env.DB.prepare('SELECT id, ts, type, sid, ua, body FROM feedback ORDER BY id DESC LIMIT ?1').bind(limit);
  const rows = await stmt.all();
  return json({ count: rows.results.length, results: rows.results });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
