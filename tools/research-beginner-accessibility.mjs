// Research only: beginner human proxy vs 3 beginner characters, ruleset 2.
// Same seed/dealer/lineup per tuning scenario. Not real human win rates.
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { beginnerDiscard } from '../src/engine/ai-levels.js';
import { BEGINNER_PARAMS } from '../src/engine/character-ai-prototype.js';
import { decideCharacter, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf, ranks } from '../src/engine/match.js';
import { matchInfo } from '../src/engine/ai-levels.js';
import { createRng } from '../src/engine/rng.js';
const N=Number(process.env.BEGINNER_MATCHES||18), seed0=Number(process.env.BEGINNER_SEED||960001);
const modeList=['math1','math2'],lengths=[4,8];
const base={kanata:{...BEGINNER_PARAMS.kanata,pick:BEGINNER_PARAMS.kanata.pick.slice()},mitsuki:{...BEGINNER_PARAMS.mitsuki,pick:BEGINNER_PARAMS.mitsuki.pick.slice()},aoto:{...BEGINNER_PARAMS.aoto}};
const scenarios={
 baseline:()=>Object.assign(BEGINNER_PARAMS,{kanata:{...base.kanata},mitsuki:{...base.mitsuki},aoto:{...base.aoto}}),
 gentle:()=>{
 BEGINNER_PARAMS.kanata={...base.kanata,pick:[.43,.27,.17,.09,.04],readyBase:.5,readyPerLive:.04,readExact:0,readKind:0,readPerWait:0,readMax:0};
 BEGINNER_PARAMS.mitsuki={...base.mitsuki,pick:[.28,.25,.22,.15,.10]};
 BEGINNER_PARAMS.aoto={...base.aoto,randomDiscard:.7,pon:.9,chi:.85};
 },
 easy:()=>{
 BEGINNER_PARAMS.kanata={...base.kanata,pick:[.23,.23,.21,.18,.15],readyBase:0,readyPerLive:0,readExact:0,readKind:0,readPerWait:0,readMax:0};
 BEGINNER_PARAMS.mitsuki={...base.mitsuki,pick:[.18,.20,.22,.21,.19],sinTile:2,sinPair:1.5};
 BEGINNER_PARAMS.aoto={...base.aoto,randomDiscard:.9,pon:.95,chi:.9};
 },
};
function novice(g,p,rng){
 if(p.type==='claim')return p.ron?{type:'ron'}:{type:'pass'};
 if(p.canTsumo)return {type:'tsumo'};
 if(g.riichi[p.seat])return {type:'discard',tile:g.drawn};
 const view=g.viewFor(p.seat);
 // Modeling novice: 25% fully random, 75% simple beginner tile-keep heuristic.
 return {type:'discard',tile:rng.next()<.25?rng.pick(view.hand).id:beginnerDiscard(g.rules,view,rng)};
}
const all={definition:'proxy human with 75% generic beginnerDiscard and 25% fully random, no calls, wins always, never riichi (not observed novice skill)',N,seed0,conditions:{}};
for(const mode of modeList)for(const length of lengths){
 const rules=createRules(makeConfig({mode}));const key=mode+'_'+length;all.conditions[key]={};
 for(const [label,settings] of Object.entries(scenarios)){
 settings();const st={matches:0,rank:[0,0,0,0],top:0,last:0,score:0,oppScore:0,rounds:0,draws:0,noviceWins:0,oppWins:0,noviceDealins:0,errors:0,lossStreakMax:0};let streak=0;
 for(let k=0;k<N;k++){
  let m=createMatch({length,startDealer:k%4}),history=newPublicHistory();
  const ids=['kanata','mitsuki','aoto'];const shifted=[...ids.slice(k%3),...ids.slice(0,k%3)];
  const roster=['proxy',...shifted];const ps=roster.map((id,i)=>({kind:'ai',name:id,personality:i===0?'speed':id==='mitsuki'?'value':id==='aoto'?'closed':'speed'}));
  let loops=0;
  while(!m.over){
    const seed=seed0+k*9719+(m.played+1)*7919;
    const g=new Game({rules,seed,dealer:dealerOf(m),players:ps,ruleset:2}),rng=createRng(seed^0x5bd1e995);
    const info={...matchInfo(m),publicHistory:history};
    for(let step=0;g.pending();step++){
      if(step>1000)throw Error('step cap');
      const p=g.pending();const action=p.seat===0?novice(g,p,rng):decideCharacter(g,p.seat,roster[p.seat],rng,info,roster.slice(1));
      applyAction(g,p.seat,action);g.checkInvariants();
    }
    if(g.result.type==='draw')st.draws++;
    else if(g.result.winner===0)st.noviceWins++;
    else st.oppWins++;
    if(g.result.type==='win'&&g.result.from===0)st.noviceDealins++;
    history=recordPublicRound(history,g.events,g.riichi);
    m=applyRoundResult(m,g.result,{round:m.played+1,maxRound:24});
    st.rounds++;
    if(++loops>24)throw Error('round cap');
  }
  const ranks0=ranks(m.scores)[0];st.rank[ranks0-1]++;st.top+=(ranks0===1);st.last+=(ranks0===4);st.score+=m.scores[0];st.oppScore+=(400-m.scores[0])/3;st.matches++;
  if(ranks0!==1)st.lossStreakMax=Math.max(st.lossStreakMax,++streak);else streak=0;
 }
 all.conditions[key][label]={...st,topRate:st.top/st.matches,lastRate:st.last/st.matches,meanScore:st.score/st.matches,meanOppScore:st.oppScore/st.matches,meanRank:st.rank.reduce((s,n,i)=>s+n*(i+1),0)/st.matches};
 }
}
console.log(JSON.stringify(all,null,2));
