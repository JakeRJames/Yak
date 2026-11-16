"""Build the YAK demo page from the current index.html.

Usage: python3 tools/build-demo.py [output_dir]   (default: a yak-demo folder next to the repo)

The demo is the real app with:
  - sample figures loaded fresh every time the page opens (nothing is kept),
  - a "Demo" button that switches between the two user types (Manager and Housemate)
    and opens every prompt and screen for that user type.
Nothing here changes the live app. Republish the output to the "YAK demo" artifact
after every change or feature that is pushed.
"""
import json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), 'yak-demo')
s = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
ver = s.split('<meta name="version" content="')[1].split('"')[0]

now = '2026-11-16T19:00:00.000Z'
old = '2026-07-10T10:00:00.000Z'
bills = [{"n": "Gas & Electricity", "a": 140, "d": "8th", "t": "split", "u": now},
         {"n": "Water", "a": 38, "d": "23rd", "t": "split", "u": now},
         {"n": "WiFi Bundle", "a": 35, "d": "28th", "t": "split", "u": now},
         {"n": "Council Tax", "a": 160, "d": "28th", "t": "split", "u": now},
         {"n": "TV Licence", "a": 14.5, "d": "1st", "t": "split", "u": now}]
data = {"tab": "dash", "fc": {"2027-01": [{"n": "Credit card", "a": 600, "u": now}]}, "fcStart": 4200, "goal": {"a": 0},
        "home": {"people": 3, "budget": 800, "months": 0, "rentTotal": 1950, "rentDate": "15th", "bills": bills},
        "me": {"salary": 3400, "spend": 450, "fromAcct": "yes",
               "bills": [{"n": n, "a": a, "u": now} for n, a in [("Phone Bill (Combined)", 32), ("Apple Music", 11), ("Gym Membership", 35), ("Car", 260), ("Car Insurance", 75), ("Fuel", 150), ("Personal Trainer", 160), ("iCloud Storage", 3)]]},
        "lastChange": old, "reviewed": old, "upd": {}, "log": [],
        "pay": {"start": "2026-10", "mates": [{"n": "Sam", "d": 1}, {"n": "Alex", "d": 1}],
                "m": {"2026-10": {"due": 779.17, "n": 2, "p": [779.17, 779.17]}, "2026-11": {"p": [779.17, 0]}}}}
# Sample monthly snapshots (v4.3): earlier months, so History has something to compare.
hb0 = [["Rent", 650], ["Gas & Electricity", 40], ["Water", 12.67], ["WiFi Bundle", 11.67], ["Council Tax", 53.33], ["TV Licence", 4.83]]
pb0 = [["Phone Bill (Combined)", 32], ["Apple Music", 11], ["Gym Membership", 30], ["Car", 260], ["Car Insurance", 75], ["Fuel", 150], ["Personal Trainer", 160], ["iCloud Storage", 3]]
def snap(i, pb, s, extra=None, f=False):
    h = round(sum(x[1] for x in hb0), 2); b = sum(x[1] for x in pb)
    d = {"i": i, "h": h, "b": b, "s": s, "v": round(i - h - b - s, 2), "hb": hb0, "pb": pb}
    if f: d["f"] = 1
    return d
data["snap"] = {"2026-06": snap(3300, pb0 + [["Netflix", 11]], 500), "2026-07": snap(3300, pb0, 500),
                "2026-08": snap(3300, pb0, 500, f=True), "2026-09": snap(3400, pb0, 500), "2026-10": snap(3400, pb0, 450)}
meta = {"dirty": True, "last": "2026-11-07T18:00:00.000Z", "lastOpen": now, "fresh": False, "src": None}
pack = {"app": "YAK", "type": "household-pack", "format": 1, "household": "demo-house", "seq": 1, "device": "iPhone",
        "from": "Jake", "recipient": None,
        "home": {"people": 3, "rentTotal": 1950, "rentDate": "15th", "budget": 800,
                 "bills": [{k: v for k, v in b.items() if k != 'u'} for b in bills]}}

seed = ('<script>try{["yak.lock","yak.household","yak.theme"].forEach(k=>localStorage.removeItem(k));'
        'localStorage.setItem("budgit.v1",%s);localStorage.setItem("budgit.meta",%s)}catch(e){}</script>\n<script>\nconst VERSION'
        % (json.dumps(json.dumps(data)), json.dumps(json.dumps(meta))))

tour = r'''<style>
#tourb{position:fixed;right:14px;bottom:calc(86px + env(safe-area-inset-bottom,0px));z-index:70;font:700 13px var(--f);background:var(--ink);color:var(--bg);border:0;border-radius:99px;padding:10px 15px;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer}
#tourp{position:fixed;right:14px;bottom:calc(132px + env(safe-area-inset-bottom,0px));z-index:70;width:min(310px,calc(100% - 28px));max-height:64vh;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:10px}
@media(min-width:641px){#tourb{bottom:20px}#tourp{bottom:66px}}
#tourp[hidden]{display:none}#tourp .h{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em;font-weight:700;padding:10px 8px 2px}
#tourp .segc{margin:2px 0 4px}
#tourl button{display:block;width:100%;text-align:left;font:600 14px var(--f);color:var(--ink);background:none;border:0;border-radius:10px;padding:9px 8px;cursor:pointer}#tourl button:hover{background:var(--bg)}
#tourp .note{font-size:12px;color:var(--mute);padding:2px 8px 4px}
</style>
<button id="tourb"></button>
<div id="tourp" hidden><div class="h">Demo as</div><div class="segc" id="tourut"><button type="button" data-u="mgr">Manager</button><button type="button" data-u="hm">Housemate</button></div><div class="note" id="tourn"></div><div id="tourl"></div></div>
<script>{
const day=864e5,PACK=PACKJSON,BASE=structuredClone(S.me),SNAP0=structuredClone(S.snap||{});
let UT='mgr',MGR=null;
const hmOff=()=>{if(HM()){HH=null;saveHH();if(MGR)S.home=structuredClone(MGR)}S.me=structuredClone(BASE)};
const hmOn=()=>{if(!HM())MGR=structuredClone(S.home);const j=structuredClone(PACK);j.exported=new Date(Date.now()-2*day).toISOString();HH={pack:j,imported:new Date().toISOString(),name:'yak-household-pack.json',diff:[]};saveHH();S.me=structuredClone(BASE);hhApply()};
const ddDemo=m=>{const cur=ymk(new Date()),k1=ymk(kd(cur,0)),k2=ymk(kd(k1,0)),due=rd2(calc().share);S.dd={on:true,a:m==='short'?750:due,d:1,start:k2,m:{}};S.dd.m[k2]={due,p:m==='short'?750:due};S.dd.m[k1]={due,p:m==='owe'?500:m==='short'?750:due};S.dd.m[cur]={p:m==='ok'?due:m==='short'?750:0}};
const clr=()=>{S.snap=structuredClone(SNAP0);HSO=null;S.dd={on:false,a:0,d:1,start:null,m:{}};M.fresh=false;ASK=false;PEND=null;RST=false;NEWV='';MSG=null;PPK=null;LEAVE=false;LK={mode:null,err:''};TDO=false;sheetClose();delete S.hh;S.tab='dash';try{localStorage.removeItem('yak.lock')}catch(e){};UT==='hm'?hmOn():hmOff()};
const imp=older=>({d:structuredClone(S),name:'yak-data.json',device:'Mac',exported:new Date(Date.now()-(older?5:0)*day).toISOString(),fl:Date.now()-(older?5:0)*day,ll:Date.now()-(older?0:day),older,hh:HM()?HH.pack:null});
const pk=seq=>{const j=structuredClone(PACK);j.seq=seq;j.exported=new Date().toISOString();if(seq>1){j.home.bills[0].a=155;j.home.bills.push({n:'Window cleaner',a:15,d:'1st',t:'split'})}return pkPend(j,'yak-household-pack.json')};
const common=[
 ['Used YAK on another device since?',()=>{M.lastOpen=new Date(Date.now()-2*day).toISOString();ASK=true}],
 ['Import: file is older than this device',()=>{PEND=imp(true)}],
 ['Import: replace my data?',()=>{PEND=imp(false)}],
 ['Update available',()=>{NEWV='9.9.9'}],
 ['Reset to starting values?',()=>{RST=true}],
 ['Message after an action',()=>{MSG='Passcode lock is on. YAK will ask for it when it opens on this device.'}],
 ['Your name',()=>{},()=>nameSheet()],
 ['Savings goal',()=>{},()=>goalSheet()],
 ['Set a passcode',()=>{LK={mode:'set',err:''}},()=>{const c=document.getElementById('lkc');if(c)c.scrollIntoView({block:'center'})}],
 ['Lock screen (passcode 1234)',async()=>{await lockSet('1234');LOCKED=true}]];
const T={
 mgr:{note:'You manage the house bills and share packs with housemates.',items:[
  ['Home with To do (4 reminders)',()=>{TDO=true}],
  ['House',()=>{S.tab='home'}],
  ['Edit a bill',()=>{S.tab='home'},()=>billSheet('home',1)],
  ['Add a bill',()=>{S.tab='home'},()=>billSheet('home',-1)],
  ['Rent',()=>{S.tab='home'},()=>rentSheet()],
  ['Personal',()=>{S.tab='me'}],
  ['Payments',()=>{S.tab='pay'}],
  ['Forecast',()=>{S.tab='fc'}],
  ['History',()=>{S.tab='hist'}],
  ['History: a month opened',()=>{S.tab='hist';HSO=ymk(new Date())}],
  ['History: first month only',()=>{S.tab='hist';const k=ymk(new Date());S.snap={};snapTake()}],
  ['Simulator',()=>{S.tab='sim'}],
  ['Changes',()=>{S.tab='log'}],
  ['Instructions',()=>{S.tab='help'}],
  ['More menu',()=>{},()=>moreOpen()],
  ['New on this device?',()=>{M.fresh=true}],
  ['No income entered yet',()=>{S.me.salary=0}],
  ['Personal: where do bills come from?',()=>{S.tab='me';S.me.fromAcct=null}],
  ['Payments: question not answered yet',()=>{S.tab='pay';S.me.fromAcct=null}],
  ['Bills collected separately (no Payments)',()=>{S.me.fromAcct='no'}],
  ['House bills changed since last pack',()=>{S.tab='home';S.hh={id:'demo',seq:2,last:new Date(Date.now()-3*day).toISOString(),sig:'old'}}],
  ['A housemate sends you a pack',()=>{PPK=pk(1)}],
  ...common]},
 hm:{note:'A housemate gets a read-only pack of the house bills from the manager and keeps their own figures.',items:[
  ['Home with To do',()=>{TDO=true}],
  ['House (read only)',()=>{S.tab='home'}],
  ['Personal',()=>{S.tab='me'}],
  ['Forecast',()=>{S.tab='fc'}],
  ['History',()=>{S.tab='hist'}],
  ['Simulator',()=>{S.tab='sim'}],
  ['Instructions',()=>{S.tab='help'}],
  ['More menu',()=>{},()=>moreOpen()],
  ['No income entered yet',()=>{S.me.salary=0}],
  ['Direct debit: set it up',()=>{S.tab='me'},()=>ddSheet()],
  ['Direct debit: Home when you owe',()=>{ddDemo('owe');TDO=true}],
  ['Direct debit: My Payments',()=>{ddDemo('owe');S.tab='pay'}],
  ['Direct debit: Personal when you owe',()=>{ddDemo('owe');S.tab='me'}],
  ['Direct debit: short of your share',()=>{ddDemo('short');S.tab='me'}],
  ['Direct debit: edit a month',()=>{ddDemo('owe');S.tab='pay'},()=>ddMonthSheet(ymk(kd(ymk(new Date()),0)))],
  ['Direct debit: all paid up',()=>{ddDemo('ok')}],
  ['A new pack arrives (changes shown)',()=>{PPK=pk(2)}],
  ['Leave housemate mode?',()=>{LEAVE=true}],
  ...common]}};
const lab=()=>{document.getElementById('tourb').textContent='Demo: '+(UT==='hm'?'Housemate':'Manager');document.querySelectorAll('#tourut button').forEach(b=>b.classList.toggle('on',b.dataset.u===UT));document.getElementById('tourn').textContent=T[UT].note;
 document.getElementById('tourl').innerHTML='<div class="h">Screens and prompts</div>'+T[UT].items.map((t,i)=>`<button data-i="${i}">${t[0]}</button>`).join('')};
const run=async it=>{clr();try{if(it)await it[1]()}catch(x){MSG='Demo: '+x.message}PLAY=true;ENTER=true;render();scrollTo(0,0);if(it&&it[2])setTimeout(it[2],120)};
document.getElementById('tourb').onclick=()=>{document.getElementById('tourp').hidden^=1};
document.getElementById('tourut').onclick=e=>{const b=e.target.closest('button');if(!b||b.dataset.u===UT)return;UT=b.dataset.u;lab();run(null)};
document.getElementById('tourl').onclick=e=>{const b=e.target.closest('button');if(!b)return;document.getElementById('tourp').hidden=true;run(T[UT].items[+b.dataset.i])};
lab();
}</script>
</body></html>'''.replace('PACKJSON', json.dumps(pack))

assert s.count('<script>\nconst VERSION') == 1 and s.rstrip().endswith('</body></html>')
s = s.replace('<script>\nconst VERSION', seed).rstrip()[:-len('</body></html>')] + tour
h1 = '<h1 onclick="tab(\'dash\')">YAK<span>.</span></h1>'
assert s.count(h1) == 1
s = s.replace(h1, h1 + '<span class="demopill" title="This is a demo with sample figures, not your live YAK">Demo</span>')
s = s.replace('</style></head>', 'header .demopill{align-self:center;margin-left:-14px;font:800 11px var(--f);letter-spacing:.06em;text-transform:uppercase;color:#fff;background:var(--dot);border-radius:99px;padding:4px 10px;line-height:1.2}@media(max-width:640px){header .demopill{margin-left:0}}</style></head>', 1)
s = s.replace('<title>YAK v%s</title>' % ver, '<title>YAK demo (v%s)</title>' % ver)
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(s)
for f in ('apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'):
    shutil.copy(os.path.join(ROOT, f), OUT)
print('YAK demo v%s written to %s' % (ver, OUT))
