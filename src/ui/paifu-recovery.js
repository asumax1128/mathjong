// Read-only recovery inspection. Normally executed inside the private storage Worker.
// Never writes, deletes, adopts a token, resumes recording, or confirms who committed a transaction.
import {encodePaifu,PAIFU_MAX_BYTES,PAIFU_SCHEMA_VERSION} from '../engine/paifu.js';
const KEYS=['storageVersion','id','token','revision','bytes','digest','savedAt','schemaVersion','visibility','mode','length','status','rounds'];
const uint=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
const hex=(x,n)=>typeof x==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=128;
const fail=code=>({ok:false,error:{code,retryable:false}});
const bytes=s=>new TextEncoder().encode(s);
function receipt(m,id){
 return m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).sort().join('|')===KEYS.slice().sort().join('|')
  &&m.id===id&&m.storageVersion===1&&m.schemaVersion===PAIFU_SCHEMA_VERSION&&m.visibility==='private-full'
  &&hex(m.token,32)&&hex(m.digest,64)&&uint(m.revision,1)&&uint(m.bytes,1)&&m.bytes<=PAIFU_MAX_BYTES&&uint(m.savedAt)
  &&['math1','math2','legacy'].includes(m.mode)&&[4,8].includes(m.length)&&['recording','complete','aborted'].includes(m.status)&&uint(m.rounds);
}
function sameReceipt(a,b){return KEYS.every(k=>a[k]===b[k]);}
async function sha(text){
 if(!globalThis.crypto?.subtle)throw Error('crypto');let timer;
 try{const hash=await Promise.race([crypto.subtle.digest('SHA-256',bytes(text)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('hash timeout')),5000);})]);return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');}
 finally{clearTimeout(timer);}
}
export async function inspectPaifuRecovery(evidence,{store}={}){
 let id,version,expectedToken,baseline,failureCode,wanted,wantedBytes;
 try{
  if(!evidence||typeof evidence!=='object'||Object.keys(evidence).some(k=>!['id','version','record','expectedToken','acknowledged','failureCode'].includes(k)))return fail('invalid-evidence');
  ({id,version,expectedToken,failureCode}=evidence);baseline=evidence.acknowledged===null?null:structuredClone(evidence.acknowledged);
  if(!validId(id)||!uint(version,1)||!['outcome-unknown','conflict'].includes(failureCode)||typeof store?.loadPrivate!=='function')return fail('invalid-evidence');
  if(expectedToken===null?baseline!==null:!hex(expectedToken,32)||!receipt(baseline,id)||baseline.token!==expectedToken)return fail('invalid-evidence');
  wanted=encodePaifu(evidence.record);const p=JSON.parse(wanted);if(p.id!==id)return fail('invalid-evidence');wantedBytes=bytes(wanted).length;
 }catch{return fail('invalid-evidence');}
 let wantedDigest;
 try{wantedDigest=await sha(wanted);}catch{return fail('unavailable');}
 let loaded;
 try{loaded=await store.loadPrivate(id);}catch{return fail('read-error');}
 const result=(kind,observed,contentPresent,requiresUserDecision)=>Object.freeze({ok:true,kind,id,version,
  failureCode,contentPresent,requiresUserDecision,retryWithExpectedToken:null,originalWriteConfirmed:false,
  writePerformed:false,automaticResume:false,wantedDigest,observed:observed?Object.freeze(structuredClone(observed)):null});
 if(!loaded?.ok){
  if(loaded?.error?.code==='not-found')return result(baseline?'missing-after-ack':'missing-initial',null,false,true);
  const allowed=['unavailable','blocked','timeout','interrupted','corrupt','unsupported-version'];
  return fail(allowed.includes(loaded?.error?.code)?loaded.error.code:'read-error');
 }
 let observed,actual,actualDigest;
 try{
  observed=structuredClone(loaded.metadata);if(!receipt(observed,id))return fail('corrupt');
  actual=encodePaifu(loaded.record);const p=JSON.parse(actual);
  if(p.id!==id||p.schemaVersion!==observed.schemaVersion||p.visibility!==observed.visibility||p.settings.rules.mode!==observed.mode
    ||p.initialMatch.length!==observed.length||p.status!==observed.status||p.rounds.length!==observed.rounds)return fail('corrupt');
 }catch{return fail('corrupt');}
 try{actualDigest=await sha(actual);}catch{return fail('unavailable');}
 // Our v1 writer stores canonical encodePaifu bytes. Unrecognised encodings fail closed, never rewritten.
 if(bytes(actual).length!==observed.bytes||actualDigest!==observed.digest)return fail('corrupt');
 const present=actualDigest===wantedDigest&&observed.bytes===wantedBytes&&actual===wanted;
 if(baseline&&observed.token===baseline.token){
  if(!sameReceipt(observed,baseline))return result('changed-under-known-token',observed,present,true);
  // Receipt equality does not prove that a different attempted archive extends this history.
  // Inspection alone never authorises a replacement, even with an unchanged token.
  return result(present?'already-acknowledged':'baseline-unchanged',observed,present,!present);
 }
 if(present){
  const expectedRevision=baseline?baseline.revision+1:1;
  if(failureCode==='conflict'||observed.revision!==expectedRevision)return result('same-content-other-writer',observed,true,true);
  return result('attempt-content-present',observed,true,false);
 }
 return result('conflicting-content',observed,false,true);
}
