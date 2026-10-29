// Real IndexedDB CRUD/atomicity/failure checks. Faults are injected only into test connections.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});
let browser,checks=0;
async function initialize(page) {
  await page.goto(`http://localhost:${server.address().port}/mathjong/`);
  await page.evaluate(async()=>{
    const module = f=>import(new URL(`src/${f}`,location.href));
    const [storage,pf,{Game},{createRules},{modeConfig},{createMatch,applyRoundResult}]=await Promise.all([
      module('ui/paifu-storage.js'),module('engine/paifu.js'),module('engine/game.js'),module('engine/rules.js'),module('engine/config.js'),module('engine/match.js')]);
    const players=['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'}));
    const record=(id,mode='math1',length=4)=>{
      const rules=createRules(modeConfig(mode)),match=createMatch({length}),g=new Game({rules,seed:1,players});
      return pf.beginRound(pf.createPaifu({id,rules,players,match,origin:'fixture'}),g);
    };
    const full=(id,mode='math1',length=4)=>{
      const rules=createRules(modeConfig(mode));let match=createMatch({length}),p=pf.createPaifu({id,rules,players,match,origin:'fixture'}),round=1;
      while(!match.over){
        const g=new Game({rules,seed:round,dealer:(match.startDealer+match.hand)%4,round,players});p=pf.beginRound(p,g);
        while(g.pending()){
          const q=g.pending(),action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:g.drawn??g.hands[q.seat].at(-1)},before=pf.captureGame(g);
          if(action.type==='pass')g.respond(q.seat,action);else g.discard(q.seat,action.tile);
          p=pf.appendDecision(p,{before,after:pf.captureGame(g),seat:q.seat,action});
        }
        match=applyRoundResult(match,g.result);p=pf.settleRound(p,match);round++;
      }
      return p;
    };
    const db=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(storage.PAIFU_DB_NAME,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});
    const raw=async(mode,fn)=>{const d=await db();try{return await new Promise((resolve,reject)=>{const t=d.transaction(['records','index'],mode);let value;t.oncomplete=()=>resolve(value);t.onabort=()=>reject(t.error||Error('raw abort'));fn(t,x=>{value=x;});});}finally{d.close();}};
    const rows=id=>raw('readonly',(t,set)=>{let r,m;const a=t.objectStore('records').get(id),b=t.objectStore('index').get(id);a.onsuccess=()=>{r=a.result;if(b.readyState==='done')set({row:r,meta:b.result});};b.onsuccess=()=>{m=b.result;if(a.readyState==='done')set({row:a.result,meta:m});};});
    const putRows=(row,meta)=>raw('readwrite',t=>{if(row)t.objectStore('records').put(row);if(meta)t.objectStore('index').put(meta);});
    const hash=async json=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json))),n=>n.toString(16).padStart(2,'0')).join('');
    const factory=fn=>({open(name,version){const r=indexedDB.open(name,version);r.addEventListener('success',()=>fn(r.result));return r;}});
    window.__storageTest={...storage,pf,record,full,raw,rows,putRows,hash,factory};
  });
}
async function check(page,name,fn) {
  await page.evaluate(fn);checks++;console.log(`✓ IndexedDB: ${name}`);
}
try{
  browser=await chromium.launch({args:['--no-proxy-server']});
  const ctx=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
  await initialize(page);
  await check(page,'保存・再読込・検証・metadata一覧、既存localStorageと他DBから独立',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('first');
    localStorage.setItem('mj-mode','math1');localStorage.setItem('mj-beginner-room-v1','existing-value');localStorage.setItem('unrelated','keep');
    t.savedLocal=JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]));
    const a=await s.save(p);if(!a.ok||a.metadata.revision!==1)throw Error(JSON.stringify(a));
    const b=await s.loadPrivate('first');if(!b.ok||t.pf.encodePaifu(b.record)!==t.pf.encodePaifu(p))throw Error('round trip');
    const c=await s.list();if(!c.ok||c.entries.length!==1||'record' in c.entries[0]||'json' in c.entries[0]||'hands' in c.entries[0])throw Error('private list');
    const verified=await s.verify('first');if(!verified.ok||verified.valid!==true||'record' in verified)throw Error('verify/private boundary');
    t.first=p;t.firstToken=a.metadata.token;
    await new Promise((resolve,reject)=>{const r=indexedDB.open('unrelated-game',1);r.onupgradeneeded=()=>r.result.createObjectStore('keep');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('keep','readwrite');tx.objectStore('keep').put('untouched',1);tx.oncomplete=()=>{db.close();resolve();};};});
  });
  const localBefore=await page.evaluate(()=>window.__storageTest.savedLocal);
  await page.reload();await initialize(page);
  await check(page,'ページ再読込後も保存済み牌譜が残る',async()=>{
    const t=window.__storageTest,r=await t.createPaifuStore().loadPrivate('first');
    if(!r.ok||r.record.id!=='first'||r.metadata.revision!==1)throw Error('reload lost record');
    t.first=r.record;t.firstToken=r.metadata.token;
    t.savedLocal=JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]));
  });
  assert.equal(await page.evaluate(()=>window.__storageTest.savedLocal),localBefore);
  await check(page,'create-only・CAS更新・古いtoken拒否',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.pf.endRecording(t.first,{reason:'left-match'});
    const a=await s.save(p);if(a.ok||a.error.code!=='conflict')throw Error('duplicate overwrote');
    const b=await s.save(p,{expectedToken:t.firstToken});if(!b.ok||b.metadata.revision!==2||b.metadata.token===t.firstToken)throw Error('update');
    const c=await s.save(t.first,{expectedToken:t.firstToken});if(c.ok||c.error.code!=='conflict')throw Error('stale update');
    const d=await s.loadPrivate('first');if(!d.ok||d.record.status!=='aborted')throw Error('updated payload');t.currentToken=d.metadata.token;
  });
  await check(page,'非同期保存中に呼出元を変更しても確定JSON/metadataが変わらない',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=JSON.parse(t.pf.encodePaifu(t.record('mutable')));
    const expected=t.pf.encodePaifu(p),pending=s.save(p);p.id='changed';p.status='aborted';p.settings.rules.mode='invalid';
    const a=await pending,b=await s.loadPrivate('mutable');if(!a.ok||!b.ok||t.pf.encodePaifu(b.record)!==expected)throw Error('caller mutation leaked');
    if((await s.loadPrivate('changed')).error.code!=='not-found')throw Error('wrong ID');
  });
  await check(page,'個別削除・削除/再作成後の古い書き込み(ABA)・存在しないID',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore();
    const stale=await s.remove('first',{expectedToken:t.firstToken});if(stale.ok||stale.error.code!=='conflict')throw Error('stale delete');
    if(!(await s.remove('first')).removed)throw Error('remove');
    if((await s.loadPrivate('first')).error.code!=='not-found')throw Error('not found');
    const a=await s.save(t.first);if(!a.ok||a.metadata.revision!==1||a.metadata.token===t.firstToken)throw Error('new incarnation');
    const b=await s.save(t.first,{expectedToken:t.firstToken});if(b.ok||b.error.code!=='conflict')throw Error('ABA');
    const c=await s.remove('absent');if(!c.ok||c.removed!==false)throw Error('absent remove');
  });
  await check(page,'全件削除は専用2ストアのみ。古いCAS保存は復活しない',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),old=(await s.loadPrivate('first')).metadata.token;
    const a=await s.clearAll(),b=await s.list();if(!a.ok||!b.ok||b.entries.length||b.bytes)throw Error('clear');
    const c=await s.save(t.first,{expectedToken:old});if(c.ok||c.error.code!=='conflict')throw Error('resurrected');
    if(JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))!==t.savedLocal)throw Error('localStorage changed');
    await new Promise((resolve,reject)=>{const r=indexedDB.open('unrelated-game',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const d=r.result,q=d.transaction('keep').objectStore('keep').get(1);q.onsuccess=()=>{d.close();q.result==='untouched'?resolve():reject(Error('other DB changed'));};};});
  });
  await check(page,'容量・件数上限で自動削除せず、上書きは差分容量で計算',async()=>{
    const t=window.__storageTest,p=t.record('budget'),bytes=new TextEncoder().encode(t.pf.encodePaifu(p)).length;
    const tiny=t.createPaifuStore({maxBytes:bytes-1}),a=await tiny.save(p);if(a.ok||a.error.code!=='capacity-exceeded')throw Error('byte budget');
    const s=t.createPaifuStore({maxBytes:bytes,maxRecords:1}),b=await s.save(p);if(!b.ok)throw Error(JSON.stringify(b));
    const c=await s.save(p,{expectedToken:b.metadata.token});if(!c.ok)throw Error('replacement double counted');
    const d=await s.save(t.record('another'));if(d.ok||d.error.code!=='capacity-exceeded')throw Error('count budget');
    const list=await s.list();if(list.entries.length!==1||list.entries[0].id!=='budget'||list.bytes!==bytes)throw Error('evicted/budget');await s.clearAll();
  });
  await check(page,'別インスタンスの同時保存も容量・CASが原子的',async()=>{
    const t=window.__storageTest,a=t.createPaifuStore({maxRecords:1}),b=t.createPaifuStore({maxRecords:1});
    let out=await Promise.all([a.save(t.record('race-a')),b.save(t.record('race-b'))]);
    if(out.filter(r=>r.ok).length!==1||out.filter(r=>r.error?.code==='capacity-exceeded').length!==1)throw Error('capacity race');
    const entry=(await a.list()).entries[0],p=(await a.loadPrivate(entry.id)).record;
    out=await Promise.all([a.save(p,{expectedToken:entry.token}),b.save(p,{expectedToken:entry.token})]);
    if(out.filter(r=>r.ok).length!==1||out.filter(r=>r.error?.code==='conflict').length!==1)throw Error('CAS race');await a.clearAll();
  });
  await check(page,'実ネイティブtransactionの途中abortで本文/索引が両方ロールバック',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('rollback'),saved=await s.save(p);
    const factory=t.factory(db=>{const original=db.transaction.bind(db);db.transaction=(...args)=>{
      const tx=original(...args);if(args[1]==='readwrite'){
        const get=tx.objectStore.bind(tx);tx.objectStore=name=>{const os=get(name);if(name==='index'&&!os.__patched){os.__patched=true;const put=os.put.bind(os);os.put=(...a)=>{const r=put(...a);r.addEventListener('success',()=>tx.abort());return r;};}return os;};
      }return tx;
    };});
    const bad=t.createPaifuStore({getIndexedDB:()=>factory});
    const r=await bad.save(t.pf.endRecording(p,{reason:'reset'}),{expectedToken:saved.metadata.token});
    if(r.ok||r.error.code!=='interrupted')throw Error('abort acknowledged');
    const after=await s.loadPrivate(p.id);if(!after.ok||after.record.status!=='recording'||after.metadata.token!==saved.metadata.token)throw Error('partial commit');await s.clearAll();
  });
  await check(page,'非同期requestエラーでも部分commitせず、削除/全削除のabortもロールバック',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('request-errors'),saved=await s.save(p);
    for(const kind of ['request-error','remove-abort','clear-abort']){
      const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{
        const tx=f(...args);if(args[1]==='readwrite'){
          const get=tx.objectStore.bind(tx);tx.objectStore=name=>{const os=get(name);if(!os.__fault){os.__fault=true;
            if(kind==='request-error'&&name==='index')os.put=value=>os.add(value);
            const method=kind==='remove-abort'?'delete':kind==='clear-abort'?'clear':null;
            if(method&&name==='records'){const fn=os[method].bind(os);os[method]=(...a)=>{const r=fn(...a);r.addEventListener('success',()=>tx.abort());return r;};}
          }return os;};
        }return tx;
      };});
      const bad=t.createPaifuStore({getIndexedDB:()=>factory});
      const r=kind==='request-error'?await bad.save(p,{expectedToken:saved.metadata.token}):kind==='remove-abort'?await bad.remove(p.id):await bad.clearAll();
      if(r.ok||r.error.code!==(kind==='request-error'?'storage-error':'interrupted'))throw Error(kind+' acknowledged');
      const after=await s.loadPrivate(p.id);if(!after.ok||after.metadata.token!==saved.metadata.token)throw Error(kind+' partial write');
    }await s.clearAll();
  });
  await check(page,'QuotaExceededErrorでも既存牌譜を保持し、通常の次回保存が成功',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('quota'),saved=await s.save(p);
    const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{const tx=f(...args);if(args[1]==='readwrite'){const get=tx.objectStore.bind(tx);tx.objectStore=name=>{const os=get(name);if(name==='index')os.put=()=>{throw new DOMException('injected quota','QuotaExceededError');};return os;};}return tx;};});
    const r=await t.createPaifuStore({getIndexedDB:()=>factory}).save(p,{expectedToken:saved.metadata.token});if(r.ok||r.error.code!=='quota-exceeded')throw Error('quota');
    const after=await s.loadPrivate(p.id);if(!after.ok||after.metadata.token!==saved.metadata.token)throw Error('quota destroyed old data');
    if(!(await s.save(p,{expectedToken:saved.metadata.token})).ok)throw Error('cannot recover');await s.clearAll();
  });
  await check(page,'実transactionのタイムアウトで中断し、後からcommitしない',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('timeout'),saved=await s.save(p);
    let started=false;
    const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{
      const tx=f(...args);if(args[1]==='readwrite'){started=true;const get=tx.objectStore.bind(tx),end=performance.now()+1500;const hold=()=>{const r=get('index').get('keep-active');r.onsuccess=()=>{if(performance.now()<end)hold();};};hold();}return tx;
    };});
    const r=await t.createPaifuStore({getIndexedDB:()=>factory,timeoutMs:200}).save(p,{expectedToken:saved.metadata.token});
    if(r.ok||r.error.code!=='timeout'||!started)throw Error('native transaction timeout');
    const after=await s.loadPrivate(p.id);if(!after.ok||after.metadata.token!==saved.metadata.token)throw Error('late commit');await s.clearAll();
  });
  await check(page,'Safari旧API相当：durability引数のTypeErrorでも通常transactionへ安全にフォールバック',async()=>{
    const t=window.__storageTest;let fallback=0;
    const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{if(args.length===3){fallback++;throw new TypeError('old API');}return f(...args);};});
    const s=t.createPaifuStore({getIndexedDB:()=>factory});if(!(await s.save(t.record('old-api'))).ok||fallback!==1)throw Error('old transaction API');await s.clearAll();
  });
  await check(page,'本文のSHA-256不一致は破損。データを自動削除せず明示削除可能',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('checksum');await s.save(p);
    const {row,meta}=await t.rows(p.id);row.json=row.json.replace('\"name\":\"kanata\"','\"name\":\"KANATA\"');
    if(t.pf.decodePaifu(row.json).settings.players[0].name!=='KANATA')throw Error('checksum fault did not preserve legal record');
    await t.putRows(row,meta);const a=await s.loadPrivate(p.id);if(a.ok||a.error.code!=='corrupt')throw Error('checksum accepted');
    if((await t.rows(p.id)).row.json!==row.json)throw Error('auto removed');if(!(await s.remove(p.id)).removed)throw Error('cannot delete corrupt');
  });
  await check(page,'構文破損・未知版・非private形式をハッシュ再計算後も拒否',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore();
    for(const kind of ['syntax','schema','engine','visibility']){
      await s.clearAll();const p=t.record('bad');await s.save(p);const {row,meta}=await t.rows('bad');
      const parsed=JSON.parse(row.json);
      if(kind==='schema')parsed.schemaVersion=99;if(kind==='engine')parsed.engineVersion='future';if(kind==='visibility')parsed.visibility='public';
      row.json=kind==='syntax'?'{broken':JSON.stringify(parsed);row.bytes=meta.bytes=new TextEncoder().encode(row.json).length;row.digest=meta.digest=await t.hash(row.json);
      await t.putRows(row,meta);const r=await s.loadPrivate('bad');if(r.ok||r.error.code!==(kind==='syntax'?'corrupt':'unsupported-version'))throw Error(kind+' accepted');
      if(!(await t.rows('bad')).row)throw Error('auto deleted');
    }await s.clearAll();
  });
  await check(page,'索引と本文の不整合・孤立レコード・未知保存行を拒否し、明示操作だけで消す',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore();
    await s.save(t.record('orphan'));await t.raw('readwrite',tx=>tx.objectStore('index').delete('orphan'));
    if((await s.loadPrivate('orphan')).error.code!=='corrupt'||(await s.list()).error.code!=='corrupt')throw Error('orphan accepted');
    if(!(await s.remove('orphan')).removed)throw Error('orphan remove');
    await s.save(t.record('future-row'));const {row,meta}=await t.rows('future-row');meta.storageVersion=99;await t.putRows(row,meta);
    if((await s.loadPrivate('future-row')).error.code!=='unsupported-version')throw Error('future row');
    if(!(await s.clearAll()).ok)throw Error('explicit clear');
  });
  await check(page,'保存ごとの接続を解放し、30回以上でも残留接続なし',async()=>{
    const t=window.__storageTest,live=new Set();let opened=0;
    const factory=t.factory(db=>{live.add(db);opened++;const close=db.close.bind(db);db.close=()=>{live.delete(db);return close();};});
    const s=t.createPaifuStore({getIndexedDB:()=>factory});
    for(let i=0;i<31;i++){const p=t.record('repeat-'+i),a=await s.save(p),b=await s.loadPrivate(p.id),c=await s.remove(p.id);if(!a.ok||!b.ok||!c.ok||live.size)throw Error('connection leak');}
    if(opened!==93||live.size)throw Error('connections');
  });
  await check(page,'数学Ⅰ4局／数学Ⅱ8局の完走牌譜を実保存・再検証し、容量と時間を測定',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore();t.metrics=[];
    for(const [mode,length] of [['math1',4],['math2',8]]){
      const p=t.full('full-'+mode,mode,length);if(p.status!=='complete')throw Error('fixture incomplete');
      const start=performance.now(),saved=await s.save(p),saveMs=performance.now()-start;
      if(!saved.ok)throw Error(JSON.stringify(saved));const at=performance.now(),loaded=await s.loadPrivate(p.id),loadMs=performance.now()-at;
      if(!loaded.ok||t.pf.encodePaifu(loaded.record)!==t.pf.encodePaifu(p)||loaded.record.final.scores.reduce((a,b)=>a+b,0)!==400)throw Error('large round trip');
      t.metrics.push({mode,length,rounds:p.rounds.length,bytes:saved.metadata.bytes,saveMs,loadMs});
    }
    if(JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))!==t.savedLocal)throw Error('preferences changed');
    await s.clearAll();
  });
  // Closing a tab during a native active write must not leave half a pair on disk.
  const closing=await ctx.newPage();await initialize(closing);
  await closing.evaluate(async()=>{const t=window.__storageTest,s=t.createPaifuStore(),p=t.record('page-close');t.saved=await s.save(p);t.p=p;});
  const pending=closing.evaluate(async()=>{
    const t=window.__storageTest;const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{const tx=f(...args);if(args[1]==='readwrite'){const store=tx.objectStore('index'),end=performance.now()+5000;const hold=()=>{const r=store.get('hold');r.onsuccess=()=>{if(performance.now()<end)hold();};};hold();window.__writeStarted=true;}return tx;};});
    return t.createPaifuStore({getIndexedDB:()=>factory,timeoutMs:10000}).save(t.p,{expectedToken:t.saved.metadata.token});
  }).then(value=>({value}),error=>({error:error.message}));
  await closing.waitForFunction(()=>window.__writeStarted===true);await closing.close();const closed=await pending;
  assert.match(closed.error||'',/closed|destroyed|Target/i);
  await check(page,'保存中のタブ終了でも前の完成トランザクションを保持',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore(),r=await s.loadPrivate('page-close');if(!r.ok||r.metadata.revision!==1)throw Error('page close committed');await s.clearAll();
  });
  await check(page,'versionchangeで接続を解放し、将来DB版を勝手に削除/降格しない',async()=>{
    const t=window.__storageTest,s=t.createPaifuStore();await s.save(t.record('future-db'));
    let signal;const started=new Promise(r=>{signal=r;});
    const factory=t.factory(db=>{const f=db.transaction.bind(db);db.transaction=(...args)=>{const tx=f(...args);if(args[1]==='readwrite'){const st=tx.objectStore('index'),end=performance.now()+1000;const hold=()=>{const r=st.get('hold');r.onsuccess=()=>{if(performance.now()<end)hold();};};hold();signal();}return tx;};});
    const pending=t.createPaifuStore({getIndexedDB:()=>factory}).clearAll();await started;
    const upgraded=new Promise((resolve,reject)=>{const r=indexedDB.open(t.PAIFU_DB_NAME,2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records'),q=tx.objectStore('records').get('future-db');q.onsuccess=()=>{const found=!!q.result;db.close();resolve(found);};};});
    const result=await pending;if(result.ok||result.error.code!=='interrupted')throw Error('versionchange ignored');
    if(!await upgraded)throw Error('upgrade deleted old data');const next=await s.list();if(next.ok||next.error.code!=='unsupported-version')throw Error('future DB downgraded');
  });
  const brokenCtx=await browser.newContext();const brokenPage=await brokenCtx.newPage();await initialize(brokenPage);
  await check(brokenPage,'同名DBの不正なkeyPathを拒否し、内容を自動修復/削除しない',async()=>{
    const t=window.__storageTest;
    await new Promise((resolve,reject)=>{const r=indexedDB.open(t.PAIFU_DB_NAME,1);r.onupgradeneeded=()=>{r.result.createObjectStore('records');r.result.createObjectStore('index',{keyPath:'id'});};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite');tx.objectStore('records').put('do-not-delete',99);tx.oncomplete=()=>{db.close();resolve();};};});
    const result=await t.createPaifuStore().list();if(result.ok||result.error.code!=='corrupt')throw Error('bad schema accepted');
    await new Promise((resolve,reject)=>{const r=indexedDB.open(t.PAIFU_DB_NAME,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records'),q=tx.objectStore('records').get(99);q.onsuccess=()=>{db.close();q.result==='do-not-delete'?resolve():reject(Error('schema auto repaired'));};};});
  });
  await brokenCtx.close();
  console.log('PAIFU_STORAGE_METRIC '+JSON.stringify(await page.evaluate(()=>window.__storageTest.metrics)));
  assert.deepEqual(errors,[]);
  await ctx.close();
  console.log(`PAIFU STORAGE E2E OK: ${checks} native IndexedDB checks, Chromium ${browser.version()}`);
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
