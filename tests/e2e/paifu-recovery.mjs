// Two real pages, module Worker, native IndexedDB. All intentional faults stay in test contexts.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {startServer} from '../../tools/serve.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});let browser,checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('✓ Recovery: '+name);};
async function init(page){await page.goto(`http://localhost:${server.address().port}/mathjong/`);await page.evaluate(async()=>{
 const m=f=>import(new URL('src/'+f,location.href));const [{createPaifuSession},{createPaifuWorkerStore},{createPaifuStore,PAIFU_DB_NAME},pf,{Game},{createRules},{modeConfig},{createMatch},{applyAction}]=await Promise.all([m('ui/paifu-session.js'),m('ui/paifu-worker-store.js'),m('ui/paifu-storage.js'),m('engine/paifu.js'),m('engine/game.js'),m('engine/rules.js'),m('engine/config.js'),m('engine/match.js'),m('engine/ai.js')]);
 window.t={createPaifuSession,createPaifuWorkerStore,createPaifuStore,PAIFU_DB_NAME,pf,Game,createRules,modeConfig,createMatch,applyAction,sessions:{},local:JSON.stringify(Object.entries(localStorage))};
 t.start=async(id,{mode='math1',intervalMs=30000}={})=>{const rules=createRules(modeConfig(mode)),players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'})),match=createMatch(),g=new Game({rules,players,seed:1}),store=createPaifuWorkerStore(),s=createPaifuSession({id,rules,players,match},{store,intervalMs});t.sessions[id]={g,s,store};s.roundStarted(g);if(!(await s.flush()).ok)throw Error('initial ack');};
 t.act=id=>{const {g,s}=t.sessions[id],q=g.pending(),action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:g.drawn},h=s.beforeAction(g,{seat:q.seat,action,source:g.players[q.seat].kind});applyAction(g,q.seat,action);if(!s.afterAction(h,g,{accepted:true}).ok)throw Error('observe');};
 t.close=id=>{t.sessions[id].s.dispose();delete t.sessions[id];};
 t.raw=async(id,fn)=>new Promise((resolve,reject)=>{const r=indexedDB.open(PAIFU_DB_NAME,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['records','index'],'readwrite'),st=tx.objectStore('records'),q=st.get(id);q.onsuccess=()=>fn(q.result,st,tx);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
});}
async function start(page,id,options){const event=page.waitForEvent('worker');await page.evaluate(({id,options})=>t.start(id,options),{id,options});return event;}
async function loseAck(worker,id){await worker.evaluate(id=>{const send=globalThis.postMessage.bind(globalThis);let once=true;globalThis.postMessage=(m,...args)=>{if(once&&m.type==='result'&&m.result?.ok&&m.result.metadata?.id===id){once=false;return send({...m,result:{ok:false,error:{code:'outcome-unknown',retryable:false}}},...args);}return send(m,...args);};},id);}
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const context=await browser.newContext({viewport:{width:390,height:844}}),a=await context.newPage(),b=await context.newPage(),errors=[];
 for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});await init(p);}
 for(const mode of ['math1','math2'])await check(`${mode}: 実commit後のack喪失を読み直しで確認し、自動再開/上書きしない`,async()=>{
  const id='lost-'+mode,w=await start(a,id,{mode});await loseAck(w,id);await a.evaluate(async id=>{t.act(id);const {s}=t.sessions[id],old=s.status().savedVersion,r=await s.flush();if(r.ok||r.error.code!=='outcome-unknown')throw Error('not unknown');const report=await s.inspectRecovery();if(report.kind!=='attempt-content-present'||!report.contentPresent||report.writePerformed||report.originalWriteConfirmed||report.automaticResume||s.status().savedVersion!==old||s.retrySaving().error.code!=='reconciliation-required')throw Error('unsafe recovery');for(const k of ['record','json','hands','wall'])if(k in report)throw Error('private payload');},id);
  await b.evaluate(async id=>{const x=await t.createPaifuStore().loadPrivate(id);if(!x.ok||x.record.rounds[0].steps.length!==1||x.record.status!=='recording')throw Error('commit missing');},id);await a.evaluate(id=>t.close(id),id);
 });
 await check('実abort後に結果不明を配送：旧receipt不変を確認するだけで再送しない',async()=>{
  const id='aborted',w=await start(a,id);
  await w.evaluate(()=>{const original=IDBDatabase.prototype.transaction,send=globalThis.postMessage.bind(globalThis);IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite'){const get=tx.objectStore.bind(tx);tx.objectStore=name=>{const os=get(name);if(name==='index'&&!os.__patched){os.__patched=true;const put=os.put.bind(os);os.put=(...a)=>{const r=put(...a);r.addEventListener('success',()=>tx.abort());return r;};}return os;};}return tx;};globalThis.postMessage=(m,...args)=>send(m.type==='result'&&m.result?.error?.code==='interrupted'?{...m,result:{ok:false,error:{code:'outcome-unknown'}}}:m,...args);});
  await a.evaluate(async id=>{t.act(id);const {s}=t.sessions[id];if((await s.flush()).error.code!=='outcome-unknown')throw Error('abort simulation');const report=await s.inspectRecovery();if(report.kind!=='baseline-unchanged'||!report.retryWithExpectedToken||report.writePerformed||s.status().saving!=='paused')throw Error('baseline');t.baselineReport=report;t.attempt=s.privateRecoveryEvidence().record;},id);
  const payload=await a.evaluate(()=>t.attempt);await b.evaluate(async({id,payload})=>{const st=t.createPaifuStore(),old=await st.loadPrivate(id),other=t.pf.endRecording(old.record,{reason:'reset'});if(!(await st.save(other,{expectedToken:old.metadata.token})).ok)throw Error('other write');}, {id,payload});
  await a.evaluate(async id=>{const r=await t.createPaifuStore().save(t.attempt,{expectedToken:t.baselineReport.retryWithExpectedToken});if(r.ok||r.error.code!=='conflict')throw Error('stale retry overwrote other tab');t.close(id);},id);
 });
 await check('別タブのCAS更新・異なる内容を保護',async()=>{
  const id='different';await start(a,id);await b.evaluate(async id=>{const st=t.createPaifuStore(),x=await st.loadPrivate(id),p=t.pf.endRecording(x.record,{reason:'reset'});const r=await st.save(p,{expectedToken:x.metadata.token});if(!r.ok)throw Error('peer');t.peerDigest=r.metadata.digest;},id);
  await a.evaluate(async id=>{t.act(id);const s=t.sessions[id].s;if((await s.flush()).error.code!=='conflict')throw Error('CAS');const r=await s.inspectRecovery();if(r.kind!=='conflicting-content'||!r.requiresUserDecision||r.writePerformed)throw Error('unsafe conflict');t.close(id);},id);
  await b.evaluate(async id=>{if((await t.createPaifuStore().loadPrivate(id)).metadata.digest!==t.peerDigest)throw Error('peer overwritten');},id);
 });
 await check('同じ内容でもCAS競合は別writerとして人の判断を要求',async()=>{
  const id='same';await start(a,id);const wanted=await a.evaluate(id=>{t.act(id);return t.sessions[id].s.privateRecord();},id);
  await b.evaluate(async({id,wanted})=>{const st=t.createPaifuStore(),x=await st.loadPrivate(id);if(!(await st.save(wanted,{expectedToken:x.metadata.token})).ok)throw Error('peer');},{id,wanted});
  await a.evaluate(async id=>{const s=t.sessions[id].s;if((await s.flush()).error.code!=='conflict')throw Error('CAS');const r=await s.inspectRecovery();if(r.kind!=='same-content-other-writer'||!r.requiresUserDecision||!r.contentPresent)throw Error('writer confusion');t.close(id);},id);
 });
 await check('別タブ削除を未保存と決めつけず、勝手に再作成しない',async()=>{
  const id='deleted';await start(a,id);await b.evaluate(id=>t.createPaifuStore().remove(id),id);
  await a.evaluate(async id=>{t.act(id);const s=t.sessions[id].s;if((await s.flush()).error.code!=='conflict')throw Error('delete conflict');const r=await s.inspectRecovery();if(r.kind!=='missing-after-ack'||!r.requiresUserDecision||r.retryWithExpectedToken!==null)throw Error('delete classification');t.close(id);},id);
  await b.evaluate(async id=>{if((await t.createPaifuStore().loadPrivate(id)).error.code!=='not-found')throw Error('resurrected');},id);
 });
 await check('正当な本文変更でもhash不一致を検出、破損行を削除/修復しない',async()=>{
  const id='corrupt',w=await start(a,id);await loseAck(w,id);await a.evaluate(async id=>{t.act(id);await t.sessions[id].s.flush();},id);
  await b.evaluate(id=>t.raw(id,(row,store)=>store.put({...row,json:row.json.replace('"name":"kanata"','"name":"KANATA"')})),id);
  await a.evaluate(async id=>{const r=await t.sessions[id].s.inspectRecovery();if(r.ok||r.error.code!=='corrupt')throw Error('corrupt accepted');t.close(id);},id);
  await b.evaluate(id=>t.raw(id,row=>{if(!row.json.includes('KANATA'))throw Error('auto repair/deletion');}),id);
 });
 await check('未知の保存版を保持し、照合失敗を保存成功にしない',async()=>{
  const id='future',w=await start(a,id);await loseAck(w,id);await a.evaluate(async id=>{t.act(id);await t.sessions[id].s.flush();},id);
  await b.evaluate(id=>t.raw(id,(row,st,tx)=>{const r=tx.objectStore('index').get(id);r.onsuccess=()=>tx.objectStore('index').put({...r.result,storageVersion:99});}),id);
  await a.evaluate(async id=>{const r=await t.sessions[id].s.inspectRecovery();if(r.ok||r.error.code!=='unsupported-version')throw Error('future accepted');t.close(id);},id);
  await b.evaluate(id=>t.raw(id,row=>{if(!row)throw Error('future deleted');}),id);
  // Explicit test cleanup, not application recovery.
  await b.evaluate(()=>t.createPaifuStore().clearAll());
 });
 await check('Chromiumページfreeze/再開：自動保存を捏造せず、前景tick後に保存',async()=>{
  const id='background';await start(a,id,{intervalMs:100});await a.evaluate(id=>{t.sessions[id].s.checkpoint();t.act(id);},id);const cdp=await context.newCDPSession(a);await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await new Promise(r=>setTimeout(r,400));
  await b.evaluate(async id=>{const x=await t.createPaifuStore().loadPrivate(id);if(!x.ok||x.record.status!=='recording'||x.record.rounds[0].steps.length)throw Error('unexpected background write');},id);
  await cdp.send('Page.setWebLifecycleState',{state:'active'});await a.evaluate(async id=>{const s=t.sessions[id].s;s.tick();if(!(await s.flush()).ok)throw Error('foreground save');s.dispose();delete t.sessions[id];},id);await cdp.detach();
 });
 await check('31回の新Game/退出/新ID：Worker残留なく、保存失敗でも次セッションを開始できる',async()=>{
  for(let i=0;i<31;i++){
   const id='cycle-'+i;await start(a,id);await a.evaluate(async id=>{const {s}=t.sessions[id];t.act(id);s.leave('reset');if(!(await s.flush()).ok)throw Error('leave save');s.dispose();delete t.sessions[id];},id);
   await b.evaluate(async id=>{const st=t.createPaifuStore(),x=await st.loadPrivate(id);if(!x.ok||x.record.status!=='aborted'||x.record.final!==null)throw Error('false complete');await st.remove(id);},id);
  }
  const until=Date.now()+5000;while(a.workers().length&&Date.now()<until)await a.waitForTimeout(20);assert.equal(a.workers().length,0);
 });
 await check('ページ終了後に保持できるのは最後の検証済み記録だけ',async()=>{
  const id='page-close';await start(a,id);await a.evaluate(id=>t.act(id),id);await a.close();const x=await b.evaluate(id=>t.createPaifuStore().loadPrivate(id),id);assert.equal(x.ok,true);assert.equal(x.record.status,'recording');assert.equal(x.record.rounds[0].steps.length,0);assert.equal(x.record.final,null);
 });
 await b.evaluate(()=>{if(JSON.stringify(Object.entries(localStorage))!==t.local)throw Error('localStorage changed');});assert.deepEqual(errors,[]);
 console.log(`PAIFU RECOVERY E2E OK: ${checks} checks, Chromium ${browser.version()}`);await context.close();
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
