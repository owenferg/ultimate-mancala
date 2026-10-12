// the static files are served without this, it only sees /turn and paths that match no file
// hands out short-lived Cloudflare TURN credentials, so the key itself never reaches the browser
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/turn') return new Response('Not found', { status: 404 });
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) return new Response('turn unavailable', { status: 502 });
    const { iceServers } = await res.json();
    // browsers block port 53, and waiting on it only slows connecting down
    for (const s of iceServers) s.urls = [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u));
    return Response.json({ iceServers }, { headers: { 'Cache-Control': 'no-store' } });
  },
};
