// Stage 4 independent observation hooks + real Worker/IDB. app.js is never patched.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {startServer} from '../../tools/serve.mjs';
import {makeStorageFixture} from '../paifu-storage-fixtures.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});let browser,checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('✓ Session: '+name);};
async function init(page){
 await page.goto(`http://localhost:${server.address().port}/mathjong/`);
 await page.evaluate(async()=>{
  const m=f=>import(new URL('src/'+f,location.href));const [{createPaifuSession},{createPaifuWorkerStore},{createPaifuStore},pf,{Game},{createRules},{modeConfig},match,ai,characters,{createRng}]=await Promise.all([m('ui/paifu-session.js'),m('ui/paifu-worker-store.js'),m('ui/paifu-storage.js'),m('engine/paifu.js'),m('engine/game.js'),m('engine/rules.js'),m('engine/config.js'),m('engine/match.js'),m('engine/ai.js'),m('engine/characters.js'),m('engine/rng.js')]);
  window.t={createPaifuSession,createPaifuWorkerStore,createPaifuStore,pf,Game,createRules,modeConfig,...match,...ai,...characters,createRng,local:JSON.stringify(Object.entries(localStorage))};
  t.same=(a,b)=>{const key=(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;return JSON.stringify(a,key)===JSON.stringify(b,key);};
  t.players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'}));
  t.make=(id,options={})=>{const rules=createRules(modeConfig('math1')),match=t.createMatch(),g=new Game({rules,players:t.players,seed:9}),s=createPaifuSession({id,rules,players:t.players,match},options);return {g,s,match};};
  t.act=(s,g,seat,action,source=g.players[seat].kind)=>{const h=s.beforeAction(g,{seat,action,source});t.applyAction(g,seat,action);const r=s.afterAction(h,g,{accepted:true});if(!r.ok)throw Error('record failed');};
 });
}
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const ctx=await browser.newContext({viewport:{width:390,height:844}}),page=await ctx.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});await init(page);
 await check('通常画面には接続されず、import/factoryもWorkerを作らない',async()=>{
  assert.equal(page.workers().length,0);await page.evaluate(()=>{t.r=t.make('native-session');if(t.r.s.status().savedVersion!==0)throw Error('not lazy');});assert.equal(page.workers().length,0);
 });
 await check('人間打牌・明示checkpoint・実Worker保存、全状態/物理IDを復元',()=>page.evaluate(async()=>{
  const {s,g}=t.r;s.roundStarted(g);t.act(s,g,0,{type:'discard',tile:g.drawn});const result=await s.flush();if(!result.ok)throw Error(JSON.stringify(result));
  const p=await t.createPaifuStore().loadPrivate('native-session');if(!p.ok||t.pf.encodePaifu(p.record)!==t.pf.encodePaifu(s.privateRecord()))throw Error('save/replay');
  const restored=t.pf.replayPrivateRound(p.record,0);if(!t.same(t.pf.captureGame(restored),t.pf.captureGame(g)))throw Error('state');s.leave();await s.flush();s.dispose();
 }));
 await check('記録エラー後もGame打牌とRNGが不変、保存はaborted prefix',()=>page.evaluate(async()=>{
  const rules=t.createRules(t.modeConfig('math1')),match=t.createMatch(),g=new t.Game({rules,players:t.players,seed:9}),plain=new t.Game({rules,players:t.players,seed:9});
  const s=t.createPaifuSession({id:'failed-prefix',rules,players:t.players,match},{recorder:{...t.pf,captureGame(){throw Error('secret');}}});s.roundStarted(g);const a={type:'discard',tile:g.drawn},h=s.beforeAction(g,{seat:0,action:a,source:'human'});t.applyAction(g,0,a);t.applyAction(plain,0,a);s.afterAction(h,g,{accepted:true});
  if(JSON.stringify(t.pf.captureGame(g))!==JSON.stringify(t.pf.captureGame(plain))||g.rng.next()!==plain.rng.next())throw Error('game changed');if(!(await s.flush()).ok)throw Error('prefix save');const p=await t.createPaifuStore().loadPrivate('failed-prefix');if(!p.ok||p.record.status!=='aborted'||p.record.rounds[0].steps.length||p.record.final!==null)throw Error('false complete');s.dispose();
 }));
 await check('queue-full後に自動retryせず、明示retryで全判断を保存',()=>page.evaluate(async()=>{
  const store=t.createPaifuWorkerStore({maxPending:1});await store.list();const r=t.make('queue-full',{store});r.s.roundStarted(r.g);const occupied=store.list(),result=await r.s.flush();
  if(result.ok||result.error.code!=='queue-full')throw Error('queue not full');await occupied;t.act(r.s,r.g,0,{type:'discard',tile:r.g.drawn});if(r.s.status().saving!=='paused')throw Error('auto retry');r.s.retrySaving();if(!(await r.s.flush()).ok)throw Error('retry');r.s.dispose();
 }));
 await check('手動削除barrier後は記録が続いてもDBへ再作成しない',()=>page.evaluate(async()=>{
  const {s,g}=t.make('manual-delete');s.roundStarted(g);await s.flush();await s.stopSaving();const store=t.createPaifuStore();await store.remove('manual-delete');t.act(s,g,0,{type:'discard',tile:g.drawn});s.tick();s.leave();if((await s.flush()).ok||(await store.loadPrivate('manual-delete')).error.code!=='not-found')throw Error('resurrected');s.dispose();
 }));
 await check('実DB容量制限で旧記録を削除せず、保存だけpaused。Game操作は継続',()=>page.evaluate(async()=>{
  const direct=t.createPaifuStore(),before=await direct.list(),store=t.createPaifuWorkerStore({maxRecords:1}),{s,g}=t.make('capacity',{store});if(before.entries.length<1)throw Error('empty capacity fixture');s.roundStarted(g);const r=await s.flush();if(r.ok||r.error.code!=='capacity-exceeded')throw Error('capacity');t.act(s,g,0,{type:'discard',tile:g.drawn});s.leave();const after=await direct.list();if(after.entries.length!==before.entries.length||s.status().savedVersion!==0||s.status().saving!=='paused')throw Error('capacity isolation');s.dispose();
 }));
 await page.evaluate(async()=>{t.uncertain=t.make('uncertain',{store:t.createPaifuWorkerStore({operationTimeoutMs:3000})});t.uncertain.s.roundStarted(t.uncertain.g);await t.uncertain.s.flush();});
 const worker=page.workers().at(-1);
 await worker.evaluate(()=>{const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite'){const st=tx.objectStore('index'),until=performance.now()+10000;const hold=()=>{const r=st.get('hold');r.onsuccess=()=>{if(performance.now()<until)hold();};};hold();}return tx;};});
 await check('実Worker期限超過はoutcome-unknown。再照合前にretry/保存成功を偽装しない',()=>page.evaluate(async()=>{
  const {s,g}=t.uncertain;t.act(s,g,0,{type:'discard',tile:g.drawn});const result=await s.flush();if(result.ok||result.error.code!=='outcome-unknown')throw Error('not uncertain');if(s.retrySaving().error.code!=='reconciliation-required')throw Error('blind retry');
  const old=await t.createPaifuStore().loadPrivate('uncertain');if(!old.ok||old.record.rounds[0].steps.length!==0||s.privateRecord().rounds[0].steps.length!==1)throw Error('partial commit');s.leave();s.dispose();
 }));
 const matrix=[];
 for(const mode of ['math1','math2'])for(const length of [4,8])await check(`${mode}×${length}: AI12人の実判断・精算・最終結果・Worker保存が非記録と一致`,async()=>{
  const metric=await page.evaluate(async({mode,length})=>{
   const roster=Object.values(t.CHARACTER_ROSTER).flat(),offset=(mode==='math1'?0:6)+(length===8?3:0),players=Array.from({length:4},(_,i)=>({...roster[(offset+i)%roster.length],kind:'ai'})),ids=players.map(p=>p.id),rules=t.createRules(t.modeConfig(mode));let match=t.createMatch({length}),round=1,history=t.newPublicHistory(),decisions=0;const timings=[];
   const s=t.createPaifuSession({id:`matrix-${mode}-${length}`,rules,players,match,seedBase:107});
   while(!match.over){const seed=107+round*7919,g=new t.Game({rules,players,seed,dealer:t.dealerOf(match),round}),plain=new t.Game({rules,players,seed,dealer:g.dealer,round}),rng=t.createRng(seed^0x5bd1e995),other=t.createRng(seed^0x5bd1e995),info={scores:match.scores.slice(),hand:match.hand,length,renchan:match.renchan,dealer:g.dealer,publicHistory:history};s.roundStarted(g);
    while(g.pending()){const q=g.pending(),a=t.decideCharacter(g,q.seat,ids[q.seat],rng,info,ids),b=t.decideCharacter(plain,q.seat,ids[q.seat],other,info,ids);if(JSON.stringify(a)!==JSON.stringify(b))throw Error('AI');let at=performance.now();const h=s.beforeAction(g,{seat:q.seat,action:a,source:'ai'});const beforeMs=performance.now()-at;t.applyAction(g,q.seat,a);at=performance.now();const r=s.afterAction(h,g,{accepted:true});timings.push(beforeMs+performance.now()-at);if(!r.ok)throw Error('hook');t.applyAction(plain,q.seat,b);if(JSON.stringify(t.pf.captureGame(g))!==JSON.stringify(t.pf.captureGame(plain)))throw Error('state');decisions++;}
    if(rng.next()!==other.next()||g.rng.next()!==plain.rng.next())throw Error('RNG');match=t.applyRoundResult(match,g.result);s.roundSettled(g,match);if(!(await s.flush()).ok)throw Error('round save');history=t.recordPublicRound(history,g.events,g.riichi);if(match.scores.reduce((a,b)=>a+b,0)!==400||++round>80)throw Error('match');
   }
   s.leave();if(!(await s.flush()).ok)throw Error('complete');const loaded=await t.createPaifuStore().loadPrivate(`matrix-${mode}-${length}`);if(!loaded.ok||loaded.record.status!=='complete'||t.pf.encodePaifu(loaded.record)!==t.pf.encodePaifu(s.privateRecord())||JSON.stringify(loaded.record.final.scores)!==JSON.stringify(match.scores))throw Error('final');
   const record=s.privateRecord();const rounds=record.rounds.length;timings.sort((a,b)=>a-b);s.dispose();return {mode,length,ids,rounds,decisions,observationP95Ms:timings[Math.floor(timings.length*.95)],observationMaxMs:timings.at(-1)};
  },{mode,length});matrix.push(metric);console.log('SESSION_MATRIX '+JSON.stringify(metric));
 });
 await check('24連荘と途中退出：全判断/精算/400点を保持し、完走と偽らない',async()=>{
  const {record}=makeStorageFixture({id:'long-session',renchan:24});
  await page.evaluate(async record=>{
   const rules=t.createRules(record.settings.rules),players=record.settings.players;let match=record.initialMatch;const s=t.createPaifuSession({id:record.id,rules,players,match,origin:'fixture'});
   for(let i=0;i<record.rounds.length;i++){const g=t.pf.replayPrivateRound(record,i,0);s.roundStarted(g,{setup:'snapshot'});for(const step of record.rounds[i].steps)t.act(s,g,step.seat,step.action,step.source);match=t.applyRoundResult(match,g.result);s.roundSettled(g,match);}
   s.leave();if(!(await s.flush()).ok)throw Error('long save');const loaded=await t.createPaifuStore().loadPrivate(record.id);if(!loaded.ok||t.pf.encodePaifu(loaded.record)!==t.pf.encodePaifu(record)||loaded.record.status!=='aborted'||match.renchan!==24||match.scores.reduce((a,b)=>a+b,0)!==400)throw Error('long mismatch');s.dispose();
  },record);
 });
 await check('ページ終了/再読込後も最後のackはrecording prefix。通常画面は自動再開しない',async()=>{
  await page.evaluate(async()=>{if(JSON.stringify(Object.entries(localStorage))!==t.local)throw Error('localStorage changed');const {s,g}=t.make('page-prefix');s.roundStarted(g);await s.flush();t.act(s,g,0,{type:'discard',tile:g.drawn});});
  await init(page);assert.equal(page.workers().length,0);await page.evaluate(async()=>{const p=await t.createPaifuStore().loadPrivate('page-prefix');if(!p.ok||p.record.status!=='recording'||p.record.final!==null||p.record.rounds[0].steps.length!==0)throw Error('prefix changed');});
 });
 assert.deepEqual(errors,[]);console.log('PAIFU SESSION E2E OK '+JSON.stringify({checks,browser:browser.version(),matrix}));await ctx.close();
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
