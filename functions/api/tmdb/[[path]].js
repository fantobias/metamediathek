// GET /api/tmdb/<pfad> — TMDB-Proxy, hängt den API-Key serverseitig an.
// Key liegt als Secret TMDB_API_KEY im Pages-Projekt (Settings → Variables and Secrets).
// movie/N und tv/N: Detailabruf (append_to_response=keywords,credits) für
// Geschmacks-Scoring (Schlagwörter, Regie/Cast) und Modal-Anzeige.
// …/recommendations und …/similar: „Ein Film wie XY"-Suche.
const ALLOWED = /^(search\/(movie|tv|person)|person\/\d+\/combined_credits|movie\/\d+(\/(recommendations|similar))?|tv\/\d+(\/(recommendations|similar))?)$/;

export async function onRequestGet(context) {
  const params = context.params;
  const env = context.env;
  const path = (Array.isArray(params.path) ? params.path : [params.path]).join('/');
  if (!ALLOWED.test(path)) return new Response('Pfad nicht erlaubt', { status: 403 });
  if (!env.TMDB_API_KEY) return new Response('TMDB_API_KEY fehlt (Pages-Settings)', { status: 503 });

  const url = new URL(context.request.url);
  const upstream = new URL('https://api.themoviedb.org/3/' + path);
  for (const pair of url.searchParams.entries()) {
    if (pair[0] !== 'api_key') upstream.searchParams.set(pair[0], pair[1]);
  }
  upstream.searchParams.set('api_key', env.TMDB_API_KEY);

  // Edge-Cache: identische Suchen (auch anderer Nutzer) kommen aus dem Cache
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const up = await fetch(upstream.toString());
  const res = new Response(up.body, {
    status: up.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    }
  });
  if (up.ok) {
    try { context.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) {}
  }
  return res;
}
