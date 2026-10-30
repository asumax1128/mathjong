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
