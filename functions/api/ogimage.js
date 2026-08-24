// GET /api/ogimage?url=<mediathek-seite> — liest das og:image (echtes Sendungsbild)
// der Senderseite aus und leitet dorthin um. Mit Edge-Cache und Domain-Allowlist
// (nur Sender-Domains — sonst wäre das ein offener Proxy).
const ALLOWED_HOSTS = ['ardmediathek.de','zdf.de','arte.tv','3sat.de','srf.ch','orf.at','ndr.de','wdr.de','br.de','swr.de','hr-fernsehen.de','mdr.de','rbb-online.de','radiobremen.de','sr-mediathek.de','phoenix.de','kika.de','dw.com','funk.net','daserste.de','sportschau.de','tagesschau.de','hessenschau.de','rbb24.de'];

function hostAllowed(h) {
  for (const a of ALLOWED_HOSTS) {
    if (h === a || h.endsWith('.' + a)) return true;
  }
  return false;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('url') || '';
  let t;
  try { t = new URL(target); } catch (e) { return new Response('Ungueltige URL', { status: 400 }); }
  if (t.protocol !== 'https:' || !hostAllowed(t.hostname)) {
    return new Response('Host nicht erlaubt', { status: 403 });
  }

  const cache = caches.default;
  // v=2 im Cache-Key: entwertet die bis 7 Tage gecachten Redirects mit
  // unkodiertem "&amp;" aus der Zeit vor dem Entity-Fix
  const cacheKey = new Request(url.toString() + '&cachev=2', { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let imgUrl = null;
  try {
    const page = await fetch(t.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MetaMediathek-Prototyp)' } });
    if (page.ok) {
      const html = (await page.text()).slice(0, 400000);
      let m = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i);
      if (!m) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i);
      // HTML-Entities in der URL dekodieren — ARTE schreibt "&amp;" in die
      // Query, das CDN antwortete darauf mit einer 400/404-GRAFIK (SVG mit
      // Status 400, aber Content-Type image/*), die der Browser anzeigte
      // statt onerror auszuloesen (Befund 23.08.: "404 Bad Request"-Kacheln)
      if (m) imgUrl = m[1].replace(/&amp;/g, '&').replace(/&#0*38;/g, '&').replace(/&#x0*26;/gi, '&');
    }
  } catch (e) {}

  let res;
  if (imgUrl && /^https:\/\//i.test(imgUrl)) {
    res = new Response(null, { status: 302, headers: {
      'Location': imgUrl,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=604800'
    } });
  } else {
    res = new Response('Kein Bild gefunden', { status: 404, headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    } });
  }
  try { context.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) {}
  return res;
}
