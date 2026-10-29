// Native dedicated Worker + unchanged native IndexedDB, never connected to app.js.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {startServer} from '../../tools/serve.mjs';
import {makeStorageFixture} from '../paifu-storage-fixtures.mjs';
import {encodePaifu} from '../../src/engine/paifu.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});let browser,checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('✓ Paifu Worker: '+name);};
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const ctx=await browser.newContext({viewport:{width:390,height:844}}),page=await ctx.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
 await page.goto(`http://localhost:${server.address().port}/mathjong/`);
 await page.evaluate(async()=>{
  const mod=f=>import(new URL(`src/${f}`,location.href));
  const [w,s,pf,{Game},{createRules},{modeConfig},{createMatch}]=await Promise.all([mod('ui/paifu-worker-store.js'),mod('ui/paifu-storage.js'),mod('engine/paifu.js'),mod('engine/game.js'),mod('engine/rules.js'),mod('engine/config.js'),mod('engine/match.js')]);
  const players=['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'})),rules=createRules(modeConfig('math1'));
  const p=pf.beginRound(pf.createPaifu({id:'native-worker',rules,players,match:createMatch(),origin:'fixture'}),new Game({rules,players,seed:9}));
  window.t={...w,...s,pf,p,stores:[],local:JSON.stringify(Object.entries(localStorage))};
  t.withId=id=>({...p,id,rounds:p.rounds.map(r=>({...r,id:`${id}:r${r.initial.round}`}))});
  t.make=opts=>{const store=t.createPaifuWorkerStore(opts);t.stores.push(store);return store;};
 });
 await check('factoryはWorker/DBを生成しない。実Workerによる保存・読込・深いfreeze・完全往復',async()=>{
  assert.equal(page.workers().length,0);
  await page.evaluate(async()=>{t.w=t.make();const a=await t.w.save(t.p),b=await t.w.loadPrivate(t.p.id);if(!a.ok||!b.ok||t.pf.encodePaifu(b.record)!==t.pf.encodePaifu(t.p))throw Error('native round trip');if(!Object.isFrozen(b.record.rounds[0].steps))throw Error('freeze');t.token=a.metadata.token;});
  assert.equal(page.workers().length,1);
 });
 await check('private本文はloadだけ、verify/listは管理情報。原文の秘密をconsole/networkへ送らない',()=>page.evaluate(async()=>{
  const v=await t.w.verify(t.p.id),l=await t.w.list();if(!v.ok||!l.ok||'record'in v||'record'in l||l.entries.some(e=>'json'in e||'hands'in e||'wall'in e))throw Error('privacy');
 }));
 await check('投稿直後の入力変更を隔離し、元スレッド保存と同じJSONになる',()=>page.evaluate(async()=>{
  const p=JSON.parse(t.pf.encodePaifu(t.withId('snapshot'))),expected=t.pf.encodePaifu(p),a=t.w.save(p);p.id='mutated';p.settings.players[0].name='mutated';const out=await a,b=await t.w.loadPrivate('snapshot');if(!out.ok||!b.ok||t.pf.encodePaifu(b.record)!==expected)throw Error('snapshot');
 }));
 await check('write queue上限・FIFOでsave→clear。過剰要求は明示拒否し、後で勝手に書かない',()=>page.evaluate(async()=>{
  const a=t.w.save(t.withId('fifo')),b=t.w.clearAll(),c=await t.w.save(t.withId('not-enqueued'));if(c.ok||c.error.code!=='queue-full')throw Error('backpressure');
  if(!(await a).ok||!(await b).ok||(await t.w.list()).entries.length)throw Error('FIFO clear');
 }));
 await check('別Worker/旧アダプターと同時更新してもCAS勝者1人、ABAと容量上限を保持',()=>page.evaluate(async()=>{
  const a=t.make({maxRecords:1}),b=t.make({maxRecords:1}),out=await Promise.all([a.save(t.withId('race-a')),b.save(t.withId('race-b'))]);
  if(out.filter(x=>x.ok).length!==1||out.filter(x=>x.error?.code==='capacity-exceeded').length!==1)throw Error('capacity race');
  const e=(await a.list()).entries[0],p=(await a.loadPrivate(e.id)).record,legacy=t.createPaifuStore();
  const updates=await Promise.all([a.save(p,{expectedToken:e.token}),legacy.save(p,{expectedToken:e.token})]);if(updates.filter(x=>x.ok).length!==1||updates.filter(x=>x.error?.code==='conflict').length!==1)throw Error('CAS');
  await b.remove(e.id);if(!(await b.save(p)).ok||(await a.save(p,{expectedToken:e.token})).error.code!=='conflict')throw Error('ABA');await a.clearAll();
 }));
 await check('未知版/違法な判断/不正物理IDを検証し、既存本文を更新しない',()=>page.evaluate(async()=>{
  const saved=await t.w.save(t.p);
  for(const bad of [{...t.p,schemaVersion:99},{...t.p,rounds:[{...t.p.rounds[0],initial:{...t.p.rounds[0].initial,drawn:-1}}]}]){
   const r=await t.w.save(bad,{expectedToken:saved.metadata.token});if(r.ok||r.error.code!=='invalid-record')throw Error('accepted invalid record');
  }
  const loaded=await t.w.loadPrivate(t.p.id);if(!loaded.ok||loaded.metadata.token!==saved.metadata.token)throw Error('failed save modified data');await t.w.clearAll();
 }));
 await check('実DBの本文破損をWorker読込で拒否、自動削除せず明示削除で回復',()=>page.evaluate(async()=>{
  await t.w.save(t.p);await new Promise((resolve,reject)=>{const r=indexedDB.open(t.PAIFU_DB_NAME,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite'),st=tx.objectStore('records'),q=st.get(t.p.id);q.onsuccess=()=>st.put({...q.result,json:'{broken'});tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
  const r=await t.w.loadPrivate(t.p.id);if(r.ok||r.error.code!=='corrupt')throw Error('corruption');if(!(await t.w.remove(t.p.id)).removed)throw Error('explicit delete');
 }));
 // Real storage fault inside the Worker: underlying transaction still has to rollback both stores.
 const nativeWorker=page.workers().find(w=>w.url().endsWith('/paifu-storage-worker.js'));
 await nativeWorker.evaluate(()=>{
  const original=IDBDatabase.prototype.transaction;globalThis.__fault='none';globalThis.__started=false;
  IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite'){
   const get=tx.objectStore.bind(tx),fault=globalThis.__fault;
   if(fault==='hold'){globalThis.__started=true;const until=performance.now()+5000;const hold=()=>{const r=get('index').get('hold');r.onsuccess=()=>{if(performance.now()<until)hold();};};hold();}
   tx.objectStore=name=>{const s=get(name);if(name==='index'&&fault==='quota')s.put=()=>{throw new DOMException('injected','QuotaExceededError');};return s;};
  }return tx;};
 });
 await check('Worker内quota失敗で旧牌譜を維持し、次要求で復帰（故障注入）',async()=>{
  await page.evaluate(async()=>{const a=await t.w.save(t.p);t.oldToken=a.metadata.token;});
  await nativeWorker.evaluate(()=>globalThis.__fault='quota');
  await page.evaluate(async()=>{const r=await t.w.save(t.p,{expectedToken:t.oldToken});if(r.ok||r.error.code!=='quota-exceeded')throw Error('quota');});
  await nativeWorker.evaluate(()=>globalThis.__fault='none');
  await page.evaluate(async()=>{const p=await t.w.loadPrivate(t.p.id);if(p.metadata.token!==t.oldToken)throw Error('old data lost');if(!(await t.w.save(t.p,{expectedToken:t.oldToken})).ok)throw Error('recovery');});
 });
 await check('実Workerの書込途中終了は結果不確定を返し、部分保存/遅い復活を残さない',async()=>{
  await nativeWorker.evaluate(()=>{globalThis.__fault='hold';globalThis.__started=false;});
  await page.evaluate(()=>{t.pending=t.w.save(t.withId('worker-close'));});
  assert.equal(await nativeWorker.evaluate(async()=>{for(let i=0;i<200;i++){if(globalThis.__started)return true;await new Promise(r=>setTimeout(r,10));}return false;}),true);
  await page.evaluate(async()=>{t.w.close();const r=await t.pending;if(r.ok||r.error.code!=='outcome-unknown')throw Error('termination lied');const s=t.createPaifuStore(),x=await s.loadPrivate('worker-close');if(x.ok||x.error.code!=='not-found')throw Error('partial/late commit');await s.clearAll();});
 });
 await check('明示操作だけの個別/全削除、既存localStorageを保持。close後は要求拒否',()=>page.evaluate(async()=>{
  t.w=t.make();await t.w.save(t.p);if(!(await t.w.remove(t.p.id)).removed||!(await t.w.clearAll()).ok)throw Error('delete');t.w.close();const r=await t.w.list();if(r.ok||r.error.code!=='closed')throw Error('closed');if(JSON.stringify(Object.entries(localStorage))!==t.local)throw Error('localStorage changed');
 }));
 await check('数学Ⅰ4局・数学Ⅱ8局・24連荘・途中終了で完全復元、400点保存を維持',async()=>{
  await page.evaluate(()=>{t.w=t.make({operationTimeoutMs:60000});});
  for(const options of [{id:'full-4',mode:'math1',length:4},{id:'full-8',mode:'math2',length:8},{id:'long-24',mode:'math1',renchan:24},{id:'partial',mode:'math2',partial:true}]){
   const {record,recording}=makeStorageFixture(options),expected=encodePaifu(record);
   const restored=await page.evaluate(async({record,expected})=>{
    const a=await t.w.save(record),b=await t.w.loadPrivate(record.id);if(!a.ok||!b.ok||t.pf.encodePaifu(b.record)!==expected)throw Error('full mismatch '+JSON.stringify(a));
    const p=b.record,last=p.rounds.at(-1),g=t.pf.replayPrivateRound(p,p.rounds.length-1);
    const result={actual:g.result,expected:last.steps.at(-1)?.state.result??last.initial.result};
    if((last.settlement?.afterScores??p.initialMatch.scores).reduce((a,b)=>a+b,0)!==400)throw Error('scores');await t.w.clearAll();return result;
   },{record,expected});assert.deepEqual(restored.actual,restored.expected);console.log('WORKER_FIXTURE '+JSON.stringify({id:record.id,bytes:Buffer.byteLength(expected),...recording}));
  }
 });
 await check('実Workerの期限超過で旧保存を保持し、復帰後の新Workerが正常',async()=>{
  await page.evaluate(async()=>{t.slow=t.make({operationTimeoutMs:3000});await t.slow.list();});
  const slow=page.workers().at(-1);
  await slow.evaluate(()=>{const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite'){const st=tx.objectStore('index'),until=performance.now()+10000;const hold=()=>{const r=st.get('hold');r.onsuccess=()=>{if(performance.now()<until)hold();};};hold();}return tx;};});
  await page.evaluate(async()=>{const r=await t.slow.save(t.withId('deadline'));if(r.ok||r.error.code!=='outcome-unknown')throw Error('deadline lied');const old=t.createPaifuStore();if((await old.loadPrivate('deadline')).error.code!=='not-found')throw Error('late write');if(!(await t.slow.save(t.withId('deadline'))).ok)throw Error('worker restart');await t.slow.clearAll();t.slow.close();});
 });
 await check('31回のWorker保存/読込/削除が同じWorkerを再利用し、操作後も正常',()=>page.evaluate(async()=>{
  const w=t.make();for(let i=0;i<31;i++){const p=t.withId('repeat-'+i);if(!(await w.save(p)).ok||!(await w.loadPrivate(p.id)).ok||!(await w.remove(p.id)).removed)throw Error('repeat');}w.close();
 }));
 await check('Workerに対応しない環境で失敗しても通常のページ操作を阻害しない',()=>page.evaluate(async()=>{
  const s=t.make({createWorker(){throw new DOMException('unavailable','SecurityError');}}),r=await s.list();if(r.ok||r.error.code!=='unavailable')throw Error('unavailable');document.querySelector('button')?.click();
 }));
 await page.evaluate(()=>t.stores.forEach(s=>s.close()));await page.waitForTimeout(100);assert.equal(page.workers().length,0);assert.deepEqual(errors,[]);
 await ctx.close();console.log(`PAIFU WORKER E2E OK: ${checks} native checks, Chromium ${browser.version()}`);
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
