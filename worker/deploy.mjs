// Deploys the YAK sync Worker. Run by .github/workflows/sync.yml, never by hand.
// dev  -> yak-sync-dev (test data, and it also serves the dev build of YAK so it can be tried on a phone)
// main -> yak-sync     (the live household data)
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
const live = process.env.BRANCH === 'main', name = live ? 'yak-sync' : 'yak-sync-dev', kv = name + '-kv';
const out = { branch: process.env.BRANCH, name, ok: false, url: '', sha: process.env.GITHUB_SHA || '', at: new Date().toISOString(), log: '',
  secrets: { CLOUDFLARE_API_TOKEN: !!process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: !!process.env.CLOUDFLARE_ACCOUNT_ID, asVariables: process.env.AS_VARS || '' } };
const scrub = t => { const a = process.env.CLOUDFLARE_ACCOUNT_ID, k = process.env.CLOUDFLARE_API_TOKEN; return [a, k].filter(Boolean).reduce((s, x) => s.split(x).join('***'), String(t)) };
const run = c => { try { return execSync(c, { cwd: 'worker', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { throw new Error(c + '\n' + (e.stdout || '') + (e.stderr || '')) } };
const W = 'npx -y wrangler@4';
try {
  const list = () => { const t = run(W + ' kv namespace list'); return JSON.parse(t.slice(t.indexOf('['))) };
  let ns = list().find(n => n.title === kv);
  if (!ns) { out.log += run(W + ' kv namespace create ' + kv); ns = list().find(n => n.title === kv || n.title.endsWith(kv)) }
  if (!ns) throw new Error('Could not create the storage namespace ' + kv);
  let toml = `name = "${name}"\nmain = "worker.js"\ncompatibility_date = "2025-10-01"\nworkers_dev = true\n\n[[kv_namespaces]]\nbinding = "KV"\nid = "${ns.id}"\n`;
  if (!live) {
    rmSync('worker/site', { recursive: true, force: true }); mkdirSync('worker/site');
    for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) copyFileSync(f, 'worker/site/' + f);
    toml += `\n[assets]\ndirectory = "./site"\nbinding = "ASSETS"\n`;
  }
  writeFileSync('worker/wrangler.toml', toml);
  const d = run(W + ' deploy'); out.log += d;
  const u = d.match(/https:\/\/[\w.-]+\.workers\.dev/); out.url = u ? u[0] : ''; out.ok = !!u;
} catch (e) { out.log += '\nFAILED: ' + e.message }
out.log = scrub(out.log).split('\n').slice(-40).join('\n');
writeFileSync(process.env.STATUS_FILE || 'status.json', JSON.stringify(out, null, 2));
console.log(out.ok ? 'Deployed ' + out.url : out.log);
if (!out.ok) process.exit(1);
