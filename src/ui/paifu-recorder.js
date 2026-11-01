// 通常対局の牌譜の自動記録（Ver.0.8 第1段階・docs/74）。app.js から呼ぶ同期の窓口で、例外を外へ出さない。
// ・ゲームの進行は記録・保存の成否に依存しない（保存は非同期・待たない。失敗しても対局は続く）。
// ・ゲーム本体・AI の乱数を使わない（記録の ID は crypto.getRandomValues、なければ時刻と連番）。
// ・記録するのは、エンジンが受け付けた行動だけ（牌の選択・ヒントの操作は記録しない）。
// ・記録できない状態（標準でない配牌・記録していない状態の変更）になったら記録をやめ、それまでの検証済みの部分を
//   「記録の失敗による中断」として保存する。完成した牌譜を偽造しない。
// ・試合ごとに独立した保存の流れ（session）を持つ。新しい試合を始めても、前の試合の最後の保存（中断・完了）は
//   その試合のトークンで最後まで行う（前の試合の結果が新しい試合の表示に混ざらない）。
// ・試合の開始時の「削除の世代」（epoch）に記録を結び付け、保存のたびに保存先で照合する（全件削除の後に復活させない）。
//   開始時に世代が分からない（読込前・保存できない端末）試合は記録しない。
// 参考：PR #37 の src/ui/paifu-session.js（保存の直列化・失敗の分類・世代の分離）。
import * as engine from '../engine/paifu.js';

export const RECORDER_STATES = ['off', 'recording', 'saving', 'saved', 'failed', 'error'];
// この記録の保存をやめる失敗（上書き・再試行で解決しない）
const FATAL = ['conflict', 'outcome-unknown', 'record-too-large', 'invalid-record', 'invalid-argument', 'unsupported-version', 'corrupt', 'stale-epoch'];
const EXCLUDED = ['exam', 'replay-url', 'old-ruleset'];

function randomId() {
  try {
    const a = new Uint8Array(12);
    globalThis.crypto.getRandomValues(a);
    return 'pf-' + Array.from(a, (n) => n.toString(16).padStart(2, '0')).join('');
  } catch {
    randomId.n = (randomId.n || 0) + 1;
    return `pf-${Date.now().toString(36)}-${randomId.n}`;
  }
}

// store：createPaifuStore() の戻り値（save だけ使う）。onChange：いまの試合の保存状態が変わったとき（画面の更新用）
// epoch：() => { epoch: いまわかっている削除の世代（直前に読んだ値。不明なら null）, error }
// readEpoch：async () => { epoch, error }（DB の現在の世代を読む。BroadcastChannel に依存しない）
// onStaleEpoch：保存が stale-epoch で拒否されたとき
//
// epochAt：() => Promise<{ epoch, error }> | null（呼んだ時点の世代を読む。読取りのトランザクションを同期で作るので、
//   値は試合の開始の時点の世代と一致する。準備ができていなければ null）
//
// 試合の開始時の世代の結び付け（PR #69 第2回監査 P2-A）：試合は直ちに始まり（記録の準備を待たない）、記録は開始と同時に
// メモリ上で始める。
// ・通常（epochAt が使える）：開始の時点の世代をそのまま結び付ける（BroadcastChannel に依存しない・正確）。
//   削除の前に始まった試合は古い世代（保存は拒否される）、削除の後に始まった試合は新しい世代（保存できる）。
// ・代替（接続の準備前など）：DB の現在の世代を非同期に読み、次のどちらかなら、その世代に結び付けて保存を始める：
//   ① 読んだ世代が、開始の時点で知っていた世代（直前に読んだ値）と同じ（＝その間に全件削除はない）
//   ② 違っても、結び付けの前に行動がまだ1つもない（＝開始の前後に削除があっても、記録の欠落も削除の前の行動もない）
// どちらでもなければ（削除の前に始まった可能性のある試合で、すでに行動がある）その試合は記録しない（epoch-changed）。
// 削除の前から存在する試合を新しい世代へ付け替えない・後から不完全な牌譜を作らない。結び付けの前の保存要求は結び付けまで待つ。
export function createPaifuRecorder({ store, appVersion, onChange = () => {}, schedule = (fn) => setTimeout(fn, 0),
  now = () => new Date(), newId = randomId, recorder = engine, epoch: epochSource = () => ({ epoch: 0, error: null }),
  readEpoch = null, epochAt = null, onStaleEpoch = () => {} } = {}) {
  const readNow = readEpoch || (async () => epochSource());
  let cur = null; // いまの試合の session
  const notify = (s) => { if (s === cur) { try { onChange(); } catch { /* 画面の更新の失敗で記録を止めない */ } } };

  function newSession() {
    return { rec: null, game: null, state: 'off', reason: null, saveError: null, savedStatus: null, recordError: null,
      token: null, epoch: null, version: 0, savedVersion: 0, inFlight: false, pending: false, disabled: false,
      bound: false, epochPre: null, actionsBeforeBind: 0, discarded: false };
  }
  function change(s, next) { s.rec = next; s.version++; }
  // 保存：1つの session の中では直列（1件ずつ）。保存中に変わったら、終わってから最新を保存する
  function save(s) {
    if (!s.rec || s.disabled || s.discarded) return;
    s.pending = true;
    if (!s.bound) return; // 世代に結び付くまで待つ（結び付いたら保存する）
    if (s.inFlight) return;
    s.inFlight = true;
    s.pending = false;
    const snapshot = s.rec, target = s.version, expectedToken = s.token;
    if (s.state !== 'error') s.state = 'saving';
    notify(s);
    // 描画・進行の後に保存する（store.save の中の encode で、記録された選択の再生による検証を行う）
    schedule(() => {
      // 保存先は上限で既存の牌譜を削除しない（自動削除なし）。epoch：この試合の開始時の削除の世代
      Promise.resolve().then(() => store.save(snapshot, { expectedToken, epoch: s.epoch })).then((r) => {
        if (r && r.ok === true && r.metadata && r.metadata.id === snapshot.id) {
          s.token = r.metadata.token; s.savedVersion = target; s.savedStatus = snapshot.status; s.saveError = null;
          if (s.state !== 'error') s.state = 'saved';
        } else {
          const code = r && r.error && typeof r.error.code === 'string' ? r.error.code : 'outcome-unknown';
          s.saveError = code;
          if (FATAL.includes(code)) s.disabled = true;
          if (code === 'stale-epoch') { try { onStaleEpoch(); } catch { /* 無視 */ } }
          if (s.state !== 'error') s.state = 'failed';
        }
      }).catch(() => {
        s.saveError = 'outcome-unknown'; s.disabled = true;
        if (s.state !== 'error') s.state = 'failed';
      }).finally(() => {
        s.inFlight = false;
        notify(s);
        if (s.pending && s.version > s.savedVersion && !s.disabled) save(s);
      });
    });
  }
  // この試合を記録しない（保存もしない）。前の試合（cur でない session）にも使う
  function discard(s, reason) {
    s.discarded = true; s.rec = null; s.game = null; s.pending = false; s.state = 'off'; s.reason = reason;
    notify(s);
  }
  // 開始時の世代の結び付け（上の説明）
  function bind(s, r, exact = false) {
    if (s.discarded || s.bound) return;
    if (!r || !Number.isSafeInteger(r.epoch) || r.epoch < 0) { discard(s, r && (r.error || r.ok === false) ? 'storage-unavailable' : 'not-ready'); return; }
    if (exact || (s.epochPre !== null && r.epoch === s.epochPre) || s.actionsBeforeBind === 0) {
      s.epoch = r.epoch; s.bound = true;
      if (s.pending && s.rec) save(s);
      notify(s);
      return;
    }
    discard(s, 'epoch-changed');
  }
  // 記録の失敗：それまでの検証済みの部分を中断として保存し、以後は記録しない
  function fail(s, e) {
    s.recordError = e && e.path ? e.path : 'recording-error';
    s.game = null;
    if (s.rec && s.rec.status === 'recording') {
      try { change(s, recorder.endRecording(s.rec, 'recording-error')); } catch { /* 直前の記録のまま */ }
      if (s.rec.rounds.length) save(s);
    }
    s.state = 'error';
    notify(s);
  }
  const guard = (fn) => {
    const s = cur;
    if (!s || !s.rec || s.discarded || s.rec.status !== 'recording' || s.state === 'error') return;
    try { fn(s); } catch (e) { fail(s, e); }
  };
  function leaveSession(s, why) {
    if (!s || !s.rec || s.rec.status !== 'recording' || s.state === 'error') return;
    try {
      change(s, recorder.endRecording(s.rec, why === 'reset' ? 'reset' : 'left-match'));
      s.game = null;
      if (s.rec.rounds.length) save(s);
      else { s.state = 'off'; s.reason = 'no-rounds'; notify(s); }
    } catch (e) { fail(s, e); }
  }

  return Object.freeze({
    // 試合の開始。eligible が false なら記録しない（reason：卒業試験・再現URL・過去のルールなど）。
    // 前の試合が記録中なら「新しい対局（reset）」として中断を保存する（前の session は独立に保存を終える）
    startMatch({ eligible, reason = null, mode, length, seedBase, players, match }) {
      leaveSession(cur, 'reset');
      const s = cur = newSession();
      if (!eligible) { s.reason = reason || 'not-eligible'; notify(s); return; }
      // 開始の時点で知っている世代（同期で読む。読込前・保存できない端末では null）
      let e = null;
      try { e = epochSource(); } catch { e = null; }
      s.epochPre = e && Number.isSafeInteger(e.epoch) && e.epoch >= 0 ? e.epoch : null;
      try {
        if (!store || typeof store.save !== 'function') throw new Error('no store');
        change(s, recorder.createPaifu({ id: newId(), createdAt: now().toISOString(), appVersion, mode, length, seedBase, players, match }));
        s.state = 'recording';
      } catch (err) { s.rec = null; s.state = 'error'; s.reason = 'start-failed'; s.recordError = err && err.path ? err.path : 'start-failed'; notify(s); return; }
      notify(s);
      // 開始の時点の世代を読み、結び付ける（ゲームは待たない）。読取りのトランザクションはここで同期に作る
      let at = null;
      try { at = epochAt ? epochAt() : null; } catch { at = null; }
      if (at && typeof at.then === 'function') at.then((r) => bind(s, r && r.ok === false ? { error: r.error && r.error.code } : r, true), () => bind(s, { error: 'storage-error' }));
      else Promise.resolve().then(() => readNow()).then((r) => bind(s, r), () => bind(s, { error: 'storage-error' }));
    },
    // 局の開始（Game を作った直後・最初の行動の前）。presetWall（テスト用の山）を使った局は記録をやめる
    roundStarted(g, { presetWall = false } = {}) {
      guard((s) => {
        if (presetWall) throw new engine.PaifuError('round.setup', 'preset wall');
        change(s, recorder.beginRound(s.rec, g));
        s.game = g;
      });
    },
    // エンジンが受け付けた行動（applyAction の成功の直後）。eventsBefore：行動の直前の g.events.length
    actionApplied(g, seat, action, source, eventsBefore) {
      guard((s) => {
        if (g !== s.game) throw new engine.PaifuError('step.game', 'not the recorded game');
        change(s, recorder.appendStep(s.rec, g, { seat, action, source, eventsBefore }));
        if (!s.bound) s.actionsBeforeBind++;
      });
    },
    // 局の精算（applyRoundResult の直後）。保存する
    roundSettled(g, matchAfter, { maxRound = null } = {}) {
      guard((s) => {
        if (g !== s.game) throw new engine.PaifuError('settlement.game', 'not the recorded game');
        change(s, recorder.settleRound(s.rec, g, matchAfter, { maxRound }));
        s.game = null;
        save(s);
      });
    },
    // 途中退出（タイトルへ・相手を変更）：精算を作らずに中断として保存する（終わった試合では何もしない）
    leave(why = 'left-match') { leaveSession(cur, why); },
    // この試合を記録しない（牌譜の機能の読込が試合の途中で終わったときなど）。表示は reason で説明する
    skipMatch(reason = 'not-ready') { leaveSession(cur, 'reset'); cur = newSession(); cur.reason = reason; notify(cur); },
    // ページを離れる（pagehide）：いまの状態（記録中）を保存しておく。ベストエフォート（完了は保証されない）
    flush() {
      const s = cur;
      try { if (s && s.rec && s.rec.rounds.length && s.version > s.savedVersion && !s.disabled) save(s); } catch { /* 無視 */ }
    },
    status() {
      const s = cur || newSession();
      return Object.freeze({ state: s.state, reason: s.reason, saveError: s.saveError, recordError: s.recordError, savedStatus: s.savedStatus,
        recordStatus: s.rec ? s.rec.status : null, rounds: s.rec ? s.rec.rounds.length : 0, dirty: s.version > s.savedVersion,
        inFlight: s.inFlight, everSaved: s.savedVersion > 0, bound: s.bound, epoch: s.epoch });
    },
    // テスト用（ローカルの検証フックからだけ参照する）：いまの記録
    privateRecord: () => (cur ? cur.rec : null),
  });
}

// 保存状態の表示（PR #69 監査 P3-1）：記録中・未保存／保存処理中／保存済み／保存失敗／記録対象外 を区別する。
// 戻り値 { kind, text }（表示しないときは text: null）。kind：excluded・not-recorded・recording・saving・saved・failed・error
const MB = (n) => Math.round(n / (1024 * 1024));
export function describePaifuStatus(st, { limits = { maxRecords: 100, maxBytes: 32 * 1024 * 1024 } } = {}) {
  const lim = `${limits.maxRecords}件・${MB(limits.maxBytes)}MB`;
  if (!st) return { kind: 'not-recorded', text: null };
  if (st.state === 'error') return { kind: 'error', text: '牌譜：この試合は記録できませんでした（ゲームの進行・結果には影響しません）' };
  if (st.state === 'off') {
    if (EXCLUDED.includes(st.reason)) return { kind: 'excluded', text: 'この対局は牌譜の記録の対象外です' };
    if (st.reason === 'not-ready' || st.reason === 'loading') return { kind: 'not-recorded', text: '牌譜：準備ができる前に始まった対局のため、記録していません' };
    if (st.reason === 'storage-unavailable') return { kind: 'not-recorded', text: '牌譜：この端末では保存できないため、記録していません（ブラウザの設定・プライベートモードなど）' };
    if (st.reason === 'unavailable') return { kind: 'not-recorded', text: '牌譜：機能を読み込めなかったため、記録していません（ゲームには影響しません）' };
    if (st.reason === 'epoch-changed') return { kind: 'not-recorded', text: '牌譜：記録の開始を確かめる前に保存済みの牌譜が削除されたため、この試合は記録していません' };
    return { kind: 'not-recorded', text: null };
  }
  if (st.inFlight) return { kind: 'saving', text: '牌譜：この端末に保存しています…' };
  if (st.state === 'failed') {
    const why = {
      'capacity-exceeded': `保存の上限（${lim}）に達しているため保存できませんでした。既存の牌譜は削除していません`,
      'stale-epoch': '保存済みの牌譜がすべて削除されたため、この試合は保存しません',
      'quota-exceeded': '端末の空き容量が足りないため保存できませんでした',
      unavailable: 'この端末に保存できませんでした（ブラウザの設定・プライベートモードなど）',
    }[st.saveError] || '保存できませんでした';
    return { kind: 'failed', text: `牌譜：${why}（ゲームの進行・結果には影響しません）` };
  }
  if (st.state === 'saved' && !st.dirty) {
    const t = st.savedStatus === 'complete' ? 'この試合をこの端末に保存しました（端末内だけ・送信しません）'
      : st.savedStatus === 'aborted' ? '中断した試合をここまでこの端末に保存しました（端末内だけ・送信しません）'
        : 'ここまでの記録をこの端末に保存しました（端末内だけ・送信しません）';
    return { kind: 'saved', text: `牌譜：${t}` };
  }
  // 記録中（未保存の変更がある）
  return { kind: 'recording', text: st.everSaved ? '牌譜：記録中（前の局までは保存済み・この局は局の終わりに保存）' : '牌譜：記録中（まだ保存していません・局の終わりにこの端末へ保存）' };
}
