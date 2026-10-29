// Presentation-only projection. Never return private payloads, IDs, tokens or arbitrary error text.
const states = Object.freeze({
  saved:'この時点までの保存応答を確認しました。', unsaved:'未保存の記録があります。',
  saving:'保存処理中です。完了はまだ確認できていません。',
  uncertain:'保存結果が不明です。読み直しによる確認が必要です。',
  capacity:'保存容量が不足しています。既存の牌譜は削除していません。',
  conflict:'別の更新と競合しました。自動で上書きしません。',
  'review-required':'記録の保存状態を確認してください。',
});
const kinds = new Set(['attempt-content-present','already-acknowledged','baseline-unchanged','same-content-other-writer',
  'conflicting-content','changed-under-known-token','missing-initial','missing-after-ack']);
const number = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
export function describePaifuSaveState(status, {inspection = null, released = false} = {}) {
  try {
    const version=number(status?.version),savedVersion=number(status?.savedVersion),code=status?.saveError?.code;
    const valid=version!==null&&savedVersion!==null&&savedVersion<=version;
    let state=!valid?'review-required':code==='outcome-unknown'?'uncertain':code==='conflict'?'conflict'
      :['quota-exceeded','capacity-exceeded','record-too-large'].includes(code)?'capacity'
      :status.recordError||['corrupt','unsupported-version','invalid-record'].includes(code)?'review-required'
      :code?'unsaved':['saving','scheduled'].includes(status.saving)?'saving'
      :version>0&&version===savedVersion?'saved':'unsaved';
    const issue=['uncertain','conflict'].includes(state)?state:null;
    let inspectedVersion=null,inspectionKind=null,contentPresent=null,fact=null;
    if(inspection!==null&&issue){
      state='review-required';
      const matches=inspection.id===status.id&&number(inspection.version)>0&&inspection.version<=version&&inspection.failureCode===code;
      if(matches&&inspection.ok===true&&kinds.has(inspection.kind)&&inspection.writePerformed===false
        &&inspection.automaticResume===false&&inspection.originalWriteConfirmed===false&&typeof inspection.contentPresent==='boolean'){
        inspectedVersion=inspection.version;inspectionKind=inspection.kind;contentPresent=inspection.contentPresent;
        fact=contentPresent?'照合時点で要求と同じ内容が見つかりました。書込者や元の処理の成功は断定しません。'
          :['missing-initial','missing-after-ack'].includes(inspectionKind)?'照合時点で保存行が見つかりませんでした。削除か未保存かは断定しません。'
          :'照合した保存内容は要求と一致しません。既存データを変更していません。';
      }else fact='安全に照合できていません。保存の成功や再開を判断しないでください。';
    }
    return Object.freeze({state,message:states[state],version:valid?version:null,savedVersion:valid?savedVersion:null,
      acknowledgedPrefix:valid&&savedVersion>0,dirty:valid?version>savedVersion:null,
      savedStatus:['recording','complete','aborted'].includes(status?.savedStatus)?status.savedStatus:null,
      issue,reviewRequired:['uncertain','conflict','review-required'].includes(state),
      inspectedVersion,inspectionKind,contentPresent,fact,automaticResume:false,
      released:released===true,releaseNote:released===true?'記録処理のメモリは解放対象です。未保存分の保持は保証されません。':null,
      acknowledgementNote:'保存応答の履歴です。他タブでの更新・削除後の現存は保証しません。'});
  }catch{return Object.freeze({state:'review-required',message:states['review-required'],automaticResume:false});}
}
