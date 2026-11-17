// YAK sync (Ethereal). A postbox for one encrypted blob per household, plus bill reminders.
// The phone encrypts the house bills before sending, so nothing readable is stored here.
// GET  /h/<id>  -> {d, t}   anyone with the household id (it is useless without the key in the invite link)
// PUT  /h/<id>  -> {t}      needs the manager's write token; the first write claims the id. Housemates with reminders on get a nudge.
//
// Bill reminders (Ethereal 1.1). Web Push, sent at 7pm UK time.
// The phone sends only its push address and a list of dates with a kind ('due', 'pay', 'dd'). No bill names or amounts.
// The nudge says only which kind it is; the phone writes the message itself from the figures it already holds.
// GET  /p/key   -> {k}      the public key phones subscribe with (VAPID)
// POST /p       {sub, at:[[YYYY-MM-DD, kind]], hh}   save or replace this phone's reminder dates ({sub, off:true} removes them)
// POST /p/test  {sub, k}    sends one nudge now, to a phone that has reminders on (to confirm they work)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX = 200000; // characters; a household is a few hundred
const KINDS = ['due', 'pay', 'dd'];
const TESTK = ['hello', 'due', 'pay', 'dd', 'chg'];
// Only real push services, so this can never be used to send requests anywhere else
const PUSH_HOSTS = /^(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w-]+\.notify\.windows\.com|push\.services\.mozilla\.com)$/;
const SUBJECT = 'https://jakerjames.github.io/Yak/';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const enc = new TextEncoder();
const b64u = a => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o };
async function sha(t) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/* ---------- VAPID: one key pair for this Worker, made the first time it is needed and kept in KV ---------- */
let VAPID = null;
async function vapid(env) {
  if (VAPID) return VAPID;
  let v = await env.KV.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.KV.put('vapid', JSON.stringify(v));
  }
  VAPID = { pub: v.pub, key: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return VAPID;
}
const JWTS = new Map();
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000), hit = JWTS.get(aud);
  const v = await vapid(env);
  if (hit && hit.exp - now > 3600) return `vapid t=${hit.t}, k=${v.pub}`;
  const exp = now + 12 * 3600;
  const body = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(enc.encode(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(body)); // raw r||s, as JWT wants
  const t = body + '.' + b64u(sig);
  JWTS.set(aud, { t, exp });
  return `vapid t=${t}, k=${v.pub}`;
}

/* ---------- Message encryption for Web Push (RFC 8291, aes128gcm) ---------- */
export async function encryptPush(p256dh, auth, text, fixed) {
  const ua = ub64u(p256dh), secret = ub64u(auth);
  const as = fixed ? fixed.keys : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hmac(await hmac(secret, shared), cat(enc.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])));
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  return cat(head, asPub, ct);
}

async function send(env, sub, msg, ttl) {
  try {
    const body = await encryptPush(sub.keys.p256dh, sub.keys.auth, JSON.stringify(msg));
    const r = await fetch(sub.endpoint, {
      method: 'POST', body,
      headers: { Authorization: await vapidAuth(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl || 21600), Urgency: 'high' },
    });
    return r.status;
  } catch (e) { return 0 }
}
const gone = s => s === 404 || s === 410;

/* ---------- Reminder storage ----------
   p:<id>   {sub, at:[[date, kind]], hh, t}   one phone (id = first half of the SHA-256 of its push address)
   hp:<hh>  [id, ...]                          housemates in a household with reminders on, nudged when the bills change */
function okSub(s) {
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys) return false;
  let u; try { u = new URL(s.endpoint) } catch (e) { return false }
  return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && /^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh || '') && /^[A-Za-z0-9_-]{16,32}$/.test(s.keys.auth || '');
}
async function houseList(env, hh, id, add) {
  const k = 'hp:' + hh, l = (await env.KV.get(k, 'json')) || [], has = l.includes(id);
  if (add && !has) { l.push(id); await env.KV.put(k, JSON.stringify(l.slice(-20))) }
  if (!add && has) { const n = l.filter(x => x !== id); if (n.length) await env.KV.put(k, JSON.stringify(n)); else await env.KV.delete(k) }
}
async function drop(env, id, rec) {
  await env.KV.delete('p:' + id);
  if (rec && rec.hh) await houseList(env, rec.hh, id, false);
}
async function remSave(req, env) {
  let b; try { b = await req.json() } catch (e) { return json({ error: 'bad data' }, 400) }
  if (!b || !okSub(b.sub)) return json({ error: 'bad subscription' }, 400);
  const id = (await sha(b.sub.endpoint)).slice(0, 32), old = await env.KV.get('p:' + id, 'json');
  if (b.off) { await drop(env, id, old); return json({ ok: true }) }
  const at = Array.isArray(b.at) ? b.at.filter(x => Array.isArray(x) && /^\d{4}-\d\d-\d\d$/.test(x[0]) && KINDS.includes(x[1])).slice(0, 400) : [];
  const hh = /^[0-9a-f]{32}$/.test(b.hh || '') ? b.hh : null;
  await env.KV.put('p:' + id, JSON.stringify({ sub: { endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } }, at, hh, t: Date.now() }));
  if (old && old.hh && old.hh !== hh) await houseList(env, old.hh, id, false);
  if (hh && (!old || old.hh !== hh)) await houseList(env, hh, id, true);
  return json({ ok: true, n: at.length });
}
async function remTest(req, env, dev) {
  let b; try { b = await req.json() } catch (e) { return json({ error: 'bad data' }, 400) }
  if (!b || !okSub(b.sub)) return json({ error: 'bad subscription' }, 400);
  const id = (await sha(b.sub.endpoint)).slice(0, 32), rec = await env.KV.get('p:' + id, 'json');
  if (!rec) return json({ error: 'reminders are off' }, 404);
  const k = dev && TESTK.includes(b.k) ? b.k : 'hello';
  if (!dev) { // at most one test a minute on the live service
    if (await env.KV.get('pt:' + id)) return json({ error: 'wait' }, 429);
    await env.KV.put('pt:' + id, '1', { expirationTtl: 60 });
  }
  const s = await send(env, rec.sub, { k: [k], test: true }, 600);
  if (gone(s)) await drop(env, id, rec);
  return json({ ok: s >= 200 && s < 300, status: s });
}
async function nudgeHouse(env, hh) {
  const l = (await env.KV.get('hp:' + hh, 'json')) || [];
  for (const id of l) {
    const rec = await env.KV.get('p:' + id, 'json');
    if (!rec) { await houseList(env, hh, id, false); continue }
    const s = await send(env, rec.sub, { k: ['chg'] }, 86400);
    if (gone(s)) await drop(env, id, rec);
  }
}
// Every evening: send each phone the reminders it asked for today. Runs at 18:00 and 19:00 UTC; only the one at 7pm UK time does anything.
const ukNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
};
export async function evening(env, force) {
  const { date, hour } = ukNow();
  if (hour !== 19 && !force) return { skipped: true };
  let cursor, sent = 0;
  do {
    const page = await env.KV.list({ prefix: 'p:', cursor });
    for (const k of page.keys) {
      const rec = await env.KV.get(k.name, 'json');
      if (!rec) continue;
      const kinds = [...new Set(rec.at.filter(x => x[0] === date).map(x => x[1]))];
      if (kinds.length) {
        const s = await send(env, rec.sub, { k: kinds, d: date });
        if (gone(s)) { await drop(env, k.name.slice(2), rec); continue }
        sent++;
      } else if (!rec.at.some(x => x[0] >= date) && Date.now() - rec.t > 120 * 864e5) await drop(env, k.name.slice(2), rec); // long unused
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { date, sent };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), dev = !!env.ASSETS;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/ping') return json({ ok: true, app: 'yak-sync' });
    if (url.pathname === '/p/key' && req.method === 'GET') return json({ k: (await vapid(env)).pub });
    if (url.pathname === '/p' && req.method === 'POST') return remSave(req, env);
    if (url.pathname === '/p/test' && req.method === 'POST') return remTest(req, env, dev);
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
      if (cur && cur.d !== d) ctx.waitUntil(nudgeHouse(env, m[1]));
      return json({ t });
    }
    return json({ error: 'method' }, 405);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(evening(env));
  },
};
