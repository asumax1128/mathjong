import test from 'node:test';
import assert from 'node:assert/strict';
import {describePaifuSaveState as view} from '../src/ui/paifu-save-state.js';
const base={id:'private-id',phase:'active',version:3,savedVersion:2,savedStatus:'recording',saving:'idle',saveError:null};
const status=(code,extra={})=>({...base,saveError:code?{code,message:'SECRET'}:null,...extra});
for(const [name,s,expected] of [
 ['saved',status(null,{savedVersion:3}),'saved'],['unsaved',base,'unsaved'],['saving',status(null,{saving:'saving'}),'saving'],
 ['scheduled',status(null,{saving:'scheduled'}),'saving'],['unknown',status('outcome-unknown'),'uncertain'],
 ['conflict',status('conflict'),'conflict'],['quota',status('quota-exceeded'),'capacity'],
 ['capacity',status('capacity-exceeded'),'capacity'],['record size',status('record-too-large'),'capacity'],
 ['corrupt',status('corrupt'),'review-required'],['unknown schema',status('unsupported-version'),'review-required'],
 ['unavailable',status('unavailable'),'unsaved'],['record failure',status(null,{recordError:'secret'}),'review-required'],
])test(`保存説明: ${name}`,()=>{const x=view(s);assert.equal(x.state,expected);assert.equal(x.automaticResume,false);assert.equal(Object.isFrozen(x),true);});
test('保存説明: ackがない0/0・不正値を保存済みとしない',()=>{
 assert.equal(view({...base,version:0,savedVersion:0}).state,'unsaved');
 for(const s of [null,{},status(null,{version:-1}),status(null,{savedVersion:5}),status(null,{version:NaN})])assert.equal(view(s).state,'review-required');
});
const inspection={ok:true,id:base.id,version:3,failureCode:'outcome-unknown',kind:'attempt-content-present',contentPresent:true,writePerformed:false,automaticResume:false,originalWriteConfirmed:false};
test('保存説明: 同内容を照合してもack/所有権/再開を捏造しない',()=>{
 const s=status('outcome-unknown'),x=view(s,{inspection});assert.equal(x.state,'review-required');assert.equal(x.issue,'uncertain');assert.equal(x.contentPresent,true);assert.equal(x.savedVersion,2);assert.equal(x.dirty,true);assert.match(x.fact,/断定しません/);assert.equal(s.savedVersion,2);
});
test('保存説明: 旧versionの照合を最新状態の保存と混同しない',()=>{
 const x=view(status('outcome-unknown',{version:7}),{inspection});assert.equal(x.inspectedVersion,3);assert.equal(x.version,7);assert.equal(x.savedVersion,2);assert.equal(x.state,'review-required');
});
test('保存説明: 異なるID/未来version/失敗種別/非読取結果の照合を採用しない',()=>{
 for(const change of [{id:'another'},{version:99},{failureCode:'conflict'},{writePerformed:true},{automaticResume:true},{originalWriteConfirmed:true}]){
  const x=view(status('outcome-unknown'),{inspection:{...inspection,...change}});assert.equal(x.inspectionKind,null);assert.equal(x.contentPresent,null);assert.equal(x.state,'review-required');
 }
});
test('保存説明: 削除や異内容は観測事実のみ。未commitだったと断定しない',()=>{
 const x=view(status('outcome-unknown'),{inspection:{...inspection,kind:'missing-after-ack',contentPresent:false}});assert.match(x.fact,/削除か未保存かは断定しません/);assert.equal(x.contentPresent,false);
 const y=view(status('conflict'),{inspection:{...inspection,failureCode:'conflict',kind:'conflicting-content',contentPresent:false}});assert.equal(y.issue,'conflict');assert.match(y.fact,/変更していません/);
});
test('保存説明: 私有本文・ID・token・例外全文は返さない',()=>{
 const secret='SECRET';const x=view({...status('outcome-unknown'),hands:secret,wall:secret,token:secret,json:secret},{inspection:{...inspection,record:secret,observed:{token:secret,json:secret}},released:true});
 const text=JSON.stringify(x);for(const value of [secret,base.id])assert.equal(text.includes(value),false);assert.equal(x.released,true);assert.match(x.acknowledgementNote,/他タブ/);assert.match(x.releaseNote,/保証されません/);
});
test('保存説明: 故障getterでも例外や私有内容を返さない',()=>{
 assert.equal(view({get version(){throw Error('SECRET');}}).state,'review-required');assert.equal(JSON.stringify(view({get version(){throw Error('SECRET');}})).includes('SECRET'),false);
});
