import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
const N=Number(process.env.CAP_GAMES||500), BASE=Number(process.env.CAP_SEED||940001);
const lineup=['speed','value','closed','speed'];
function play(mode,seed,cap){
  const rules=createRules(makeConfig({mode}));
  const players=lineup.map((_,i)=>{const p=lineup[(i+(seed-BASE))%4];return {name:p,personality:p,kind:'ai'}});
  const g=new Game({rules,seed,dealer:seed%4,players});
  const dead=g.wall.splice(0,14); // after first dealer draw, 14 dead wall reserved
  const draws=[0,0,0,0];draws[g.dealer]=1;
  const oldDraw=g._draw.bind(g);
  let limited=false;
  g._draw=(seat)=>{
    if(cap!==null && draws[seat]>=cap){limited=true;g._endDraw();return;}
    draws[seat]++;
    return oldDraw(seat);
  };
  const rng=createRng(seed*7+3);
  let steps=0;
  while(g.pending()){
    const p=g.pending();
    applyAction(g,p.seat,decide(g,p.seat,players[p.seat].personality,rng));
    if(++steps>2000) throw Error('stalled '+mode+' '+seed);
  }
  const river=g.rivers.map(x=>x.length);
  const win=g.result.type==='win';
  return {win,limited,draws,river,riverMax:Math.max(...river),riverTotal:river.reduce((a,b)=>a+b,0)};
}
const result={method:'Game+AI paired seeds, reserve 14 from bottom after dealer first draw, cap natural draw at 24/seat, dealer initial draw counted; no kan',N,BASE,modes:{}};
for(const mode of ['math1','math2']){
 const cases={};
 const records={};
 for(const cap of [null,24]){
  const key=cap===null?'uncapped':'cap24', a=[];
  for(let i=0;i<N;i++)a.push(play(mode,BASE+i,cap));
  records[key]=a;
  const draws=a.filter(x=>!x.win).length, capped=a.filter(x=>x.limited).length;
  const flatten=a.flatMap(x=>x.river);
  cases[key]={wins:N-draws,draws,capped,drawRate:draws/N,meanRiver:flatten.reduce((s,n)=>s+n,0)/flatten.length,
    maxRiver:Math.max(...flatten),riverSeatOver18:flatten.filter(n=>n>18).length,
    maxNaturalDraws:Math.max(...a.flatMap(x=>x.draws)),meanMaxRiver:a.reduce((s,x)=>s+x.riverMax,0)/N};
 }
 const transitions={extraDraws:0,drawToWin:0,winToDraw:0};
 for(let i=0;i<N;i++){const a=records.uncapped[i],b=records.cap24[i];if(a.win&&!b.win)transitions.winToDraw++;if(!a.win&&b.win)transitions.drawToWin++;}
 result.modes[mode]={deck:mode==='math1'?124:168, cases,transitions};
}
console.log(JSON.stringify(result,null,2));