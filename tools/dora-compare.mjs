// Research only. Does not modify Game, rules, AI or published app.
// Matched-seed comparison: remove 14 tiles from the BOTTOM of the wall just after initial deal/draw.
// Existing seed and AI decision policy otherwise unchanged; actual AI plays all actions.
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
const N = Number(process.env.DORA_GAMES || '100');
const BASE_SEED = Number(process.env.DORA_SEED || '910001');
const lineup = ['speed','value','closed','speed'];
function nextDora(rules, typeIndex) {
  const t=rules.types[typeIndex];
  let seq=rules.types.filter(x=>x.kind===t.kind);
  if(t.kind==='angle') seq=seq.sort((a,b)=>a.deg-b.deg);
  else if(t.kind==='value') seq=seq.sort((a,b)=>{
    const v=x=>x.exact ? (Array.isArray(x.exact) ? x.exact[0]/x.exact[1]*Math.sqrt(x.exact[2]) : 0) : 0;
    return v(a)-v(b) || a.idx-b.idx;
  });
  const idx=seq.findIndex(x=>x.idx===typeIndex);
  return seq[(idx+1)%seq.length].idx;
}
function stats(vals) {
  const s=[...vals].sort((a,b)=>a-b);
  return {mean:vals.reduce((a,b)=>a+b,0)/vals.length,p90:s[Math.min(s.length-1,Math.ceil(s.length*.9)-1)],max:s.at(-1)};
}
function play(rules,seed,dead) {
 const pers=lineup.map((_,k)=>lineup[(k+(seed-BASE_SEED))%4]);
 const players=pers.map(p=>({name:p,kind:'ai',personality:p}));
 const game=new Game({rules,seed,dealer:seed%4,players});
 const removed=dead ? game.wall.splice(0,14) : [];
 const indicator=dead ? removed[0] : null;
 const rng=createRng(seed*7+3);
 let steps=0;
 while(game.pending()) {
   const p=game.pending();
   applyAction(game,p.seat,decide(game,p.seat,players[p.seat].personality,rng));
   if(++steps>2000) throw Error('stalled seed='+seed);
 }
 const lengths=game.rivers.map(r=>r.length);
 const win=game.result.type==='win';
 let dora=0,group=null;
 if(dead){
    const indicatorType=game.typeOf(indicator);
    const doraType=nextDora(rules,indicatorType);
    group=rules.types[doraType].kind;
    if(win){
      const winner=game.result.winner;
      const physical=[...game.hands[winner],...game.melds[winner].flatMap(m=>m.tiles)];
      dora=physical.filter(id=>game.typeOf(id)===doraType).length;
    }
 }
 return {win,how:win?game.result.how:null,rivers:lengths,discards:lengths.reduce((a,b)=>a+b,0),steps,delta:win?game.result.points:0, dora,group,indicator,removed:removed.length};
}
const result={method:'matched-seed real Game+AI; remove bottom 14 after dealer initial draw; score sampled post-win, AI ignores dora',gamesPerMode:Number.isFinite(N)?N:0,modes:{}};
for(const mode of ['math1','math2']){
 const rules=createRules(makeConfig({mode}));
 const out={deck:rules.deckSize,variants:{}};
 for(const variant of ['baseline','deadwall14']){
   const results=[];
   for(let i=0;i<N;i++)results.push(play(rules,BASE_SEED+i,variant==='deadwall14'));
   const w=results.filter(x=>x.win),d=results.filter(x=>!x.win);
   const r=results.flatMap(x=>x.rivers);
   const count={};for(const x of w){if(x.group){count[x.group]??={wins:0,bonusTotal:0,atLeastOne:0};count[x.group].wins++;count[x.group].bonusTotal+=x.dora;count[x.group].atLeastOne+=Number(x.dora>0)}}
   out.variants[variant]={hands:results.length,wins:w.length,winRate:w.length/N,draws:d.length,drawRate:d.length/N,ron:w.filter(x=>x.how==='ron').length,tsumo:w.filter(x=>x.how==='tsumo').length,riverTilesPerSeat:stats(r),maxRiverInHand:stats(results.map(x=>Math.max(...x.rivers))),riverSeatsOver18:r.filter(x=>x>=19).length,riverSeatsOver22:r.filter(x=>x>=23).length,riverSeatsOver30:r.filter(x=>x>=31).length,totalDiscardsPerHand:stats(results.map(x=>x.discards)),winsWithDora:w.filter(x=>x.dora>0).length,doraPerWin:w.length?w.reduce((a,x)=>a+x.dora,0)/w.length:null,doraByKind:count};
 }
 result.modes[mode]=out;
}
console.log(JSON.stringify(result,null,2));
