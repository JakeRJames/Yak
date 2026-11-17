// YAK offline support and bill reminders. The page is fetched fresh whenever there is a connection,
// and the last copy is used when there is not. Saved data lives in the browser, not here.
const CACHE = 'yak-v5.1.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  // "Check for updates" asks for a fresh copy: always go to the network for it.
  if (r.cache === 'reload' || r.cache === 'no-store') return;
  if (new URL(r.url).pathname.match(/\/(h|p)\//)) return; // the sync service on the test Worker
  if (r.mode === 'navigate') {
    const net = fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); }
      return res;
    });
    const fromCache = () => caches.match('./').then(m => m || caches.match('index.html'));
    // Use the network, but fall back to the saved copy if it is slow (weak signal) or offline.
    e.respondWith(
      Promise.race([net.catch(() => null), new Promise(ok => setTimeout(() => ok(null), 3500))])
        .then(res => res || fromCache().then(m => m || net))
        .catch(fromCache)
    );
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});

/* ================= Bill reminders (Ethereal 1.1) =================
   The page hands over a small copy of what reminders need (house bills, who pays what, payment and direct debit dates),
   kept here in IndexedDB. From it this file works out the evenings that need a reminder and sends only those dates to the
   sync service. At 7pm the service sends a nudge saying which kind it is ('due', 'pay', 'dd', or 'chg' when the manager
   changes the house bills), and the message is written here, on the phone, so no names or amounts ever leave it. */
const SYNC = /\.workers\.dev$/.test(location.hostname) ? location.origin : 'https://yak-sync.jake-rjames.workers.dev';
const DAYS = 120; // how far ahead reminder dates are sent
const db = () => new Promise((ok, no) => { const q = indexedDB.open('yak', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error) });
const idb = async (mode, fn) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction('kv', mode), r = fn(t.objectStore('kv')); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error) }) };
const get = k => idb('readonly', s => s.get(k));
const put = (k, v) => idb('readwrite', s => s.put(v, k));
const del = k => idb('readwrite', s => s.delete(k));

const gbp = n => '£' + (Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day0 = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plus = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayOf = d => { const m = String(d || '').match(/\d{1,2}/); return m ? Math.min(31, Math.max(1, +m[0])) : null };
const fdd = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// Every bill and the rent, with the amount this person pays
function bills(m) {
  const h = m.latest || m.home || { bills: [] }, p = Math.max(1, +h.people || 1), o = [];
  for (const b of h.bills || []) { const a = +b.a || 0; if (a > 0.004) o.push({ n: String(b.n || 'Bill'), day: dayOf(b.d), v: m.full ? (b.t === 'each' ? a * p : a) : (b.t === 'each' ? a : a / p) }) }
  if (+h.rentTotal > 0) o.push({ n: 'Rent', day: dayOf(h.rentDate), v: m.full ? +h.rentTotal : +h.rentTotal / p });
  return o;
}
// The bills taken on a date (a bill on the 31st is taken on the last day of shorter months)
function dueOn(m, d) {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return bills(m).filter(b => b.day && Math.min(b.day, last) === d.getDate());
}
function dates(m) {
  const t = day0(), o = [];
  if (!m.skipDue) for (let i = 0; i < DAYS; i++) { const ev = plus(t, i); if (dueOn(m, plus(ev, 1)).length) o.push([ymd(ev), 'due']) }
  const today = ymd(t);
  for (const x of m.extra || []) if (x.d >= today && x.d <= ymd(plus(t, DAYS))) o.push([x.d, x.k]);
  return o.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1);
}
// Send the reminder dates to the sync service, only when they have changed or are running out
async function schedule(force) {
  const m = await get('remind'), sub = await self.registration.pushManager.getSubscription();
  if (!m || !m.on || !sub) return { ok: false, why: 'off' };
  const at = dates(m), today = ymd(day0()), prev = await get('remindSent'), s = sub.toJSON(), hh = m.sync ? m.sync.id : null;
  if (!force && prev && prev.ep === s.endpoint && prev.hh === hh && prev.end > ymd(plus(day0(), 40))) {
    const win = l => JSON.stringify(l.filter(x => x[0] >= today && x[0] <= prev.end));
    if (win(at) === win(prev.at)) return { ok: true, same: true };
  }
  const r = await fetch(SYNC + '/p', { method: 'POST', body: JSON.stringify({ sub: s, at, hh }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) return { ok: false, why: 'status ' + r.status };
  await put('remindSent', { ep: s.endpoint, hh, at, end: ymd(plus(day0(), DAYS - 1)), t: Date.now() });
  return { ok: true, n: at.length };
}
async function off() {
  const sub = await self.registration.pushManager.getSubscription();
  if (sub) { try { await fetch(SYNC + '/p', { method: 'POST', body: JSON.stringify({ sub: sub.toJSON(), off: true }), headers: { 'Content-Type': 'application/json' } }) } catch (e) {} try { await sub.unsubscribe() } catch (e) {} }
  await del('remind'); await del('remindSent');
}
self.addEventListener('message', e => {
  const d = e.data || {}, port = e.ports && e.ports[0], reply = v => { if (port) port.postMessage(v) };
  if (d.type === 'yak-remind') e.waitUntil((async () => {
    const old = await get('remind');
    const m = Object.assign({}, d.m, { on: true });
    if (old && old.latest && m.sync && JSON.stringify(old.home) === JSON.stringify(m.home)) m.latest = old.latest; // the page has not caught up with a change yet
    await put('remind', m);
    reply(await schedule(!!d.force).catch(x => ({ ok: false, why: String(x) })));
  })());
  if (d.type === 'yak-remind-off') e.waitUntil(off().then(() => reply({ ok: true }), () => reply({ ok: false })));
});

/* ---------- writing the messages ---------- */
function dueMsg(m, test) {
  let when = plus(day0(), 1), L = dueOn(m, when), pre = 'tomorrow';
  if (!L.length && test) { for (let i = 2; i < 40 && !L.length; i++) { when = plus(day0(), i); L = dueOn(m, when) } pre = 'on ' + fdd(when) }
  if (!L.length) return test ? { title: 'Bill reminders are working', body: 'No bills have dates set yet.' } : null;
  const share = !m.full && Math.max(1, +((m.latest || m.home || {}).people) || 1) > 1;
  if (L.length === 1) return { title: `${L[0].n} is due ${pre}`, body: gbp(L[0].v) + (share ? ', your share' : ''), tab: 'home' };
  return { title: `${L.length} bills are due ${pre}`, body: (share ? 'Your share: ' : '') + L.map(b => b.n + ' ' + gbp(b.v)).join(' · ') + '. Total ' + gbp(L.reduce((n, b) => n + b.v, 0)) + '.', tab: 'home' };
}
function listMsg(m, k, date, test) {
  let L = (m.extra || []).filter(x => x.k === k && x.d === date);
  if (!L.length && test) { const f = (m.extra || []).find(x => x.k === k); if (f) L = (m.extra || []).filter(x => x.k === k && x.d === f.d) }
  if (!L.length) return test ? { title: k === 'pay' ? 'Payment reminders are working' : 'Direct debit reminders are working', body: 'Nothing is coming up yet.' } : null;
  if (L.length === 1 || k === 'dd') return { title: L[0].t, body: L[0].b, tab: 'pay' };
  return { title: `${L.length} housemates have not paid for ${L[0].mon}`, body: L.map(x => x.n + ' ' + gbp(x.a)).join(' · ') + '.', tab: 'pay' };
}
const ub64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function open(id, k, d) {
  const a = ub64u(d), key = await crypto.subtle.importKey('raw', ub64u(k), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.slice(0, 12), additionalData: new TextEncoder().encode(id) }, key, a.slice(12))));
}
const shareOf = h => { const p = Math.max(1, +h.people || 1); return (+h.rentTotal || 0) / p + (h.bills || []).reduce((n, b) => n + (b.t === 'each' ? +b.a || 0 : (+b.a || 0) / p), 0) };
function diff(a, b) {
  const o = [], r = x => Math.round(x * 100) / 100, am = x => (x > 0 ? '+' : '−') + gbp(Math.abs(x)), key = x => String(x.n).trim().toLowerCase();
  const A = new Map((a.bills || []).map(x => [key(x), x])), B = new Map((b.bills || []).map(x => [key(x), x]));
  const pa = Math.max(1, +a.people || 1), pb = Math.max(1, +b.people || 1);
  if (pa !== pb) o.push('People in the house ' + pa + ' → ' + pb);
  const dr = r((+b.rentTotal || 0) - (+a.rentTotal || 0)); if (dr) o.push('Rent ' + am(dr));
  B.forEach((x, k) => { const y = A.get(k); if (!y) { o.push(x.n + ' added (' + gbp(+x.a || 0) + ')'); return } const d = r((+x.a || 0) - (+y.a || 0)); if (d) o.push(x.n + ' ' + am(d)); else if ((x.d || '') !== (y.d || '')) o.push(x.n + ' date now ' + (x.d || 'not set')) });
  A.forEach((y, k) => { if (!B.has(k)) o.push(y.n + ' removed') });
  return o;
}
async function chgMsg(m) {
  const fall = { title: 'House bills updated', body: 'Open YAK to see what changed.', tab: 'home' };
  if (!m.sync) return fall;
  try {
    const r = await fetch(SYNC + '/h/' + m.sync.id, { cache: 'no-store' }); if (!r.ok) return fall;
    const j = await open(m.sync.id, m.sync.k, (await r.json()).d);
    if (!j || !j.home || !Array.isArray(j.home.bills)) return fall;
    const before = m.home || { bills: [] }, lines = diff(before, j.home), a = shareOf(before), b = shareOf(j.home);
    m.latest = j.home; await put('remind', m); schedule().catch(() => {}); // the dates may have moved
    const who = j.from ? ' by ' + j.from : '';
    if (!lines.length) return { title: 'House bills updated' + who, body: 'Your share is still ' + gbp(b) + ' a month.', tab: 'home' };
    return { title: 'House bills changed' + who, body: lines.join(' · ') + '. ' + (Math.abs(a - b) > 0.004 ? 'Your share ' + gbp(a) + ' → ' + gbp(b) + ' a month.' : 'Your share is still ' + gbp(b) + ' a month.'), tab: 'home' };
  } catch (e) { return fall }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {} } catch (x) {}
  const kinds = Array.isArray(d.k) && d.k.length ? d.k : ['due'], date = d.d || ymd(day0());
  e.waitUntil((async () => {
    const m = (await get('remind')) || {}, out = [];
    for (const k of kinds) {
      let n = null;
      if (k === 'hello') n = { title: 'Bill reminders are on', body: 'YAK will remind you at 7pm the evening before something is due.' };
      else if (k === 'due') n = dueMsg(m, d.test);
      else if (k === 'pay' || k === 'dd') n = listMsg(m, k, date, d.test);
      else if (k === 'chg') n = await chgMsg(m);
      if (n) out.push(Object.assign(n, { k }));
    }
    if (!out.length) out.push({ title: 'YAK', body: 'You have a reminder. Open YAK to see what is coming up.', k: 'x' }); // a nudge must always show something
    for (const n of out) await self.registration.showNotification(n.title, { body: n.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'yak-' + n.k, data: { tab: n.tab || '' } });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = (e.notification.data || {}).tab || '';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { try { await c.focus(); c.postMessage({ type: 'yak-open', tab }); return } catch (x) {} }
    await self.clients.openWindow('./' + (tab ? '#open=' + tab : ''));
  })());
});
