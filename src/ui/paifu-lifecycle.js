// Stage 6: one active session + one retiring session, per shared coordinator/realm. No app/DOM hooks.
import {createPaifuSession} from './paifu-session.js';
import {createPaifuWorkerStore} from './paifu-worker-store.js';
import {describePaifuSaveState} from './paifu-save-state.js';
const fail = reason => Object.freeze({ok:false,recording:false,reason});
const reasons = new Set(['left-match','reset']);
export function createPaifuLifecycle({createStore=createPaifuWorkerStore,createSession=createPaifuSession,
  sessionOptions={},retireTimeoutMs=35000,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=clearTimeout}={}) {
  let active=null,closing=null,lastFinished=null,lastSkip=null,generation=0,closed=false,busy=false,cleanupFailed=false;
  const recentFinished=[];let reviewRequired=false,releasedDirtyCount=0;
  const configured=Number.isSafeInteger(retireTimeoutMs)&&retireTimeoutMs>=1&&retireTimeoutMs<=120000
    &&typeof createStore==='function'&&typeof createSession==='function'&&typeof schedule==='function'&&typeof cancel==='function';
  function raw(e){try{return e.session.status();}catch{return {version:null,savedVersion:null};}}
  function summary(e,forced=false,wasSaving=false){
    const s=raw(e);
    // Closing a posted write cannot establish rollback. Scheduled-only writes are cancelled without posting.
    const status=forced&&(s.saving==='saving'||wasSaving)?{...s,saveError:{code:'outcome-unknown'}}:s;
    return Object.freeze({generation:e.generation,save:describePaifuSaveState(status,{released:true})});
  }
  function release(e,forced=false,wasSaving=false){
    const result=summary(e,forced,wasSaving);
    try{e.session?.dispose();}catch{/* the owned store is closed below too */}
    try{e.closeStore();}catch{cleanupFailed=true;}
    if(!lastFinished||result.generation>=lastFinished.generation)lastFinished=result;
    recentFinished.push(result);if(recentFinished.length>8)recentFinished.shift();
    reviewRequired ||= result.save.reviewRequired===true;
    if(result.save.dirty!==false)releasedDirtyCount=Math.min(Number.MAX_SAFE_INTEGER,releasedDirtyCount+1);
    e.session=null;e.store=null;
  }
  function complete(g,forced=false){
    if(closing?.generation!==g)return;
    const e=closing;closing=null;
    if(e.timer!==null){try{cancel(e.timer);}catch{cleanupFailed=true;}}
    release(e,forced);
  }
  function end(reason='left-match'){
    if(!reasons.has(reason))return fail('invalid-reason');
    if(!active)return Object.freeze({ok:true,ignored:true});
    const e=active;active=null;
    if(closing){
      // Never create a second retiring worker. Cancel unposted work; a posted write remains uncertain.
      const wasSaving=raw(e).saving==='saving';
      try{Promise.resolve(e.session.stopSaving()).catch(()=>{});}catch{/* cleanup still runs */}
      try{e.session.leave(reason);}catch{/* do not delay the game */}
      release(e,true,wasSaving);return Object.freeze({ok:true,released:true,finalSaveRequested:false});
    }
    closing=e;
    try{
      e.session.leave(reason);
      const g=e.generation;e.timer=schedule(()=>complete(g,true),retireTimeoutMs);
      if(e.timer===null||e.timer===undefined)throw Error('scheduler');
      // Only the scalar generation is captured by callbacks, not the private session/snapshot.
      Promise.resolve(e.session.flush()).then(()=>complete(g),()=>complete(g,true));
    }catch{complete(e.generation,true);}
    return Object.freeze({ok:true,retiring:closing!==null});
  }
  const api={
    start(config){
      if(closed)return fail('closed');if(busy)return fail('transition-in-progress');
      if(!configured||cleanupFailed)return fail('resources-unavailable');
      busy=true;
      try{
        const saturated=Boolean(active&&closing);
        if(active)end('reset');
        if(saturated){lastSkip='resources-busy';return fail(lastSkip);}
        if(closed||cleanupFailed)return fail(closed?'closed':'resources-unavailable');
        let store=null,closeCalled=false;
        const e={generation:++generation,session:null,store:null,timer:null,closeStore(){
          if(closeCalled)return;closeCalled=true;try{store?.close();}catch{cleanupFailed=true;throw Error('cleanup');}finally{store=null;}
        }};
        try{
          store=createStore();if(typeof store?.close!=='function'||typeof store?.save!=='function')throw Error('store');
          const methods=Object.fromEntries(Object.entries(store).map(([k,v])=>[k,typeof v==='function'?v.bind(store):v]));
          e.store=store;e.session=createSession(config,{...sessionOptions,store:{...methods,close:e.closeStore}});
          if(['status','leave','flush','dispose','stopSaving'].some(k=>typeof e.session?.[k]!=='function')||raw(e).phase!=='active')throw Error('session');
          if(closed){e.session.dispose();e.closeStore();return fail('closed');}
          active=e;lastSkip=null;return Object.freeze({ok:true,recording:true,generation:e.generation,session:e.session});
        }catch{try{e.session?.dispose?.();}catch{}try{e.closeStore();}catch{cleanupFailed=true;}lastSkip='initialization-failed';return fail(lastSkip);}
      }finally{busy=false;}
    },
    end,
    checkpoint(){try{return active?active.session.checkpoint():{ok:true,ignored:true};}catch{return fail('recording-unavailable');}},
    status(){
      const a=active?Object.freeze({generation:active.generation,save:describePaifuSaveState(raw(active))}):null;
      const c=closing?Object.freeze({generation:closing.generation,save:describePaifuSaveState(raw(closing))}):null;
      return Object.freeze({active:a,closing:c,
      activeCount:active?1:0,closingCount:closing?1:0,lastFinished,lastSkip,closed,cleanupFailed,
      recentFinished:Object.freeze(recentFinished.slice()),reviewRequired:reviewRequired||a?.save.reviewRequired===true||c?.save.reviewRequired===true,releasedDirtyCount,
      recordingNotice:lastSkip==='resources-busy'?'保存の終了処理中のため、この試合の記録を見送りました。'
        :lastSkip==='initialization-failed'?'記録を開始できませんでした。ゲームは続けられます。':null});},
    dispose(){if(closed)return {ok:true,closed:true};closed=true;
      if(active){const e=active;active=null;release(e,true);}if(closing)complete(closing.generation,true);
      return Object.freeze({ok:true,closed:true});},
  };
  return Object.freeze(api);
}
