// YAK sync (Ethereal). A postbox for one encrypted blob per household.
// The phone encrypts the house bills before sending, so nothing readable is stored here.
// GET  /h/<id>  -> {d, t}   anyone with the household id (it is useless without the key in the invite link)
// PUT  /h/<id>  -> {t}      needs the manager's write token; the first write claims the id
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX = 200000; // characters; a household is a few hundred
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function sha(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/ping') return json({ ok: true, app: 'yak-sync' });
    const m = url.pathname.match(/^\/h\/([0-9a-f]{32})$/);
    if (!m) {
      if (env.ASSETS) return env.ASSETS.fetch(req); // the test build of YAK, on the dev Worker only
      return json({ error: 'not found' }, 404);
    }
    const key = 'h:' + m[1];
    if (req.method === 'GET') {
      const v = await env.KV.get(key, 'json');
      if (!v) return json({ error: 'no household' }, 404);
      return json({ d: v.d, t: v.t });
    }
    if (req.method === 'PUT') {
      const tok = (req.headers.get('Authorization') || '').match(/^Bearer ([0-9a-f]{64})$/);
      if (!tok) return json({ error: 'no token' }, 401);
      const d = await req.text();
      if (!d || d.length > MAX || !/^[A-Za-z0-9_-]+$/.test(d)) return json({ error: 'bad data' }, 400);
      const w = await sha(tok[1]);
      const cur = await env.KV.get(key, 'json');
      if (cur && cur.w !== w) return json({ error: 'not allowed' }, 403);
      const t = Date.now();
      await env.KV.put(key, JSON.stringify({ w, d, t }));
      return json({ t });
    }
    return json({ error: 'method' }, 405);
  },
};
