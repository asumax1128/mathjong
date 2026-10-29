// Stage 4 opt-in lifecycle controller. Never executes game/AI actions or patches app.js.
import * as paifu from '../engine/paifu.js';
import {createPaifuWorkerStore} from './paifu-worker-store.js';
const SAVE_CODES=new Set(['unavailable','blocked','timeout','interrupted','quota-exceeded','capacity-exceeded','record-too-large','conflict','not-found','invalid-record','invalid-argument','corrupt','unsupported-version','storage-error','outcome-unknown','queue-full','closed']);
const failure=(code,retryable=false)=>({ok:false,error:{code,retryable}});
const same=(a,b)=>{const key=(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;return JSON.stringify(a,key)===JSON.stringify(b,key);};
const uint=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export function createPaifuSession(config,{store=createPaifuWorkerStore(),intervalMs=30000,maxDecisions=4000,maxRounds=64,
  now=()=>performance.now(),schedule=fn=>setTimeout(fn,0),cancel=id=>clearTimeout(id),recorder=paifu}={}){
  let record=null,phase='active',version=0,savedVersion=0,savedStatus=null,token=null,gameRef=null,settled=false,ticket=null;
  let totalDecisions=0,requested=0,scheduled=null,inFlight=null,saveError=null,recordError=null,stopped=false,disposed=false,lastRequested=0;
  let lastReceipt=null,lastAttempt=null;
  const tickets=new WeakMap();
  function clock(){const n=now();if(!Number.isFinite(n)||n<lastRequested)throw Error('clock');return n;}
  function cancelScheduled(){if(scheduled!==null){try{cancel(scheduled);}catch{/* no external callbacks escape */}scheduled=null;}}
  function block(code,retryable=false){saveError={code,retryable};cancelScheduled();}
  function kick(){
    if(disposed||stopped||saveError||!record||inFlight||scheduled!==null||requested<=savedVersion)return;
    try{const marker={};scheduled=marker;const handle=schedule(()=>{scheduled=null;write();});if(scheduled===marker)scheduled=handle??marker;}
    catch{block('storage-error',true);}
  }
  function request(reason){
    if(disposed||stopped)return failure('closed');
    if(!record)return failure('invalid-record');
    if(saveError)return {ok:false,error:{...saveError}};
    try{lastRequested=clock();}catch{block('storage-error',true);return failure('storage-error',true);}
    requested=version;kick();
    return saveError?{ok:false,error:{...saveError}}:{ok:true,queued:version>savedVersion,version,reason};
  }
  function write(){
    if(disposed||stopped||saveError||inFlight||!record||requested<=savedVersion)return;
    const snapshot=record,target=version,expectedToken=token;
    lastAttempt=Object.freeze({id:snapshot.id,record:snapshot,version:target,expectedToken,acknowledged:lastReceipt});
    // Defer even a synchronously throwing injected store until inFlight has been assigned.
    inFlight=Promise.resolve().then(()=>store.save(snapshot,{expectedToken})).then(result=>{
      if(result?.ok===true){
        if(result.metadata?.id!==snapshot.id||!/^[a-f0-9]{32}$/.test(result.metadata?.token??'')){block('outcome-unknown');return;}
        lastReceipt=Object.freeze(structuredClone(result.metadata));lastAttempt=null;
        token=result.metadata.token;savedVersion=target;savedStatus=snapshot.status;
      }else{
        const code=SAVE_CODES.has(result?.error?.code)?result.error.code:'outcome-unknown';
        block(code,result?.error?.retryable===true);
        if(['record-too-large','invalid-record'].includes(code))stopRecording();
      }
    }).catch(()=>block('outcome-unknown')).finally(()=>{inFlight=null;kick();});
  }
  function changed(){version++;}
  function stopRecording(){
    if(phase==='failed')return;
    phase='failed';recordError='recording-error';if(ticket)tickets.delete(ticket);ticket=null;
    if(record?.status==='recording'){
      try{record=recorder.endRecording(record,{reason:'recording-error'});changed();}catch{/* keep last verified prefix */}
    }
    if(!saveError&&!disposed&&!stopped)request('recording-error');
  }
  function observe(fn){
    if(disposed||phase!=='active')return {ok:true,ignored:true};
    try{return fn();}catch{stopRecording();return failure('recording-error');}
  }
  function tick(){
    if(disposed||stopped||saveError||!record||version<=savedVersion)return {ok:true,ignored:true};
    try{if(clock()-lastRequested>=intervalMs)return request('interval');}
    catch{block('storage-error',true);return failure('storage-error',true);}
    return {ok:true,ignored:true};
  }
  try{
    if(!uint(intervalMs,1,3600000)||!uint(maxDecisions,1,20000)||!uint(maxRounds,1,1000)
      ||typeof now!=='function'||typeof schedule!=='function'||typeof cancel!=='function'||typeof store?.save!=='function')throw Error('config');
    record=recorder.createPaifu(config);changed();lastRequested=clock();
  }catch{phase='failed';recordError='recording-error';}
  const api={
    roundStarted(game,options){return observe(()=>{
      if(game===gameRef)return {ok:true,duplicate:true};
      if(ticket||record.rounds.length>=maxRounds)throw Error('unclosed action/round limit');
      record=recorder.beginRound(record,game,options);gameRef=game;settled=false;changed();request('round-start');
      return {ok:true,recorded:true};
    });},
    beforeAction(game,details={}){
      let handle=null;observe(()=>{
        if(game!==gameRef||settled)return {ok:true,ignored:true};
        const {seat,action,source}=details;
        if(ticket||totalDecisions>=maxDecisions)throw Error('unclosed action/decision limit');
        if(source==='auto-pass'){const p=game.pending();if(action?.type!=='pass'||p?.type!=='claim'||p.seat!==seat||p.ron||(!p.pon&&!p.chi.length))throw Error('auto-pass provenance');}
        const before=recorder.captureGame(game),snapshot=structuredClone(action);
        handle=Object.freeze({});tickets.set(handle,{before,seat,action:snapshot,source,game,version});ticket=handle;
        return {ok:true};
      });return handle;
    },
    afterAction(handle,game,options={}){return observe(()=>{
      if(!options||Object.keys(options).some(k=>!['accepted','atMs'].includes(k))||typeof (options.accepted??false)!=='boolean')throw Error('action result');
      const {accepted=false,atMs=null}=options;
      if(!handle||handle!==ticket)return {ok:true,ignored:true};
      const data=tickets.get(handle);ticket=null;tickets.delete(handle);
      if(data.game!==gameRef||game!==gameRef||data.version!==version)throw Error('stale action');
      const after=recorder.captureGame(game);
      if(!accepted){
        if(!same(data.before,after))throw Error('rejected action mutated state');
        return {ok:true,rejected:true};
      }
      record=recorder.appendDecision(record,{before:data.before,after,seat:data.seat,action:data.action,source:data.source,atMs});
      totalDecisions++;changed();tick();return {ok:true,recorded:true};
    });},
    roundSettled(game,matchAfter,options){return observe(()=>{
      if(game!==gameRef)return {ok:true,ignored:true};
      if(settled){if(!same(record.rounds.at(-1).settlement.matchAfter,matchAfter))throw Error('duplicate settlement differs');return {ok:true,duplicate:true};}
      if(ticket)throw Error('unclosed action');
      record=recorder.settleRound(record,matchAfter,options);settled=true;changed();request('round-end');
      return {ok:true,recorded:true};
    });},
    leave(reason='left-match',options={}){
      if(disposed||phase==='closed')return {ok:true,ignored:true};
      if(phase==='active'){
        try{if(record.status==='recording'){record=recorder.endRecording(record,{reason,atMs:options.atMs??null});changed();}phase='closed';if(ticket)tickets.delete(ticket);ticket=null;}
        catch{stopRecording();}
      }
      request('leave');return phase==='failed'?failure('recording-error'):{ok:true,closed:true};
    },
    tick,
    checkpoint:()=>request('explicit'),
    async flush(){
      const target=version,result=request('flush');if(!result.ok)return result;
      // Wait for this call's version, not for an indefinitely advancing game. Never called by hooks.
      while(savedVersion<target&&!saveError&&!disposed&&!stopped){
        if(scheduled!==null)cancelScheduled();if(!inFlight)write();
        if(!inFlight)break;await inFlight;
      }
      return savedVersion>=target?{ok:true,savedVersion,savedStatus}:saveError?{ok:false,error:{...saveError}}:failure('closed');
    },
    retrySaving(){
      if(disposed||stopped)return failure('closed');
      if(['outcome-unknown','conflict'].includes(saveError?.code))return failure('reconciliation-required');
      if(saveError&&!saveError.retryable&&saveError.code!=='capacity-exceeded')return {ok:false,error:{...saveError}};
      saveError=null;return request('manual-retry');
    },
    async stopSaving(){
      // Managed deletion barrier: no new writes; an already posted write may still commit.
      stopped=true;cancelScheduled();const pending=inFlight;if(pending)await pending;
      return {ok:true,stopped:true,uncertain:saveError?.code==='outcome-unknown'};
    },
    privateRecord:()=>record,
    privateRecoveryEvidence:()=>lastAttempt&&['outcome-unknown','conflict'].includes(saveError?.code)?Object.freeze({...lastAttempt,failureCode:saveError.code}):null,
    async inspectRecovery(){
      if(disposed)return failure('closed');
      if(inFlight)await inFlight;
      const evidence=api.privateRecoveryEvidence();
      if(!evidence)return failure('reconciliation-not-needed');
      if(typeof store.inspectRecovery!=='function')return failure('unavailable');
      try{return await store.inspectRecovery(evidence);}catch{return failure('read-error');}
    },
    status:()=>Object.freeze({id:record?.id??null,phase,version,savedVersion,savedStatus,dirty:version>savedVersion,
      recordStatus:record?.status??null,rounds:record?.rounds.length??0,decisions:totalDecisions,
      saving:disposed?'disposed':stopped?'stopped':saveError?'paused':inFlight?'saving':scheduled!==null?'scheduled':'idle',
      recordError,saveError:saveError?Object.freeze({...saveError}):null}),
    dispose(){
      if(disposed)return {ok:true,disposed:true};disposed=true;if(phase==='active')phase='closed';if(ticket)tickets.delete(ticket);ticket=null;cancelScheduled();
      try{store.close?.();}catch{block('outcome-unknown');}
      return {ok:true,disposed:true};
    },
  };
  return Object.freeze(api);
}
