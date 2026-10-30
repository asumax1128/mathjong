// Dedicated stress research, not product logic. Each paired seed runs uncapped / cap24.
// long-game scenario intentionally suppresses ALL winning until 100 total natural draws
// (math1: 65). This is not an estimate of real-player probabilities.
import {createRules} from '../src/engine/rules.js';
import {makeConfig} from '../src/engine/config.js';
import {Game} from '../src/engine/game.js';
import {decide,applyAction,chooseDiscard} from '../src/engine/ai.js';
import {createRng} from '../src/engine/rng.js';
const N=Number(process.env.LONG_GAMES||60),BASE=Number(process.env.LONG_SEED||950001);
const lineup=['speed','value','closed','speed'];
function run(mode,seed,cap,scenario,withKan){
 const rules=createRules(makeConfig({mode})); const players=lineup.map((_,i)=>({kind:'ai',name:lineup[(i+seed-BASE)%4],personality:lineup[(i+seed-BASE)%4]}));
 const g=new Game({rules,seed,dealer:seed%4,players}),dead=g.wall.splice(0,14);
 const rinshan=withKan?dead.slice(0,4):[];const extras=[];const inactive=withKan?dead.slice(4):dead;
 let kan=0;const draws=[0,0,0,0];draws[g.dealer]=1;
 const oldDraw=g._draw.bind(g);let capped=false;
 g._draw=(seat)=>{if(cap!==null&&draws[seat]>=cap){capped=true;return g._endDraw();}draws[seat]++;return oldDraw(seat);};
 function invariant(){
  const ids=[...g.wall,...rinshan,...extras,...inactive,...g.hands.flat(),...g.rivers.flatMap(r=>r.map(x=>x.id)),...g.melds.flatMap(ms=>ms.flatMap(m=>m.tiles))];
  if(ids.length!==rules.deckSize||new Set(ids).size!==ids.length)throw Error('tile conservation '+mode+' '+seed+' '+scenario+' '+withKan);
 }
 invariant();
 let steps=0;
 while(g.pending()){
   const p=g.pending();
   if(withKan&&p.type==='turn'&&!g.riichi[p.seat]&&rinshan.length&&g.wall.length&&kan<4){
     const byType=new Map();
     for(const id of g.hands[p.seat]){const t=g.typeOf(id);byType.set(t,[...(byType.get(t)||[]),id]);}
     const four=[...byType.entries()].find(([t,ids])=>ids.length>=4&&rules.koutsuOf(t));
     if(four){const [t,ids]=four,quad=ids.slice(0,4);for(const id of quad)g.hands[p.seat].splice(g.hands[p.seat].indexOf(id),1);
       g.melds[p.seat].push({meld:rules.koutsuOf(t).idx,kind:'koutsu',call:'ankan',tiles:quad,claimed:null,from:null});
       const id=rinshan.pop();g.hands[p.seat].push(id);extras.push(g.wall.shift());g.drawn=id;g.justDrew=true;g.turnCount++;kan++;invariant();continue;}
   }
   let action=decide(g,p.seat,players[p.seat].personality,createRng(seed*7+3+steps));
   const minimum=scenario==='stress'?(mode==='math2'?100:65):0;
   const total=draws.reduce((a,b)=>a+b,0);
   if(total<minimum&&(action.type==='ron'||action.type==='tsumo')){
     if(action.type==='ron')action={type:'pass'};
     else action={type:'discard',tile:g.riichi[p.seat]?g.drawn:chooseDiscard(rules,g.viewFor(p.seat),players[p.seat].personality).id};
   }
   applyAction(g,p.seat,action);if(++steps>1000)throw Error('stalled');invariant();
 }
 return {win:g.result.type==='win',capped,kan,river:Math.max(...g.rivers.map(r=>r.length)),draws:Math.max(...draws),totalDraws:draws.reduce((a,b)=>a+b,0)};
}
const output={N,BASE,methods:'Actual game actions, no-kan vs research forced ankan, ordinary AI vs forced delayed-win stress; 14-tile dead wall; cap at 24 natural draws per seat; stress is NOT representative',modes:{}};
for(const mode of ['math1','math2']){
 output.modes[mode]={};
 for(const scenario of ['normal','stress'])for(const withKan of [false,true]){
 const pair={};
 for(const cap of [null,24]){
   const arr=[];for(let i=0;i<N;i++)arr.push(run(mode,BASE+i,cap,scenario,withKan));
   pair[cap===null?'uncapped':'cap24']={wins:arr.filter(x=>x.win).length,draws:arr.filter(x=>!x.win).length,capped:arr.filter(x=>x.capped).length,kan:arr.reduce((a,x)=>a+x.kan,0),meanMaxRiver:arr.reduce((a,x)=>a+x.river,0)/N,maxRiver:Math.max(...arr.map(x=>x.river)),maxNaturalDraws:Math.max(...arr.map(x=>x.draws)),river19plus:arr.filter(x=>x.river>=19).length};
 }
 output.modes[mode][scenario+(withKan?'_ankan':'_noKan')]=pair;
 }}
console.log(JSON.stringify(output,null,2));