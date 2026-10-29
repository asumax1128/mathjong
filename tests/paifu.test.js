import test from 'node:test';
import assert from 'node:assert/strict';
import { captureGame, createPaifu, beginRound, appendDecision, settleRound, endRecording,
  verifyPaifu, replayPrivateRound, encodePaifu, decodePaifu, PaifuError, PAIFU_MAX_BYTES } from '../src/engine/paifu.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { createMatch, matchAt, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { CHARACTER_ROSTER, decideCharacter, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { rulesFor, makeGame, findTile } from './helpers.js';

const ids = ['kanata','tara','nocchi','yujin'];
const players = ids.map(id => ({id,name:id,kind:'ai',personality:'speed'}));
const H = ['sin','30','=1/2','cos','180','=-1','tan','45'];
const O = [['sin','sin','0','90','90','=-√3','=√3','150'],
  ['cos','135','=√3','=-1/√2','120','120','tan','=0'],['=-1','tan','tan','120','=1/√3','90','=-1/√2','=-√3']];
const json = x => JSON.parse(JSON.stringify(x));
function fixture(mode, hands, draws, {dealer=0, match=createMatch({startDealer:dealer}), human=false}={}) {
  const who=human?players.map((p,i)=>i?{...p}:{name:'あなた',kind:'human'}):players;
  const g=makeGame({r:rulesFor(mode),hands,draws,dealer,players:who});
  const p=beginRound(createPaifu({id:'fixture',rules:g.rules,players:who,match,origin:'fixture'}),g,{setup:'snapshot'});
  return {g,p,match};
}
function act(s, seat, action, opts={}) {
  const before=captureGame(s.g), old=s.p, bytes=JSON.stringify(old);
  applyAction(s.g,seat,action);
  const t=performance.now();
  s.p=appendDecision(s.p,{before,after:captureGame(s.g),seat,action,...opts});
  if(s.timings)s.timings.push(performance.now()-t);
  assert.equal(JSON.stringify(old),bytes,'previous record is immutable');
}
function pass(s) { while(s.g.pending()?.type==='claim') act(s,s.g.pending().seat,{type:'pass'}); }
function finish(s, opts={}) { s.match=applyRoundResult(s.match,s.g.result,opts);s.p=settleRound(s.p,s.match,{maxRound:opts.maxRound??null}); }
function assertReplay(s) {
  const p=decodePaifu(encodePaifu(s.p));
  assert.deepEqual(captureGame(replayPrivateRound(p,0)),captureGame(s.g));
  assert.equal(verifyPaifu(p).decisions,s.p.rounds[0].steps.length);
  return p;
}

for (const mode of ['math1','math2']) {
  test(`牌譜 ${mode}: リーチ→ロン見送り→ツモ和了。初期と全行動の前後を復元`,()=>{
    const s=fixture(mode,[H,...O],['0','=1','=-1/√3','=-√3/2','=1']);
    const expected=[captureGame(s.g)];
    act(s,0,{type:'discard',tile:findTile(s.g,0,'0'),riichi:true});expected.push(captureGame(s.g));
    pass(s);
    act(s,1,{type:'discard',tile:s.g.drawn});
    assert.equal(s.g.pending().seat,0);assert.equal(s.g.pending().ron,true);
    act(s,0,{type:'pass'});pass(s);
    for(const seat of [2,3]){act(s,seat,{type:'discard',tile:s.g.drawn});pass(s);}
    assert.ok(s.g.pending().canTsumo);act(s,0,{type:'tsumo'});finish(s);
    const p=assertReplay(s),r=p.rounds[0];
    assert.deepEqual(captureGame(replayPrivateRound(p,0,0)),expected[0]);
    assert.deepEqual(captureGame(replayPrivateRound(p,0,1)),expected[1]);
    const actions=r.steps.map(x=>x.action.type);
    assert.ok(actions.includes('pass') && actions.includes('tsumo'));
    const ri=r.steps[0].events;
    assert.deepEqual(ri.map(x=>x.type).slice(0,2),['riichi','discard']);
    assert.equal(ri[0].tile,r.steps[0].action.tile);
    assert.equal(s.g.result.analysis.riichiBonus,1);
    assert.equal(r.settlement.deltas.reduce((a,b)=>a+b,0),0);
    assert.equal(r.settlement.afterScores.reduce((a,b)=>a+b,0),400);
  });
  test(`牌譜 ${mode}: ロンの和了牌と役満・精算を保存`,()=>{
    const hands=[['0','30','45','60','90','120','135','150'],...O];
    const s=fixture(mode,hands,['=-√3/2','180']);
    act(s,0,{type:'discard',tile:s.g.drawn,riichi:true});pass(s);
    act(s,1,{type:'discard',tile:s.g.drawn});
    while(s.g.pending().seat!==0)act(s,s.g.pending().seat,{type:'pass'});
    assert.ok(s.g.pending().ron);act(s,0,{type:'ron'});finish(s);
    const p=assertReplay(s),w=p.rounds[0].steps.at(-1).events.at(-1);
    assert.equal(w.type,'win');assert.equal(w.tile,s.g.result.tile);
    assert.equal(w.result.analysis.yakuman,true);assert.equal(w.result.points,16);
    assert.equal(w.result.analysis.riichi,true);assert.equal(w.result.analysis.riichiBonus,0);
    assert.deepEqual(p.rounds[0].settlement.deltas,[96,-96,0,0]);
  });
  test(`牌譜 ${mode}: ポン→チーの物理牌3枚、鳴き後打牌、流局まで全チェックポイント`,()=>{
    const s=fixture(mode,[['=1/2','=1/2','sin','30','0','0','135','=-√3'],...O],['45','=-1/√3','=-√3/2','=-1/√2']);
    // Use a fresh seeded game and only legal claims/discards to exercise all seats and long rivers.
    const g=new Game({rules:rulesFor(mode),seed:1,dealer:0,players});
    s.g=g;s.p=beginRound(createPaifu({id:'calls',rules:g.rules,players,match:s.match}),g);
    const snapshots=[captureGame(g)];let n=0;
    while(g.pending()) {
      const q=g.pending(),a=q.type==='claim'?(q.pon?{type:'pon'}:q.chi.length?{type:'chi',option:0}:{type:'pass'}):{type:'discard',tile:g.drawn??g.hands[q.seat].at(-1)};
      act(s,q.seat,a);snapshots.push(captureGame(g));assert.ok(++n<1000);
    }
    finish(s);const p=assertReplay(s),r=p.rounds[0],types=r.steps.flatMap(x=>x.events.map(e=>e.type));
    assert.ok(types.includes('chi'));assert.ok(types.includes('pon'));assert.ok(types.includes('exhaustive-draw'));
    for(const step of r.steps)for(const e of step.events)if(['chi','pon'].includes(e.type)) {
      const m=step.state.melds[e.engine.seat].find(m=>m.claimed===e.tile);
      assert.deepEqual(e.tiles,m.tiles);assert.equal(new Set(e.tiles).size,3);
      assert.equal(step.state.justDrew,false);assert.equal(step.state.drawn,null);
    }
    // Every decision boundary, including passes with no emitted engine event, must be reproducible.
    for(let i=0;i<snapshots.length;i++)assert.deepEqual(captureGame(replayPrivateRound(p,0,i)),snapshots[i]);
    assert.deepEqual(r.settlement.deltas,[0,0,0,0]);
  });
}

test('牌譜: ロン見送り後、次のロン判断が残るゼロイベントのパスも保存',()=>{
  const s=fixture('math1',[H,O[0],H,O[2]],['0','=1']);
  act(s,0,{type:'discard',tile:s.g.drawn});pass(s);act(s,1,{type:'discard',tile:s.g.drawn});
  assert.equal(s.g.pending().seat,2);assert.ok(s.g.pending().ron);
  const before=captureGame(s.g);act(s,2,{type:'pass'});
  const a=s.p.rounds[0].steps.at(-1);
  assert.equal(a.action.type,'pass');assert.deepEqual(a.events,[]);
  assert.equal(s.g.events.length,before.events.length);assert.equal(s.g.pending().seat,0);
  assert.notDeepEqual(a.state.claim,before.claim);
  assertReplay(s);
});

test('牌譜: 同じseedでも別の合法な打牌・同じ種類の別物理IDを区別',()=>{
  const g1=new Game({rules:rulesFor('math1'),seed:7920,players}),g2=new Game({rules:g1.rules,seed:g1.seed,players});
  const open=g=>({g,match:createMatch(),p:beginRound(createPaifu({id:'same-seed',rules:g.rules,players,match:createMatch(),seedBase:1}),g)});
  const a=open(g1),b=open(g2),first=g1.hands[0][0],second=g1.hands[0].find(id=>g1.typeOf(id)===g1.typeOf(first)&&id!==first);
  assert.notEqual(second,undefined,'fixture contains duplicate tile type');
  act(a,0,{type:'discard',tile:first});act(b,0,{type:'discard',tile:second});
  assert.notEqual(encodePaifu(a.p),encodePaifu(b.p));
  assertReplay(a);assertReplay(b);
});

test('牌譜: 無効入力・欠落した行動・二重精算・精算前の次局を拒否し元データ不変',()=>{
  const s=fixture('math1',[H,...O],['=1']),original=JSON.stringify(s.p);
  assert.throws(()=>settleRound(s.p,s.match),/not ended/);
  assert.throws(()=>beginRound(s.p,s.g),/not settled/);
  const before=captureGame(s.g);applyAction(s.g,0,{type:'tsumo'});
  assert.throws(()=>appendDecision(s.p,{before,after:captureGame(s.g),seat:0,action:{type:'pass'}}));
  assert.equal(JSON.stringify(s.p),original);
  s.p=appendDecision(s.p,{before,after:captureGame(s.g),seat:0,action:{type:'tsumo'}});
  const wrong=applyRoundResult(s.match,s.g.result);wrong.scores[0]++;
  assert.throws(()=>settleRound(s.p,wrong),/mismatch/);
  finish(s);assert.throws(()=>settleRound(s.p,s.match),/already settled/);
  const t=fixture('math1',[H,...O],['0']);const b=captureGame(t.g);t.g.discard(0,t.g.drawn);
  while(t.g.pending()?.type==='claim')t.g.respond(t.g.pending().seat,{type:'pass'});
  if(t.g.pending()?.seat===1)t.g.discard(1,t.g.drawn);
  assert.throws(()=>appendDecision(t.p,{before:b,after:captureGame(t.g),seat:0,action:{type:'discard',tile:b.drawn}}),/step.after/);
});

test('牌譜: 記録処理がlive Game・入力配列・RNG・ルール・AI viewに影響しない',()=>{
  const rules=rulesFor('math2'),a=new Game({rules,seed:901,players}),b=new Game({rules,seed:901,players});
  const old=captureGame(a),view=a.viewFor(0),config=json(rules.config),who=json(players);
  const p=beginRound(createPaifu({id:'read-only',rules,players,match:createMatch()}),a);
  verifyPaifu(p);encodePaifu(p);decodePaifu(encodePaifu(p));replayPrivateRound(p,0);
  assert.deepEqual(captureGame(a),old);assert.deepEqual(a.viewFor(0),view);
  assert.equal(a.rng.next(),b.rng.next());assert.deepEqual(rules.config,config);assert.deepEqual(players,who);
  assert.ok(Object.isFrozen(p.rounds[0].initial.hands[0]));
  assert.throws(()=>p.rounds[0].initial.hands[0].push(999),TypeError);
  assert.equal('paifu' in a.viewFor(0),false);
});

test('牌譜: チーのみの自動パスの主体を保持、AI/人間の名義混同を拒否',()=>{
  const s=fixture('math1',[['sin','30','cos','cos','180','180','=√3','=√3'],...O],
    ['=-1/√3','=-√3/2','=-√3/2','=1/2'],{human:true});
  for(const seat of [0,1,2]){act(s,seat,{type:'discard',tile:s.g.drawn});pass(s);}
  act(s,3,{type:'discard',tile:s.g.drawn});
  assert.equal(s.g.pending().seat,0);assert.equal(s.g.pending().ron,false);assert.ok(s.g.pending().chi.length>0);
  const before=captureGame(s.g);s.g.respond(0,{type:'pass'});const after=captureGame(s.g);
  assert.throws(()=>appendDecision(s.p,{before,after,seat:0,action:{type:'pass'},source:'ai'}),/source/);
  s.p=appendDecision(s.p,{before,after,seat:0,action:{type:'pass'},source:'auto-pass'});
  assert.equal(s.p.rounds[0].steps.at(-1).source,'auto-pass');assertReplay(s);
});

test('牌譜: 途中退出は流局・精算を捏造せず、有効な途中記録として復元できる',()=>{
  const s=fixture('math1',[H,...O],['0']);act(s,0,{type:'discard',tile:s.g.drawn});
  const p=endRecording(s.p,{reason:'left-match',atMs:100});
  assert.equal(p.status,'aborted');assert.equal(p.rounds[0].settlement,null);assert.equal(p.final,null);
  assert.equal(decodePaifu(encodePaifu(p)).termination.reason,'left-match');
  assert.throws(()=>beginRound(p,s.g),/not recording/);
  assert.throws(()=>endRecording(p,{reason:'reset'}),/not recording/);
});

test('牌譜: 未計測時刻はnull、行動順が正本。nullを挟む時刻逆転も拒否',()=>{
  const s=fixture('math1',[H,...O],['0']);
  act(s,0,{type:'discard',tile:s.g.drawn},{atMs:20});
  const old=s.p,before=captureGame(s.g),q=s.g.pending();
  const action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:s.g.drawn};applyAction(s.g,q.seat,action);
  assert.throws(()=>appendDecision(old,{before,after:captureGame(s.g),seat:q.seat,action,atMs:19}),/time/);
  s.p=appendDecision(old,{before,after:captureGame(s.g),seat:q.seat,action,atMs:null});
  const bad=json(s.p);bad.rounds[0].steps.at(-1).atMs=19;assert.throws(()=>verifyPaifu(bad),/time/);
  assertReplay(s);
});

test('牌譜: 未知版・不正JSON・危険キー・NaN・深すぎる構造・サイズ超過を明示拒否',()=>{
  const s=fixture('math1',[H,...O],['0']);
  for(const key of ['schemaVersion','engineVersion','ruleVersion']){
    const bad=json(s.p);bad[key]='future';assert.throws(()=>decodePaifu(JSON.stringify(bad)),PaifuError);
  }
  for(const raw of ['', '{', 'null','[]','{"__proto__":{"polluted":true}}'])assert.throws(()=>decodePaifu(raw),PaifuError);
  const bad=json(s.p);bad.createdAt='2026-99-99T00:00:00.000Z';assert.throws(()=>verifyPaifu(bad),PaifuError);
  assert.throws(()=>encodePaifu({...s.p,createdAt:NaN}),PaifuError);
  assert.throws(()=>decodePaifu(' '.repeat(PAIFU_MAX_BYTES+1)),/byte limit/);
  assert.throws(()=>decodePaifu('['.repeat(66)+'0'+']'.repeat(66)),/structure limit/);
  assert.equal({}.polluted,undefined);
});

test('牌譜: 物理牌・山順・ツモ牌・行動・パス・和了点・精算の改変を検出',()=>{
  const s=fixture('math1',[H,...O],['=1']);act(s,0,{type:'tsumo'});finish(s);
  const mutations=[p=>{p.rounds[0].initial.hands[0][0]=p.rounds[0].initial.hands[0][1];},
    p=>{p.rounds[0].initialEvents[0].tile++;},p=>{p.rounds[0].steps[0].action={type:'pass'};},
    p=>{p.rounds[0].steps[0].events[0].tile++;},p=>{p.rounds[0].steps[0].state.result.points++;},
    p=>{p.rounds[0].settlement.deltas[0]++;},p=>{p.rounds[0].steps=[];},p=>{p.rounds[0].id='different';}];
  for(const change of mutations){const bad=json(s.p);change(bad);assert.throws(()=>decodePaifu(JSON.stringify(bad)),PaifuError);}
  const g=new Game({rules:rulesFor('math1'),seed:100,players});
  const p=beginRound(createPaifu({id:'seed',rules:g.rules,players,match:createMatch()}),g),bad=json(p);
  bad.rounds[0].initial.wall.reverse();assert.throws(()=>verifyPaifu(bad),/seed/);
});

for(const mode of ['math1','math2'])for(const length of [4,8]) {
  test(`牌譜 ${mode}×${length}局: 12人AIの実判断で完走し、非記録対局と全行動・RNG・精算が一致`,()=>{
    const roster=Object.values(CHARACTER_ROSTER).flat();
    let match=createMatch({length}),history=newPublicHistory(),p;
    let number=1;const timings=[];
    // Rotate the roster across modes/lengths: all twelve IDs appear in the four configurations.
    const offset=(mode==='math1'?0:6)+(length===8?3:0),seatIds=Array.from({length:4},(_,i)=>roster[(offset+i)%roster.length].id);
    const who=seatIds.map(id=>({...roster.find(x=>x.id===id),kind:'ai'}));
    p=createPaifu({id:`${mode}-${length}`,rules:rulesFor(mode),players:who,match,seedBase:107});
    while(!match.over){
      const seed=107+number*7919,g=new Game({rules:rulesFor(mode),seed,dealer:dealerOf(match),round:number,players:who});
      const plain=new Game({rules:g.rules,seed,dealer:g.dealer,round:number,players:who});
      const rng=createRng(seed^0x5bd1e995),plainRng=createRng(seed^0x5bd1e995);
      const info={scores:match.scores.slice(),hand:match.hand,length,renchan:match.renchan,dealer:g.dealer,publicHistory:history};
      p=beginRound(p,g);const session={g,p,match,timings:[]};let n=0;
      while(g.pending()){
        const q=g.pending(),a=decideCharacter(g,q.seat,seatIds[q.seat],rng,info,seatIds);
        const expected=decideCharacter(plain,q.seat,seatIds[q.seat],plainRng,info,seatIds);
        assert.deepEqual(a,expected);act(session,q.seat,a);applyAction(plain,q.seat,expected);
        assert.deepEqual(captureGame(g),captureGame(plain));assert.ok(++n<1000);
      }
      assert.equal(rng.next(),plainRng.next());finish(session,{round:number,maxRound:1000000});
      timings.push(...session.timings);p=session.p;match=session.match;history=recordPublicRound(history,g.events,g.riichi);number++;
      assert.ok(number<80);assert.equal(match.scores.reduce((a,b)=>a+b,0),400);
    }
    const encoded=encodePaifu(p),result=verifyPaifu(decodePaifu(encoded));assert.equal(result.status,'complete');
    timings.sort((a,b)=>a-b);console.log('PAIFU_METRIC '+JSON.stringify({mode,length,played:match.played,decisions:result.decisions,bytes:new TextEncoder().encode(encoded).length,appendP95Ms:timings[Math.floor(timings.length*.95)],appendMaxMs:timings.at(-1)}));
    assert.deepEqual(p.final.scores,match.scores);assert.deepEqual(p.final.wins,match.wins);
    assert.throws(()=>beginRound(p,new Game({rules:rulesFor(mode),seed:1,players:who})),/not recording/);
  });
}

test('牌譜: 最終親の連荘による上限終了と、最終子和了の通常終了を区別',()=>{
  for(const [length,hand,winner,reason] of [[4,0,0,'round-limit'],[8,7,1,'normal']]){
    const dealer=0,match=matchAt({length,hand,renchan:100,startDealer:(4-hand%4)%4});
    const hands=winner===0?[H,...O]:[O[0],H,O[1],O[2]];
    const s=fixture('math1',hands,winner===0?['=1']:['=-√3/2','=1'],{dealer,match});
    s.g.round=1000000;
    s.p=beginRound(createPaifu({id:'boundary',rules:s.g.rules,players,match,firstRound:1000000,origin:'fixture'}),s.g,{setup:'snapshot'});
    if(winner===1){act(s,0,{type:'discard',tile:s.g.drawn});pass(s);}
    assert.equal(s.g.pending().seat,winner);assert.ok(s.g.pending().canTsumo);
    act(s,winner,{type:'tsumo'});finish(s,{round:1000000,maxRound:1000000});
    assert.equal(s.p.final.endReason,reason);assert.equal(s.p.status,'complete');assertReplay(s);
  }
});

test('牌譜: 親4席×和了4席・全放銃席の実和了を精算し、独立した支払期待値に一致',()=>{
  const fill=['=-1/√3','=-√3/2','=-1/√2'];
  for(let dealer=0;dealer<4;dealer++)for(let winner=0;winner<4;winner++)for(const how of ['tsumo','ron']){
    for(const from of how==='ron'?[0,1,2,3].filter(s=>s!==winner):[null]){
      const target=how==='ron'?from:winner,distance=(target-dealer+4)%4;
      const hands=Array(4);hands[winner]=H;let j=0;for(let s=0;s<4;s++)if(s!==winner)hands[s]=O[j++];
      const s=fixture('math1',hands,[...fill.slice(0,distance),'=1'],{dealer});
      for(let i=0;i<distance;i++){const q=s.g.pending();act(s,q.seat,{type:'discard',tile:s.g.drawn});pass(s);}
      assert.equal(s.g.pending().seat,target);
      if(how==='ron'){
        act(s,from,{type:'discard',tile:s.g.drawn});
        while(s.g.pending().seat!==winner)act(s,s.g.pending().seat,{type:'pass'});
        assert.ok(s.g.pending().ron);act(s,winner,{type:'ron'});
      }else{assert.ok(s.g.pending().canTsumo);act(s,winner,{type:'tsumo'});}
      assert.equal(s.g.result.points,2);
      finish(s);const delta=[0,0,0,0];
      if(how==='ron'){delta[winner]=winner===dealer?12:8;delta[from]=-delta[winner];}
      else if(winner===dealer){delta.fill(-4);delta[winner]=12;}
      else{delta.fill(-2);delta[dealer]=-4;delta[winner]=8;}
      assert.deepEqual(s.p.rounds[0].settlement.deltas,delta,JSON.stringify({dealer,winner,how,from}));
      assertReplay(s);
    }
  }
});

for(const resolution of ['ron','pon','chi'])test(`牌譜: 保留されたチー→ポン→${resolution}の選択と成立を分離`,()=>{
  const hands=[['=1/2','0','0','270','270','=-√3','tan','360'],
    ['sin','30','cos','tan','225','315','=√3','=-1/√3'],
    ['=1/2','=1/2','90','90','=-√3/2','=-1/√2','tan','210'],
    ['cos','180','=-1','tan','45','=1','sin','150']];
  const s=fixture('math2',hands,['=-√3/2']);
  act(s,0,{type:'discard',tile:findTile(s.g,0,'=1/2')});
  assert.equal(s.g.pending().seat,1);act(s,1,{type:'chi',option:0});
  assert.equal(s.g.pending().seat,2);assert.deepEqual(s.p.rounds[0].steps.at(-1).events,[]);
  act(s,2,{type:resolution==='chi'?'pass':'pon'});
  assert.equal(s.g.pending().seat,3);assert.deepEqual(s.p.rounds[0].steps.at(-1).events,[]);
  act(s,3,{type:resolution==='ron'?'ron':'pass'});
  const steps=s.p.rounds[0].steps;
  assert.deepEqual(steps.map(x=>x.action.type),['discard','chi',resolution==='chi'?'pass':'pon',resolution==='ron'?'ron':'pass']);
  assert.deepEqual(steps.flatMap(x=>x.events.map(e=>e.type)),['discard',resolution==='ron'?'win':resolution]);
  assert.equal(s.g.melds[1].length,resolution==='chi'?1:0);
  assert.equal(s.g.melds[2].length,resolution==='pon'?1:0);
  assertReplay(s);
});

test('牌譜: 既存再現URLの高い局番号・親・山を同じ値のまま記録',async()=>{
  const {validateReplay,replayQuery}=await import('../src/ui/replay.js');
  for(const mode of ['math1','math2'])for(const [round,hand,renchan,len] of [[1000,2,100,4],[1000000,7,499999,8]]){
    const seed=999999999,dealer=3,q=replayQuery({seed,round,hand,renchan,len,dealer,mode,chars:['kanata','tara','nocchi']});
    const v=validateReplay(new URLSearchParams(q));assert.equal(v.ok,true);
    const match=matchAt({length:len,hand,renchan,startDealer:(dealer-hand%4+4)%4});
    const g=new Game({rules:rulesFor(mode),seed:seed+round*7919,round,dealer,players});
    const p=beginRound(createPaifu({id:'from-url',rules:g.rules,players,match,seedBase:seed,firstRound:round,origin:'replay-url'}),g);
    const restored=replayPrivateRound(decodePaifu(encodePaifu(p)),0);
    assert.deepEqual(captureGame(restored),captureGame(g));
    assert.deepEqual(p.initialMatch.scores,[100,100,100,100]);assert.equal(p.initialMatch.renchan,renchan);
  }
});

test('牌譜: 退出・再戦は独立した記録。古い局を新しい試合へ追加できない',()=>{
  const a=fixture('math1',[H,...O],['0']),b=fixture('math1',[H,...O],['0']);
  a.p=endRecording(a.p,{reason:'reset'});
  const before=captureGame(b.g);b.g.discard(0,b.g.drawn);
  assert.throws(()=>appendDecision(a.p,{before,after:captureGame(b.g),seat:0,action:{type:'discard',tile:before.drawn}}),/not recording/);
  b.p=appendDecision(b.p,{before,after:captureGame(b.g),seat:0,action:{type:'discard',tile:before.drawn}});
  assert.equal(a.p.rounds[0].steps.length,0);assert.equal(b.p.rounds[0].steps.length,1);
  assert.equal(verifyPaifu(a.p).status,'aborted');assert.equal(verifyPaifu(b.p).status,'recording');
});

test('牌譜: 復元Gameのルール変更や継続操作で元記録・評価キャッシュを汚染しない',()=>{
  const s=fixture('math1',[H,...O],['0']);const encoded=encodePaifu(s.p);
  const replay=replayPrivateRound(s.p,0);
  replay.discard(0,replay.drawn);replay.rules.config.scoring.base=999;
  replay.rules.types[0].copies=0;replay.rules.melds.length=0;
  assert.equal(encodePaifu(s.p),encoded);
  assert.deepEqual(captureGame(replayPrivateRound(s.p,0)),captureGame(s.g));
  const shallow=json(s.p);Object.freeze(shallow.settings);
  assert.equal(verifyPaifu(shallow).valid,true);
  shallow.settings.rules.scoring.base=999;
  assert.throws(()=>verifyPaifu(shallow),/settings.rules/);
});

test('牌譜: 通常シャッフル／preset配牌とも復元Gameの未使用RNG状態が元Gameと一致',()=>{
  for(const setup of ['seed','snapshot']){
    const g=setup==='seed'?new Game({rules:rulesFor('math1'),seed:81,players}):makeGame({r:rulesFor('math1'),hands:[H,...O],draws:['0'],players});
    const p=beginRound(createPaifu({id:'rng',rules:g.rules,players,match:createMatch(),origin:setup==='seed'?'match-start':'fixture'}),g,{setup});
    const restored=replayPrivateRound(p,0);
    assert.equal(restored.rng.next(),g.rng.next());
    assert.equal(restored.rng.next(),g.rng.next());
  }
});

test('牌譜: 負点の途中状態からも実和了と400点精算・次局が正常',()=>{
  let match=createMatch();
  match=applyRoundResult(match,{type:'win',winner:1,how:'ron',from:0,points:16});
  match=applyRoundResult(match,{type:'win',winner:1,how:'ron',from:0,points:16});
  assert.ok(match.scores[0]<0);
  const dealer=dealerOf(match),hands=[O[0],H,O[1],O[2]],s=fixture('math1',hands,['=1'],{dealer,match});
  assert.equal(dealer,1);act(s,1,{type:'tsumo'});finish(s);
  assert.equal(s.match.scores.reduce((a,b)=>a+b,0),400);assert.equal(s.match.over,false);
  assertReplay(s);
});

test('牌譜: 不正な席・空の配列要素・壊れたMatchを生成時点で拒否',()=>{
  const rules=rulesFor('math1'),base={id:'bad-metadata',rules,players,match:createMatch()};
  for(const who of [Array(4),[null,...players.slice(1)],[{...players[0],kind:'other'},...players.slice(1)],
    [{...players[0],id:''},...players.slice(1)]])assert.throws(()=>createPaifu({...base,players:who}),PaifuError);
  const match=createMatch();match.wins=Array(4);assert.throws(()=>createPaifu({...base,match}),PaifuError);
  assert.throws(()=>createPaifu({...base,firstRound:0}),PaifuError);
  assert.throws(()=>createPaifu({...base,createdAt:'2026-99-99T00:00:00.000Z'}),PaifuError);
  assert.throws(()=>createPaifu({...base,match:{...createMatch(),hand:4}}),PaifuError);
});
