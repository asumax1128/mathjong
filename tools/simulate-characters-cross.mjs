// Ver.0.6 cross-level difficulty smoke test: one challenger vs 3 AIs of the next level.
// Each group rotates seats and dealer, uses public match scores, validates tile conservation.
// Usage: node tools/simulate-characters-cross.mjs --mode math1 --groups 4 --seed 31
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decideCharacter, CHARACTER_ROSTER } from '../src/engine/character-ai.js';
import { applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, ranks, dealerOf, START_POINTS } from '../src/engine/match.js';
const argv = process.argv.slice(2);
const get = (s, v) => { const i = argv.indexOf(s); return i >= 0 ? argv[i+1] : v; };
const mode = get('--mode','math1'), groups = Number(get('--groups',4)), seed0 = Number(get('--seed',31));
if (!['math1','math2'].includes(mode) || !Number.isInteger(groups) || groups < 1 || groups > 100 ||
    !Number.isInteger(seed0)) throw Error('invalid parameters');
const rules = createRules(makeConfig({ mode }));
const roster = Object.values(CHARACTER_ROSTER).flat();
const byId = Object.fromEntries(roster.map(x => [x.id,x]));
const junior = CHARACTER_ROSTER.beginner.map(x=>x.id);
const middle = CHARACTER_ROSTER.intermediate.map(x=>x.id);
const senior = CHARACTER_ROSTER.advanced.map(x=>x.id);
const cases = [
  ...junior.map(x=>({challenger:x,opponents:middle})),
  ...middle.map(x=>({challenger:x,opponents:senior})),
];
const stats = {};
const started = Date.now();
for(let ci=0;ci<cases.length;ci++){
  const c=cases[ci];
  let win=0,last=0,rankSum=0,scoreSum=0,wins=0,discards=0;
  const against={rankSum:0,n:0};
  for(let g=0;g<groups;g++)for(let rot=0;rot<4;rot++){
    const lineup=[c.challenger,...c.opponents];
    const seats=lineup.map((_,i)=>lineup[(i+rot)%4]);
    let m=createMatch({length:4}),round=0;
    const base=seed0*1000003+ci*11717+g*7919+rot*97;
    while(!m.over){
      const roundSeed=base+(++round)*7919;
      if(round>100)throw Error('excessive rounds');
      const game=new Game({rules,seed:roundSeed,dealer:dealerOf(m),
        players:seats.map(id=>({name:byId[id].name,kind:'ai',personality:byId[id].personality}))});
      const rng=createRng(roundSeed ^ 0x5bd1e995);
      let steps=0;
      while(game.pending()){
        const p=game.pending();
        const a=decideCharacter(game,p.seat,seats[p.seat],rng,
          {scores:m.scores,hand:m.hand,length:m.length,dealer:dealerOf(m),renchan:m.renchan},seats);
        applyAction(game,p.seat,a);
        if(++steps>3000)throw Error('decision loop');
      }
      game.checkInvariants();
      if(game.result.type==='win' && seats[game.result.winner]===c.challenger)wins++;
      m=applyRoundResult(m,game.result);
      if(m.scores.reduce((a,b)=>a+b,0)!==4*START_POINTS)throw Error('score conservation');
    }
    const rr=ranks(m.scores),target=seats.indexOf(c.challenger);
    rankSum+=rr[target];scoreSum+=m.scores[target];
    if(rr[target]===1)win++;
    if(rr[target]===4)last++;
    seats.forEach((id,seat)=>{if(seat!==target){against.rankSum+=rr[seat];against.n++}});
  }
  const n=groups*4;
  stats[c.challenger]={vs:c.opponents, matches:n, avgRank:+(rankSum/n).toFixed(3),
    firstRate:+(win/n).toFixed(3),lastRate:+(last/n).toFixed(3),
    avgPoints:+(scoreSum/n).toFixed(2),winsPerMatch:+(wins/n).toFixed(3),
    opponentsAvgRank:+(against.rankSum/against.n).toFixed(3)};
}
console.log(JSON.stringify({mode,groups,seed:seed0,seconds:+((Date.now()-started)/1000).toFixed(2),
  note:'初級1名 vs 中級3名、中級1名 vs 上級3名。全席ローテーション。差が小さい場合は結論保留。',
  stats},null,2));
