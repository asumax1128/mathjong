// Research-only actual Game+AI simulation. NEVER imported by production.
// 14 reserved physical tiles: 4 rinshan, five two-candidate dora indicator slots.
// At kan a tail-of-live tile moves to dead wall while rinshan physical tile enters a hand.
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
const N = Number(process.env.KAN_GAMES || 100), SEED=Number(process.env.KAN_SEED || 930001);
const kinds=['speed','value','closed','speed'];
function nextType(rules, idx) {
 const t=rules.types[idx], arr=rules.types.filter(q=>q.kind===t.kind);
 if(t.kind==='angle') arr.sort((a,b)=>a.deg-b.deg);
 if(t.kind==='value') arr.sort((a,b)=>{
  const n=x=>x.exact.p/x.exact.q*Math.sqrt(x.exact.r); // fallback below if exact shape varies
  return a.idx-b.idx; // deterministic numeric type order from config
 });
 return arr[(arr.findIndex(q=>q.idx===idx)+1)%arr.length].idx;
}
function run(rules,seed,variant){
 const players=kinds.map((_,i)=>({name:kinds[(i+seed-SEED)%4],personality:kinds[(i+seed-SEED)%4],kind:'ai'}));
 const game=new Game({rules,seed,dealer:seed%4,players});
 const rng=createRng(seed*7+3);
 let rinshan=[], indicatorPairs=[], extras=[], kan=0,physicalDora=[];
 if(variant!=='old'){
  const reserved=game.wall.splice(0,14);
  rinshan=reserved.slice(0,4);
  indicatorPairs=Array.from({length:5},(_,i)=>reserved.slice(4+i*2,6+i*2));
 }
 const reveal=i=>{
  const pair=indicatorPairs[i], first=pair[0], second=pair[1];
  const display=rules.types[game.typeOf(first)].kind==='func'?second:first;
  physicalDora.push({display,type:nextType(rules,game.typeOf(display)),firstFunction:rules.types[game.typeOf(first)].kind==='func'});
 };
 if(variant!=='old')reveal(0);
 const assert=()=>{
  const all=[...game.wall,...rinshan,...indicatorPairs.flat(),...extras,
  ...game.hands.flat(),...game.rivers.flatMap(r=>r.map(x=>x.id)),
  ...game.melds.flatMap(ms=>ms.flatMap(m=>m.tiles))];
  if(all.length!==rules.deckSize||new Set(all).size!==all.length||all.some(id=>!Number.isInteger(id)||id<0||id>=rules.deckSize))
   throw new Error('PHYSICAL CONSERVATION FAILED '+JSON.stringify({seed,variant,count:all.length,unique:new Set(all).size,expected:rules.deckSize}));
 };
 assert();
 let steps=0;
 while(game.pending()){
  const p=game.pending();
  if(variant==='ankan'&&p.type==='turn'&&!game.riichi[p.seat]&&kan<4&&game.wall.length>0&&rinshan.length){
    const counts=new Map();
    for(const id of game.hands[p.seat]){const t=game.typeOf(id);if(!counts.has(t))counts.set(t,[]);counts.get(t).push(id);}
    const candidate=[...counts.entries()].find(([type,ids])=>ids.length>=4&&rules.koutsuOf(type));
    // Always kan if legal, without changing the existing AI's choices otherwise.
    if(candidate){
      const [type,ids]=candidate, quad=ids.slice(0,4);
      for(const id of quad)game.hands[p.seat].splice(game.hands[p.seat].indexOf(id),1);
      const meld=rules.koutsuOf(type);
      game.melds[p.seat].push({meld:meld.idx,kind:'koutsu',call:'ankan',tiles:quad,claimed:null,from:null});
      const draw=rinshan.pop();
      game.hands[p.seat].push(draw);
      // Maintain 14 physical tiles in dead wall; live wall loses one tail tile.
      extras.push(game.wall.shift());
      game.drawn=draw;game.justDrew=true;game.turnCount++;
      game.log({type:'ankan',seat:p.seat,tiles:quad.slice()});
      kan++;reveal(kan);
      assert();
      continue;
    }
  }
  applyAction(game,p.seat,decide(game,p.seat,players[p.seat].personality,rng));
  if(++steps>2000)throw Error('loop');
  assert();
 }
 const win=game.result.type==='win',river=game.rivers.map(r=>r.length);
 let bonus=0;
 if(win&&variant!=='old'){
  const w=game.result.winner;
  const ids=[...game.hands[w],...game.melds[w].flatMap(m=>m.tiles)];
  bonus=physicalDora.reduce((acc,x)=>acc+ids.filter(id=>game.typeOf(id)===x.type).length,0);
 }
 return {win,kan,bonus,riverMax:Math.max(...river),riverTotal:river.reduce((a,b)=>a+b,0),doraCount:physicalDora.length,funcIndicators:physicalDora.filter(x=>rules.types[game.typeOf(x.display)].kind==='func').length};
}
const out={description:'research: current AI with always-ankan if 4 same physical tiles in hand, no engine/rule changes, 14 conserved wall tiles, first/second indicator, no AI dora strategy',samplesPerMode:N,modes:{}};
for(const mode of ['math1','math2']){
 const rules=createRules(makeConfig({mode}));out.modes[mode]={deck:rules.deckSize};
 for(const variant of ['old','dead14','ankan']){
   const arr=[];for(let i=0;i<N;i++)arr.push(run(rules,SEED+i,variant));
   const sums=k=>arr.reduce((a,x)=>a+x[k],0);
   out.modes[mode][variant]={wins:sums('win'),draws:N-sums('win'),kanTotal:sums('kan'),gamesWithKan:arr.filter(x=>x.kan).length,kanMax:Math.max(...arr.map(x=>x.kan)),meanRiverPerSeat:sums('riverTotal')/(N*4),riverMax:Math.max(...arr.map(x=>x.riverMax)),riverMax19plus:arr.filter(x=>x.riverMax>=19).length,winBonusMean:arr.filter(x=>x.win).reduce((a,x)=>a+x.bonus,0)/Math.max(1,sums('win')),totalFunctionIndicators:sums('funcIndicators'),totalIndicators:sums('doraCount')};
 }
}
console.log(JSON.stringify(out,null,2));
