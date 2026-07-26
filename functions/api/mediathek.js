// POST /api/mediathek — Proxy zu MediathekViewWeb.
// Ersetzt die corsproxy.io/allorigins-Kette durch einen eigenen, zuverlässigen Weg.
export async function onRequestPost(context) {
  const body = await context.request.text();
  if (body.length > 10000) return new Response('Payload zu gross', { status: 413 });
  const upstream = await fetch('https://mediathekviewweb.de/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: body
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
