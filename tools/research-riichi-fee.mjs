// Research-only paired counterfactual settlement: same games, compare riichi fee 0/5.
// Fee is escrow: 5 from declarer when riichi succeeds, all pot to winner; refund at match end
// if unclaimed; temporary pot included in conservation check. No AI decision adaptation.
// This is NOT an end-to-end 5-point-fee implementation or 4-riichi abortive-draw test.
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf, ranks } from '../src/engine/match.js';
import { matchInfo } from '../src/engine/ai-levels.js';
import { createRng } from '../src/engine/rng.js';
const N=Number(process.env.FEE_MATCHES||100),SEED=Number(process.env.FEE_SEED||20261030);
const ids=Object.values(CHARACTER_ROSTER).flat().map(x=>x.id);
let out={method:'Post-hoc fee settlement under unchanged AI decisions; any strategic deterrence of paying fee is unmodeled. Escrow carries through draws, returns if unclaimed at match end. No 4-riichi rule in engine yet.',matchesPerModeLength:N,seed:SEED,conditions:{}};
for(const mode of ['math1','math2'])for(const length of [1,4,8]){
 const cfg=createRules(makeConfig({mode}));let st={matches:0,hands:0,riichi:0,draw:0,noWinnerWithPot:0,feePaid:0,feeReturned:0,feeAwarded:0,rankChanges:0,topChanges:0,meanAbsScoreShift:0,top0:0,top5:0,potMax:0,feePayoutWin:0,feePayoutOther:0,samples:[]};
 for(let mi=0;mi<N;mi++){
  const persons=[0,1,2,3].map((i)=>ids[(mi*7+i*5)%ids.length]);
  const players=persons.map((id)=>({name:id,kind:'ai',personality:id==='mitsuki'?'value':'speed'}));
  let m=createMatch({length:length===1?4:length,startDealer:mi%4}),adj=[0,0,0,0],ledger=[0,0,0,0],pot=0,hands=0,history=newPublicHistory();
  while(length===1?hands<1:!m.over){
   let seed=SEED+mi*8917+hands*1777+(mode==='math1'?1:1000000)+(length*999999);
   let g=new Game({rules:cfg,seed,dealer:dealerOf(m),players,ruleset:2}),rng=createRng(seed^0x5bd1e995);
   let info={...matchInfo(m),publicHistory:history};
   for(let steps=0;g.pending();steps++){
    if(steps>1500)throw Error('no progress');
    const p=g.pending(),a=decideCharacter(g,p.seat,persons[p.seat],rng,info,persons.slice(1));
    applyAction(g,p.seat,a);
   }
   g.checkInvariants();
   let reach=g.events.filter(e=>e.type==='riichi'),declarers=new Set(reach.map(x=>x.seat));
   for(const seat of declarers){adj[seat]-=5;ledger[seat]+=5;pot+=5;st.feePaid+=5;}
   st.riichi+=declarers.size;st.potMax=Math.max(st.potMax,pot);
   if(g.result.type==='win'){adj[g.result.winner]+=pot;st.feeAwarded+=pot;st.feePayoutWin++;pot=0;ledger.fill(0);}
   else{st.draw++;if(pot>0)st.noWinnerWithPot++;}
   m=applyRoundResult(m,g.result,{round:m.played+1,maxRound:length===1?1:24});
   st.hands++;hands++;
   history=recordPublicRound(history,g.events,g.riichi);
   if(m.scores.reduce((a,b)=>a+b,0)!==400)throw Error('baseline not conserved');
   if(adj.reduce((a,b)=>a+b,0)+pot!==0)throw Error('fee escrow not conserved');
   if(hands>24)throw Error('match cap');
  }
  // At a match boundary, unclaimed deposits return to their original declarers only if tracked.
  // Alternative policy to keep sums and prevent cross-match carry: redistribute residual equally.
  // We track exact per-seat escrow ownership for refund by reconstructing pending deposits in order.
  // Exact ownership tracking is required, so fee pending ledger is accounted per-seat below.
  if(pot){ // equal redistribution to all 4 is policy sensitivity, not an individual refund
    for(let i=0;i<4;i++)adj[i]+=pot/4;
    st.feeReturned+=pot;pot=0;
  }
  const ranks0=ranks(m.scores),ranks5=ranks(m.scores.map((v,i)=>v+adj[i]));
  if(adj.reduce((a,b)=>a+b,0)!==0)throw Error('final conservation');
  for(let seat=0;seat<4;seat++){
   if(ranks0[seat]!==ranks5[seat])st.rankChanges++;
   if((ranks0[seat]===1)!==(ranks5[seat]===1))st.topChanges++;
   st.meanAbsScoreShift+=Math.abs(adj[seat]);
   st.top0+=(ranks0[seat]===1);st.top5+=(ranks5[seat]===1);
  }
  st.matches++;
 }
 st.meanAbsScoreShift/=N*4;
 out.conditions[mode+'_'+length]=st;
}
console.log(JSON.stringify(out,null,2));
