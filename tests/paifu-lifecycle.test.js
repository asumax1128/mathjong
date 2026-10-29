import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaifuLifecycle} from '../src/ui/paifu-lifecycle.js';
import {createPaifuSession} from '../src/ui/paifu-session.js';
import {Game} from '../src/engine/game.js';
import {createMatch} from '../src/engine/match.js';
import {applyAction} from '../src/engine/ai.js';
import {rulesFor} from './helpers.js';
const players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'}));
const micro=()=>new Promise(r=>setImmediate(r));
function rig(extra={}){
 const stores=[],timers=new Map();let seq=0;
 const manager=createPaifuLifecycle({schedule:fn=>{timers.set(++seq,fn);return seq;},cancel:id=>timers.delete(id),createStore(){
  const s={closed:0,calls:[],pending:[],mode:'ok',save(p,o){this.calls.push({p,o});if(this.mode==='hold')return new Promise(r=>this.pending.push(()=>r({ok:false,error:{code:'outcome-unknown'}})));if(this.mode!=='ok')return Promise.resolve({ok:false,error:{code:this.mode}});return Promise.resolve({ok:true,metadata:{id:p.id,token:'a'.repeat(32)}});},close(){this.closed++;for(const f of this.pending.splice(0))f();}};
  stores.push(s);return s;
 },...extra});
 const start=(id,mode='math1')=>{const rules=rulesFor(mode),config={id,rules,players,match:createMatch()},r=manager.start(config);return {...r,g:new Game({rules,players,seed:1})};};
 return {manager,stores,timers,start};
}
test('資源管理: factory/初期化ではWorkerを作らず、active1件だけ',()=>{
 const r=rig(),a=r.start('a');assert.equal(a.ok,true);assert.equal(r.stores.length,1);assert.equal(r.stores[0].calls.length,0);assert.equal(r.manager.status().activeCount,1);assert.equal(r.manager.status().closingCount,0);r.manager.dispose();assert.equal(r.stores[0].closed,1);
});
test('資源管理: 旧flushを待たず新試合を開始、終了中最大1件',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='hold';a.session.roundStarted(a.g);const b=r.start('b');assert.equal(b.ok,true);await micro();assert.equal(r.manager.status().closingCount,1);assert.equal(r.manager.status().activeCount,1);assert.equal(r.stores.length,2);r.stores[0].pending.shift()();await micro();assert.equal(r.manager.status().closingCount,0);assert.equal(r.stores[0].closed,1);r.manager.dispose();
});
test('資源管理: 飽和時は旧activeを解放し新記録を見送り。途中から自動開始しない',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='hold';a.session.roundStarted(a.g);const b=r.start('b');r.stores[1].mode='hold';b.session.roundStarted(b.g);const flight=b.session.flush();await micro();
 const c=r.start('c');assert.equal(c.recording,false);assert.equal(c.reason,'resources-busy');assert.equal(r.stores.length,2);assert.equal(r.manager.status().activeCount,0);assert.equal(r.manager.status().closingCount,1);assert.equal(r.manager.status().lastFinished.save.state,'uncertain');assert.equal(r.stores[1].closed,1);await flight;
 r.stores[0].pending.shift()();await micro();assert.equal(r.manager.status().activeCount,0);assert.equal(r.manager.status().closingCount,0);assert.equal(r.stores.length,2);r.manager.dispose();
});
test('資源管理: 飽和時の未投稿要求は取消、知らない書込があったとは言わない',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='hold';a.session.roundStarted(a.g);const b=r.start('b');b.session.roundStarted(b.g);r.start('c');assert.equal(r.stores[1].calls.length,0);assert.equal(r.manager.status().lastFinished.save.state,'unsaved');assert.equal(r.manager.status().lastFinished.save.savedStatus,null);r.manager.dispose();await micro();
});
test('資源管理: タイトル退出はabortedを保存し、timerとstoreを解放',async()=>{
 const r=rig(),a=r.start('a');a.session.roundStarted(a.g);assert.equal(r.manager.end().ok,true);await micro();assert.equal(r.manager.status().activeCount,0);assert.equal(r.manager.status().closingCount,0);assert.equal(r.stores[0].calls.at(-1).p.status,'aborted');assert.equal(r.manager.status().lastFinished.save.savedStatus,'aborted');assert.equal(r.timers.size,0);assert.equal(r.stores[0].closed,1);assert.equal(r.manager.end().ignored,true);r.manager.dispose();
});
test('資源管理: 終了期限はpending書込を不確定とし、古い完了で新sessionを閉じない',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='hold';a.session.roundStarted(a.g);const b=r.start('b');await micro();const expire=[...r.timers.values()][0];expire();assert.equal(r.manager.status().closingCount,0);assert.equal(r.manager.status().lastFinished.save.state,'uncertain');assert.equal(r.manager.status().active.generation,b.generation);await micro();assert.equal(r.manager.status().active.generation,b.generation);r.manager.dispose();
});
for(const code of ['quota-exceeded','capacity-exceeded','outcome-unknown','conflict','unavailable'])test(`資源管理: ${code}後も自動retryなし、次試合を開始できる`,async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode=code;a.session.roundStarted(a.g);assert.equal((await a.session.flush()).ok,false);const n=r.stores[0].calls.length;r.manager.end();await micro();assert.equal(r.stores[0].calls.length,n);assert.equal(r.stores[0].closed,1);assert.equal(r.start('b').ok,true);r.manager.dispose();
});
test('資源管理: session初期化失敗でも所有storeを1回閉じ、秘密を返さない',()=>{
 for(const createSession of [()=>{throw Error('SECRET');},()=>({}),()=>({status:()=>({phase:'failed'}),dispose(){}})]){
  const r=rig({createSession});const x=r.start('a');assert.equal(x.reason,'initialization-failed');assert.equal(r.manager.status().activeCount,0);assert.equal(r.stores[0].closed,1);assert.equal(JSON.stringify(x).includes('SECRET'),false);r.manager.dispose();
 }
});
test('資源管理: store初期化不能/不正設定はゲーム側へthrowしない',()=>{
 for(const options of [{createStore(){throw Error('SECRET');}},{retireTimeoutMs:0}]){const r=rig(options);assert.doesNotThrow(()=>r.start('a'));assert.equal(r.manager.status().activeCount,0);r.manager.dispose();}
});
test('資源管理: 終了scheduler故障では直ちに解放、成功保存を捏造しない',()=>{
 const r=rig({schedule(){throw Error('SECRET');}}),a=r.start('a');a.session.roundStarted(a.g);r.manager.end();assert.equal(r.manager.status().closingCount,0);assert.equal(r.stores[0].closed,1);assert.notEqual(r.manager.status().lastFinished.save.state,'saved');r.manager.dispose();
});
test('資源管理: 解放確認不能なら追加資源を作らず記録だけ見送る',()=>{
 const r=rig({createStore:()=>({save:async()=>({ok:false}),close(){throw Error('SECRET');}})});r.start('a');r.manager.dispose();assert.equal(r.manager.status().cleanupFailed,true);assert.equal(r.start('b').ok,false);
});
test('資源管理: 31回連続再戦の同時所有は最大2、最後は0',async()=>{
 const r=rig();for(let i=0;i<31;i++){const a=r.start('cycle-'+i);assert.equal(a.ok,true);a.session.roundStarted(a.g);await a.session.flush();r.manager.end('reset');await micro();assert.ok(r.manager.status().closingCount<=1);assert.ok(r.stores.filter(s=>!s.closed).length<=2);}
 r.manager.dispose();assert.equal(r.stores.every(s=>s.closed===1),true);assert.equal(r.timers.size,0);
});
test('資源管理: 背景checkpointは退出/完走に変えず、disposeで未保存を保存済みとしない',async()=>{
 const r=rig(),a=r.start('a');a.session.roundStarted(a.g);r.manager.checkpoint();assert.equal(a.session.privateRecord().status,'recording');r.manager.dispose();assert.equal(r.manager.status().closed,true);assert.equal(r.manager.status().activeCount,0);assert.equal(r.timers.size,0);assert.equal(r.start('b').reason,'closed');await micro();
});
for(const mode of ['math1','math2'])test(`資源管理 ${mode}: 保存障害でも成立打牌・山・RNG・Match400点を変えない`,async()=>{
 const r=rig(),a=r.start('a',mode),plain=new Game({rules:a.g.rules,players,seed:1});r.stores[0].mode='unavailable';a.session.roundStarted(a.g);const action={type:'discard',tile:a.g.drawn},h=a.session.beforeAction(a.g,{seat:0,action,source:'human'});applyAction(a.g,0,action);applyAction(plain,0,action);a.session.afterAction(h,a.g,{accepted:true});await a.session.flush();assert.deepEqual(a.g.hands,plain.hands);assert.deepEqual(a.g.wall,plain.wall);assert.deepEqual(a.g.events,plain.events);assert.equal(a.g.rng.next(),plain.rng.next());assert.equal(createMatch().scores.reduce((x,y)=>x+y),400);r.manager.dispose();
});
test('資源管理: 初期化中disposeの再入後にsessionを残さない',()=>{
 let manager;const r=rig({createSession:(config,options)=>{manager.dispose();return createPaifuSession(config,options);}});manager=r.manager;assert.equal(r.start('a').ok,false);assert.equal(r.manager.status().activeCount,0);assert.equal(r.stores[0].closed,1);
});
test('資源管理: statusには私有ID・本文・token・任意エラーを含めない',async()=>{
 const r=rig(),a=r.start('SECRET');r.stores[0].mode='SECRET';a.session.roundStarted(a.g);await a.session.flush();const text=JSON.stringify(r.manager.status());for(const word of ['SECRET','wall','hands','token','json'])assert.equal(text.includes(word),false);r.manager.dispose();
});
test('資源管理: 新しい終了概要があっても古い不確定の警告を残す',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='hold';a.session.roundStarted(a.g);r.start('b');await micro();r.start('c');const expire=[...r.timers.values()][0];expire();await micro();assert.equal(r.manager.status().reviewRequired,true);assert.ok(r.manager.status().recentFinished.some(x=>x.generation===a.generation&&x.save.state==='uncertain'));r.manager.dispose();
});
test('資源管理: 保存失敗の概要は8件までで、本文を溜めない',async()=>{
 const r=rig();for(let i=0;i<31;i++){r.start('secret-'+i);r.manager.end();await micro();}assert.equal(r.manager.status().recentFinished.length,8);assert.equal(JSON.stringify(r.manager.status()).includes('secret-'),false);r.manager.dispose();
});
test('資源管理: end中のcleanup失敗後は次storeを作成しない',()=>{
 let creates=0;const r=rig({createStore:()=>{creates++;return {save:async()=>({ok:false}),close(){throw Error('SECRET');}};},schedule(){throw Error('scheduler');}});r.start('a');assert.equal(r.start('b').ok,false);assert.equal(creates,1);r.manager.dispose();
});
test('資源管理: activeの不確定状態も全体の要確認フラグへ反映',async()=>{
 const r=rig(),a=r.start('a');r.stores[0].mode='outcome-unknown';a.session.roundStarted(a.g);await a.session.flush();assert.equal(r.manager.status().reviewRequired,true);assert.equal(r.manager.status().active.save.state,'uncertain');r.manager.dispose();
});
