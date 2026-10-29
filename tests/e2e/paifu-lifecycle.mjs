// Stage 6 independent manager: native Worker/IDB. No production hooks or app.js changes.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {startServer} from '../../tools/serve.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});let browser,checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('✓ Lifecycle: '+name);};
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
 await page.goto(`http://localhost:${server.address().port}/mathjong/`);
 await page.evaluate(async()=>{
  const m=f=>import(new URL('src/'+f,location.href));
  const [{createPaifuLifecycle},{describePaifuSaveState},{createPaifuWorkerStore},{createPaifuStore},pf,{Game},{createRules},{modeConfig},{createMatch},{applyAction}]=await Promise.all([m('ui/paifu-lifecycle.js'),m('ui/paifu-save-state.js'),m('ui/paifu-worker-store.js'),m('ui/paifu-storage.js'),m('engine/paifu.js'),m('engine/game.js'),m('engine/rules.js'),m('engine/config.js'),m('engine/match.js'),m('engine/ai.js')]);
  window.t={createPaifuLifecycle,describePaifuSaveState,createPaifuWorkerStore,createPaifuStore,pf,Game,createRules,modeConfig,createMatch,applyAction,local:JSON.stringify(Object.entries(localStorage))};
  t.same=(a,b)=>{const key=(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;return JSON.stringify(a,key)===JSON.stringify(b,key);};
  t.players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'}));
  t.manager=(storeOptions={},options={})=>createPaifuLifecycle({createStore:()=>{const s=createPaifuWorkerStore(storeOptions);t.store=s;return s;},...options});
  t.begin=(manager,id,mode='math1',length=4)=>{const rules=createRules(modeConfig(mode)),match=createMatch({length}),config={id,rules,players:t.players,match},r=manager.start(config),g=new Game({rules,players:t.players,seed:1});return {...r,g,match};};
  t.act=r=>{const q=r.g.pending(),action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:r.g.drawn},h=r.session.beforeAction(r.g,{seat:q.seat,action,source:r.g.players[q.seat].kind});applyAction(r.g,q.seat,action);if(!r.session.afterAction(h,r.g,{accepted:true}).ok)throw Error('observe');};
 });
 const ended=()=>page.waitForFunction(()=>t.managerUnderTest.status().closingCount===0,null,{timeout:7000});
 await check('import/factoryではWorker/DBを作らず、statusへ秘密を含めない',async()=>{
  assert.equal(page.workers().length,0);await page.evaluate(()=>{t.managerUnderTest=t.manager();if(t.managerUnderTest.status().activeCount!==0)throw Error('eager');});assert.equal(page.workers().length,0);
 });
 for(const mode of ['math1','math2'])for(const length of [4,8])await check(`${mode}×${length}: 成立打牌・退出・prefix復元、400点とGame不変`,async()=>{
  await page.evaluate(async({mode,length})=>{
   t.managerUnderTest.dispose();const manager=t.managerUnderTest=t.manager(),id=`native-${mode}-${length}`,r=t.r=t.begin(manager,id,mode,length);if(!r.ok)throw Error('admission');r.session.roundStarted(r.g);if(!(await r.session.flush()).ok)throw Error('first ack');
   const plain=new t.Game({rules:r.g.rules,players:t.players,seed:1}),a={type:'discard',tile:r.g.drawn};t.act(r);t.applyAction(plain,0,a);
   if(t.pf.encodePaifu(r.session.privateRecord()).length===0||JSON.stringify(t.pf.captureGame(r.g))!==JSON.stringify(t.pf.captureGame(plain))||r.g.rng.next()!==plain.rng.next())throw Error('game changed');
   if(r.match.scores.reduce((a,b)=>a+b)!==400)throw Error('score');manager.end('left-match');
  },{mode,length});await ended();
  await page.evaluate(async({mode,length})=>{const p=await t.createPaifuStore().loadPrivate(`native-${mode}-${length}`);if(!p.ok||p.record.status!=='aborted'||p.record.final!==null||p.record.rounds[0].steps.length!==1)throw Error('false final/prefix');const restored=t.pf.replayPrivateRound(p.record,0);if(!t.same(t.pf.captureGame(restored),t.pf.captureGame(t.r.g)))throw Error('restoration');if(t.managerUnderTest.status().lastFinished.save.state!=='saved')throw Error('ack missing');},{mode,length});
 });
 await check('二重再戦飽和では新記録を見送り、終了期限後も途中開始しない',async()=>{
  await page.evaluate(async()=>{t.managerUnderTest.dispose();t.managerUnderTest=t.manager({}, {retireTimeoutMs:1800});t.a=t.begin(t.managerUnderTest,'saturated-a');t.a.session.roundStarted(t.a.g);await t.a.session.flush();});
  const worker=page.workers().at(-1);await worker.evaluate(()=>{globalThis.postMessage=()=>{};});
  await page.evaluate(async()=>{t.act(t.a);t.b=t.begin(t.managerUnderTest,'saturated-b');if(!t.b.ok)throw Error('second');t.b.session.roundStarted(t.b.g);if(!(await t.b.session.flush()).ok)throw Error('new active');const x=t.begin(t.managerUnderTest,'saturated-c');if(x.recording!==false||x.reason!=='resources-busy')throw Error('third admitted');if(t.managerUnderTest.status().activeCount!==0||t.managerUnderTest.status().closingCount!==1)throw Error('cap');});
  assert.ok(page.workers().length<=2);await ended();await page.evaluate(()=>{const s=t.managerUnderTest.status();if(s.activeCount!==0||!s.reviewRequired||s.lastSkip!=='resources-busy'||!s.recentFinished.some(x=>x.save.state==='uncertain'))throw Error('false restart/unknown');});
 });
 await check('実commit応答喪失：照合してもsavedVersionを進めず、自動再開しない',async()=>{
  await page.evaluate(async()=>{t.managerUnderTest.dispose();t.managerUnderTest=t.manager({operationTimeoutMs:350});t.r=t.begin(t.managerUnderTest,'lost-ack');t.r.session.roundStarted(t.r.g);await t.r.session.flush();});
  await page.workers().at(-1).evaluate(()=>{const send=globalThis.postMessage.bind(globalThis);let once=true;globalThis.postMessage=(m,...args)=>{if(once&&m.type==='result'&&m.result?.ok&&m.result.metadata){once=false;return;}return send(m,...args);};});
  await page.evaluate(async()=>{const {session}=t.r;t.act(t.r);const old=session.status().savedVersion,result=await session.flush();if(result.ok||result.error.code!=='outcome-unknown')throw Error('not unknown');const report=await session.inspectRecovery(),view=t.describePaifuSaveState(session.status(),{inspection:report});if(!report.ok||report.kind!=='attempt-content-present'||view.state!=='review-required'||view.contentPresent!==true||view.savedVersion!==old||session.retrySaving().error.code!=='reconciliation-required')throw Error('unsafe fact projection');t.managerUnderTest.end();});await ended();
 });
 await check('容量不足では自動削除/再送せず、Game打牌が成立する',async()=>{
  await page.evaluate(async()=>{t.managerUnderTest.dispose();const direct=t.createPaifuStore(),before=await direct.list();if(!before.ok||before.entries.length===0)throw Error('need existing rows');t.managerUnderTest=t.manager({maxRecords:1});const r=t.begin(t.managerUnderTest,'capacity');r.session.roundStarted(r.g);const x=await r.session.flush();if(x.ok||x.error.code!=='capacity-exceeded')throw Error('not capacity');t.act(r);if(r.g.events.filter(e=>e.type==='discard').length!==1)throw Error('game blocked');t.managerUnderTest.end();const after=await direct.list();if(after.entries.length!==before.entries.length)throw Error('auto deletion/write');});await ended();await page.evaluate(()=>{if(t.managerUnderTest.status().lastFinished.save.state!=='capacity')throw Error('lost capacity');});
 });
 await check('Worker停止・初回利用不能でも保存だけ失敗し、次Gameを止めない',async()=>{
  await page.evaluate(async()=>{t.managerUnderTest.dispose();t.managerUnderTest=t.manager({createWorker(){throw Error('PRIVATE');}});const r=t.begin(t.managerUnderTest,'no-worker');r.session.roundStarted(r.g);const x=await r.session.flush();if(x.ok||x.error.code!=='unavailable')throw Error('expected unavailable');t.act(r);t.managerUnderTest.end();});await ended();
  await page.evaluate(()=>{if(JSON.stringify(t.managerUnderTest.status()).includes('PRIVATE'))throw Error('leak');t.managerUnderTest.dispose();t.managerUnderTest=t.manager();if(!t.begin(t.managerUnderTest,'after-worker-failure').ok)throw Error('blocked new game');t.managerUnderTest.dispose();});
 });
 await check('初期化失敗後にWorker/activeを残さず、失敗内容を秘匿',async()=>{
  await page.evaluate(()=>{t.managerUnderTest=t.manager({}, {createSession(){throw Error('PRIVATE INIT');}});const r=t.begin(t.managerUnderTest,'invalid');if(r.ok||t.managerUnderTest.status().activeCount!==0||JSON.stringify(r).includes('PRIVATE'))throw Error('init cleanup');t.managerUnderTest.dispose();});
 });
 await check('背景化/再開は途中退出とせず、前景で明示保存できる',async()=>{
  await page.evaluate(async()=>{t.managerUnderTest=t.manager();t.r=t.begin(t.managerUnderTest,'background');t.r.session.roundStarted(t.r.g);await t.r.session.flush();t.act(t.r);});
  const cdp=await context.newCDPSession(page);await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await new Promise(r=>setTimeout(r,120));await cdp.send('Page.setWebLifecycleState',{state:'active'});await cdp.detach();
  await page.evaluate(async()=>{if(t.managerUnderTest.status().activeCount!==1||t.r.session.privateRecord().status!=='recording')throw Error('false exit');t.managerUnderTest.checkpoint();if(!(await t.r.session.flush()).ok)throw Error('resume checkpoint');t.managerUnderTest.end();});await ended();
 });
 await check('31回の実セッション再戦：最大active1/closing1、最後のWorker0、既存localStorage不変',async()=>{
  // Explicit fixture cleanup to stay below the unchanged 20-record limit, not product recovery.
  await page.evaluate(async()=>{t.managerUnderTest.dispose();await t.createPaifuStore().clearAll();t.managerUnderTest=t.manager();});
  for(let i=0;i<31;i++){
   await page.evaluate(async i=>{const r=t.begin(t.managerUnderTest,'cycle-'+i);if(!r.ok)throw Error('admission');r.session.roundStarted(r.g);t.act(r);if(!(await r.session.flush()).ok)throw Error('ack');t.managerUnderTest.end('reset');if(t.managerUnderTest.status().activeCount>1||t.managerUnderTest.status().closingCount>1)throw Error('resource cap');},i);await ended();
   await page.evaluate(async i=>{const st=t.createPaifuStore(),x=await st.loadPrivate('cycle-'+i);if(!x.ok||x.record.status!=='aborted')throw Error('prefix');await st.remove('cycle-'+i);},i);
  }
  await page.evaluate(()=>{t.managerUnderTest.dispose();const s=t.managerUnderTest.status();if(s.recentFinished.length>8||s.activeCount||s.closingCount||JSON.stringify(Object.entries(localStorage))!==t.local)throw Error('retention/localStorage');});
  const until=Date.now()+5000;while(page.workers().length&&Date.now()<until)await page.waitForTimeout(20);assert.equal(page.workers().length,0);
 });
 assert.deepEqual(errors,[]);console.log(`PAIFU LIFECYCLE E2E OK: ${checks} checks, Chromium ${browser.version()}`);await context.close();
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
