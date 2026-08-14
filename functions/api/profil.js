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
    + 'Erweitere NUR die ausdruecklich genannten Interessen um eng verwandte Konzepte und Synonyme (z.B. "Hunde" -> auch Welpen, Tierheim, Hundetrainer; "skandinavische Krimis" -> auch Nordic Noir, Schweden, Daenemark, Kommissar). '
    + 'ERFINDE KEINE Vorlieben, die der Nutzer nicht genannt hat (wenn er nichts von Arthouse sagt, gehoert Arthouse nicht hinein). Keine zu allgemeinen Woerter wie "Film" oder "Doku". '
    + 'Verwende KEINE reinen Laender-, Regions- oder Staedtenamen als eigenstaendige suchbegriffe (NICHT "Deutschland", "USA", "Europa", "Bayern") — sie treffen jeden Nachrichtenbeitrag und sind wertlos. Uebersetze die geografische Angabe stattdessen in themenspezifische Begriffe. '
    + 'Beispiel: "Ich mag Nachkriegsfilme aus Deutschland" -> {"suchbegriffe":["Nachkriegszeit","Truemmerfilm","Wirtschaftswunder","Heimkehrer","Besatzungszeit","Wiederaufbau","Stunde Null"],"genres":["drama","geschichte","kriegsfilm"],"ausschluesse":[]}. '
    + 'genres: 0-5 passende Werte NUR aus dieser Liste: ' + GENRE_KEYS.join(', ') + '. Auch hier: nur was aus den genannten Interessen folgt. '
    + 'ausschluesse: SEHR WICHTIG. Alles, was der Nutzer NICHT will. Erkenne Verneinungen wie "keine …", "kein …", "nichts mit …", "ohne …", "bitte nicht …", "… mag ich nicht", "ausser …". '
    + 'Erweitere Ausschluesse um enge Synonyme (z.B. "Schlagermusik" -> Schlager, Volksmusik; "nichts mit Kochen" -> Kochen, Kochshow, Rezepte, Backen). Leer NUR, wenn wirklich keine Verneinung im Text steht. '
    + 'Beispiel: "Ich mag skandinavische Krimis und Bergdokus, aber keine Schlagermusik und nichts mit Kochen" -> '
    + '{"suchbegriffe":["Skandinavien","Nordic Noir","Kommissar","Schweden","Berge","Alpen","Gipfel","Bergsteigen"],"genres":["krimi","nordic","natur","doku"],"ausschluesse":["Schlager","Volksmusik","Kochen","Kochshow","Rezepte"]}';

  // Modell-Fallback-Kette: Namen aendern sich bei Cloudflare gelegentlich.
  const MODELS = [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/meta/llama-3.1-8b-instruct-fast',
    '@cf/meta/llama-3.1-8b-instruct-awq',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3-8b-instruct'
  ];
  const payload = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'Geschmacksbeschreibung: """' + text + '"""' }
    ],
    max_tokens: 500,
    temperature: 0.2
  };
  let raw = '';
  const errors = [];
  for (const model of MODELS) {
    try {
      const result = await env.AI.run(model, payload);
      let out = result;
      if (out && typeof out === 'object') {
        if (out.response !== undefined) out = out.response;
        else if (out.result !== undefined) out = out.result;
        else if (out.choices && out.choices[0]) out = out.choices[0].message ? out.choices[0].message.content : out.choices[0].text;
      }
      raw = (out && typeof out === 'object') ? JSON.stringify(out) : String(out == null ? '' : out);
      if (raw.trim()) break;
      errors.push(model + ': leere Antwort');
    } catch (e) {
      errors.push(model + ': ' + String(e && e.message || e).slice(0, 160));
    }
  }
  if (!raw.trim()) {
    return jsonResponse({ error: 'KI-Aufruf fehlgeschlagen', details: errors }, 502);
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return jsonResponse({ error: 'Keine JSON-Antwort', raw: raw.slice(0, 300) }, 502);
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) { return jsonResponse({ error: 'JSON nicht parsebar' }, 502); }

  const genres = cleanList(parsed.genres, 5).map(g => g.toLowerCase()).filter(g => GENRE_KEYS.includes(g));
  return jsonResponse({
    suchbegriffe: cleanList(parsed.suchbegriffe, 12),
    genres: genres,
    ausschluesse: cleanList(parsed.ausschluesse, 8)
  });
}
