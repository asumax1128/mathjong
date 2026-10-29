// Opt-in benchmark; no engine files are edited. Diagnostic module instrumentation is test-only.
// No performance threshold substitutes for integrity checks. Values are hardware-dependent.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startServer} from '../../tools/serve.mjs';
import {makeStorageFixture} from '../paifu-storage-fixtures.mjs';
import {encodePaifu} from '../../src/engine/paifu.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const probe=`\nconst __stageLog=(name,ms)=>(globalThis.__paifuStageTimes??=[]).push({name,ms});\nconst __stageSync=(name,fn)=>{const at=performance.now();try{return fn();}finally{__stageLog(name,performance.now()-at);}};\n`;
function one(s,a,b){assert.equal(s.split(a).length,2,'instrumentation marker must occur once: '+a);return s.replace(a,b);}
let codec=await readFile(new URL('../../src/engine/paifu.js',import.meta.url),'utf8');
codec=one(codec,'jsonCheck(p); verifyPaifu(p);',"__stageSync('jsonStructure',()=>jsonCheck(p)); __stageSync('validation',()=>verifyPaifu(p));");
codec=one(codec,'const s = canonical(p);',"const s = __stageSync('jsonCanonical',()=>canonical(p));");
codec=one(codec,'p = JSON.parse(s);',"p = __stageSync('jsonParse',()=>JSON.parse(s));");
codec=one(codec,'jsonCheck(p); freeze(p);',"__stageSync('jsonStructure',()=>jsonCheck(p)); __stageSync('freeze',()=>freeze(p));");
codec=one(codec,'verifyPaifu(p);\n  return p;',"__stageSync('validation',()=>verifyPaifu(p));\n  return p;");
assert.equal(codec.split('new TextEncoder().encode(s).length').length,3);
codec=codec.replaceAll('new TextEncoder().encode(s).length',"__stageSync('utf8',()=>new TextEncoder().encode(s).length)")+probe;
let storage=await readFile(new URL('../../src/ui/paifu-storage.js',import.meta.url),'utf8');
storage=one(storage,'const sizeOf = s => new TextEncoder().encode(s).length;',"const sizeOf = s => __stageSync('storageUtf8',()=>new TextEncoder().encode(s).length);");
storage=one(storage,'async function digest(json) {','async function digest(json) { const __hashAt=performance.now();');
storage=one(storage,'finally { clearTimeout(timer); }',"finally { clearTimeout(timer); __stageLog('sha256',performance.now()-__hashAt); }");
storage=one(storage,'const db = await open();',"const __openAt=performance.now(); const db = await open(); __stageLog('idbOpen',performance.now()-__openAt); const __txAt=performance.now();");
storage=one(storage,'finally { db.close(); }',"finally { db.close(); __stageLog('idbTransaction:'+mode,performance.now()-__txAt); }");
storage=one(storage,'const snapshot = JSON.parse(json), id = snapshot.id;',"const snapshot = __stageSync('metadataJsonParse',()=>JSON.parse(json)), id = snapshot.id;")+probe;
const fixtures=[];
for(const mode of ['math1','math2'])for(const length of [4,8])fixtures.push(makeStorageFixture({id:`bench-${mode}-${length}`,mode,length}));
fixtures.push(makeStorageFixture({id:'bench-long-24',mode:'math1',length:4,renchan:24}));
fixtures.push(makeStorageFixture({id:'bench-partial',mode:'math2',length:8,partial:true}));
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});let browser;
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 await context.route('**/src/engine/paifu.js',r=>r.fulfill({contentType:'text/javascript',body:codec}));
 await context.route('**/src/ui/paifu-storage.js',r=>r.fulfill({contentType:'text/javascript',body:storage}));
 await page.goto(`http://localhost:${server.address().port}/mathjong/`);
 await page.evaluate(async()=>{
  const mod=f=>import(new URL(`src/ui/${f}`,location.href)),[{createPaifuStore},{createPaifuWorkerStore}]=await Promise.all([mod('paifu-storage.js'),mod('paifu-worker-store.js')]);
  window.bench={direct:createPaifuStore(),remote:createPaifuWorkerStore({operationTimeoutMs:60000}),pf:await import(new URL('src/engine/paifu.js',location.href))};
  window.measure=async(kind,method)=>{
   const gaps=[],frames=[];let last=performance.now(),frameAt=last,raf;
   const frame=at=>{frames.push(at-frameAt);frameAt=at;raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);
   const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},8);
   const start=performance.now();const promise=bench[kind][method](method==='save'?bench.fixture:bench.fixture.id),submitMs=performance.now()-start;
   const result=await promise,totalMs=performance.now()-start;
   await new Promise(r=>setTimeout(r,35));clearInterval(timer);cancelAnimationFrame(raf);
   if(!result.ok)throw Error(JSON.stringify(result));
   if(method==='loadPrivate'){
    // Independently compare entire JSON after timing, not merely matching digests or IDs.
    if(JSON.stringify(result.record)!==JSON.stringify(bench.fixture))throw Error('round trip changed');
    if(!Object.isFrozen(result.record.rounds))throw Error('immutability lost');
   }
   return {totalMs,submitMs,maxTimerGapMs:Math.max(0,...gaps),maxFrameGapMs:Math.max(0,...frames),frameCallbacks:frames.length};
  };
 });
 const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.enable');
 const heap=async()=>{await cdp.send('HeapProfiler.collectGarbage');return (await cdp.send('Runtime.getHeapUsage')).usedSize;};
 // Initialize real Worker before testing. Each fixture's first codec pass is still reported separately.
 const workerColdStartMs=await page.evaluate(async()=>{const at=performance.now();const r=await bench.remote.list();if(!r.ok)throw Error(JSON.stringify(r));return performance.now()-at;});const worker=page.workers()[0];assert.ok(worker);
 const samples=[],heapBefore=await heap();
 for(const {record,recording} of fixtures){
  const expected=encodePaifu(record);await page.evaluate(record=>{bench.fixture=record;},JSON.parse(expected));
  const group={id:record.id,mode:record.settings.rules.mode,length:record.initialMatch.length,bytes:Buffer.byteLength(expected),recording,samples:[]};
  for(let iteration=0;iteration<3;iteration++)for(const kind of iteration%2?['remote','direct']:['direct','remote']){
   await page.evaluate(kind=>bench[kind].clearAll(),kind);
   const sample={kind,iteration};
   for(const method of ['save','loadPrivate']){
    const realm=kind==='direct'?page:worker;await realm.evaluate(()=>globalThis.__paifuStageTimes=[]);
    sample[method]=await page.evaluate(({kind,method})=>measure(kind,method),{kind,method});
    const stages=await realm.evaluate(()=>globalThis.__paifuStageTimes??[]);sample[method].stages=Object.fromEntries([...new Set(stages.map(s=>s.name))].map(name=>[name,stages.filter(s=>s.name===name).reduce((n,s)=>n+s.ms,0)]));
    assert.ok(sample[method].stages.validation>=0,'full validation not instrumented');
    assert.ok(sample[method].stages.sha256>=0,'SHA not instrumented');
   }
   group.samples.push(sample);
  }
  group.browserOneDecision=await page.evaluate(()=>{
   const pf=bench.pf,p=bench.fixture,last=p.rounds.at(-1),prefix=pf.decodePaifu(JSON.stringify({...p,status:'recording',final:null,termination:null,rounds:[...p.rounds.slice(0,-1),{...last,steps:[],settlement:null}]})),g=pf.replayPrivateRound(prefix,p.rounds.length-1,0),q=g.pending();
   let at=performance.now();const before=pf.captureGame(g),beforeMs=performance.now()-at,action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:g.drawn};
   if(action.type==='pass')g.respond(q.seat,action);else g.discard(q.seat,action.tile);
   at=performance.now();const after=pf.captureGame(g),afterMs=performance.now()-at;at=performance.now();const appended=pf.appendDecision(prefix,{before,after,seat:q.seat,action});const appendMs=performance.now()-at;pf.verifyPaifu(appended);
   return {beforeMs,afterMs,appendMs,description:'one valid decision at start of last round; earlier rounds retained; validation/setup excluded'};
  });
  samples.push(group);console.log('PAIFU_BENCH '+JSON.stringify(group));
 }
 await page.evaluate(async()=>{await bench.remote.clearAll();bench.remote.close();delete bench.fixture;});await page.waitForTimeout(100);const heapAfter=await heap();
 const result={browser:browser.version(),samplesPerVariant:3,instrumentation:'test-only module responses; no engine file edits; validation unchanged',workerColdStartIncluded:false,workerColdStartMs,
  windowHeapAfterForcedGc:{before:heapBefore,after:heapAfter,excludesWorkerAndNativeIndexedDb:true},samples};
 const arg=process.argv.indexOf('--output');if(arg>=0){assert.ok(process.argv[arg+1]);await writeFile(process.argv[arg+1],JSON.stringify(result,null,2)+'\n');}
 console.log('PAIFU BENCHMARK OK '+JSON.stringify({fixtures:samples.length,windowHeapAfterForcedGc:result.windowHeapAfterForcedGc}));await context.close();
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
