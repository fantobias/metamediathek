// GET /api/meta?url=<mediathek-seite> — liest og:image UND og:description
// der Senderseite aus und liefert beides als JSON. Die Beschreibung dient
// als zusätzliches Matching-Futter fürs Geschmacksprofil, wenn TMDB
// keine Inhaltsangabe kennt. Gleiche Domain-Allowlist wie /api/ogimage.
const ALLOWED_HOSTS = ['ardmediathek.de','zdf.de','arte.tv','3sat.de','srf.ch','orf.at','ndr.de','wdr.de','br.de','swr.de','hr-fernsehen.de','mdr.de','rbb-online.de','radiobremen.de','sr-mediathek.de','phoenix.de','kika.de','dw.com','funk.net','daserste.de','sportschau.de','tagesschau.de','hessenschau.de','rbb24.de'];

function hostAllowed(h) {
  for (const a of ALLOWED_HOSTS) {
    if (h === a || h.endsWith('.' + a)) return true;
  }
  return false;
}

function extractMeta(html, prop) {
  let m = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'));
  if (!m) m = html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']' + prop + '["\']', 'i'));
  return m ? m[1] : null;
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
  // cachev=2: entwertet gecachte Antworten mit unkodierter Bild-URL (Entity-Fix)
  const cacheKey = new Request(url.toString() + '&cachev=2', { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let image = null;
  let description = null;
  try {
    const page = await fetch(t.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MetaMediathek-Prototyp)' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (page.ok) {
      const html = (await page.text()).slice(0, 400000);
      image = extractMeta(html, 'og:image');
      // HTML-Entities in der Bild-URL dekodieren (ARTE: "&amp;" in der Query)
      if (image) image = image.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&').replace(/&#x0*26;/gi, '&');
      description = extractMeta(html, 'og:description');
      if (!description) {
        const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
        if (m) description = m[1];
      }
      if (description) {
        description = description.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').slice(0, 600);
      }
    }
  } catch (e) {}

  const res = new Response(JSON.stringify({ image: image, description: description }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=604800'
    }
  });
  try { context.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) {}
  return res;
}

