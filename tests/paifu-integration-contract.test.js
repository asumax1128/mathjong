import test from 'node:test';
import assert from 'node:assert/strict';
import {integrationHarness} from './paifu-integration-harness.mjs';
import {createPaifuLifecycle} from '../src/ui/paifu-lifecycle.js';
import {createPaifuWorkerStore} from '../src/ui/paifu-worker-store.js';
import {createPaifuStore} from '../src/ui/paifu-storage.js';
import {createPaifuSession} from '../src/ui/paifu-session.js';
import {Game} from '../src/engine/game.js';
import {createRng} from '../src/engine/rng.js';
import {applyAction} from '../src/engine/ai.js';
import {createMatch,applyRoundResult,dealerOf} from '../src/engine/match.js';
import * as pf from '../src/engine/paifu.js';
import {rulesFor,makeGame} from './helpers.js';
const players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'}));
const micro=()=>new Promise(r=>setImmediate(r));
function setup(mode='math1',length=4){const rules=rulesFor(mode),match=createMatch({length}),g=new Game({rules,players,seed:9});return {rules,match,g,config:id=>({id,rules,players,match})};}
function memoryStore(){let n=0;return {calls:[],close(){},async save(p){pf.verifyPaifu(p);this.calls.push(p);return {ok:true,metadata:{id:p.id,token:(++n).toString(16).padStart(32,'0')}};}};}
async function ready(options={}){const stores=[];const h=integrationHarness({load:async()=>()=>createPaifuLifecycle({createStore(){const s=memoryStore();stores.push(s);return s;},...options})});await h.preload();return {h,stores};}
function discard(h,token,g){const q=g.pending();return h.action(token,g,q.seat,q.type==='claim'?{type:'pass'}:{type:'discard',tile:g.drawn??g.hands[q.seat].at(-1)},g.players[q.seat].kind);}
test('統合契約試作: preload前は記録を見送っても実Gameの打牌が成立',()=>{
 const r=setup(),h=integrationHarness({load:async()=>()=>createPaifuLifecycle()}),t=h.begin(r.config('a'));h.round(t,r.g);discard(h,t,r.g);assert.equal(r.g.events.filter(e=>e.type==='discard').length,1);assert.equal(h.view().recording,false);h.dispose();
});
test('統合契約試作: 遅いimportがA/Bの途中へ接続せず、新しいCの開始時だけ利用',async()=>{
 let release,created=0;const h=integrationHarness({load:()=>new Promise(r=>release=r)}),loading=h.preload();await micro();const r=setup(),a=h.begin(r.config('a'));h.round(a,r.g);discard(h,a,r.g);const b=h.begin(r.config('b')),gb=new Game({rules:r.rules,players,seed:2});h.round(b,gb);
 release(()=>{created++;return createPaifuLifecycle({createStore:memoryStore});});await loading;assert.equal(created,0);assert.equal(h.view().recording,false);discard(h,b,gb);const c=h.begin(r.config('c'));h.round(c,new Game({rules:r.rules,players,seed:3}));assert.equal(created,1);assert.equal(h.privateSessionForTest().privateRecord().rounds[0].initial.seed,3);h.dispose();
});
test('統合契約試作: タイトル退出後のimport完了は資源や記録を作らない',async()=>{
 let release,created=0;const h=integrationHarness({load:()=>new Promise(r=>release=r)}),p=h.preload();await micro();const r=setup(),t=h.begin(r.config('a'));h.round(t,r.g);h.leave(t);release(()=>{created++;return createPaifuLifecycle();});await p;assert.equal(h.view().inGame,false);assert.equal(created,0);h.dispose();
});
for(const mode of ['math1','math2'])for(const fault of ['import','manager','session','worker','idb'])test(`統合契約試作 ${mode}: ${fault}初期化失敗でもGame/次RNG/400点は非記録と一致`,async()=>{
 const r=setup(mode),plain=new Game({rules:r.rules,players,seed:9});let workerAttempts=0,idbAttempts=0;
 const h=integrationHarness({load:async()=>{
  if(fault==='import')throw Error('PRIVATE');
  return ()=>{if(fault==='manager')throw Error('PRIVATE');return createPaifuLifecycle({
   createSession:fault==='session'?()=>{throw Error('PRIVATE');}:createPaifuSession,
   createStore:fault==='worker'?()=>createPaifuWorkerStore({createWorker(){workerAttempts++;throw Error('PRIVATE');}})
    :fault==='idb'?()=>({...createPaifuStore({getIndexedDB(){idbAttempts++;throw new DOMException('PRIVATE','SecurityError');}}),close(){}}):memoryStore,
  });};
 }});await h.preload();const t=h.begin(r.config('a'));h.round(t,r.g);const session=h.privateSessionForTest();if(session)assert.equal((await session.flush()).ok,false);if(fault==='worker')assert.equal(workerAttempts,1);if(fault==='idb')assert.equal(idbAttempts,1);
 const action={type:'discard',tile:r.g.drawn};h.action(t,r.g,0,action,'human');applyAction(plain,0,action);
 assert.deepEqual(pf.captureGame(r.g),pf.captureGame(plain));assert.equal(r.g.rng.next(),plain.rng.next());assert.equal(r.match.scores.reduce((a,b)=>a+b),400);assert.equal(JSON.stringify(h.view()).includes('PRIVATE'),false);h.dispose();
});
test('統合契約試作: 旧試合のAI callbackは判断/RNG/新Game/新牌譜を変更しない',async()=>{
 const {h}=await ready(),r=setup(),a=h.begin(r.config('a'));h.round(a,r.g);const old=r.g,b=h.begin(r.config('b')),g=new Game({rules:r.rules,players,seed:2});h.round(b,g);const oldBefore=pf.captureGame(old),newBefore=pf.captureGame(g);let decisions=0;const aiRng=createRng(91),referenceRng=createRng(91);
 if(h.current(a,old)){decisions++;aiRng.next();discard(h,a,old);}assert.equal(decisions,0);assert.equal(aiRng.next(),referenceRng.next());assert.equal(h.action(a,old,0,{type:'discard',tile:old.drawn},'ai').ignored,true);
 assert.deepEqual(pf.captureGame(old),oldBefore);assert.deepEqual(pf.captureGame(g),newBefore);assert.equal(h.privateSessionForTest().privateRecord().rounds[0].steps.length,0);h.dispose();
});
test('統合契約試作: 同じ試合でも前局のGame/精算通知を次局へ混ぜない',async()=>{
 const {h}=await ready(),r=setup(),t=h.begin(r.config('a'));h.round(t,r.g);
 while(r.g.pending())discard(h,t,r.g);const settled=h.settle(t,r.g,r.match,{round:1,maxRound:1000000});assert.equal(settled.ignored,false);assert.equal(settled.match.scores.reduce((a,b)=>a+b),400);assert.equal(h.settle(t,r.g,r.match).ignored,true);
 const next=new Game({rules:r.rules,players,seed:2,dealer:dealerOf(settled.match),round:2});h.round(t,next);const count=h.privateSessionForTest().privateRecord().rounds.length;assert.equal(h.settle(t,r.g,r.match).ignored,true);assert.equal(h.action(t,r.g,0,{type:'tsumo'},'human').ignored,true);assert.equal(h.privateSessionForTest().privateRecord().rounds.length,count);h.dispose();
});
test('統合契約試作: 飽和で見送ったCの操作をA/Bへ書かず、Dは新規記録',async context=>{
 const hold=[];let n=0;const h=integrationHarness({load:async()=>()=>createPaifuLifecycle({createStore(){const s=memoryStore();if(++n===1)s.save=()=>new Promise(r=>hold.push(r));return s;}})});context.after(()=>h.dispose());await h.preload();const r=setup(),a=h.begin(r.config('a'));h.round(a,r.g);const b=h.begin(r.config('b')),gb=new Game({rules:r.rules,players,seed:2});h.round(b,gb);await micro();const c=h.begin(r.config('c')),gc=new Game({rules:r.rules,players,seed:3});h.round(c,gc);assert.equal(h.view().recording,false);discard(h,c,gc);assert.equal(gc.events.filter(e=>e.type==='discard').length,1);assert.equal(h.view().resources.activeCount,0);
 hold.shift()({ok:false,error:{code:'outcome-unknown'}});await micro();assert.equal(h.view().recording,false);const d=h.begin(r.config('d')),gd=new Game({rules:r.rules,players,seed:4});h.round(d,gd);assert.equal(h.privateSessionForTest().privateRecord().id,'d');assert.equal(h.privateSessionForTest().privateRecord().rounds[0].steps.length,0);assert.equal(h.action(c,gc,0,{type:'tsumo'},'human').ignored,true);h.dispose();
});
test('統合契約試作: before/after故障でも実行1回。エンジン拒否を握りつぶさない',async()=>{
 for(const where of ['beforeAction','afterAction']){let calls=0;const {h}=await ready({createSession:(c,o)=>{const s=createPaifuSession(c,o);return {...s,[where](){calls++;throw Error('PRIVATE');}};}}),r=setup(),t=h.begin(r.config('a'));h.round(t,r.g);const tile=r.g.drawn;h.action(t,r.g,0,{type:'discard',tile},'human');assert.equal(r.g.events.filter(e=>e.type==='discard'&&e.tile===tile).length,1);assert.equal(calls,1);assert.equal(h.view().recording,false);h.dispose();}
 const {h}=await ready(),r=setup(),t=h.begin(r.config('a'));h.round(t,r.g);const before=pf.captureGame(r.g);assert.throws(()=>h.action(t,r.g,0,{type:'discard',tile:-1},'human'));assert.deepEqual(pf.captureGame(r.g),before);assert.equal(h.privateSessionForTest().privateRecord().rounds[0].steps.length,0);h.dispose();
});
test('統合契約試作: 観測精算の故障でも和了結果/400点/二重精算ガードを保持',async()=>{
 const {h}=await ready({createSession:(c,o)=>({...createPaifuSession(c,o),roundSettled(){throw Error('PRIVATE');}})}),r=setup();
 const g=makeGame({r:r.rules,players,hands:[['sin','30','=1/2','cos','180','=-1','tan','45'],['sin','sin','0','90','90','=-√3','=√3','150'],['cos','135','=√3','=-1/√2','120','120','tan','=0'],['=-1','tan','tan','120','=1/√3','90','=-1/√2','=-√3']],draws:['=1']});
 const t=h.begin({...r.config('a'),origin:'fixture'});h.round(t,g,{setup:'snapshot'});assert.equal(h.privateSessionForTest().status().phase,'active');
 h.action(t,g,0,{type:'tsumo'},'human');const expected=applyRoundResult(r.match,g.result),result=h.settle(t,g,r.match);assert.deepEqual(result.match,expected);assert.equal(result.match.scores.reduce((a,b)=>a+b),400);assert.equal(h.settle(t,g,r.match).ignored,true);h.dispose();
});
test('統合契約試作: 退出したscopeの通知は新タイトル/次試合を動かさない',async()=>{
 const {h}=await ready(),r=setup(),t=h.begin(r.config('a'));h.round(t,r.g);h.leave(t);assert.equal(h.current(t,r.g),false);assert.equal(h.action(t,r.g,0,{type:'discard',tile:r.g.drawn},'human').ignored,true);assert.equal(h.round(t,r.g).ignored,true);assert.equal(h.view().inGame,false);h.dispose();
});
