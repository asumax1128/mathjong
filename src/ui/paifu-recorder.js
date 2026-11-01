// 通常対局の牌譜の自動記録（Ver.0.8 第1段階・docs/74）。app.js から呼ぶ同期の窓口で、例外を外へ出さない。
// ・ゲームの進行は記録・保存の成否に依存しない（保存は非同期・待たない。失敗しても対局は続く）。
// ・ゲーム本体・AI の乱数を使わない（記録の ID は crypto.getRandomValues、なければ時刻と連番）。
// ・記録するのは、エンジンが受け付けた行動だけ（牌の選択・ヒントの操作は記録しない）。
// ・記録できない状態（標準でない配牌・記録していない状態の変更）になったら記録をやめ、それまでの検証済みの部分を
//   「記録の失敗による中断」として保存する。完成した牌譜を偽造しない。
// ・試合ごとに独立した保存の流れ（session）を持つ。新しい試合を始めても、前の試合の最後の保存（中断・完了）は
//   その試合のトークンで最後まで行う（前の試合の結果が新しい試合の表示に混ざらない）。
// 参考：PR #37 の src/ui/paifu-session.js（保存の直列化・失敗の分類・世代の分離）。Worker・復旧の照合は第1段階では使わない。
import * as engine from '../engine/paifu.js';

export const RECORDER_STATES = ['off', 'recording', 'saving', 'saved', 'failed', 'error'];
// この記録の保存をやめる失敗（上書き・再試行で解決しない）
const FATAL = ['conflict', 'outcome-unknown', 'record-too-large', 'invalid-record', 'invalid-argument', 'unsupported-version', 'corrupt'];

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
export function createPaifuRecorder({ store, appVersion, onChange = () => {}, schedule = (fn) => setTimeout(fn, 0),
  now = () => new Date(), newId = randomId, recorder = engine } = {}) {
  let cur = null; // いまの試合の session
  const notify = (s) => { if (s === cur) { try { onChange(); } catch { /* 画面の更新の失敗で記録を止めない */ } } };

  function newSession() {
    return { rec: null, game: null, state: 'off', reason: null, saveError: null, savedStatus: null, recordError: null,
      token: null, version: 0, savedVersion: 0, inFlight: false, pending: false, disabled: false, evicted: 0 };
  }
  function change(s, next) { s.rec = next; s.version++; }
  // 保存：1つの session の中では直列（1件ずつ）。保存中に変わったら、終わってから最新を保存する
  function save(s) {
    if (!s.rec || s.disabled) return;
    s.pending = true;
    if (s.inFlight) return;
    s.inFlight = true;
    s.pending = false;
    const snapshot = s.rec, target = s.version, expectedToken = s.token;
    if (s.state !== 'error') s.state = 'saving';
    notify(s);
    // 描画・進行の後に保存する（store.save の中の encode で、記録された選択の再生による検証を行う）
    schedule(() => {
      Promise.resolve().then(() => store.save(snapshot, { expectedToken, evict: true })).then((r) => {
        if (r && r.ok === true && r.metadata && r.metadata.id === snapshot.id) {
          s.token = r.metadata.token; s.savedVersion = target; s.savedStatus = snapshot.status; s.saveError = null;
          s.evicted += r.evicted || 0;
          if (s.state !== 'error') s.state = 'saved';
        } else {
          const code = r && r.error && typeof r.error.code === 'string' ? r.error.code : 'outcome-unknown';
          s.saveError = code;
          if (FATAL.includes(code)) s.disabled = true;
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
    if (!s || !s.rec || s.rec.status !== 'recording' || s.state === 'error') return;
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
      try {
        if (!store || typeof store.save !== 'function') throw new Error('no store');
        change(s, recorder.createPaifu({ id: newId(), createdAt: now().toISOString(), appVersion, mode, length, seedBase, players, match }));
        s.state = 'recording';
      } catch (e) { s.rec = null; s.state = 'error'; s.reason = 'start-failed'; s.recordError = e && e.path ? e.path : 'start-failed'; }
      notify(s);
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
    // ページを離れる（pagehide）：いまの状態（記録中）を保存しておく。ベストエフォート（完了は保証されない）
    flush() {
      const s = cur;
      try { if (s && s.rec && s.rec.rounds.length && s.version > s.savedVersion && !s.disabled) save(s); } catch { /* 無視 */ }
    },
    status() {
      const s = cur || newSession();
      return Object.freeze({ state: s.state, reason: s.reason, saveError: s.saveError, recordError: s.recordError, savedStatus: s.savedStatus,
        recordStatus: s.rec ? s.rec.status : null, rounds: s.rec ? s.rec.rounds.length : 0, dirty: s.version > s.savedVersion, evicted: s.evicted });
    },
    // テスト用（ローカルの検証フックからだけ参照する）：いまの記録
    privateRecord: () => (cur ? cur.rec : null),
  });
}
