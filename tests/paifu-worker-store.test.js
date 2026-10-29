import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaifuWorkerStore,PAIFU_WORKER_PROTOCOL as protocol} from '../src/ui/paifu-worker-store.js';
import {attachPaifuStorageWorker} from '../src/ui/paifu-storage-worker.js';
class WorkerDouble extends EventTarget {
  sent=[];terminated=0;
  postMessage(m){this.sent.push(structuredClone(m));}
  terminate(){this.terminated++;}
  reply(m){this.dispatchEvent(new MessageEvent('message',{data:{protocol,...m}}));}
  result(id,result){this.reply({type:'result',id,result});}
}
function setup(options={}){const w=new WorkerDouble();let made=0;const store=createPaifuWorkerStore({...options,createWorker:()=>{made++;return w;}});return {store,w,made:()=>made};}
const code=(r,c)=>{assert.equal(r.ok,false);assert.equal(r.error.code,c);};
const tick=()=>new Promise(r=>setImmediate(r));
test('Worker保存: 遅延生成・固定プロトコル・閉鎖。app/DOM/保存キーに接続しない',async()=>{
 const {store,w,made}=setup();assert.equal(made(),0);assert.ok(Object.isFrozen(store));
 const result=store.list();assert.equal(made(),1);assert.equal(w.sent[0].type,'init');assert.equal(w.sent[0].config.maxPending,2);
 w.reply({type:'ready'});w.result(1,{ok:true,entries:[],bytes:0});assert.deepEqual(await result,{ok:true,entries:[],bytes:0});
 store.close();store.close();assert.equal(w.terminated,1);code(await store.list(),'closed');
});
test('Worker保存: 投稿時にsnapshotをcloneし、queuedの元データ変更を受けない',async()=>{
 const {store,w}=setup(),p={id:'original',rounds:[{steps:[1]}]};const a=store.save(p);p.id='changed';p.rounds[0].steps.push(2);
 assert.deepEqual(w.sent[1].args[0],{id:'original',rounds:[{steps:[1]}]});w.result(1,{ok:true,metadata:{token:'x'}});await a;store.close();
});
test('Worker保存: queue上限では破棄/置換/再試行せずqueue-fullを返す',async()=>{
 const {store,w}=setup();const a=store.save({id:'a'}),b=store.clearAll();code(await store.remove('b'),'queue-full');assert.equal(w.sent.length,3);
 w.result(1,{ok:true});await a;w.result(2,{ok:true});await b;const c=store.list();w.result(3,{ok:true,entries:[]});await c;store.close();
});
test('Worker保存: loadPrivateの転送後も深いfreezeを復元、verify/listは本文を返さない',async()=>{
 const {store,w}=setup();const a=store.loadPrivate('x');w.result(1,{ok:true,record:{rounds:[{steps:[]}]},metadata:{id:'x'}});const r=await a;
 assert.ok(Object.isFrozen(r.record.rounds[0].steps));assert.throws(()=>r.record.rounds.push({}),TypeError);
 const b=store.verify('x');w.result(2,{ok:true,valid:true,metadata:{id:'x'}});assert.equal('record' in await b,false);store.close();
});
test('Worker保存: 利用不可/設定不正はメインスレッド保存へ黙ってfallbackしない',async()=>{
 let calls=0;const s=createPaifuWorkerStore({createWorker(){calls++;throw Error('CSP/unsupported');}});code(await s.list(),'unavailable');assert.equal(calls,1);
 for(const options of [{maxPending:0},{operationTimeoutMs:0},{maxRecords:0},{maxBytes:Infinity},{timeoutMs:60001}]){
  const {store,made}=setup(options);code(await store.list(),'invalid-argument');assert.equal(made(),0);store.close();
 }
});
test('Worker保存: clone不能入力はrejectせず次の要求が正常',async()=>{
 const {store,w}=setup();code(await store.save({invalid:()=>{}}),'invalid-record');const b=store.list();w.result(2,{ok:true,entries:[]});assert.equal((await b).ok,true);store.close();
});
test('Worker保存: 全体期限超過でWorker終了、投稿済みwriteはoutcome-unknown',async()=>{
 const {store,w}=setup({operationTimeoutMs:5});const a=store.save({}),b=store.list();code(await a,'outcome-unknown');code(await b,'timeout');assert.equal(w.terminated,1);
 w.result(1,{ok:true});code(await store.verify('x'),'timeout');store.close();
});
test('Worker保存: closeは待機中writeも不確定と扱い、再接続/自動再試行しない',async()=>{
 const {store,w,made}=setup();const a=store.save({}),b=store.clearAll();store.close();code(await a,'outcome-unknown');code(await b,'outcome-unknown');assert.equal(made(),1);assert.equal(w.terminated,1);
});
test('Worker保存: error/messageerror/protocol不整合で未処理例外とprivate出力を残さない',async()=>{
 for(const fault of ['error','messageerror','protocol']){
  const {store,w}=setup();const a=store.save({});if(fault==='protocol')w.reply({protocol:99,type:'result',id:1,result:{ok:true}});else w.dispatchEvent(new Event(fault));
  const r=await a;code(r,'outcome-unknown');assert.equal('record' in r,false);assert.equal(w.terminated,1);store.close();
 }
});
test('Worker保存: 古い世代の通知が新世代の要求を完了/停止させない',async()=>{
 const workers=[];const s=createPaifuWorkerStore({createWorker(){const w=new WorkerDouble();workers.push(w);return w;}});
 const a=s.list();workers[0].dispatchEvent(new Event('error'));code(await a,'interrupted');
 const b=s.list();workers[0].result(2,{ok:false,error:{code:'bad'}});workers[1].result(2,{ok:true,entries:[]});assert.equal((await b).ok,true);s.close();
});
test('Worker endpoint: FIFOで実行し、失敗後も次要求が進み、clearの順序を保つ',async()=>{
 const scope=new WorkerDouble(),order=[],releases=[];
 const detach=attachPaifuStorageWorker(scope,{createStore:()=>Object.fromEntries(['save','list','clearAll'].map(k=>[k,async()=>{order.push(k);await new Promise(r=>releases.push(r));return k==='save'?{ok:false,error:{code:'quota-exceeded'}}:{ok:true};}]))});
 scope.reply({type:'init',config:{maxPending:3}});scope.reply({type:'request',id:1,method:'save',args:[]});scope.reply({type:'request',id:2,method:'clearAll',args:[]});scope.reply({type:'request',id:3,method:'list',args:[]});
 assert.deepEqual(order,['save']);releases.shift()();await tick();assert.deepEqual(order,['save','clearAll']);releases.shift()();await tick();releases.shift()();await tick();assert.deepEqual(order,['save','clearAll','list']);
 assert.deepEqual(scope.sent.filter(x=>x.type==='result').map(x=>x.id),[1,2,3]);detach();
});
test('Worker endpoint: 未初期化/未知操作/重複init/過剰待機を拒否し、原文エラーを返さない',async()=>{
 const scope=new WorkerDouble();let release;const detach=attachPaifuStorageWorker(scope,{createStore:()=>({save:()=>new Promise(r=>release=r)})});
 scope.reply({type:'request',id:1,method:'save',args:[]});assert.equal(scope.sent.at(-1).result.error.code,'invalid-argument');
 scope.reply({type:'init',config:{maxPending:1}});scope.reply({type:'request',id:2,method:'save',args:[]});scope.reply({type:'request',id:3,method:'save',args:[]});assert.equal(scope.sent.at(-1).result.error.code,'queue-full');
 scope.reply({type:'request',id:4,method:'upload',args:[]});assert.equal(scope.sent.at(-1).result.error.code,'invalid-argument');scope.reply({type:'init',config:{maxPending:1}});assert.equal(scope.sent.at(-1).type,'fatal');release({ok:true});await tick();detach();
});
