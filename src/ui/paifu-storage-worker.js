// Private Worker endpoint. Uses the UNCHANGED full validator and atomic IndexedDB adapter.
import {createPaifuStore} from './paifu-storage.js';
import {PAIFU_WORKER_PROTOCOL as protocol,PAIFU_WORKER_METHODS} from './paifu-worker-store.js';
const writes=new Set(['save','remove','clearAll']);
const fail=code=>({ok:false,error:{code,retryable:code==='queue-full'}});
export function attachPaifuStorageWorker(scope,{createStore=createPaifuStore}={}) {
  let store=null,busy=false,limit=2;
  const queue=[];
  function send(m){scope.postMessage({protocol,...m});}
  async function pump(){
    if(busy)return;busy=true;
    try{
      while(queue.length){
        const job=queue.shift();let result;
        try{result=await store[job.method](...job.args);}
        catch{result=fail(writes.has(job.method)?'outcome-unknown':'storage-error');}
        try{send({type:'result',id:job.id,result});}
        catch{try{send({type:'result',id:job.id,result:fail(writes.has(job.method)?'outcome-unknown':'storage-error')});}catch{scope.close?.();queue.length=0;}}
      }
    }finally{busy=false;}
  }
  function receive({data:m}){
    if(!m||m.protocol!==protocol){send({type:'fatal'});return;}
    if(m.type==='init'){
      if(store||!m.config||!Number.isSafeInteger(m.config.maxPending)||m.config.maxPending<1||m.config.maxPending>8){send({type:'fatal'});return;}
      const {maxPending,...config}=m.config;limit=maxPending;
      try{store=createStore(config);send({type:'ready'});}catch{send({type:'fatal'});}return;
    }
    if(m.type!=='request'||!store||!Number.isSafeInteger(m.id)||m.id<1||!PAIFU_WORKER_METHODS.includes(m.method)||!Array.isArray(m.args)){
      send({type:'result',id:m.id,result:fail('invalid-argument')});return;
    }
    if(queue.length+(busy?1:0)>=limit){send({type:'result',id:m.id,result:fail('queue-full')});return;}
    queue.push(m);void pump();
  }
  scope.addEventListener('message',receive);
  return ()=>scope.removeEventListener('message',receive);
}
if(typeof DedicatedWorkerGlobalScope!=='undefined'&&globalThis instanceof DedicatedWorkerGlobalScope)attachPaifuStorageWorker(globalThis);
