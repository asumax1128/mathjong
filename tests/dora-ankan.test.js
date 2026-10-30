import test from 'node:test';
import assert from 'node:assert/strict';
import {makeConfig} from '../src/engine/config.js';
import {createRules} from '../src/engine/rules.js';
import {Game} from '../src/engine/game.js';
import {decide,applyAction} from '../src/engine/ai.js';
import {createRng} from '../src/engine/rng.js';
const players=Array.from({length:4},(_,i)=>({name:'AI'+i,kind:'ai',personality:'speed'}));
for(const mode of ['math1','math2']){
 test(mode+' opt-in dead wall has 14 unique physical tiles',()=>{
  const g=new Game({rules:createRules(makeConfig({mode})),seed:17,dealer:0,players,newRules:true});
  assert.equal(g.deadWall.allPhysical().length,14);
  assert.equal(g.doraIndicators.length,1);
  assert.equal(g.checkInvariants(),true);
  assert.equal(g.normalDraws[0],1);
  assert.equal(g.viewFor(0).doraIndicators.length,1);
 });
 test(mode+' legacy remains without dead wall',()=>{
  const g=new Game({rules:createRules(makeConfig({mode})),seed:17,dealer:0,players});
  assert.equal(g.deadWall,null);assert.equal(g.checkInvariants(),true);
 });
 test(mode+' new-rules AI game conserves physical tiles across all actions',()=>{
  const rules=createRules(makeConfig({mode}));
  for(let seed=1;seed<=12;seed++){
   const g=new Game({rules,seed,dealer:seed%4,players,newRules:true});
   const rng=createRng(seed*7+3);
   let loops=0;
   while(g.pending()){
    const p=g.pending();
    applyAction(g,p.seat,decide(g,p.seat,'speed',rng));
    assert.equal(g.checkInvariants(),true);
    assert.ok(++loops<1000);
   }
   assert.ok(g.result);
  }
 });
}

test('math2 natural draw 25 is exhaustive draw; math1 is unchanged',()=>{
 for(const mode of ['math1','math2']){
  const g=new Game({rules:createRules(makeConfig({mode})),seed:19,dealer:0,players,newRules:true});
  g.normalDraws[0]=24;
  g._draw(0);
  assert.equal(g.result?.type==='draw',mode==='math2');
 }
});
test('forced ankan conserves 14 reserved, keeps closed and reveals second dora',()=>{
 const g=new Game({rules:createRules(makeConfig({mode:'math1'})),seed:57,dealer:0,players,newRules:true});
 const seat=g.current;
 const byType=new Map();
 for(const id of g.wall){const t=g.typeOf(id);byType.set(t,[...(byType.get(t)||[]),id]);}
 const found=[...byType.entries()].find(([t,ids])=>ids.length>=4&&g.rules.koutsuOf(t));
 assert.ok(found);
 const [t,ids]=found,quad=ids.slice(0,4);
 const removed=g.hands[seat].splice(0,4);
 for(const id of quad)g.wall.splice(g.wall.indexOf(id),1);
 g.hands[seat].push(...quad);
 g.wall.unshift(...removed);
 assert.equal(g.checkInvariants(),true);
 assert.ok(g.ankanOptions(seat).some(x=>x.type===t));
 const live=g.wall.length;
 g.ankan(seat,t);
 assert.equal(g.checkInvariants(),true);
 assert.equal(g.wall.length,live-1);
 assert.equal(g.deadWall.allPhysical().length,14);
 assert.equal(g.doraIndicators.length,2);
 assert.equal(g.melds[seat][0].tiles.length,4);
 assert.equal(g.isClosed(seat),true);
});
