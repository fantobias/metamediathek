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
    + '{"themen": [{"name": "...", "begriffe": [...]}], "genres": [...], "ausschluesse": [...]}. '
    + 'themen: EINE Gruppe pro ausdruecklich genanntem Interesse des Nutzers (nicht mehr, nicht weniger). '
    + 'name = kurze Bezeichnung des Interesses. begriffe = 2-6 deutsche Suchbegriffe je Gruppe: das Wort selbst plus eng verwandte Konzepte und Synonyme '
    + '(z.B. Interesse "Katzen" -> begriffe ["Katze","Katzen","Kater","Stubentiger"]; "skandinavische Krimis" -> ["Nordic Noir","Skandinavien","Schweden","Kommissar"]). '
    + 'ERFINDE KEINE Interessen, die der Nutzer nicht genannt hat. Keine zu allgemeinen Woerter wie "Film" oder "Doku". '
    + 'VERNEINTE Interessen ("keine …", "ohne …", "mag ich nicht") gehoeren AUSSCHLIESSLICH in ausschluesse und duerfen NIEMALS eine themen-Gruppe bilden. '
    + 'Verwende KEINE reinen Laender-, Regions- oder Staedtenamen als begriffe (NICHT "Deutschland", "USA", "Europa", "Bayern") — sie treffen jeden Nachrichtenbeitrag. Uebersetze Geografie in themenspezifische Begriffe. '
    + 'Beispiel 1: "Katzen, Mord, schwarz-weiss" -> {"themen":[{"name":"Katzen","begriffe":["Katze","Katzen","Kater","Stubentiger"]},{"name":"Mord/Krimi","begriffe":["Mord","Krimi","Kommissar","Mordfall"]},{"name":"Schwarzweiss","begriffe":["schwarzweiss","schwarz-weiss","Filmklassiker"]}],"genres":["krimi"],"ausschluesse":[]}. '
    + 'Beispiel 2: "Ich mag Nachkriegsfilme aus Deutschland" -> {"themen":[{"name":"Nachkriegszeit","begriffe":["Nachkriegszeit","Truemmerfilm","Wirtschaftswunder","Heimkehrer","Besatzungszeit","Stunde Null"]}],"genres":["drama","geschichte","kriegsfilm"],"ausschluesse":[]}. '
    + 'Beispiel 3: "Ich mag Dokus, aber bitte keinen Schlager" -> {"themen":[{"name":"Dokumentationen","begriffe":["Doku","Dokumentation","Reportage"]}],"genres":["doku"],"ausschluesse":["Schlager","Schlagermusik","Volksmusik"]} — Schlager ist KEIN Thema, nur Ausschluss. '
    + 'genres: 0-5 passende Werte NUR aus dieser Liste: ' + GENRE_KEYS.join(', ') + '. Nur was aus den genannten Interessen folgt. '
    + 'ausschluesse: SEHR WICHTIG. Alles, was der Nutzer NICHT will. Erkenne Verneinungen wie "keine …", "kein …", "nichts mit …", "ohne …", "bitte nicht …", "… mag ich nicht", "ausser …". '
    + 'Erweitere Ausschluesse um enge Synonyme (z.B. "Schlagermusik" -> Schlager, Volksmusik; "nichts mit Kochen" -> Kochen, Kochshow, Rezepte, Backen). Leer NUR, wenn wirklich keine Verneinung im Text steht.';

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
  // Themen-Gruppen validieren; flache suchbegriffe zusätzlich liefern
  // (abwärtskompatibel — der Empfehlungs-Feed sucht mit der flachen Liste)
  const ausschluesse = cleanList(parsed.ausschluesse, 8);
  // Sicherheitsnetz: Gruppen, die verneinte Interessen doppeln (Name/Begriffe
  // überlappen mit ausschluesse), verwerfen — die KI machte aus "keine Schlager"
  // sonst zusaetzlich ein positives Thema "Schlagermusik" (Interplay-Test)
  const exSet = ausschluesse.map(a => a.toLowerCase());
  const overlapsExclusion = (name, begriffe) => {
    const all = [name.toLowerCase(), ...begriffe.map(b => b.toLowerCase())];
    return all.some(w => exSet.some(x => w.includes(x) || x.includes(w)));
  };
  const themen = [];
  if (Array.isArray(parsed.themen)) {
    for (const t of parsed.themen.slice(0, 8)) {
      if (!t || typeof t !== 'object') continue;
      const name = (typeof t.name === 'string' ? t.name.trim() : '').slice(0, 40);
      const begriffe = cleanList(t.begriffe, 6);
      if (name && begriffe.length > 0 && !overlapsExclusion(name, begriffe)) themen.push({ name, begriffe });
    }
  }
  const flach = [];
  for (const t of themen) for (const b of t.begriffe) { if (!flach.includes(b) && flach.length < 15) flach.push(b); }
  const suchbegriffe = flach.length > 0 ? flach : cleanList(parsed.suchbegriffe, 12);
  return jsonResponse({
    themen: themen,
    suchbegriffe: suchbegriffe,
    genres: genres,
    ausschluesse: ausschluesse
  });
}
