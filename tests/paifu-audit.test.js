import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine/game.js';
import {createMatch} from '../src/engine/match.js';
import {createPaifu,beginRound,encodePaifu,decodePaifu,verifyPaifu} from '../src/engine/paifu.js';
import {rulesFor} from './helpers.js';
const players=['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'}));
for(const mode of ['math1','math2']){
 test(`監査P3 ${mode}: fixtureへの余分な不存在物理IDをbuilder/import両方で拒否`,()=>{
  const rules=rulesFor(mode),config={id:'fixture',rules,players,match:createMatch(),origin:'fixture'};
  const original=encodePaifu(beginRound(createPaifu(config),new Game({rules,players,seed:1}),{setup:'snapshot'}));
  for(const extra of [-1,-.5,'phantom',rules.types.length*100]){
   const g=new Game({rules,players,seed:1});g.wall.unshift(extra);assert.throws(()=>beginRound(createPaifu(config),g,{setup:'snapshot'}),/physical tile domain\/count/);
   const p=JSON.parse(original);p.rounds[0].initial.wall.unshift(extra);assert.throws(()=>decodePaifu(JSON.stringify(p)),/physical tile domain\/count/);
  }
 });
 test(`監査P3 ${mode}: 正常なseed/snapshotの物理牌総数と完全往復を維持`,()=>{
  const rules=rulesFor(mode),g=new Game({rules,players,seed:1});
  for(const setup of ['seed','snapshot']){const p=beginRound(createPaifu({id:'good',rules,players,match:createMatch(),origin:'fixture'}),g,{setup});assert.equal(p.rounds[0].initial.wall.length+p.rounds[0].initial.hands.flat().length,mode==='math1'?124:168);assert.equal(verifyPaifu(decodePaifu(encodePaifu(p))).valid,true);}
 });
}
