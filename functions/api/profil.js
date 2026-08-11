// POST /api/profil { text } — übersetzt die Geschmacksbeschreibung einmalig
// per Workers AI (Llama 3.1 8B, kostenloses Kontingent) in ein strukturiertes
// Interessenpaket: Suchbegriffe (inkl. verwandter Konzepte), Genres, Ausschlüsse.
// Benötigt das AI-Binding "AI" im Pages-Projekt (Settings → Bindings → Workers AI).
const GENRE_KEYS = ['krimi','thriller','drama','komödie','doku','natur','geschichte','scifi','romantik','abenteuer','horror','familie','action','heimat','musik','politik','arthouse','wissenschaft','truecrime','nordic','euro','kriegsfilm','western','animation'];

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

function cleanList(arr, max) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t.length < 3 || t.length > 40) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export async function onRequestPost(context) {
  const env = context.env;
  if (!env.AI) return jsonResponse({ error: 'AI-Binding fehlt (Pages-Settings → Bindings → Workers AI)' }, 503);

  let body;
  try { body = await context.request.json(); } catch (e) { return jsonResponse({ error: 'Ungueltiger Body' }, 400); }
  const text = (body && typeof body.text === 'string') ? body.text.slice(0, 1200) : '';
  if (!text.trim()) return jsonResponse({ error: 'Text fehlt' }, 400);

  const system = 'Du analysierst die Film-Geschmacksbeschreibung eines Nutzers einer deutschen Mediatheken-Suche. '
    + 'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Erklaerung, ohne Markdown. Schema: '
    + '{"suchbegriffe": [...], "genres": [...], "ausschluesse": [...]}. '
    + 'suchbegriffe: 6-12 praegnante deutsche Einzelwoerter oder kurze Begriffe, mit denen man in Titeln/Themen von TV-Sendungen suchen wuerde. '
    + 'Erweitere die genannten Interessen um eng verwandte Konzepte und Synonyme (z.B. "Hunde" -> auch Welpen, Tierheim, Hundetrainer; "Islam" -> auch Muslime, Moschee, Koran, Nahost, arabische Welt). Keine Fantasiebegriffe, keine zu allgemeinen Woerter wie "Film" oder "Doku". '
    + 'genres: 0-5 passende Werte NUR aus dieser Liste: ' + GENRE_KEYS.join(', ') + '. '
    + 'ausschluesse: Themen/Begriffe, die der Nutzer ausdruecklich NICHT will (leer, wenn keine genannt).';

  let raw = '';
  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { 
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Geschmacksbeschreibung: """' + text + '"""' }
      ],
      max_tokens: 500,
      temperature: 0.2
    });
    raw = (result && (result.response || result.result || '')) + '';
  } catch (e) {
    return jsonResponse({ error: 'KI-Aufruf fehlgeschlagen' }, 502);
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return jsonResponse({ error: 'Keine JSON-Antwort' }, 502);
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) { return jsonResponse({ error: 'JSON nicht parsebar' }, 502); }

  const genres = cleanList(parsed.genres, 5).map(g => g.toLowerCase()).filter(g => GENRE_KEYS.includes(g));
  return jsonResponse({
    suchbegriffe: cleanList(parsed.suchbegriffe, 12),
    genres: genres,
    ausschluesse: cleanList(parsed.ausschluesse, 8)
  });
}

