// Unit tests cover failure contracts and request lifecycle. Actual IDB data/atomicity is tested in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaifuStore, PAIFU_DB_NAME, PAIFU_DB_VERSION, PAIFU_STORAGE_DEFAULTS } from '../src/ui/paifu-storage.js';
import { createPaifu, captureGame } from '../src/engine/paifu.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { rulesFor } from './helpers.js';
import { createMatch } from '../src/engine/match.js';
const p=createPaifu({id:'storage-unit',rules:rulesFor('math1'),players:['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'})),match:createMatch()});
const code=(r,c)=>{assert.equal(r.ok,false);assert.equal(r.error.code,c);assert.equal('record' in r,false);};
const operations=s=>[()=>s.save(p),()=>s.loadPrivate('storage-unit'),()=>s.verify('storage-unit'),()=>s.list(),()=>s.remove('storage-unit'),()=>s.clearAll()];

// These fake factories deliberately cannot perform a database operation. They only deliver native-style
// open/error/blocked events so unsupported platforms can be exercised without emulating IDB internals.
function failedOpen(name) { return { open(db,version){assert.equal(db,PAIFU_DB_NAME);assert.equal(version,PAIFU_DB_VERSION);const r={error:new DOMException('injected',name)};queueMicrotask(()=>r.onerror());return r;} }; }

test('保存アダプター: import/factoryはDBを開かず、固定された専用名前空間だけを使う',()=>{
  let opened=0;const s=createPaifuStore({getIndexedDB(){opened++;throw Error('must be lazy');}});
  assert.equal(opened,0);assert.ok(Object.isFrozen(s));
  assert.equal(PAIFU_DB_NAME,'mathjong-paifu');assert.equal(PAIFU_DB_VERSION,1);
  assert.deepEqual(PAIFU_STORAGE_DEFAULTS,{maxRecords:20,maxBytes:32*1024*1024,timeoutMs:5000});
  assert.deepEqual(Object.keys(s).sort(),['clearAll','list','loadPrivate','remove','save','verify']);
});
for(const mode of ['missing','getter-security','open-security'])test(`保存アダプター: ${mode}でも全操作がrejectせず利用不可を返す`,async()=>{
  const s=createPaifuStore({getIndexedDB:()=>{
    if(mode==='missing')return undefined;
    if(mode==='getter-security')throw new DOMException('Safari-like denial','SecurityError');
    return {open(){throw new DOMException('denied','SecurityError');}};
  }});
  for(const op of operations(s))code(await op(),'unavailable');
});
for(const [name,expected] of [['QuotaExceededError','quota-exceeded'],['NS_ERROR_DOM_QUOTA_REACHED','quota-exceeded'],['VersionError','unsupported-version'],['AbortError','interrupted'],['UnknownError','storage-error']])test(`保存アダプター: 非同期openの${name}を構造化し、未処理例外にしない`,async()=>{
  const s=createPaifuStore({getIndexedDB:()=>failedOpen(name)});
  code(await s.loadPrivate('x'),expected);
});

test('保存アダプター: blocked後の遅い成功は接続を閉じ、後から書き込まない',async()=>{
  let req,closed=0,transactions=0;
  const db={close(){closed++;},transaction(){transactions++;throw Error('late transaction');}};
  const s=createPaifuStore({getIndexedDB:()=>({open(){req={};queueMicrotask(()=>req.onblocked());return req;}})});
  code(await s.loadPrivate('x'),'blocked');req.result=db;req.onsuccess();
  assert.equal(closed,1);assert.equal(transactions,0);
});

test('保存アダプター: openタイムアウト後のupgradeを中断し、成功通知も閉じる',async()=>{
  let req,closed=0,aborted=0;
  const s=createPaifuStore({timeoutMs:5,getIndexedDB:()=>({open(){req={};return req;}})});
  code(await s.loadPrivate('x'),'timeout');
  req.transaction={abort(){aborted++;}};req.onupgradeneeded({oldVersion:0});
  req.result={close(){closed++;}};req.onsuccess();
  assert.equal(aborted,1);assert.equal(closed,1);
});

test('保存アダプター: 初期化失敗を返し、既存DBを削除/再作成しない',async()=>{
  let aborted=0,created=0;
  const s=createPaifuStore({getIndexedDB:()=>({open(){const r={transaction:{abort(){aborted++;}},result:{createObjectStore(){created++;throw new DOMException('quota','QuotaExceededError');}}};queueMicrotask(()=>r.onupgradeneeded({oldVersion:0}));return r;}})});
  code(await s.loadPrivate('x'),'quota-exceeded');assert.equal(aborted,1);assert.equal(created,1);
});

test('保存アダプター: 不正な保存データ・ID・オプションをDBに触らず拒否',async()=>{
  let opened=0;const s=createPaifuStore({getIndexedDB:()=>{opened++;throw Error('unexpected DB access');}});
  code(await s.save({...p,schemaVersion:999}),'invalid-record');
  for(const id of ['',null,1,{},'x'.repeat(129)]){
    code(await s.loadPrivate(id),'invalid-argument');code(await s.verify(id),'invalid-argument');code(await s.remove(id),'invalid-argument');
  }
  for(const options of [null,[],{overwrite:true},{expectedToken:'invalid'}]){
    code(await s.save(p,options),'invalid-argument');code(await s.remove('x',options),'invalid-argument');
  }
  assert.equal(opened,0);
});

test('保存アダプター: 無効な容量/タイムアウト設定でもpublic操作はthrow/rejectしない',async()=>{
  for(const options of [{maxRecords:0},{maxBytes:0},{maxBytes:Infinity},{timeoutMs:0},{timeoutMs:60001},{getIndexedDB:1}]){
    const s=createPaifuStore(options);for(const op of operations(s))code(await op(),'invalid-argument');
  }
});

test('保存アダプター: 不正スキーマ接続は閉じ、unknown DBを勝手にupgradeしない',async()=>{
  let closed=0;
  const s=createPaifuStore({getIndexedDB:()=>({open(){const r={result:{version:1,objectStoreNames:[],close(){closed++;}}};queueMicrotask(()=>r.onsuccess());return r;}})});
  code(await s.list(),'corrupt');assert.equal(closed,1);
});

test('保存アダプター: 保存利用不可でも実Gameが進行し、非保存Gameと状態・乱数が一致',async()=>{
  const s=createPaifuStore({getIndexedDB:()=>undefined}),rules=rulesFor('math1'),players=p.settings.players;
  const a=new Game({rules,seed:81,players}),b=new Game({rules,seed:81,players});
  for(let i=0;i<8;i++){
    const q=a.pending(),action=q.type==='claim'?{type:'pass'}:{type:'discard',tile:a.drawn};
    applyAction(a,q.seat,action);const saved=await s.save(p);code(saved,'unavailable');
    applyAction(b,q.seat,action);a.checkInvariants();assert.deepEqual(captureGame(a),captureGame(b));
  }
  assert.equal(a.rng.next(),b.rng.next());
});

test('保存アダプター: commit境界でabort不能なら未保存と断定せずoutcome-unknownを返す',async()=>{
  let tx,closed=0,clears=0;
  const db={version:1,objectStoreNames:['records','index'],close(){closed++;},transaction(){
    tx={error:null,objectStore(){return {keyPath:'id',autoIncrement:false,clear(){clears++;}};},abort(){throw new DOMException('already committing','InvalidStateError');}};
    return tx;
  }};
  const s=createPaifuStore({timeoutMs:5,getIndexedDB:()=>({open(){const r={result:db};queueMicrotask(()=>r.onsuccess());return r;}})});
  const r=await s.clearAll();code(r,'outcome-unknown');assert.equal(r.error.retryable,false);
  assert.equal(closed,1);assert.equal(clears,2);tx.oncomplete();
  assert.equal(r.error.code,'outcome-unknown','late completion must not change the returned result');
});
