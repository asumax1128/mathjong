// TEST-ONLY executable sketch of docs/57. Not imported by app.js or any production module.
// This is a proposed caller contract, not the eventual application adapter.
import {applyAction} from '../src/engine/ai.js';
import {applyRoundResult} from '../src/engine/match.js';
export function integrationHarness({load}) {
 let ready=null,loading=null,manager=null,scope=null,game=null,session=null,settled=false;
 const quiet=fn=>{try{return fn();}catch{return null;}};
 const current=(token,g=game)=>scope!==null&&token===scope&&g===game;
 const observe=(target,method,...args)=>{
  try{return target?.[method](...args);}catch{
   if(target&&session===target){session=null;quiet(()=>target.leave('recording-error'));quiet(()=>manager?.end('left-match'));}
   return null;
  }
 };
 return {
  preload(){
   loading??=Promise.resolve().then(load).then(factory=>{
    if(typeof factory!=='function')throw Error('factory');ready=factory;return {ok:true};
   }).catch(()=>({ok:false,reason:'recording-unavailable'}));
   return loading;
  },
  begin(config){
   // Revoke the old application scope BEFORE old-session cleanup or async callbacks.
   scope=Object.freeze({});game=null;session=null;settled=false;
   if(ready){
    if(!manager)manager=quiet(()=>ready());
    const admitted=quiet(()=>manager?.start(config));
    if(admitted?.recording===true)session=admitted.session;
   }else quiet(()=>manager?.end('reset'));
   return scope;
  },
  round(token,g,options){
   if(token!==scope||scope===null)return {ignored:true};
   game=g;settled=false;observe(session,'roundStarted',g,options);return {ignored:false};
  },
  current,
  action(token,g,seat,action,source){
   if(!current(token,g))return {ignored:true};
   const observer=session; // Capture this game's observer, never look up a newer one in an async callback.
   const ticket=observe(observer,'beforeAction',g,{seat,action,source});
   if(!current(token,g))return {ignored:true};
   try{applyAction(g,seat,action);}catch(engineError){
    if(session===observer)observe(observer,'afterAction',ticket,g,{accepted:false});throw engineError;
   }
   if(session===observer)observe(observer,'afterAction',ticket,g,{accepted:true});return {ignored:false};
  },
  settle(token,g,match,options){
   if(!current(token,g)||settled)return {ignored:true};
   settled=true; // Mirrors the existing scored guard; recorder errors do not reopen it.
   const after=applyRoundResult(match,g.result,options);
   observe(session,'roundSettled',g,after,{maxRound:options?.maxRound??1000000});return {ignored:false,match:after};
  },
  leave(token){
   if(token!==scope||scope===null)return {ignored:true};
   scope=null;game=null;session=null;quiet(()=>manager?.end('left-match'));return {ignored:false};
  },
  view:()=>({recording:session!==null,ready:ready!==null,inGame:scope!==null,resources:quiet(()=>manager?.status())}),
  privateSessionForTest:()=>session,
  dispose(){scope=null;game=null;session=null;quiet(()=>manager?.dispose());},
 };
}
