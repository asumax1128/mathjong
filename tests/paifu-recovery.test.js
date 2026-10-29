import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectPaifuRecovery} from '../src/ui/paifu-recovery.js';
import {createPaifuSession} from '../src/ui/paifu-session.js';
import {createPaifu,beginRound,endRecording,encodePaifu} from '../src/engine/paifu.js';
import {Game} from '../src/engine/game.js';
import {createMatch} from '../src/engine/match.js';
import {rulesFor} from './helpers.js';
const rules=rulesFor('math1'),players=['kanata','tara','nocchi','yujin'].map(id=>({id,name:id,kind:'ai'})),match=createMatch();
const old=createPaifu({id:'recover',rules,players,match}),next=beginRound(old,new Game({rules,players,seed:1})),other=endRecording(old,{reason:'reset'});
function metadata(p,token='a'.repeat(32),revision=1){const json=encodePaifu(p);return {storageVersion:1,id:p.id,token,revision,bytes:Buffer.byteLength(json),digest:createHash('sha256').update(json).digest('hex'),savedAt:100,schemaVersion:1,visibility:'private-full',mode:p.settings.rules.mode,length:p.initialMatch.length,status:p.status,rounds:p.rounds.length};}
const baseline=metadata(old),newMeta=metadata(next,'b'.repeat(32),2);
function evidence(options={}){return {id:'recover',version:2,record:next,expectedToken:baseline.token,acknowledged:baseline,failureCode:'outcome-unknown',...options};}
function backing(record=next,m=newMeta){let calls=0;return {get calls(){return calls;},async loadPrivate(id){assert.equal(id,'recover');calls++;return {ok:true,record,metadata:m};},save(){throw Error('unexpected write');},remove(){throw Error('unexpected delete');},clearAll(){throw Error('unexpected clear');}};}
const inspect=(e,s)=>inspectPaifuRecovery(e,{store:s});
const error=(r,c)=>{assert.equal(r.ok,false);assert.equal(r.error.code,c);};
test('復旧照合: 希望snapshotの存在を確認するが、元transactionの成功/所有権/自動再開と混同しない',async()=>{
 const store=backing(),r=await inspect(evidence(),store);assert.equal(r.kind,'attempt-content-present');assert.equal(r.contentPresent,true);assert.equal(r.originalWriteConfirmed,false);assert.equal(r.writePerformed,false);assert.equal(r.automaticResume,false);assert.equal(r.retryWithExpectedToken,null);assert.equal(store.calls,1);for(const k of ['record','json','wall','hands'])assert.equal(k in r,false);
});
test('復旧照合: 旧receipt不変だけでは再試行を許可せず、変更する内容はユーザー判断',async()=>{
 const r=await inspect(evidence(),backing(old,baseline));assert.equal(r.kind,'baseline-unchanged');assert.equal(r.retryWithExpectedToken,null);assert.equal(r.contentPresent,false);assert.equal(r.requiresUserDecision,true);assert.equal(r.writePerformed,false);
});
test('復旧照合: 希望内容が既存ackと同じなら追加書込みを必要としない',async()=>{
 const r=await inspect(evidence({record:old}),backing(old,baseline));assert.equal(r.kind,'already-acknowledged');assert.equal(r.contentPresent,true);assert.equal(r.retryWithExpectedToken,null);
});
for(const code of ['outcome-unknown','conflict'])test(`復旧照合: ${code}で別内容を検出したら上書きせずユーザー判断`,async()=>{
 const r=await inspect(evidence({failureCode:code}),backing(other,metadata(other,'c'.repeat(32),2)));assert.equal(r.kind,'conflicting-content');assert.equal(r.requiresUserDecision,true);assert.equal(r.contentPresent,false);assert.equal(r.retryWithExpectedToken,null);
});
test('復旧照合: CAS競合なら同一内容でも別writerとして扱う',async()=>{
 const r=await inspect(evidence({failureCode:'conflict'}),backing());assert.equal(r.kind,'same-content-other-writer');assert.equal(r.contentPresent,true);assert.equal(r.requiresUserDecision,true);
});
test('復旧照合: 新規createの内容がrevision1で存在する場合の読取り復旧',async()=>{
 const r=await inspect(evidence({expectedToken:null,acknowledged:null}),backing(next,metadata(next,'c'.repeat(32),1)));assert.equal(r.kind,'attempt-content-present');assert.equal(r.originalWriteConfirmed,false);
});
test('復旧照合: 同一内容でもrevision飛越しを自分の失敗書込みと決めつけない',async()=>{
 for(const revision of [1,3,99]){const r=await inspect(evidence(),backing(next,metadata(next,'c'.repeat(32),revision)));assert.equal(r.kind,'same-content-other-writer');assert.equal(r.requiresUserDecision,true);}
});
for(const previous of [true,false])test(`復旧照合: rowなし（過去ack=${previous}）は未書込/削除を推測せず再作成しない`,async()=>{
 const r=await inspect(evidence(previous?{}:{expectedToken:null,acknowledged:null}),{loadPrivate:async()=>({ok:false,error:{code:'not-found'}})});assert.equal(r.kind,previous?'missing-after-ack':'missing-initial');assert.equal(r.requiresUserDecision,true);assert.equal(r.retryWithExpectedToken,null);
});
test('復旧照合: 同じtokenの内容/receipt変更を検出して自動採用しない',async()=>{
 const r=await inspect(evidence(),backing(next,metadata(next,baseline.token,2)));assert.equal(r.kind,'changed-under-known-token');assert.equal(r.requiresUserDecision,true);
});
test('復旧照合: 異なるID・旧token・不正な証拠はDBを読む前に拒否',async()=>{
 for(const patch of [{id:'other'},{version:0},{expectedToken:'bad'},{failureCode:'timeout'},{acknowledged:null},{record:{...next,schemaVersion:999}},{acknowledged:{...baseline,token:'f'.repeat(32)}},{unexpected:true}]){const store=backing();error(await inspect(evidence(patch),store),'invalid-evidence');assert.equal(store.calls,0);}
});
test('復旧照合: 保存内容/サイズ/hash/型の不整合は成功にせず、データを修復/削除しない',async()=>{
 for(const patch of [{digest:'0'.repeat(64)},{bytes:newMeta.bytes+1},{token:BigInt('1'.repeat(32))},{id:'other'},{status:'complete'},{revision:0},{storageVersion:99}])error(await inspect(evidence(),backing(next,{...newMeta,...patch})),'corrupt');
 error(await inspect(evidence(),backing({...next,id:'other'},newMeta)),'corrupt');
});
for(const code of ['corrupt','unsupported-version','unavailable','blocked','timeout'])test(`復旧照合: 読込${code}を保持し、未知版/壊れたデータを消去しない`,async()=>{
 error(await inspect(evidence(),{loadPrivate:async()=>({ok:false,error:{code}})}),code);
});
test('復旧照合: 読込throwのprivate情報を返さずread-error',async()=>{
 const r=await inspect(evidence(),{loadPrivate:async()=>{throw Error('private wall details');}});error(r,'read-error');assert.equal(JSON.stringify(r).includes('private'),false);
});
test('復旧照合: ハッシュAPIの失敗を破損と決めつけない',async()=>{
 const digest=crypto.subtle.digest;let n=0;
 try{crypto.subtle.digest=function(...args){if(++n===2)return Promise.reject(Error('crypto unavailable'));return digest.apply(this,args);};error(await inspect(evidence(),backing()),'unavailable');}
 finally{crypto.subtle.digest=digest;}
});
test('復旧照合: 非同期処理中の元evidence変更を受けず、投稿snapshotを照合',async()=>{
 const e=structuredClone(evidence()),pending=inspect(e,backing());e.id='changed';e.record.id='changed';e.acknowledged.token='d'.repeat(32);assert.equal((await pending).kind,'attempt-content-present');
});
test('復旧照合: 読取後の別writer変更はCASで拒否（照合結果は永久ロックではない）',async()=>{
 let current=baseline;const store={loadPrivate:async()=>{const r={ok:true,record:old,metadata:baseline};current=newMeta;return r;}};const r=await inspect(evidence(),store);assert.equal(r.kind,'baseline-unchanged');assert.equal(r.retryWithExpectedToken,null);assert.equal(r.requiresUserDecision,true);assert.notEqual(baseline.token,current.token); // A separate, explicit write using the old token would conflict.
});
test('session照合: inspectは保存成功version/自動retryを進めず、失敗時snapshotを使う',async()=>{
 let saves=0,seen;const store={save:async()=>{saves++;return {ok:false,error:{code:'outcome-unknown'}};},inspectRecovery:async e=>{seen=e;return {ok:true,kind:'attempt-content-present',writePerformed:false};}};
 const s=createPaifuSession({id:'recover',rules,players,match},{store});s.roundStarted(new Game({rules,players,seed:1}));error(await s.flush(),'outcome-unknown');const before=s.status();const r=await s.inspectRecovery();assert.equal(r.kind,'attempt-content-present');assert.equal(seen.version,before.version);assert.equal(seen.failureCode,'outcome-unknown');assert.equal(s.status().savedVersion,0);assert.equal(saves,1);error(s.retrySaving(),'reconciliation-required');s.dispose();
});
test('session照合: 不要時/利用不可/閉鎖後を明示し、GameもDBも操作しない',async()=>{
 const s=createPaifuSession({id:'recover',rules,players,match},{store:{save:async()=>({ok:false,error:{code:'outcome-unknown'}})}});error(await s.inspectRecovery(),'reconciliation-not-needed');s.roundStarted(new Game({rules,players,seed:1}));await s.flush();error(await s.inspectRecovery(),'unavailable');s.dispose();error(await s.inspectRecovery(),'closed');
});

test('復旧監査P3: 同一IDの別モード/別対局を、旧receiptだけで安全なretry候補にしない',async()=>{
 const changed=createPaifu({id:'recover',rules:rulesFor('math2'),players,match:createMatch()});const r=await inspect(evidence({record:changed}),backing(old,baseline));assert.equal(r.kind,'baseline-unchanged');assert.equal(r.requiresUserDecision,true);assert.equal(r.retryWithExpectedToken,null);assert.equal(r.writePerformed,false);
});
