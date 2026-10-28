import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/engine/rng.js';
import { applyAction } from '../src/engine/ai.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { decideCharacter, CHARACTER_ROSTER, TRIO_ROSTER, rosterForLevel, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { decideCharacter as oldDecision, CHARACTER_ROSTER as oldRoster } from '../src/engine/character-ai.js';
import { TRIO_PARAMS } from '../src/engine/character-ai-trio.js';
import { rulesFor, makeGame, findTile } from './helpers.js';

test('名簿：既存9人と既定3人を維持。追加3人は強さ・年齢を捏造しない別枠', () => {
  for (const level of ['beginner','intermediate','advanced']) {
    assert.equal(CHARACTER_ROSTER[level], oldRoster[level]); assert.equal(rosterForLevel(level), oldRoster[level]);
  }
  assert.deepEqual(TRIO_ROSTER.map(c => c.id), ['yujin','tara','nocchi']);
  assert.ok(TRIO_ROSTER.every(c => c.age === null));
  assert.equal(Object.values(CHARACTER_ROSTER).flat().length, 12);
  assert.deepEqual(TRIO_PARAMS, { yujin:{tripletWeight:4,formulaWeight:.25},tara:{minLive:6,maxDelay:2,minWall:24},nocchi:{defense:1.5,ownBase:2.5,opponentBase:3} });
});
test('公開履歴：入力は不変、鳴き・全体6ツモ番以内のリーチのみ集計。新試合では全て0', () => {
  const a = newPublicHistory(), before = structuredClone(a);
  const b = recordPublicRound(a, [{type:'draw',seat:0},{type:'discard',seat:0,tile:99},{type:'chi',seat:2},{type:'pon',seat:2},{type:'riichi',seat:0},{type:'riichi',seat:1}], [{turn:6},{turn:7},null,null]);
  assert.deepEqual(a,before); assert.deepEqual(b,[{rounds:1,calls:0,earlyRiichi:1},{rounds:1,calls:0,earlyRiichi:0},{rounds:1,calls:2,earlyRiichi:0},{rounds:1,calls:0,earlyRiichi:0}]);
  assert.deepEqual(newPublicHistory(),before); assert.notEqual(newPublicHistory()[0],newPublicHistory()[1]);
});
test('既存9人：実局面で委譲前後の行動と次のRNG値が一致', () => {
  for (const mode of ['math1','math2']) for (let group=0;group<3;group++) {
    const ids=[...Object.values(oldRoster).flat().map(c=>c.id).slice(group*3,group*3+3),'ousuke'];
    const g = new Game({rules:rulesFor(mode),seed:83210+group,dealer:group,players:ids.map(name=>({name,kind:'ai',personality:'speed'}))});
    let n=0;
    while(g.pending()) {
      const p=g.pending(),aRng=createRng(9900+n),bRng=createRng(9900+n),info={scores:[100,100,100,100],hand:0,length:4,dealer:group};
      const a=decideCharacter(g,p.seat,ids[p.seat],aRng,{...info,publicHistory:newPublicHistory()},ids);
      const b=oldDecision(g,p.seat,ids[p.seat],bRng,info,ids);
      assert.deepEqual(a,b);assert.equal(aRng.next(),bRng.next());applyAction(g,p.seat,a);g.checkInvariants();assert.ok(++n<4000);
    }
  }
});
test('採用済み28試合：数学ⅠⅡ×4/8局、混合・同一キャラのイベント・精算・局数が実験データと完全一致', () => {
  const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/trio-adopted-matches.json.gz',import.meta.url))));
  assert.equal(fixture.matches.length,28);
  for(const row of fixture.matches) {
    let m=createMatch({length:row.length}),history=newPublicHistory();
    for(const expected of row.logs) {
      const g=new Game({rules:rulesFor(row.mode),seed:expected.gameSeed,dealer:dealerOf(m),players:row.seats.map(name=>({name,kind:'ai',personality:'speed'}))});
      const rng=createRng((expected.gameSeed^0x5bd1e995)>>>0),info={scores:m.scores.slice(),hand:m.hand,length:m.length,dealer:dealerOf(m),renchan:m.renchan,publicHistory:history};
      let n=0;
      while(g.pending()) {
        const p=g.pending(),id=row.seats[p.seat],a=decideCharacter(g,p.seat,id,rng,info,row.seats);
        if(p.canTsumo)assert.equal(a.type,'tsumo');if(p.ron)assert.equal(a.type,'ron');
        if(id==='yujin')assert.ok(!['chi','pon'].includes(a.type));
        applyAction(g,p.seat,a);g.checkInvariants();assert.ok(++n<4000);
      }
      assert.deepEqual(g.events,expected.events,row.sample);assert.deepEqual(g.result,expected.result,row.sample);
      history=recordPublicRound(history,g.events,g.riichi);m=applyRoundResult(m,g.result);
      assert.deepEqual(m.scores,expected.scores);assert.equal(m.scores.reduce((a,b)=>a+b),400);
    }
    assert.ok(m.over);assert.equal(m.played,row.played);assert.equal(m.renchanTotal,row.renchan);assert.deepEqual(m.scores,row.scores);
  }
});
const H=['sin','30','=1/2','cos','180','=-1','tan','45'];
const O=[['sin','sin','0','90','90','=-√3','=√3','150'],['cos','135','=√3','=-1/√2','120','120','tan','=0'],['=-1','tan','tan','120','=1/√3','90','=-1/√2','=-√3']];
const pass=g=>{while(g.pending()?.type==='claim')g.respond(g.pending().seat,{type:'pass'});};
for(const mode of ['math1','math2']) {
  test(`追加3人 ${mode}：実際のロン・ツモとリーチ後ツモ切りを保護`,()=>{
    for(const id of ['yujin','tara','nocchi']) {
      const create=draws=>makeGame({r:rulesFor(mode),hands:[H,...O],draws});
      const g=create(['0','=1']);g.discard(0,findTile(g,0,'0'));pass(g);g.discard(1,g.drawn);assert.ok(g.pending().ron);assert.equal(decideCharacter(g,0,id,createRng(1)).type,'ron');
      const t=create(['=1']);assert.ok(t.pending().canTsumo);assert.equal(decideCharacter(t,0,id,createRng(1)).type,'tsumo');
      const h=create(['0','=-1/√3','=-√3/2','=-1/√2','=0']);h.discard(0,findTile(h,0,'0'),{riichi:true});pass(h);for(let s=1;s<4;s++){h.discard(s,h.drawn);pass(h);}
      assert.deepEqual(decideCharacter(h,0,id,createRng(1)),{type:'discard',tile:h.drawn});
    }
  });
  test(`追加3人 ${mode}：他家の手牌・山順を変えても行動不変。たらの同じGameの状態は最大2巡で復旧`,()=>{
    for(const id of ['yujin','tara','nocchi']) {
      const create=()=>makeGame({r:rulesFor(mode),hands:[H,...O],draws:['0']});const a=create(),b=create();
      [b.hands[1][0],b.hands[2][0]]=[b.hands[2][0],b.hands[1][0]];b.wall.reverse();
      assert.deepEqual(decideCharacter(a,0,id,createRng(11)),decideCharacter(b,0,id,createRng(11)));
    }
    const g=makeGame({r:rulesFor(mode),hands:[H,...O],draws:['0','=-1/√3','=-√3/2','=-1/√2','0','=-1/√3','=-√3/2','=-1/√2','0']});const flags=[];
    for(let k=0;k<3;k++){const a=decideCharacter(g,0,'tara',createRng(1));flags.push(a.riichi);applyAction(g,0,a);pass(g);if(k<2)for(let s=1;s<4;s++){g.discard(s,g.drawn);pass(g);}}
    assert.deepEqual(flags,[false,false,true]);g.checkInvariants();
  });
}
