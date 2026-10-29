import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaifuSession} from '../src/ui/paifu-session.js';
import * as pf from '../src/engine/paifu.js';
import {Game} from '../src/engine/game.js';
import {applyAction} from '../src/engine/ai.js';
import {createMatch,applyRoundResult,dealerOf} from '../src/engine/match.js';
import {createRng} from '../src/engine/rng.js';
import {CHARACTER_ROSTER,decideCharacter,newPublicHistory,recordPublicRound} from '../src/engine/characters.js';
import {rulesFor,makeGame,findTile} from './helpers.js';
const players=['kanata','tara','nocchi','yujin'].map((id,i)=>({id,name:id,kind:i?'ai':'human'}));
const H=['sin','30','=1/2','cos','180','=-1','tan','45'];
const O=[['sin','sin','0','90','90','=-√3','=√3','150'],['cos','135','=√3','=-1/√2','120','120','tan','=0'],['=-1','tan','tan','120','=1/√3','90','=-1/√2','=-√3']];
const error=(r,c)=>{assert.equal(r.ok,false);assert.equal(r.error.code,c);};
function memoryStore(){const rows=new Map(),calls=[];let n=0;return {rows,calls,async save(p,options){calls.push({p,options});pf.verifyPaifu(p);const old=rows.get(p.id);if((old?.metadata.token??null)!==options.expectedToken)return {ok:false,error:{code:'conflict',retryable:false}};const metadata={id:p.id,token:(++n).toString(16).padStart(32,'0')};rows.set(p.id,{record:p,metadata});return {ok:true,metadata};},close(){}};}
function rig(mode='math1',opts={}){let time=0,seq=0;const tasks=new Map(),store=opts.store??memoryStore(),rules=rulesFor(mode),match=createMatch(),g=new Game({rules,players,seed:9});
 const s=createPaifuSession({id:'session',rules,players,match,...opts.config},{store,now:()=>time,schedule:fn=>{tasks.set(++seq,fn);return seq;},cancel:id=>tasks.delete(id),...opts});
 return {s,g,match,store,tasks,time:n=>time=n};}
function act(r,seat,action,source=r.g.players[seat].kind){const h=r.s.beforeAction(r.g,{seat,action,source});applyAction(r.g,seat,action);const result=r.s.afterAction(h,r.g,{accepted:true});assert.equal(result.ok,true);return h;}
function passes(r){while(r.g.pending()?.type==='claim')act(r,r.g.pending().seat,{type:'pass'},r.g.pending().seat===0?(r.g.pending().ron?'human':'auto-pass'):'ai');}
function fixed(mode='math1',hands=[H,...O],draws=['0','=1','=-1/√3','=-√3/2','=1']){const r=rig(mode,{config:{origin:'fixture'}});r.g=makeGame({hands,draws,r:rulesFor(mode),players});r.s.roundStarted(r.g,{setup:'snapshot'});return r;}
const micro=()=>new Promise(r=>setImmediate(r));
test('接続基盤: factoryは保存せず、初回配牌/ツモを1回記録。statusは秘密を返さない',async()=>{
 const r=rig();assert.equal(r.store.calls.length,0);assert.equal(r.s.roundStarted(r.g).recorded,true);assert.equal(r.s.roundStarted(r.g).duplicate,true);assert.equal(r.s.privateRecord().rounds[0].initialEvents[0].tile,r.g.drawn);
 assert.equal('record' in r.s.status(),false);assert.equal('token' in r.s.status(),false);await r.s.flush();assert.equal(r.store.calls.length,1);r.s.dispose();
});
for(const mode of ['math1','math2'])test(`接続基盤 ${mode}: リーチ・ゼロeventロン見送り・ツモ・精算・400点`,async()=>{
 const r=fixed(mode,[H,O[0],H,O[2]]);act(r,0,{type:'discard',tile:findTile(r.g,0,'0'),riichi:true});passes(r);act(r,1,{type:'discard',tile:r.g.drawn});
 assert.equal(r.g.pending().seat,2);assert.ok(r.g.pending().ron);const count=r.g.events.length;act(r,2,{type:'pass'});assert.equal(r.g.events.length,count);assert.equal(r.s.privateRecord().rounds[0].steps.at(-1).events.length,0);passes(r);
 for(const seat of [2,3]){act(r,seat,{type:'discard',tile:r.g.drawn});passes(r);}assert.ok(r.g.pending().canTsumo);act(r,0,{type:'tsumo'});
 const result=structuredClone(r.g.result),m=applyRoundResult(r.match,r.g.result);r.s.roundSettled(r.g,m);assert.equal(r.s.roundSettled(r.g,m).duplicate,true);assert.deepEqual(r.g.result,result);assert.equal(m.scores.reduce((a,b)=>a+b),400);assert.equal(r.s.privateRecord().rounds[0].settlement.matchAfter.renchan,1);
 await r.s.flush();const p=r.s.privateRecord();assert.deepEqual(pf.captureGame(pf.replayPrivateRound(p,0)),pf.captureGame(r.g));assert.ok(p.rounds[0].steps.some(s=>s.action.type==='pass'&&s.source==='human'));assert.equal(pf.verifyPaifu(p).valid,true);r.s.dispose();
});
test('接続基盤: ロン・役満は実エンジンの和了牌/点/精算を記録',async()=>{
 const r=fixed('math1',[['0','30','45','60','90','120','135','150'],...O],['=-√3/2','180']);act(r,0,{type:'discard',tile:r.g.drawn,riichi:true});passes(r);act(r,1,{type:'discard',tile:r.g.drawn});while(r.g.pending().seat!==0)act(r,r.g.pending().seat,{type:'pass'});act(r,0,{type:'ron'});
 r.s.roundSettled(r.g,applyRoundResult(r.match,r.g.result));await r.s.flush();const p=r.s.privateRecord(),w=p.rounds[0].steps.at(-1).events.at(-1);assert.equal(w.result.points,16);assert.equal(w.result.analysis.riichiBonus,0);assert.deepEqual(p.rounds[0].settlement.deltas,[96,-96,0,0]);r.s.dispose();
});
test('接続基盤: チー/ポンの選択と成立を区別し、流局・次局を記録',async()=>{
 const r=rig();r.g=new Game({rules:rulesFor('math1'),players,seed:1});r.s.roundStarted(r.g);let n=0;
 while(r.g.pending()){const q=r.g.pending(),a=q.type==='claim'?(q.pon?{type:'pon'}:q.chi.length?{type:'chi',option:0}:{type:'pass'}):{type:'discard',tile:r.g.drawn??r.g.hands[q.seat].at(-1)};act(r,q.seat,a);assert.ok(++n<1000);}
 const m=applyRoundResult(r.match,r.g.result);r.s.roundSettled(r.g,m);const old=r.g;r.g=new Game({rules:rulesFor('math1'),players,seed:2,round:2,dealer:dealerOf(m)});r.s.roundStarted(r.g);
 assert.equal(r.s.roundSettled(old,m).ignored,true);const p=r.s.privateRecord();assert.equal(p.rounds.length,2);const es=p.rounds[0].steps.flatMap(s=>s.events);for(const type of ['chi','pon','exhaustive-draw'])assert.ok(es.some(e=>e.type===type));for(const e of es.filter(e=>['chi','pon'].includes(e.type)))assert.equal(new Set(e.tiles).size,3);r.s.leave();await r.s.flush();assert.equal(r.s.privateRecord().status,'aborted');r.s.dispose();
});
test('接続基盤: 拒否/ignored/二重通知は判断を捏造しない',()=>{
 const r=rig();r.s.roundStarted(r.g);const h=r.s.beforeAction(r.g,{seat:0,action:{type:'discard',tile:-1},source:'human'});assert.throws(()=>applyAction(r.g,0,{type:'discard',tile:-1}));assert.equal(r.s.afterAction(h,r.g,{accepted:false}).rejected,true);
 const a=act(r,0,{type:'discard',tile:r.g.drawn});assert.equal(r.s.afterAction(a,r.g,{accepted:true}).ignored,true);assert.equal(r.s.privateRecord().rounds[0].steps.length,1);r.s.dispose();
});
test('接続基盤: capture失敗でも呼出側の成立打牌・RNGを変えず、有効prefixで閉じる',()=>{
 const r=rig('math1',{recorder:{...pf,captureGame(){throw Error('secret capture');}}}),plain=new Game({rules:r.g.rules,players,seed:9});r.s.roundStarted(r.g);const a={type:'discard',tile:r.g.drawn},h=r.s.beforeAction(r.g,{seat:0,action:a,source:'human'});assert.equal(h,null);applyAction(r.g,0,a);applyAction(plain,0,a);r.s.afterAction(h,r.g,{accepted:true});
 assert.deepEqual(pf.captureGame(r.g),pf.captureGame(plain));assert.equal(r.g.rng.next(),plain.rng.next());assert.equal(r.s.privateRecord().status,'aborted');assert.equal(r.s.privateRecord().termination.reason,'recording-error');assert.equal(JSON.stringify(r.s.status()).includes('secret'),false);r.s.dispose();
});
test('接続基盤: append/精算観測の失敗でゲーム結果を巻き戻さない',()=>{
 for(const fault of ['appendDecision','settleRound']){const r=fixed('math1',[H,...O],['=1']);const s=createPaifuSession({id:'fault',rules:r.g.rules,players,match:r.match,origin:'fixture'},{store:memoryStore(),recorder:{...pf,[fault](){throw Error('private payload');}}});r.s.dispose();r.s=s;s.roundStarted(r.g,{setup:'snapshot'});
  const h=s.beforeAction(r.g,{seat:0,action:{type:'tsumo'},source:'human'});applyAction(r.g,0,{type:'tsumo'});s.afterAction(h,r.g,{accepted:true});const m=applyRoundResult(r.match,r.g.result);s.roundSettled(r.g,m);assert.equal(r.g.result.type,'win');assert.equal(m.scores.reduce((a,b)=>a+b),400);assert.equal(s.status().phase,'failed');assert.notEqual(s.privateRecord().status,'complete');s.dispose();}
});
test('接続基盤: 30秒tickは保存要求だけ。全判断は間引かない',async()=>{
 const r=rig();r.s.roundStarted(r.g);await r.s.flush();act(r,0,{type:'discard',tile:r.g.drawn});r.time(29999);r.s.tick();assert.equal(r.tasks.size,0);r.time(30000);r.s.tick();assert.equal(r.tasks.size,1);await r.s.flush();assert.equal(r.store.calls.length,2);assert.equal(r.store.calls.at(-1).p.rounds[0].steps.length,1);r.s.dispose();
});
test('接続基盤: in-flight1件＋最新snapshotだけ。成功時の追送にも全判断を含む',async()=>{
 const store=memoryStore(),releases=[],base=store.save;store.save=(...args)=>new Promise(resolve=>releases.push(async()=>resolve(await base(...args))));const r=rig('math1',{store});r.s.roundStarted(r.g);let firstDone=false,secondDone=false;const first=r.s.flush().then(x=>{firstDone=true;return x;});await micro();act(r,0,{type:'discard',tile:r.g.drawn});r.s.checkpoint();const second=r.s.flush().then(x=>{secondDone=true;return x;});assert.equal(releases.length,1);await releases.shift()();await micro();assert.equal(firstDone,true);assert.equal(secondDone,false);assert.equal(releases.length,1);await releases.shift()();await Promise.all([first,second]);assert.equal(store.calls.length,2);assert.equal(store.calls[1].p.rounds[0].steps.length,1);r.s.dispose();
});
for(const code of ['queue-full','quota-exceeded','unavailable','timeout','capacity-exceeded'])test(`接続基盤: ${code}で自動retryせず、明示retryだけ再開`,async()=>{
 const store=memoryStore(),save=store.save;let count=0;store.save=(...args)=>++count===1?Promise.resolve({ok:false,error:{code,retryable:code!=='capacity-exceeded'}}):save(...args);const r=rig('math1',{store});r.s.roundStarted(r.g);error(await r.s.flush(),code);act(r,0,{type:'discard',tile:r.g.drawn});r.time(90000);r.s.tick();assert.equal(count,1);assert.equal(r.tasks.size,0);r.s.retrySaving();assert.equal((await r.s.flush()).ok,true);assert.equal(count,2);r.s.dispose();
});
for(const code of ['outcome-unknown','conflict'])test(`接続基盤: ${code}では再照合前のretryを禁止`,async()=>{
 let calls=0;const r=rig('math1',{store:{save:async()=>{calls++;return {ok:false,error:{code,retryable:true}};}}});r.s.roundStarted(r.g);error(await r.s.flush(),code);error(r.s.retrySaving(),'reconciliation-required');act(r,0,{type:'discard',tile:r.g.drawn});r.s.leave();assert.equal(calls,1);r.s.dispose();
});
test('接続基盤: 保存のthrow/不正ackも不確定として停止し未処理rejectを出さない',async()=>{
 for(const save of [()=>{throw Error('secret');},async()=>({ok:true,metadata:{id:'wrong',token:'bad'}})]){const r=rig('math1',{store:{save}});r.s.roundStarted(r.g);error(await r.s.flush(),'outcome-unknown');assert.equal(r.s.status().savedVersion,0);r.s.dispose();}
});
test('接続基盤: 手動削除barrier後は新規書込せず、同じ記録を復活させない',async()=>{
 const r=rig();r.s.roundStarted(r.g);await r.s.flush();const stopped=await r.s.stopSaving();assert.equal(stopped.stopped,true);r.store.rows.delete('session');act(r,0,{type:'discard',tile:r.g.drawn});r.s.leave();error(r.s.retrySaving(),'closed');error(await r.s.flush(),'closed');assert.equal(r.store.calls.length,1);assert.equal(r.store.rows.size,0);r.s.dispose();
});
test('接続基盤: 途中退出はaborted、ページcheckpointはrecording。完走と偽らない',async()=>{
 const r=rig();r.s.roundStarted(r.g);await r.s.flush();assert.equal(r.s.status().savedStatus,'recording');r.s.leave();await r.s.flush();assert.equal(r.s.status().savedStatus,'aborted');assert.equal(r.s.privateRecord().final,null);assert.equal(r.s.leave().ignored,true);r.s.dispose();
});
test('接続基盤: 行動数/局数上限では記録だけ停止し、未完成をcompleteにしない',()=>{
 const r=rig('math1',{maxDecisions:1});r.s.roundStarted(r.g);act(r,0,{type:'discard',tile:r.g.drawn});const q=r.g.pending(),a=q.type==='claim'?{type:'pass'}:{type:'discard',tile:r.g.drawn};const h=r.s.beforeAction(r.g,{seat:q.seat,action:a,source:players[q.seat].kind});assert.equal(h,null);applyAction(r.g,q.seat,a);r.s.afterAction(h,r.g,{accepted:true});assert.equal(r.s.status().phase,'failed');assert.equal(r.s.privateRecord().status,'aborted');r.s.dispose();
});
test('接続基盤: 故障scheduler/clock/設定は呼出側へ例外を波及させない',async()=>{
 for(const options of [{schedule(){throw Error('scheduler');}},{now(){throw Error('clock');}},{intervalMs:0}]){const r=rig('math1',options);assert.doesNotThrow(()=>r.s.roundStarted(r.g));const result=await r.s.flush();assert.equal(result.ok,false);r.s.dispose();}
});
test('接続基盤: after通知の上書きパラメータで実際と違うaction/afterを記録しない',()=>{
 const r=rig();r.s.roundStarted(r.g);const a={type:'discard',tile:r.g.drawn},h=r.s.beforeAction(r.g,{seat:0,action:a,source:'human'});applyAction(r.g,0,a);error(r.s.afterAction(h,r.g,{accepted:true,action:{type:'pass'}}),'recording-error');assert.equal(r.s.privateRecord().rounds[0].steps.length,0);r.s.dispose();
});
for(const mode of ['math1','math2'])for(const length of [4,8])test(`接続基盤 ${mode}×${length}: AI12人の判断・状態・RNG・精算が非記録と一致`,async()=>{
 const roster=Object.values(CHARACTER_ROSTER).flat(),offset=(mode==='math1'?0:6)+(length===8?3:0),who=Array.from({length:4},(_,i)=>({...roster[(offset+i)%roster.length],kind:'ai'})),ids=who.map(p=>p.id);let match=createMatch({length}),history=newPublicHistory(),round=1;
 const store=memoryStore(),s=createPaifuSession({id:`live-${mode}-${length}`,rules:rulesFor(mode),players:who,match,seedBase:107},{store});
 while(!match.over){const seed=107+round*7919,g=new Game({rules:rulesFor(mode),seed,players:who,dealer:dealerOf(match),round}),plain=new Game({rules:g.rules,seed,players:who,dealer:g.dealer,round}),rng=createRng(seed^0x5bd1e995),plainRng=createRng(seed^0x5bd1e995),info={scores:match.scores.slice(),hand:match.hand,length,renchan:match.renchan,dealer:g.dealer,publicHistory:history};assert.equal(s.roundStarted(g).ok,true);let actions=0;
  while(g.pending()){const q=g.pending(),a=decideCharacter(g,q.seat,ids[q.seat],rng,info,ids),b=decideCharacter(plain,q.seat,ids[q.seat],plainRng,info,ids);assert.deepEqual(a,b);const h=s.beforeAction(g,{seat:q.seat,action:a,source:'ai'});applyAction(g,q.seat,a);assert.equal(s.afterAction(h,g,{accepted:true}).ok,true);applyAction(plain,q.seat,b);assert.deepEqual(pf.captureGame(g),pf.captureGame(plain));assert.ok(++actions<1000);}
  assert.equal(rng.next(),plainRng.next());assert.equal(g.rng.next(),plain.rng.next());match=applyRoundResult(match,g.result);assert.equal(s.roundSettled(g,match).ok,true);history=recordPublicRound(history,g.events,g.riichi);assert.equal(match.scores.reduce((a,b)=>a+b),400);assert.ok(++round<80);
 }
 s.leave();assert.equal((await s.flush()).ok,true);assert.equal(s.privateRecord().status,'complete');assert.deepEqual(s.privateRecord().final.scores,match.scores);pf.decodePaifu(pf.encodePaifu(s.privateRecord()));s.dispose();
});

test('接続基盤: ロン可能時のauto-pass誤ラベルを検出し、通常の手動見送りと区別',()=>{
 const r=fixed('math1',[H,O[0],H,O[2]]);act(r,0,{type:'discard',tile:r.g.drawn});passes(r);act(r,1,{type:'discard',tile:r.g.drawn});act(r,2,{type:'pass'});assert.equal(r.g.pending().seat,0);assert.ok(r.g.pending().ron);assert.equal(r.s.beforeAction(r.g,{seat:0,action:{type:'pass'},source:'auto-pass'}),null);assert.equal(r.s.status().phase,'failed');assert.equal(r.s.privateRecord().status,'aborted');r.s.dispose();
});
test('接続基盤: 実際のチーのみ宣言をauto-passとして保存',()=>{
 const r=rig();r.g=new Game({rules:rulesFor('math1'),players,seed:1});r.s.roundStarted(r.g);let found=false;
 for(let n=0;n<1000&&r.g.pending();n++){const q=r.g.pending();if(q.type==='claim'&&q.seat===0&&!q.ron&&(q.chi.length||q.pon)){act(r,0,{type:'pass'},'auto-pass');found=true;break;}act(r,q.seat,q.type==='claim'?{type:'pass'}:{type:'discard',tile:r.g.drawn});}
 assert.equal(found,true);assert.equal(r.s.privateRecord().rounds[0].steps.at(-1).source,'auto-pass');pf.verifyPaifu(r.s.privateRecord());r.s.dispose();
});

test('接続基盤: 次局の記録上限でもGameの新局を変更せずprefixだけ終了',()=>{
 const r=rig('math1',{maxRounds:1,config:{origin:'fixture'}});r.g=makeGame({hands:[H,...O],draws:['=1'],r:r.g.rules,players});r.s.roundStarted(r.g,{setup:'snapshot'});act(r,0,{type:'tsumo'});const m=applyRoundResult(r.match,r.g.result);r.s.roundSettled(r.g,m);const next=new Game({rules:r.g.rules,seed:2,round:2,dealer:dealerOf(m),players}),before=pf.captureGame(next);error(r.s.roundStarted(next),'recording-error');assert.deepEqual(pf.captureGame(next),before);assert.equal(r.s.privateRecord().status,'aborted');r.s.dispose();
});

test('接続基盤: 手動削除barrierはin-flight終了を待ち、待機snapshotを追送しない',async()=>{
 const store=memoryStore(),save=store.save;let release;store.save=(...a)=>new Promise(r=>release=async()=>r(await save(...a)));const r=rig('math1',{store});r.s.roundStarted(r.g);const saving=r.s.flush();await micro();act(r,0,{type:'discard',tile:r.g.drawn});r.s.checkpoint();let ended=false;const stopped=r.s.stopSaving().then(x=>{ended=true;return x;});await micro();assert.equal(ended,false);await release();await Promise.all([saving,stopped]);assert.equal(ended,true);store.rows.delete('session');assert.equal(store.calls.length,1);assert.equal(r.tasks.size,0);r.s.dispose();
});
test('接続基盤: record-too-largeでも既存ackを捏造せず、メモリの記録だけ終了',async()=>{
 const r=rig('math1',{store:{save:async()=>({ok:false,error:{code:'record-too-large',retryable:false}})}});r.s.roundStarted(r.g);error(await r.s.flush(),'record-too-large');assert.equal(r.s.status().phase,'failed');assert.equal(r.s.status().savedVersion,0);assert.equal(r.s.status().savedStatus,null);assert.equal(r.s.privateRecord().status,'aborted');r.s.dispose();
});
