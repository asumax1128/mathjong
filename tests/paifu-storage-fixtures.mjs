// Deterministic private benchmarks only; no AI, game or production hooks are replaced.
import {Game} from '../src/engine/game.js';
import {createRules} from '../src/engine/rules.js';
import {modeConfig} from '../src/engine/config.js';
import {createMatch,applyRoundResult,dealerOf} from '../src/engine/match.js';
import {createPaifu,beginRound,captureGame,appendDecision,settleRound,endRecording} from '../src/engine/paifu.js';
const players=['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'}));
const percentile=(a,p)=>a.slice().sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*p))]??0;
export function makeStorageFixture({id,mode='math1',length=4,renchan=0,partial=false}){
 const rules=createRules(modeConfig(mode));let match=createMatch({length}),record=createPaifu({id,rules,players,match,origin:'fixture'}),round=1;
 const appendMs=[],captureMs=[];
 while(!match.over&&(!renchan||round<=renchan)){
  let presetWall=null;
  if(renchan){
   // Dealer holds two formulae and tan45, eventually draws =1 after 18 legal circuits.
   const hand=['f:sin','a:30','v:1/2','f:cos','a:180','v:-1','f:tan','a:45'];
   const pool=rules.types.flatMap(t=>Array(t.copies).fill(t.key));
   const take=k=>{const i=pool.indexOf(k);if(i<0)throw Error('fixture shortage '+k);pool.splice(i,1);return k;};
   const h=hand.map(take),last=take('v:1'),others=Array.from({length:3},()=>pool.splice(0,8));
   presetWall=[];for(let r=0;r<8;r++)for(let s=0;s<4;s++)presetWall.push(s?others[s-1][r]:h[r]);
   presetWall.push(...pool.splice(0,72),last);
  }
  const g=new Game({rules,seed:round,dealer:dealerOf(match),round,players,presetWall});
  record=beginRound(record,g,{setup:renchan?'snapshot':'seed'});
  while(g.pending()){
   const q=g.pending(),action=q.type==='claim'?{type:'pass'}:renchan&&g.turnCount===73?{type:'tsumo'}:{type:'discard',tile:g.drawn};
   let at=performance.now();const before=captureGame(g);captureMs.push(performance.now()-at);
   if(action.type==='pass')g.respond(q.seat,action);else if(action.type==='tsumo')g.tsumo(q.seat);else g.discard(q.seat,action.tile);
   at=performance.now();const after=captureGame(g);captureMs.push(performance.now()-at);at=performance.now();
   record=appendDecision(record,{before,after,seat:q.seat,action});appendMs.push(performance.now()-at);
   if(partial&&appendMs.length===17){record=endRecording(record,{reason:'left-match'});return finish();}
  }
  g.checkInvariants();match=applyRoundResult(match,g.result);record=settleRound(record,match);round++;
 }
 if(renchan)record=endRecording(record,{reason:'left-match'});
 return finish();
 function finish(){return {record,recording:{decisions:appendMs.length,rounds:record.rounds.length,renchan:match.renchan,
  appendP95Ms:percentile(appendMs,.95),appendMaxMs:Math.max(0,...appendMs),captureP95Ms:percentile(captureMs,.95)}};}
}
