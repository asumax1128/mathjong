// Opt-in private storage on a dedicated module Worker. Never imported by app.js.
// Structured clone snapshots inputs at submission; no JSON/verification is done here.
export const PAIFU_WORKER_PROTOCOL = 1;
export const PAIFU_WORKER_METHODS = Object.freeze(['save','loadPrivate','verify','list','remove','clearAll','inspectRecovery']);
const writes = new Set(['save','remove','clearAll']);
const uint = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const fail = (code, retryable = false) => ({ok:false,error:{code,retryable}});
function freezeResult(value) {
  // Worker structured clone does not preserve Object.freeze. Restore the private API's immutability.
  const pending=[value],seen=new WeakSet();
  while(pending.length){const x=pending.pop();if(!x||typeof x!=='object'||seen.has(x))continue;
    seen.add(x);for(const v of Object.values(x))if(v&&typeof v==='object')pending.push(v);Object.freeze(x);
  }
  return value;
}
export function createPaifuWorkerStore({maxRecords=20,maxBytes=32*1024*1024,timeoutMs=5000,
  operationTimeoutMs=30000,maxPending=2,
  createWorker=()=>new Worker(new URL('./paifu-storage-worker.js',import.meta.url),{type:'module',name:'mathjong-private-paifu'})}={}) {
  const valid=uint(maxRecords,1,10000)&&uint(maxBytes,1,256*1024*1024)&&uint(timeoutMs,1,60000)
    &&uint(operationTimeoutMs,1,120000)&&uint(maxPending,1,8)&&typeof createWorker==='function';
  let worker=null,closed=false,nextId=0;
  const pending=new Map();
  function stop(code) {
    const old=worker;worker=null;
    if(old){old.removeEventListener('message',onMessage);old.removeEventListener('error',onError);old.removeEventListener('messageerror',onError);try{old.terminate();}catch{/* unavailable worker */}}
    for(const job of pending.values()){
      clearTimeout(job.timer);
      // Posted writes may have crossed commit before termination. Never claim guaranteed rollback.
      job.resolve(fail(writes.has(job.method)?'outcome-unknown':code));
    }
    pending.clear();
  }
  function onError(event){event?.preventDefault?.();stop('interrupted');}
  function onMessage(event) {
    if(event.currentTarget!==worker)return; // Ignore notifications from a terminated generation.
    const m=event.data;
    if(!m||m.protocol!==PAIFU_WORKER_PROTOCOL){stop('storage-error');return;}
    if(m.type==='ready')return;
    if(m.type==='fatal'){stop('unavailable');return;}
    const job=pending.get(m.id);
    if(m.type!=='result'||!job||!m.result||typeof m.result.ok!=='boolean'){
      stop('storage-error');return;
    }
    pending.delete(m.id);clearTimeout(job.timer);
    try{job.resolve(freezeResult(m.result));}catch{job.resolve(fail('storage-error'));}
  }
  function submit(method,args) {
    if(closed)return Promise.resolve(fail('closed'));
    if(!valid)return Promise.resolve(fail('invalid-argument'));
    if(pending.size>=maxPending)return Promise.resolve(fail('queue-full',true));
    try{
      if(!worker){
        worker=createWorker();
        worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onError);
        worker.postMessage({type:'init',protocol:PAIFU_WORKER_PROTOCOL,config:{maxRecords,maxBytes,timeoutMs,maxPending}});
      }
    }catch{stop('unavailable');return Promise.resolve(fail('unavailable'));}
    return new Promise(resolve=>{
      const id=++nextId,job={method,resolve,timer:null};pending.set(id,job);
      job.timer=setTimeout(()=>stop('timeout'),operationTimeoutMs);
      try{
        // postMessage performs structured clone now, not when a queued operation later starts.
        worker.postMessage({type:'request',protocol:PAIFU_WORKER_PROTOCOL,id,method,args});
      }catch{
        pending.delete(id);clearTimeout(job.timer);resolve(fail(method==='save'?'invalid-record':'invalid-argument'));
      }
    });
  }
  const api=Object.fromEntries(PAIFU_WORKER_METHODS.map(method=>[method,(...args)=>submit(method,args)]));
  return Object.freeze({...api,close(){if(!closed){closed=true;stop('interrupted');}return {ok:true,closed:true};}});
}
