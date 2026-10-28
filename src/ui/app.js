// MATHJONG 画面制御。ゲームの判定はすべて engine 側で行い、ここは表示と入力だけを担当する。
import { createRules } from '../engine/rules.js';
import { makeConfig, MODES, DEFAULT_MODE, ENGINE_VERSION } from '../engine/config.js';
import { Game } from '../engine/game.js';
import { decide, applyAction, PERSONALITIES } from '../engine/ai.js';
import { decideCharacter, rosterForLevel, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../engine/characters.js';
import { OPPONENTS, PICK_COUNT, LEVEL_LABELS, opponentById, toggleOpponent, canStartWith, drawOpponents, assignSeats } from './opponents.js';
import { matchInfo } from '../engine/ai-levels.js';
import { createRng } from '../engine/rng.js';
import { trigExact } from '../engine/exact.js';
import { tileHTML, formulaHTML, backHTML, valueHTML, angleHTML, angleText } from './render.js';
import { yakuCandidates, warmUp, claimForSeat } from '../engine/yakuhint.js';
import { hintKey } from './hintstate.js';
import { analyzeFormulas, initialSelection, assignColors, exposedSummary } from '../engine/formulahint.js';
import { createMatch, applyRoundResult, dealerOf, handLabel, ranks, matchAt, START_POINTS } from '../engine/match.js';
import { reconcileOrder, defaultOrder } from './handorder.js';
import { createHandDrag } from './handdrag.js';
import { CHI_AUTOPASS_KEY, PON_AUTOPASS_KEY, parseChiAutoPass, parsePonAutoPass, visibleClaimActions, claimPendingForHint, claimPolicy, autoPassDue, policySettings, autoPassedKind, mergeKind, autoPassNotice } from './autopass.js';
import { YAKU_GUIDE, GUIDE_NOTES, guideCondition } from './guide.js';
import { createRoomState, pickRoomTile, checkRoom, nextRoom, roomHint, roomHTML, enterStage, gotoStage, resumeRoom, retryRoom, openRoomList, roomPracticeSelect, roomPracticeAct, roomPracticeContinue, partsOf } from './beginner-room.js';
import { loadProgress, saveProgress, hasProgress } from './beginner-progress.js';
import { isLocalHost, resolveSpeed, speedDelays, publicSpeedNames, MAX_ROUND } from './params.js';
import { validateReplay, replayQuery } from './replay.js';
import { EFFECTS, EFFECT_MODE_KEY, parseEffectMode, scanEffects, fxOffer, fxAdvance, fxTimes, fxProgress, isLiteEffect } from './effects.js';
import { SOUND_KEY, parseSoundSetting, pickSound, createSoundPlayer } from './sound.js';
import { VOICE_KEY, parseVoiceSetting, createVoicePlayer } from './voice.js';

// 画面（UI）の版。エンジン（判定・AI）の版 ENGINE_VERSION とは別に管理する。
// ヘッダー・ページタイトル・再現情報はすべてこの値から表示する（index.html の title は tests/autopass.test.js で照合）。
const APP_VERSION = '0.6.1';
document.title = `数雀（MATHJONG）Ver.${APP_VERSION}`;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作する */ } },
};
// 初心者の部屋の進み具合（専用のキー。保存できない環境では画面の記憶だけで動く）
const roomStorage = () => { try { return window.localStorage; } catch { return null; } };
function saveRoom() { if (S.beginnerRoom) S.beginnerRoom.saveOk = saveProgress(roomStorage(), S.beginnerRoom.progress); }
const params = new URLSearchParams(location.search);
// テスト専用機能（山の指定・AI待ち時間0）はローカル開発環境でのみ有効。公開サイトでは無効。
const IS_LOCAL = isLocalHost(location.hostname);
// 再現 URL（Ver.0.4-A）：?seed=（0〜999,999,999）がある URL は、タイトルを飛ばしてその局から始める。
//   従来形式 ?seed&round、新形式 ?seed&round&dealer&hand&renchan&len[&mode]。src/ui/replay.js で、各値の範囲と
//   局状態の組み合わせ（round ≥ hand + renchan + 1、hand < len など）を検証する。不整合な URL は別の局面として
//   黙って始めず、エラー画面（タイトルへ戻れる）を出す。seed がない・不正な URL は通常のタイトル画面。
const savedLen = (() => { const v = store.get('mj-length', null); return v === '4' || v === '8' ? Number(v) : 4; })();
const REPLAY = validateReplay(params, { defaultLen: savedLen });
const RV = REPLAY.values; // seed が有効なときだけ（kind が none なら null）
// モード（Ver.0.3）：数学Ⅰ（度数法・124枚）／数学Ⅱ（弧度法・168枚）。新しい対局の開始時にだけ切り替える。
// ?mode=math1|math2 または保存値（mj-mode）。?rules=legacy はローカル開発環境だけの互換テスト用（Ver.0.2.1 の規則）。
const MODE_KEY = 'mj-mode';
const parseMode = (v) => (v === 'math1' || v === 'math2' ? v : null);
const LEGACY = IS_LOCAL && params.get('rules') === 'legacy';
const rulesCache = {};
function rulesForMode(mode) {
  const key = LEGACY ? 'legacy' : mode;
  return rulesCache[key] || (rulesCache[key] = createRules(LEGACY ? makeConfig({ legacy: true }) : makeConfig({ mode })));
}
const modeLabel = (r) => (MODES[r.config.mode] ? MODES[r.config.mode].label : '旧規則');
const HUMAN = 0;
const POS = ['自分', '下家', '対面', '上家'];
let PLAYERS = [
  { name: 'あなた', kind: 'human' },
  ...rosterForLevel('intermediate').map((c) => ({ ...c, kind: 'ai' })),
]; // 試合の開始時に、選んだ3人と座席で作り直す（startMatch）


// AI 難易度（Ver.0.4-B〜0.6-A）。Ver.0.6 からタイトルでは選ばず、対戦相手を9人から自由に選ぶ（src/ui/opponents.js）。
// 難易度は、従来の再現 URL（?ai=）と、その既定の3人（rosterForLevel）のためだけに残す。
const AI_LEVELS = [
  { id: 'beginner', label: '初級', desc: 'かなた・みつき・あおと。3人それぞれの打ち方' },
  { id: 'intermediate', label: '中級', desc: 'おうすけ・なつき・ゆき。点差で打ち方が変わります' },
  { id: 'advanced', label: '上級', desc: 'シャカ・かおる・アスマ。危険と高得点を読み合う' },
];
const parseLen = (v) => (v === 4 || v === 8 || v === '4' || v === '8' ? Number(v) : null);
const parseAi = (v) => (AI_LEVELS.some((a) => a.id === v) ? v : null);

const S = {
  // 局の通し番号（連荘を含む、1から）。山は seed と この番号だけで決まる（従来の ?round=n と同じ）。
  round: REPLAY.kind !== 'none' && REPLAY.ok ? RV.round : 1,
  dealer: 0, // その局の親の席（試合の状態 S.match から決まる）
  scores: [START_POINTS, START_POINTS, START_POINTS, START_POINTS],
  match: null, // 試合の状態（src/engine/match.js）
  screen: REPLAY.kind === 'none' ? 'title' : REPLAY.ok ? 'game' : 'replay-error',
  seedBase: RV ? RV.seed : Math.floor(Math.random() * 1e9),
  game: null,
  selected: null,
  hintsUsed: 0,
  modal: null,
  speed: null, // 下で resolveSpeed により許可された値だけを設定する
  timer: null,
  aiRng: null,
  history: [],
};

S.speed = resolveSpeed(params.get('speed'), store.get('mj-speed', null), IS_LOCAL);
// ロン・ポン・チーの演出（Ver.0.5-B）。画面だけの機能で、ゲームの進行・判定・得点には関わらない。
// mode：'full'（通常）／'lite'（簡易：文字だけ）。seen：演出を判定済みの記録（Game.events）の件数。history：出した演出（確認用）。
// queue：待っている演出（Ver.0.5-E。宣言が続いたとき順番に見せる）。dropped：出さずに捨てた演出の数（確認用）。
S.fx = { mode: parseEffectMode(store.get(EFFECT_MODE_KEY, null)), seen: 0, serial: -1, current: null, queue: [], timer: null, leaveTimer: null, history: [], dropped: 0 };
// 効果音（Ver.0.5-D）。画面だけの機能。on：設定（保存キー mj-sound、'0' のときだけオフ）。seen：音を判定済みの記録の件数。
// 音はすべて自作の合成音（音声ファイルなし）。iPhone Safari は最初の操作で再生を許可する（下の unlock）。
S.sound = { on: parseSoundSetting(store.get(SOUND_KEY, null)), seen: 0, serial: -1 };
const sound = createSoundPlayer({
  getCtor: () => window.AudioContext || window.webkitAudioContext || null,
  isOn: () => S.sound.on,
});
// 宣言ボイス（Ver.0.5-E：導入の準備）。正式採用された音声ができるまでは何も読み込まず、設定にも出さない。保存キー mj-voice
S.voice = { on: parseVoiceSetting(store.get(VOICE_KEY, null)) };
const voice = createVoicePlayer({ sound, isOn: () => S.voice.on });
// 対局中のモード（S.mode）と、次の新しい対局で使うモード（S.nextMode）
S.mode = parseMode(params.get('mode')) || parseMode(store.get(MODE_KEY, null)) || DEFAULT_MODE;
S.nextMode = S.mode;
let rules = rulesForMode(S.mode);
// 対局設定（タイトル画面で選び、「対局開始」で確定）。保存キー mj-mode・mj-length・mj-ai
S.length = REPLAY.kind !== 'none' && REPLAY.ok && RV.lenGiven ? RV.len : savedLen;
S.ai = (REPLAY.kind !== 'none' && REPLAY.ok && RV.ai) || parseAi(store.get('mj-ai', null)) || 'intermediate';
// チーのオートパス（Ver.0.2-B）・ポンのオートパス（Ver.0.4-B）。保存値 '1' だけが ON、それ以外・保存不可は OFF。
S.chiAutoPass = parseChiAutoPass(store.get(CHI_AUTOPASS_KEY, null));
S.ponAutoPass = parsePonAutoPass(store.get(PON_AUTOPASS_KEY, null));
// 自動パスの回数（手動操作の S.input とは別に数える）と、次の自分の手番に出す通知（noticeKind：見送った鳴きの種類）
S.autoPass = { count: 0, failed: 0, noticePending: false, noticeKind: null, noticeKey: null, shownKind: null };
// 人間の入力の処理回数（多重処理の検出用。accepted=打牌などが成立、ignored=手番外の入力）
S.input = { accepted: 0, ignored: 0, failed: 0 };
// AI の判断回数（難易度ごと）。表示・判断には使わない（E2E で採用された難易度の確認に使う）
S.aiDecisions = {};
S.aiDecisionsBySeat = [{}, {}, {}, {}];
S.publicAiHistory = newPublicHistory(); // 試合内の公開行動のみ。保存・別試合への持越しはしない。
if (IS_LOCAL) { S.aiDecisionTiming = []; S.aiFirstDecisionTiming = {}; S.aiDecisionMaxMs = 0; } // 上限付きのローカル検証データ。判断には使用しない。

const app = document.getElementById('app');
const T = (idx) => rules.types[idx];
const nameOf = (s) => (s === HUMAN ? 'あなた' : `${PLAYERS[s].name}`);
// キャラクターID → AI の名簿の項目（名前・年齢・性格・打ち方の名前）。対局の PLAYERS はこの項目に kind: 'ai' を付けたもの
const ROSTER_BY_ID = Object.fromEntries(Object.values(CHARACTER_ROSTER).flat().map((c) => [c.id, c]));
const LEVEL_BY_ID = Object.fromEntries(OPPONENTS.map((o) => [o.id, o.level]));
const playersFor = (seatIds) => [{ name: 'あなた', kind: 'human' }, ...seatIds.map((id) => ({ ...ROSTER_BY_ID[id], kind: 'ai' }))];
// 対戦相手の自由選択（Ver.0.6）。selected：選んだキャラクターID（最大3人、選んだ順）。detail：詳細を開いているID。
// 画面の記憶の中だけで持ち、保存しない（ページの再読み込みで0人に戻る）。タイトルへ戻っても、モード・局数を変えても残す。
S.opp = { selected: [], detail: null, notice: null };
S.beginnerRoom = createRoomState(); // 通常の対戦相手選択・対局とは独立した練習

function startRound() {
  clearTimeout(S.timer);
  S.timer = null;
  S.stepDeferred = false;
  S.gameSerial = (S.gameSerial || 0) + 1;
  S.handOrder = null; // 手牌の表示順は局ごとに初期化（従来の種類順から始まる）
  S.dealer = dealerOf(S.match);
  const seed = S.seedBase + S.round * 7919;
  const presetWall = IS_LOCAL ? S.nextPresetWall || null : null; // テスト用：山の並びを指定（ローカルのみ）
  S.nextPresetWall = null;
  S.game = new Game({ rules, seed, dealer: S.dealer, players: PLAYERS, round: S.round, presetWall });
  S.aiRng = createRng(seed ^ 0x5bd1e995);
  warmUp(rules); // 役候補ヒント用の評価を少しずつ事前計算（判定・進行には影響しない）
  S.selected = null;
  // ヒントは局ごとに閉じた状態から始める（使用回数も局ごと）
  // 回数：発見（第1段階）・確認（第2段階）は「同じ手牌の状態」では1回だけ。値表は従来どおり開くたび。
  S.hintStats = { discover: 0, confirm: 0, table: 0 };
  S.hintCounted = { discover: new Set(), confirm: new Set() };
  S.hintsUsed = 0; // 互換：上の3つの合計
  closeHint();
  S.modal = null;
  S.scored = false;
  S.claimPolicy = null; // 宣言ごとの表示方針（局ごとに初期化）
  S.riichiSelect = false; // リーチの宣言牌を選んでいる途中か（局ごとに初期化）
  fxClear(); // 前の局の演出を残さない
  sound.silence(); // 前の局の効果音の残りも止める
  S.autoPass.noticePending = false;
  S.autoPass.noticeKind = null;
  S.autoPass.noticeKey = null;
  S.autoPass.shownKind = null;
  render();
  step();
}

// 局面の識別子：局の通し番号＋エンジンの記録数。打牌のたびに増えるので、
// 宣言待ち（打牌直後）と自分の手番（ツモ直後）をそれぞれ1件ずつ区別できる。
function stateKey() {
  return `${S.gameSerial}:${S.game.events.length}`;
}

// いま表示中の自分の宣言待ちの方針（step() が宣言の発生時に決めたもの）。読むだけで変更しない。
function currentClaimPolicy() {
  const p = S.game && S.game.pending();
  if (!p || p.seat !== HUMAN || p.type !== 'claim') return null;
  return S.claimPolicy && S.claimPolicy.key === stateKey() ? S.claimPolicy : null;
}
// 表示・ヒント・自動パスで共通に使う、この宣言の設定（宣言の発生時点で固定した値）
const claimSettings = () => policySettings(currentClaimPolicy());

// changed：直前にゲーム状態を変えた（AI の行動・自動パスの直後）。このときだけ AI の手番でも描画する。
// それ以外（ドラッグ後の再開など）では従来どおり AI の手番で再描画しない（操作中のタップを妨げない）。
function step(changed = false) {
  clearTimeout(S.timer);
  S.timer = null;
  if (!S.game) return; // タイトル画面へ戻った後（遅れて呼ばれた step は何もしない）
  fxScan(); // ゲームの記録に新しいロン・ポン・チーがあれば演出を出す（ゲーム状態は読むだけ）
  soundScan(); // 同じく、新しい記録に応じて効果音を鳴らす（待たない・ゲーム状態は読むだけ）
  // 手牌の並び替え（dragging）中は AI を進めない。指を離すか中止した時点で step() を1回だけ呼び直す。
  // AI の判断・乱数は局面だけで決まるので、待つ時間は結果に影響しない。
  if (drag && drag.isDragging()) { S.stepDeferred = true; return; }
  const g = S.game;
  const p = g.pending();
  if (!p) {
    S.autoPass.noticePending = false; // 他家のロン・流局で終わったら通知は持ち越さない
    S.autoPass.noticeKind = null;
    return finishRound();
  }
  if (p.seat === HUMAN) {
    if (p.type === 'claim') {
      // 宣言の方針は、その宣言が発生した時点の設定で決め、同じ宣言の間は変えない（表示中の選択肢を途中で変えない）
      const policy = S.claimPolicy = claimPolicy(S.claimPolicy, stateKey(), { chi: S.chiAutoPass, pon: S.ponAutoPass });
      // チー・ポンのオートパス：ロン不可で、可能な鳴きがすべて設定 ON のときだけ、宣言ボタンを描画する前に1回だけ見送る
      if (autoPassDue(policy, p, HUMAN)) {
        policy.tried = true;
        const kind = autoPassedKind(p);
        if (applyHumanAction({ type: 'pass' }) === 'ok') {
          S.autoPass.count++;
          S.autoPass.noticePending = true;
          S.autoPass.noticeKind = mergeKind(S.autoPass.noticeKind, kind);
          return step(true); // 次の判断番へ（後続のロン判断か、自分のツモ番）
        }
        S.autoPass.failed++; // 失敗したら通常の宣言 UI を表示（手動で選べる）
      }
    } else if (S.autoPass.noticePending) {
      // 自動パス後の最初の自分の手番：この手番の間だけ状態欄に通知を出す
      S.autoPass.noticePending = false;
      S.autoPass.noticeKey = stateKey();
      S.autoPass.shownKind = S.autoPass.noticeKind;
      S.autoPass.noticeKind = null;
    }
    return render();
  }
  if (changed) render();
  const [turnDelay, claimDelay] = speedDelays(S.speed, IS_LOCAL);
  S.timer = setTimeout(() => {
    S.timer = null;
    if (g !== S.game) return;
    if (drag && drag.isDragging()) { S.stepDeferred = true; return; }
    // AI 難易度は試合の開始時に確定した値（試合の途中で変えない）。試合の公開情報（持ち点・親番）は上級だけが使う。
    const decisionStart = IS_LOCAL ? performance.now() : 0;
    const action = decideCharacter(g, p.seat, PLAYERS[p.seat].id, S.aiRng,
      { ...matchInfo(S.match), publicHistory: S.publicAiHistory }, PLAYERS.map((x) => x.id || 'human'));
    if (IS_LOCAL) {
      const sample = { id: PLAYERS[p.seat].id, seat: p.seat, mode: rules.config.mode, ms: performance.now() - decisionStart, kind: p.type };
      S.aiDecisionTiming.push(sample);
      S.aiDecisionMaxMs = Math.max(S.aiDecisionMaxMs, sample.ms);
      if (p.type === 'turn' && !Object.hasOwn(S.aiFirstDecisionTiming, sample.id)) S.aiFirstDecisionTiming[sample.id] = sample;
      if (S.aiDecisionTiming.length > 256) S.aiDecisionTiming.shift();
    }
    const cid = PLAYERS[p.seat].id; // 判断したキャラクター（表示している名前と同じ席の項目）。難易度別・キャラ別に数える（確認用）
    S.aiDecisions[LEVEL_BY_ID[cid]] = (S.aiDecisions[LEVEL_BY_ID[cid]] || 0) + 1;
    S.aiDecisionsBySeat[p.seat][cid] = (S.aiDecisionsBySeat[p.seat][cid] || 0) + 1;
    applyAction(g, p.seat, action);
    // 描画は step() が行う（自分の宣言を自動で見送る場合は、宣言ボタンを一度も描画しない）
    step(true);
  }, p.type === 'turn' ? turnDelay : claimDelay);
}

function finishRound() {
  const g = S.game;
  if (!S.scored) {
    // 試合の状態に反映（親子の精算・連荘／親交代・終了判定）。1局につき1回だけ。
    S.scored = true;
    S.publicAiHistory = recordPublicRound(S.publicAiHistory, g.events, g.riichi);
    S.prevScores = S.match.scores.slice();
    S.lastRound = { label: handLabel(S.match), renchan: S.match.renchan, dealer: S.dealer };
    // 通し局数が MAX_ROUND に達したら試合を終える（出力する round・renchan を再現 URL の範囲内に保つ。
    // 終了の理由は S.match.endReason に残る：'normal'＝通常終了、'round-limit'＝上限による打ち切り）
    S.match = applyRoundResult(S.match, g.result, { round: S.round, maxRound: MAX_ROUND });
    S.scores = S.match.scores;
    S.history.push({ round: S.round, result: g.result.type === 'win' ? { ...g.result, analysis: undefined } : g.result });
  }
  closeHint(); // 和了・流局でヒントを閉じる
  S.modal = 'result';
  render();
}

// 人間の行動をエンジンに適用する（状態の変更だけ。描画・進行は呼び出し元が行う）。
// 戻り値：'ok'＝成立／'ignored'＝自分の判断番ではない／'failed'＝エンジンが拒否。
function applyHumanAction(action) {
  const g = S.game;
  const p = g.pending();
  if (!p || p.seat !== HUMAN) return 'ignored';
  try {
    applyAction(g, HUMAN, action);
  } catch (e) {
    console.error(e);
    return 'failed';
  }
  return 'ok';
}

// 画面からの手動操作（S.input に数える）
function humanAct(action) {
  const r = applyHumanAction(action);
  if (r !== 'ok') { S.input[r]++; return; }
  S.input.accepted++;
  S.selected = null;
  S.riichiSelect = false;
  render();
  step();
}

// ---------- ロン・ポン・チーの演出（Ver.0.5-B） ----------
// 表示は #app の外の専用レイヤー（#fx-layer）に出す。render() が #app の中身を作り直しても演出は途切れず、操作も妨げない
// （pointer-events: none）。ゲームの状態は読むだけで、演出の有無・長さが進行・判定・得点に影響することはない。
const fxLayer = document.createElement('div');
fxLayer.id = 'fx-layer';
fxLayer.setAttribute('aria-hidden', 'true');
document.body.appendChild(fxLayer);

const fxReduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } };
const fxLite = () => isLiteEffect(S.fx.mode, fxReduced());
const fxNow = () => performance.now();

// 演出を消す（新しい局・タイトルへ戻る・演出の終了）
function fxClear() {
  clearTimeout(S.fx.timer);
  clearTimeout(S.fx.leaveTimer);
  S.fx.timer = null;
  S.fx.leaveTimer = null;
  S.fx.current = null;
  S.fx.dropped += S.fx.queue.length; // 待っている演出も捨てる（古い局の演出を新しい局へ持ち越さない。音・声も鳴らさない）
  S.fx.queue = [];
  fxLayer.className = '';
  fxLayer.innerHTML = '';
  fxApply();
}

// ゲームの記録に新しい宣言があれば演出を出す。同じ記録で2回は出さない。別の局（記録が短くなった）は数え直す。
// 同じ回に増えた宣言は、すべて記録の順に演出キューへ渡す（Ver.0.5-E 監査 P2-A。1件だけ選ぶと残りが消えていた）。
// 同じ回にロン・ツモがあれば、和了だけを渡し、それより前の通常の宣言は破棄する（表示も音・声もなし）。
function fxScan() {
  const g = S.game;
  if (!g) return;
  if (S.fx.serial !== S.gameSerial) { S.fx.serial = S.gameSerial; S.fx.seen = 0; }
  const r = scanEffects(g.events, S.fx.seen);
  S.fx.seen = r.next; // 宣言はすべて offers か dropped に入っているので、ここで進めても失われない
  S.fx.dropped += r.dropped.length;
  for (const o of r.offers) fxFire(o.kind, o.event);
}

// ゲームの記録に新しい打牌・チー・ポン・リーチ・ロン・ツモがあれば、効果音を1つ鳴らす。同じ記録で2回は鳴らさない。
// 優先度は ロン・ツモ ＞ リーチ ＞ ポン ＞ チー ＞ 打牌。演出（fxScan）と同じ step() の先頭で、同じ記録を一度だけ読む。
function soundScan() {
  const g = S.game;
  if (!g) return;
  if (S.sound.serial !== S.gameSerial) { S.sound.serial = S.gameSerial; S.sound.seen = 0; }
  const pick = pickSound(g.events, S.sound.seen);
  S.sound.seen = pick.next;
  // 宣言（チー・ポン・リーチ・ロン・ツモ）の音は、その演出が実際に始まったとき（fxShow）に鳴らす。演出キューで待った宣言は、
  // 表示と同時に鳴り、出さずに捨てた宣言は鳴らさない（演出と音を一致させる）。ここで鳴らすのは打牌だけで、1回の判定で最大1回。
  // 同じ回に宣言があれば打牌音は鳴らさない（その回の音は宣言の音が代表する。リーチの宣言牌の打牌音と重ねないのと同じ規則）。
  if (pick.kind === 'discard') sound.play('discard');
}

// 効果音と宣言ボイスは独立した設定（Ver.0.5-E 監査 P2-B）。AudioContext が要るのは、効果音がオン、または採用された声がありボイスがオンのとき。
// 両方オフ・声が未採用でボイスだけオンのときは、何も作らず、何も読み込まない。
const voiceWanted = () => voice.available() && S.voice.on;
const audioWanted = () => S.sound.on || voiceWanted();
function audioUnlock() {
  if (!audioWanted()) return;
  sound.unlock();
  if (voiceWanted()) voice.load();
}
// iPhone Safari：最初のタップなどの操作の中で AudioContext を作って再生を許可する。以降も、止まっていれば操作のたびに再開を試みる。
// 受け身（passive）の記録だけで、操作の挙動（タップ・スクロール・ドラッグ）は変えない。
for (const t of ['touchend', 'pointerup', 'click', 'keydown']) {
  window.addEventListener(t, audioUnlock, { capture: true, passive: true });
}

// 画面が隠れた・ページを離れた（iPhone のバックグラウンド移行・ホーム画面・タブ切替）：鳴っている音を切り離す。
// 復帰したあと、隠れる前の音の続きが鳴らないようにする（新しい音は復帰後に新しい出力で鳴る）。リスナーは1回だけ登録。
document.addEventListener('visibilitychange', () => { if (document.hidden) sound.drop(); });
window.addEventListener('pagehide', () => sound.drop());

// 演出の中身（HTML）。簡易表示（lite）は文字と宣言者だけ。牌は公開されている情報（鳴いた面子・和了牌・宣言牌）だけを使う。
// lite は演出の開始時に決めた値（S.fx.current.lite）を渡す。設定をいま読み直さない。
// 宣言者は、必ずゲームの記録（event.seat）から決める。「AI-B の / ロン！」のように、宣言者と宣言を大きく並べる。
function fxHTML(kind, ev, lite) {
  const g = S.game;
  const pos = ev.seat === HUMAN ? '' : `<span class="fx-pos">${POS[ev.seat]}</span>`;
  const who = `<div class="fx-who" data-seat="${ev.seat}">${pos}<span class="fx-name">${nameOf(ev.seat)}</span><span class="fx-of">の</span></div>`;
  const word = `<div class="fx-word">${EFFECTS[kind].text}</div>`;
  if (lite) return `<div class="fx-card">${who}<div class="fx-mid">${word}</div></div>`;
  // カットインの帯（斜めに横切る帯と光のライン）。チー・ポン・ロン・ツモ
  const band = kind === 'riichi' ? '' : '<div class="fx-band"><div class="fx-band-lines"></div></div>';
  let tiles = '';
  let back = '';
  if (kind === 'riichi') {
    // リーチ：白銀の鋭い閃光（十字の光条）と紫〜金の発光。宣言牌（いま捨てた牌）を大きく見せる。
    tiles = ev.tile !== undefined && ev.tile !== null ? `<div class="fx-decl">${tileHTML(T(g.typeOf(ev.tile)), { size: 'm' })}</div>` : '';
    back = '<div class="fx-flash"></div><div class="fx-streak fx-streak-h"></div><div class="fx-streak fx-streak-v"></div>';
  } else if (kind === 'ron' || kind === 'tsumo') {
    // 和了牌（ロンは打牌、ツモは引いた牌）を大きく見せる。冒頭に閃光1回と、ロンは放射状の光条・ツモは光の輪。
    tiles = g.result && g.result.tile !== undefined ? `<div class="fx-wintile">${tileHTML(T(g.typeOf(g.result.tile)), { size: 'm' })}</div>` : '';
    back = `<div class="fx-flash"></div>${kind === 'tsumo' ? '<div class="fx-halo"></div>' : '<div class="fx-rays"></div>'}`;
    // 後半に替わる、画面最上部の小さな帯（結果画面を隠さずに、誰の和了かを示し続ける）
    const small = g.result && g.result.tile !== undefined ? tileHTML(T(g.typeOf(g.result.tile)), { size: 's' }) : '';
    back += `<div class="fx-banner">${pos}<span class="fx-name">${nameOf(ev.seat)}</span><span class="fx-of">の</span><span class="fx-bword">${EFFECTS[kind].text}</span>${small}</div>`;
  } else {
    // 演出の元の宣言の面子（鳴いた牌＝記録の tile）だけを使う。見つからなければ、別の面子で代用しない（Ver.0.5-E 監査 P2-C）
    const meld = g.melds[ev.seat].find((m) => m.claimed === ev.tile);
    tiles = meld ? `<div class="fx-tiles">${meld.tiles.map((id, i) => `<span class="fx-t fx-t${i + 1}">${tileHTML(T(g.typeOf(id)), { size: 'm' })}</span>`).join('')}</div>` : '';
  }
  return `${back}<div class="fx-card">${who}<div class="fx-mid">${band}${word}</div>${tiles}</div>`;
}

// 新しい宣言の演出が届いた（ゲームの記録から。テストでは直接呼ぶ）。演出キューに渡し、表示するものがあれば表示する。
// ロン・ツモは最優先ですぐ表示し、待っている演出を捨てる。それ以外は、表示中の演出があれば待たせて順番に見せる。
function fxFire(kind, ev) {
  const now = fxNow();
  fxCommit(fxOffer({ current: S.fx.current, queue: S.fx.queue }, { kind, event: ev }, now), now);
}

// 演出キューの結果を反映する：表示（shown）なら表示を始め、退出・終了の時刻にタイマーを掛け直す。
function fxCommit(r, now) {
  S.fx.queue = r.queue;
  S.fx.dropped += r.dropped.length;
  if (r.shown) fxShow(r.current.kind, r.current.event, now);
  else if (!r.current) { fxClear(); return; }
  fxSchedule(now);
}

// 退出（後ろに演出が待つとき、最低表示時間の後に短く消える）と、終了（次の演出へ・消す）のタイマー。
function fxSchedule(now) {
  clearTimeout(S.fx.timer);
  clearTimeout(S.fx.leaveTimer);
  S.fx.timer = null;
  S.fx.leaveTimer = null;
  const t = fxTimes({ current: S.fx.current, queue: S.fx.queue }, now);
  if (!t) return;
  if (t.leaveAt !== null) {
    if (t.leaveAt <= now) fxLeave(now);
    else S.fx.leaveTimer = setTimeout(() => { S.fx.leaveTimer = null; fxLeave(Math.max(fxNow(), t.leaveAt)); }, t.leaveAt - now); // タイマーが僅かに早く来ても最低表示時間を割らない
  }
  // 本来の長さで終えるときは、CSS の消え方が終わるまで少し待つ（+60ms）。退出のときは退出の終わりで次へ
  S.fx.timer = setTimeout(fxTick, Math.max(0, t.endAt - now) + (t.leaveAt === null ? 60 : 0));
}

// 退出を始める（P3-A）。中央の表示（文字・宣言者・牌・帯）を短く消してから次の演出へ。始めた時刻を保存して、後から延びないようにする。
function fxLeave(now) {
  const c = S.fx.current;
  if (!c || c.leaveAt !== undefined) return;
  c.leaveAt = now;
  fxLayer.classList.add('fx-leaving');
}

// 表示中の演出が終わった：待っている演出があれば次を表示し、なければ消す。
function fxTick() {
  S.fx.timer = null;
  const now = fxNow();
  fxCommit(fxAdvance({ current: S.fx.current, queue: S.fx.queue }, now), now);
}

// 演出を実際に表示する。宣言の効果音と宣言ボイスは、この時に鳴らす（表示と音・声を一致させる）。
function fxShow(kind, ev, now) {
  // 通常／簡易の実効モード（設定＋OS の reduced motion）は、演出の開始時に1回だけ決めて保存する。
  // 文字・牌・フラッシュ（レイヤー）と、盤面の揺れ・発光（fxApply）は、終了まで同じ値を使う。
  // 演出中に設定を変えても表示中の演出は変わらず、次に始まる演出から新しい設定になる。
  const lite = fxLite();
  S.fx.current = { kind, startedAt: now, seat: ev.seat, tile: ev.tile, lite, event: ev };
  S.fx.history.push(kind);
  if (S.fx.history.length > 100) S.fx.history.shift();
  fxLayer.className = `fx-${kind}${lite ? ' lite' : ''}`;
  fxLayer.innerHTML = fxHTML(kind, ev, lite);
  fxApply();
  // 宣言ボイス（採用された音声があり、読み込み済みのときだけ）。鳴ったら、宣言の効果音を少し下げて声を聞き取りやすくする。
  const v = voice.play(kind);
  sound.play(kind, v === 'played' ? { gain: voice.sfxGain() } : {});
}

// 盤面の演出（ロン・ツモの画面揺れ・宣言者の席の発光・ポン／チーの面子とリーチの宣言牌の発光）を、いまの演出の経過に合わせて付け外しする。
// 再描画で作り直された要素にも、経過分だけアニメーションをずらして続きから再生する（再描画でやり直さない）。
const FX_BOARD = ['fx-shake', 'fx-shake-ron', 'fx-glow', 'fx-glow-pon', 'fx-glow-chi', 'fx-glow-riichi', 'fx-seat', 'fx-seat-lite',
  'fx-seat-chi', 'fx-seat-pon', 'fx-seat-ron', 'fx-seat-tsumo', 'fx-seat-riichi'];
function fxApply() {
  const table = app.querySelector('.table');
  for (const el of app.querySelectorAll('.fx-shake, .fx-glow, .fx-seat, .fx-seat-lite')) {
    el.classList.remove(...FX_BOARD);
    el.style.removeProperty('animation-delay');
  }
  const c = S.fx.current;
  const { active, elapsed } = fxProgress(c, fxNow());
  if (!c || !active || !S.game) return;
  const delay = `-${Math.round(elapsed)}ms`;
  // 宣言者の席（自分は手牌の欄、AI は各席の欄）。ゲームの記録の seat から決める
  const seatEl = app.querySelector(c.seat === HUMAN ? '.self' : `.panel.seat-${c.seat}`);
  if (c.lite) {
    // 簡易表示：席は点滅させず、枠の色だけで示す（動き・閃光なし）
    if (seatEl) seatEl.classList.add('fx-seat-lite', `fx-seat-${c.kind}`);
    return;
  }
  if (seatEl) { seatEl.classList.add('fx-seat', `fx-seat-${c.kind}`); seatEl.style.animationDelay = delay; }
  if (c.kind === 'ron' || c.kind === 'tsumo') {
    // ロンは、最初の衝撃を強めに減衰させる揺れ（fx-shake-ron）。ツモの揺れは従来どおり。
    if (table) { table.classList.add('fx-shake'); if (c.kind === 'ron') table.classList.add('fx-shake-ron'); table.style.animationDelay = delay; }
    return;
  }
  if (c.kind === 'riichi') {
    // 宣言牌（河の横向きの牌）を光らせる
    const rsel = c.seat === HUMAN ? '.river.mine .tile.riichi-decl' : `.panel.seat-${c.seat} .river .tile.riichi-decl`;
    const rel = app.querySelector(rsel);
    if (rel) { rel.classList.add('fx-glow', 'fx-glow-riichi'); rel.style.animationDelay = delay; }
    return;
  }
  // 演出の元の宣言の面子だけを光らせる（鳴いた牌の id で特定。Ver.0.5-E 監査 P2-C：最後の面子では、続けて鳴いたときに取り違える）。
  // 見つからなければ何も光らせない。
  const sel = `${c.seat === HUMAN ? '.self' : `.panel.seat-${c.seat}`} .melds .meld[data-claimed="${c.tile}"]`;
  const el = c.tile === undefined || c.tile === null ? null : app.querySelector(sel);
  if (el) { el.classList.add('fx-glow', `fx-glow-${c.kind}`); el.style.animationDelay = delay; }
}

// ---------- 描画 ----------

function lastEventText() {
  const g = S.game;
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.type === 'discard') {
      const decl = i > 0 && g.events[i - 1].type === 'riichi' && g.events[i - 1].tile === e.tile;
      return decl ? `${nameOf(e.seat)} が<b class="riichi-word">リーチ</b>： ${tileHTML(T(g.typeOf(e.tile)), { size: 's' })} を捨てました`
        : `${nameOf(e.seat)} が ${tileHTML(T(g.typeOf(e.tile)), { size: 's' })} を捨てました`;
    }
    if (e.type === 'chi') return `${nameOf(e.seat)} がチー： ${formulaHTML(rules, e.meld)}`;
    if (e.type === 'pon') return `${nameOf(e.seat)} がポン： ${formulaHTML(rules, e.meld)}`;
    if (e.type === 'win') return `${nameOf(e.seat)} の${e.how === 'ron' ? 'ロン' : 'ツモ'}和了！`;
    if (e.type === 'exhaustive-draw') return '流局（山がなくなりました）';
  }
  return `${nameOf(g.dealer)} が親です`;
}

function meldsHTML(seat, size) {
  const g = S.game;
  return g.melds[seat].map((m) => {
    const tiles = m.tiles.map((id) => tileHTML(T(g.typeOf(id)), { size, cls: id === m.claimed ? 'claimed' : '' })).join('');
    return `<span class="meld ${m.call === 'pon' ? 'pon' : 'chi'}" data-claimed="${m.claimed}" title="${m.call === 'pon' ? 'ポン' : 'チー'}">${tiles}</span>`;
  }).join('');
}

function riverHTML(seat, size) {
  const g = S.game;
  const last = [...g.events].reverse().find((e) => e.type === 'discard');
  const claimTile = g.claim ? g.claim.tile : null;
  return g.rivers[seat].map((r) => tileHTML(T(g.typeOf(r.id)), {
    size,
    cls: [r.tsumogiri ? 'tsumogiri' : '', r.riichi ? 'riichi-decl' : '', last && last.tile === r.id ? 'last' : '', claimTile === r.id ? 'claimable' : ''].join(' '),
  })).join('');
}

function panelHTML(seat) {
  const g = S.game;
  const p = g.pending();
  const active = p && p.seat === seat && p.type === 'turn';
  const pl = PLAYERS[seat];
  const pers = ''; // Ver.0.6：対局中はキャラ名だけを出し、牌の表示領域を優先
  return `<section class="panel seat-${seat} ${active ? 'active' : ''}">
    <header>
      <span class="pos">${POS[seat]}</span><span class="name">${pl.name}</span>${pers}
      ${g.dealer === seat ? '<span class="oya">親</span>' : ''}
      ${g.riichi[seat] ? '<span class="riichi-badge">リーチ</span>' : ''}
      ${!g.isClosed(seat) ? '<span class="naki">鳴き</span>' : ''}
      <span class="score">${S.scores[seat]}点</span>
    </header>
    <div class="row">${backHTML(g.hands[seat].length)}<span class="melds">${meldsHTML(seat, 's')}</span></div>
    <div class="river">${riverHTML(seat, 'xs')}</div>
  </section>`;
}

// 手牌の表示順（画面だけの状態）をエンジンの手牌と突き合わせて返す。エンジンには反映しない。
function currentDrawn() {
  const g = S.game;
  const p = g.pending();
  return p && p.seat === HUMAN && p.type === 'turn' && g.drawn !== null && g.drawn !== undefined ? g.drawn : null;
}
function currentOrder() {
  const g = S.game;
  S.handOrder = reconcileOrder(S.handOrder, g.hands[HUMAN], (id) => g.typeOf(id), currentDrawn());
  return S.handOrder;
}

function handHTML() {
  const g = S.game;
  const p = g.pending();
  const myTurn = p && p.seat === HUMAN && p.type === 'turn';
  const drawn = currentDrawn();
  const order = currentOrder();
  // ツモ牌：右端にあれば従来どおり隙間で区別、並び替えで移動したら金色の点で示す
  const drawnAtEnd = drawn !== null && order[order.length - 1] === drawn;
  // 数式の確認（第2段階）の色枠：物理牌 id ごとに 黄／赤／青／赤青（共有）
  const fc = S.hintColors || new Map();
  const frame = (id) => {
    const c = fc.get(id);
    if (!c) return '';
    return c.length === 2 ? 'fhf fhf-rb' : `fhf fhf-${c[0]}`;
  };
  // リーチ中はツモ牌だけ、リーチの宣言牌を選んでいる間は聴牌になる牌だけを選べる（エンジンも同じ条件で拒否する）
  const allowed = humanDiscardFilter();
  const tile = (id) => {
    const ok = myTurn && allowed(id);
    return tileHTML(T(g.typeOf(id)), {
      size: 'l', id,
      cls: [ok ? 'tap' : '', myTurn && !ok ? 'locked' : '', S.selected === id ? 'selected' : '', frame(id),
        S.riichiSelect && ok ? 'riichi-ok' : '',
        id === drawn ? (drawnAtEnd ? 'drawn' : 'drawn drawn-mark') : ''].join(' '),
      attrs: ok ? `data-action="tile" tabindex="0"` : '',
    });
  };
  const body = order.map((id) => (drawnAtEnd && id === drawn ? `<span class="drawn-gap"></span>${tile(id)}` : tile(id))).join('');
  return `<div class="hand">${body}</div>
    <div class="hand-help"><span>長押しで並び替え・タップ2回で捨てる</span><span class="hh-tools">${autoPassToggleHTML('chi')}${autoPassToggleHTML('pon')}<button data-action="autosort" class="small">自動整列</button><button data-action="hint" class="small hint-btn" aria-pressed="${!!S.hintOpen}">ヒント</button></span></div>`;
}

// チー・ポンの自動パスの切替（対戦画面。Ver.0.5-A で設定画面から移動）。ON/OFF を色と文字で示す。
// 切り替えは次に発生する宣言から反映し、表示中の宣言の選択肢は変えない（宣言ごとの方針 claimPolicy で固定）。
function autoPassToggleHTML(kind) {
  const on = kind === 'chi' ? S.chiAutoPass : S.ponAutoPass;
  const name = kind === 'chi' ? 'チー' : 'ポン';
  return `<button data-action="toggle-${kind}-autopass" class="small ap-toggle ${on ? 'on' : 'off'}" aria-pressed="${on}" aria-label="${name}の自動パス ${on ? 'ON' : 'OFF'}"><span class="apt-name">${name}自動</span><span class="apt-state">${on ? 'ON' : 'OFF'}</span></button>`;
}

// 自分の打牌番で、いま捨てられる牌の条件（リーチ中はツモ牌だけ、宣言牌の選択中は聴牌になる種類だけ）
function humanDiscardFilter() {
  const g = S.game;
  if (g.riichi[HUMAN]) return (id) => id === g.drawn;
  if (S.riichiSelect) {
    const types = new Set(g.riichiOptions(HUMAN).map((o) => o.type));
    return (id) => types.has(g.typeOf(id));
  }
  return () => true;
}

// 直前の鳴き（チー／ポン）の名前
function lastCallName(g) {
  for (let i = g.events.length - 1; i >= 0; i--) {
    const t = g.events[i].type;
    if (t === 'pon') return 'ポン';
    if (t === 'chi') return 'チー';
  }
  return 'チー';
}

function actionsHTML() {
  const g = S.game;
  const p = g.pending();
  if (!p) return `<div class="actions"><button data-action="show-result" class="primary">結果を見る</button></div>`;
  if (p.seat !== HUMAN) {
    const what = p.type === 'turn' ? `${nameOf(p.seat)} の手番…` : `${nameOf(p.seat)} が考え中…`;
    return `<div class="actions waiting"><span class="status">${what}</span></div>`;
  }
  if (p.type === 'turn' && g.riichi[HUMAN]) {
    // リーチ中：ツモ和了かツモ切りだけ
    const tsumo = p.canTsumo ? '<button data-action="tsumo" class="win">ツモ</button>' : '';
    return `<div class="actions">
      <span class="status riichi-status">${p.canTsumo ? 'リーチ中・和了できます！' : 'リーチ中：ツモ切り'}</span>
      ${tsumo}
      <button data-action="tsumogiri" class="primary">ツモ切り</button>
    </div>`;
  }
  if (p.type === 'turn' && S.riichiSelect) {
    // リーチの宣言牌を選ぶ：聴牌になる牌だけ選べる（光る牌）
    const tsumo = p.canTsumo ? '<button data-action="tsumo" class="win">ツモ</button>' : '';
    const ok = S.selected !== null && humanDiscardFilter()(S.selected);
    return `<div class="actions">
      <span class="status riichi-status">リーチ：宣言して捨てる牌を選択</span>
      ${tsumo}
      <button data-action="riichi-cancel">やめる</button>
      <button data-action="riichi-discard" class="primary riichi" ${ok ? '' : 'disabled'}>リーチして捨てる</button>
    </div>`;
  }
  if (p.type === 'turn') {
    const tsumo = p.canTsumo ? '<button data-action="tsumo" class="win">ツモ</button>' : '';
    const riichiBtn = g.riichiOptions(HUMAN).length ? '<button data-action="riichi" class="riichi">リーチ</button>' : '';
    const sel = S.selected !== null;
    // チー・ポンを自動で見送った後の最初の手番だけ、通常の案内の代わりに通知を出す（状態欄の大きさは変えない）
    const notice = S.autoPass.noticeKey === stateKey() ? autoPassNotice(S.autoPass.shownKind) : null;
    const text = p.canTsumo ? (notice ? `${notice}・和了できます！` : '和了できます！')
      : notice || (g.justDrew ? 'あなたの番：捨てる牌を選択' : `${lastCallName(g)}後：捨てる牌を選択`);
    return `<div class="actions">
      <span class="status${notice ? ' autopass-notice' : ''}">${text}</span>
      ${tsumo}${riichiBtn}
      <button data-action="discard" class="primary" ${sel ? '' : 'disabled'}>捨てる</button>
    </div>`;
  }
  const tile = tileHTML(T(g.typeOf(p.tile)), { size: 'm' });
  // 表示する選択肢はこの宣言の方針で決める（OFF なら従来どおり全部。ON の鳴きは出さない。ロンは必ず出す）
  const v = visibleClaimActions(p, claimSettings());
  const ron = v.ron ? '<button data-action="ron" class="win">ロン</button>' : '';
  const pon = v.pon ? `<button data-action="pon" class="pon">ポン ${formulaHTML(rules, v.pon.meld)}</button>` : '';
  const chi = v.chi.map((o) => {
    const m = rules.melds[o.meld];
    return `<button data-action="chi" data-opt="${o.index}" class="chi">チー ${formulaHTML(rules, m.idx)}</button>`;
  }).join('');
  const pass = v.passNote
    ? `<button data-action="pass" class="pass-with-note">${v.passLabel}<small class="pass-note">${v.passNote}</small></button>`
    : `<button data-action="pass">${v.passLabel}</button>`;
  return `<div class="actions claim">
    <span class="status">${POS[p.from]} ${nameOf(p.from)} の打牌 ${tile}</span>
    ${ron}${pon}${chi}
    ${pass}
  </div>`;
}

function headerHTML() {
  const g = S.game;
  // 局の表示：終局後（精算済み）はその局の名前のまま（試合の状態は次の局へ進んでいる）
  const cur = S.scored && S.lastRound ? S.lastRound : { label: handLabel(S.match), renchan: S.match.renchan };
  return `<header class="top">
    <span class="logo">数雀 <small>Ver.${APP_VERSION}</small></span>
    <span class="info"><span class="mode" title="${modeLabel(rules)}">${({ math1: '数Ⅰ', math2: '数Ⅱ' })[rules.config.mode] || '旧'}</span> <b class="hand-label">${cur.label}</b>${cur.renchan ? ` <span class="renchan">連荘${cur.renchan}</span>` : ''} <span class="wall" aria-label="山の残り">山 <b>${g.wall.length}</b></span></span>
    <span class="tools">
      <button data-action="guide" class="small">ガイド</button>
      <button data-action="settings" class="small" aria-label="設定">⚙</button>
    </span>
  </header>`;
}

function render() {
  if (S.screen === 'title') { app.innerHTML = titleHTML(); return; }
  if (S.screen === 'select') { app.innerHTML = selectHTML(); return; }
  if (S.screen === 'beginner-room') { app.innerHTML = roomHTML(S.beginnerRoom, rulesForMode('math1')); return; }
  if (S.screen === 'replay-error') { app.innerHTML = replayErrorHTML(); return; }
  if (!S.game) return;
  // 並び替え中に再描画が必要になったら、並び替えを中止してから描画する（DOM が作り直されるため）
  if (drag && drag.isDragging()) drag.cancel('render');
  const g = S.game;
  // ヒント表示中は、役候補が参照する公開情報（手牌・河・公開面子・宣言状態）が変わったときだけ再計算する。
  // 自動更新ではヒント使用回数を加算しない。
  if (S.hintOpen) refreshHintIfChanged();
  app.innerHTML = `
    ${headerHTML()}
    <main class="table">
      <div class="opponents">
        <div class="area-top">${panelHTML(2)}</div>
        <div class="area-left">${panelHTML(3)}</div>
        <div class="area-right">${panelHTML(1)}</div>
      </div>
      <div class="msg" aria-live="polite">${lastEventText()}</div>
      <section class="self ${g.pending() && g.pending().seat === HUMAN && g.pending().type === 'turn' ? 'active' : ''}">
        <header>
          <span class="pos">自分</span><span class="name">あなた</span>
          ${g.dealer === HUMAN ? '<span class="oya">親</span>' : ''}
          ${g.riichi[HUMAN] ? '<span class="riichi-badge">リーチ</span>' : ''}
          ${!g.isClosed(HUMAN) ? '<span class="naki">鳴き（役が必要）</span>' : '<span class="menzen">門前</span>'}
          <span class="score">${S.scores[HUMAN]}点</span>
        </header>
        <div class="river mine">${riverHTML(HUMAN, 'xs')}</div>
        <div class="melds mine">${meldsHTML(HUMAN, 'm')}</div>
        ${handHTML()}
        ${S.hintText ? `<div class="hint-box">${S.hintText}</div>` : ''}
      </section>
    </main>
    <footer class="bar">${actionsHTML()}</footer>
    ${modalHTML()}
  `;
  fxApply(); // 再描画で作り直された要素にも、演出中なら続きから発光・揺れを付ける
}

// ---------- モーダル ----------

function modalHTML() {
  if (!S.modal) return '';
  let body = '';
  if (S.modal === 'result') body = resultHTML();
  if (S.modal === 'guide') body = guideHTML();
  if (S.modal === 'table') body = tableHTML();
  if (S.modal === 'settings') body = settingsHTML();
  if (S.modal === 'final') body = finalHTML();
  const closable = S.modal !== 'result' && S.modal !== 'final';
  return `<div class="overlay${S.modal === 'result' ? ' overlay-result' : ''}" role="dialog" aria-modal="true"><div class="modal">${body}
    ${closable ? '<div class="modal-actions"><button data-action="close" class="primary">閉じる</button></div>' : ''}</div></div>`;
}

function revealHTML(seat) {
  const g = S.game;
  const hand = g.hands[seat].slice().sort((a, b) => g.typeOf(a) - g.typeOf(b)).map((id) => tileHTML(T(g.typeOf(id)), { size: 's' })).join('');
  return `<div class="reveal"><span class="who">${seat === HUMAN ? 'あなた' : `${POS[seat]} ${nameOf(seat)}`}</span><span class="tiles">${hand}</span><span class="melds">${meldsHTML(seat, 's')}</span></div>`;
}

function resultHTML() {
  const g = S.game;
  const r = g.result;
  let head;
  let detail = '';
  if (r.type === 'win') {
    const a = r.analysis;
    const how = r.how === 'ron' ? `ロン（${r.from === HUMAN ? 'あなた' : `${POS[r.from]} ${nameOf(r.from)}`} から）` : 'ツモ';
    head = `<h2>${nameOf(r.winner)} の和了 <small>${how}</small></h2>`;
    if (a.kind === 'special') {
      const sp = rules.config.specialHands.find((s) => s.id === a.special);
      detail = `<p class="special">特殊和了：角度牌9種類 ${sp.angles.map((d) => angleText(rules.typeByKey.get(`a:${d}`))).join('・')}</p>
        <div class="tiles">${g.hands[r.winner].slice().sort((x, y) => g.typeOf(x) - g.typeOf(y)).map((id) => tileHTML(T(g.typeOf(id)), { size: 'm' })).join('')}</div>`;
    } else {
      // 先頭の exposedMelds.length 組が公開面子（g.melds と同じ順）。チー／ポンの別を表示する。
      const calls = g.melds[r.winner];
      detail = `<ol class="formulas">${a.melds.map((mi, i) => {
        const m = rules.melds[mi];
        const tiles = m.tiles.map((t) => tileHTML(T(t), { size: 's' })).join('');
        const tag = i < a.exposedMelds.length ? `<span class="tag">${calls[i] && calls[i].call === 'pon' ? 'ポン' : 'チー'}</span>` : '';
        return `<li class="${m.kind}"><span class="tiles">${tiles}</span>${formulaHTML(rules, mi)}${tag}</li>`;
      }).join('')}</ol>`;
    }
    const base = a.yakuman ? '' : `<li><span>通常和了</span><b>${rules.config.scoring.base}</b></li>`;
    const yaku = a.yaku.map((y) => `<li class="${y.yakuman ? 'yakuman' : ''}"><span>${y.name}${y.yakuman ? '（役満）' : ''}</span><b>${a.yakuman ? '' : '+'}${y.points}</b></li>`).join('');
    // リーチの加点は yaku に含まれる（エンジンが追加）。役満では加点しないことを明示する
    const riichiNote = a.riichi && !a.riichiBonus ? '<li class="riichi-li"><span>リーチ（役満のため加点なし）</span><b>+0</b></li>' : '';
    detail += `<ul class="yaku">${base}${yaku || (a.yakuman ? '' : '<li class="none"><span>役なし（門前のため和了可）</span><b></b></li>')}${riichiNote}
      <li class="total"><span>合計</span><b>${r.points}点</b></li></ul>
      ${a.kind === 'normal' && a.melds.some((mi) => rules.melds[mi].kind === 'koutsu') && a.melds.some((mi) => rules.melds[mi].kind === 'formula') ? '<p class="note">数式面子と刻子の混合形：数式系の役は付きません（門前なら役なしで和了できます）。</p>' : ''}
      ${a.candidateCount > 1 ? `<p class="note">この手は${a.candidateCount}通りの和了形に分けられます。最高得点の形を採用しました。</p>` : ''}`;
  } else {
    head = '<h2>流局</h2>';
    detail = '<p>山の牌がなくなりました。得点の移動はありません。</p>';
  }
  // 親子の精算（局前 → 増減 → 局後）と、次の局（連荘・親交代・試合終了）
  const prev = S.prevScores || S.scores;
  const delta = (s) => S.scores[s] - prev[s];
  const sign = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : '±0');
  const scores = `<table class="scores"><tr><th></th>${[0, 1, 2, 3].map((s) => `<th>${POS[s]}<br>${PLAYERS[s].name}${s === S.dealer ? '<span class="oya">親</span>' : ''}</th>`).join('')}</tr>
    <tr><th>局前</th>${[0, 1, 2, 3].map((s) => `<td>${prev[s]}</td>`).join('')}</tr>
    <tr class="delta"><th>増減</th>${[0, 1, 2, 3].map((s) => `<td class="${delta(s) > 0 ? 'plus' : delta(s) < 0 ? 'minus' : ''}">${sign(delta(s))}</td>`).join('')}</tr>
    <tr><th>持ち点</th>${[0, 1, 2, 3].map((s) => `<td class="${r.winner === s ? 'win' : ''}">${S.scores[s]}</td>`).join('')}</tr></table>`;
  const m = S.match;
  const dealerName = (s) => (s === HUMAN ? 'あなた' : `${POS[s]} ${PLAYERS[s].name}`);
  const nextLine = m.over && m.endReason === 'round-limit' ? `<p class="next-round over">${ROUND_LIMIT_NOTE}</p>`
    : m.over ? `<p class="next-round over">${S.lastRound.label}の親番が終わりました。<b>試合終了</b>です。</p>`
    : m.renchan > 0 && r.type === 'win' && r.winner === S.lastRound.dealer
      ? `<p class="next-round">親が和了したので<b>連荘</b>：次は${handLabel(m)}（連荘${m.renchan}回目）、親は${dealerName(dealerOf(m))}</p>`
      : `<p class="next-round"><b>親交代</b>：次は${handLabel(m)}、親は${dealerName(dealerOf(m))}</p>`;
  const payout = r.type === 'win' ? `<p class="note payout">精算：${r.how === 'ron' ? `${r.winner === S.lastRound.dealer ? '親' : '子'}のロン（放銃者が${r.winner === S.lastRound.dealer ? 6 : 4}×和了点を支払い）` : `${r.winner === S.lastRound.dealer ? '親のツモ（子3人が 2×和了点ずつ）' : '子のツモ（親 2×和了点、ほかの子 1×和了点）'}`}。和了点 ${r.points}点。</p>` : '';
  const hs = S.hintStats;
  const hints = S.hintsUsed ? `<p class="note hint-stats">この局のヒント：発見 ${hs.discover}回・確認 ${hs.confirm}回・値表 ${hs.table}回</p>` : '';
  return `<div class="result">${head}${detail}
    <h3>${S.lastRound.label}${S.lastRound.renchan ? `（連荘${S.lastRound.renchan}）` : ''}の精算</h3>${payout}${scores}${nextLine}${hints}
    <details><summary>全員の手牌を見る</summary>${[0, 1, 2, 3].map(revealHTML).join('')}</details>
    ${reportInfoHTML()}
    <div class="modal-actions"><button data-action="next" class="primary">${m.over ? '最終結果へ' : '次の局へ'}</button>
    <button data-action="close-result">盤面を見る</button></div></div>`;
}

// 通し局数の上限で試合を終えた場合の説明（通常の試合終了では表示しない）
const ROUND_LIMIT_NOTE = `通し局数の上限（${MAX_ROUND.toLocaleString('en-US')}局）に達したため、試合を終了しました。親の連荘もここで終了します。`;

// 試合終了のリザルト（最終順位・得点・開始点との差・和了回数・最高和了・局数・連荘・設定）
function finalHTML() {
  const m = S.match;
  const rk = ranks(m.scores);
  const order = [0, 1, 2, 3].sort((a, b) => rk[a] - rk[b] || a - b);
  const sign = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : '±0');
  const rows = order.map((s) => `<tr class="${s === HUMAN ? 'me' : ''}"><td class="rank">${rk[s]}位</td><th>${s === HUMAN ? 'あなた' : `${PLAYERS[s].name}<small>${PLAYERS[s].styleLabel || PERSONALITIES[PLAYERS[s].personality].label}</small>`}</th>
      <td class="pts">${m.scores[s]}</td><td>${sign(m.scores[s] - START_POINTS)}</td><td>${m.wins[s]}回</td><td>${m.best[s] ? `+${m.best[s]}<small>（和了点${m.bestBase[s]}）</small>` : '—'}</td></tr>`).join('');
  return `<div class="final">
    <h2>試合終了</h2>
    <p class="final-me">あなたは <b>${rk[HUMAN]}位</b>（${m.scores[HUMAN]}点）</p>
    <div class="table-wrap"><table class="final-table">
      <tr><th>順位</th><th>名前</th><th>得点</th><th>開始との差</th><th>和了</th><th>最高和了</th></tr>${rows}</table></div>
    <ul class="final-info">
      <li>実施した局数：<b>${m.played}局</b>（${m.length === 4 ? '4局戦・東1〜東4局' : '8局戦・東1〜南4局'}）</li>
      <li>連荘回数：<b>${m.renchanTotal}回</b></li>
      <li>数学モード：${modeLabel(rules)}</li>
      <li class="final-opps">対戦相手：${opponentsText()}</li>
      ${m.endReason === 'round-limit' ? `<li class="note round-limit-note">${ROUND_LIMIT_NOTE}</li>` : ''}
      <li class="note">開始時の持ち点は各${START_POINTS}点（合計${START_POINTS * 4}点）。同点は同順位。点数配分は試作段階の暫定値です。</li>
    </ul>
    <div class="modal-actions final-actions"><button data-action="again" class="primary">同じ3人と再戦</button><button data-action="change-opponents">相手を変更</button><button data-action="to-title">タイトルへ戻る</button></div>
  </div>`;
}

// 再現 URL の局状態が不正なとき（別の局面として黙って始めない）。タイトルへ戻れる。
function replayErrorHTML() {
  return `<main class="title-screen replay-error">
    <h1 class="re-title">再現URLの局状態が不正です</h1>
    <p class="re-lead">この再現URLは、正規の進行では起こり得ない局状態、または範囲外の値を含んでいるため、対局を始めませんでした。</p>
    <ul class="re-list">${REPLAY.errors.map((e) => `<li><code>${e.key}</code>：${e.message}</li>`).join('')}</ul>
    <button data-action="to-title" class="primary start-btn">タイトルへ戻る</button>
  </main>`;
}

// ---------- タイトル画面 ----------
// タイトルロゴ（Ver.0.5-C）：正式採用の画像（背景透過 PNG、1536×1024、3:2）。画面の幅と解像度に合わせて6つの大きさ
// （384・576・768・960・1152・1536 幅。縮小は比率・色を変えない。1536 幅は採用画像そのもの）から選ぶ。
// sizes は styles.css の .title-logo-img の実際の表示幅（画面の幅−左右の余白 32px・380px・高さの割合 の最小値）と同じ式。
// 低い横画面（高さ 500px 以下）は高さの 66%、それ以外は 45%（3:2 なので、高さの 30%／44% の枠）。
// width・height は元画像の大きさ（読み込み前から枠の比率を確保して表示のずれを防ぐ）。
function titleHTML() {
  const radio = (name, value, label, checked, extra = '') => `<label class="setting radio"><input type="radio" name="${name}" value="${value}" data-action="title-${name}" ${checked ? 'checked' : ''}><span>${label}${extra}</span></label>`;
  return `<main class="title-screen">
    <div class="title-logo"><img class="title-logo-img" src="src/ui/title-logo-768.png" srcset="src/ui/title-logo-384.png 384w, src/ui/title-logo-576.png 576w, src/ui/title-logo-768.png 768w, src/ui/title-logo-960.png 960w, src/ui/title-logo-1152.png 1152w, src/ui/title-logo-1536.png 1536w" sizes="(orientation: landscape) and (max-height: 500px) min(calc(100vw - 32px), 380px, 66vh), min(calc(100vw - 32px), 380px, 45vh)" width="1536" height="1024" alt="数雀（MATHJONG）" decoding="async"></div>
    <p class="title-lead">三角関数の牌で遊ぶ4人麻雀</p>
    <div class="title-form">
      <fieldset class="title-set"><legend>数学モード</legend>
        ${radio('mode', 'math1', '数学Ⅰ', S.nextMode === 'math1', '<small>度数法・0°〜180°・124枚</small>')}
        ${radio('mode', 'math2', '数学Ⅱ', S.nextMode === 'math2', '<small>弧度法・0〜2π・168枚</small>')}
      </fieldset>
      <fieldset class="title-set"><legend>対局の長さ</legend>
        ${radio('length', '4', '4局戦', S.length === 4, '<small>東1〜東4局</small>')}
        ${radio('length', '8', '8局戦', S.length === 8, '<small>東1〜南4局</small>')}
      </fieldset>
    </div>
    <button data-action="choose-opponents" class="primary start-btn">対戦相手を選ぶ</button>
    <button data-action="br-open" class="br-open">初心者の部屋（練習）</button>
    <p class="note title-ver">持ち点 各${START_POINTS}点 ／ 画面 v${APP_VERSION}・エンジン v${ENGINE_VERSION}</p>
  </main>`;
}

// ---------- 対戦相手の選択（Ver.0.6） ----------
// 一覧（初級→中級→上級の順に連続）。カード本体のタップで詳細、右上のチェック欄のタップで選択・解除（詳細は開かない）。
// スマートフォンは2列・PC は3列（styles.css）。3人そろったときだけ「対局開始」を押せる。
function selectHTML() {
  const sel = S.opp.selected;
  const full = sel.length >= PICK_COUNT;
  const cards = OPPONENTS.map((o) => {
    const on = sel.includes(o.id);
    const blocked = !on && full;
    return `<div class="opp-card${on ? ' selected' : ''}" data-action="opp-detail" data-id="${o.id}" role="button" tabindex="0" aria-label="${o.name}の詳細">
      <button class="opp-check" data-action="opp-toggle" data-id="${o.id}" aria-pressed="${on}" aria-label="${o.name}を${on ? '外す' : '選ぶ'}"${blocked ? ' aria-disabled="true"' : ''}><span class="opp-box" aria-hidden="true">${on ? '✓' : ''}</span></button>
      <div class="opp-name">${o.name}</div>
      ${o.placeholder ? `<div class="opp-placeholder" aria-label="${o.name}の仮表示"><span aria-hidden="true">${o.placeholder}</span><small>仮表示</small></div>` : ''}
      <div class="opp-meta"><span class="opp-level lv-${o.level}">${o.levelLabel}</span></div>
      <div class="opp-trait">${o.trait}</div>
    </div>`;
  }).join('');
  const chips = sel.map((id) => { const o = opponentById(id); return `<span class="opp-chip">${o.name}<small>${o.levelLabel}</small></span>`; }).join('');
  const empty = Array.from({ length: PICK_COUNT - sel.length }, () => '<span class="opp-chip empty">未選択</span>').join('');
  const ready = canStartWith(sel);
  return `<main class="select-screen">
    <h1 class="select-title">対戦相手を選ぶ</h1>
    <p class="select-lead">${OPPONENTS.length}人から3人を選んでください。カードをタップすると詳しい紹介を見られます。</p>
    <div class="opp-status" aria-live="polite"><span class="opp-count">選択 <b>${sel.length}</b>/${PICK_COUNT}人</span>
      <span class="opp-chips">${chips}${empty}</span></div>
    ${S.opp.notice ? `<p class="note opp-notice">${S.opp.notice}</p>` : ''}
    <div class="opp-grid">${cards}</div>
    <div class="select-actions">
      <button data-action="opp-random" class="opp-random">おまかせ</button>
      <button data-action="start-match" class="primary start-btn"${ready ? '' : ' disabled'}>対局開始</button>
      <button data-action="to-title" class="opp-back">タイトルへ戻る</button>
    </div>
    <p class="note select-setting">${MODES[S.nextMode] ? MODES[S.nextMode].label : ''} ／ ${S.length}局戦</p>
    ${S.opp.detail ? oppDetailHTML(S.opp.detail) : ''}
  </main>`;
}

// キャラクターの詳細：スマートフォンは下から開くパネル、PC は中央のポップアップ（styles.css）。×・パネルの外で閉じる
function oppDetailHTML(id) {
  const o = opponentById(id);
  if (!o) return '';
  const on = S.opp.selected.includes(id);
  const blocked = !on && S.opp.selected.length >= PICK_COUNT;
  return `<div class="opp-overlay" data-action="opp-backdrop"><div class="opp-sheet" role="dialog" aria-modal="true" aria-label="${o.name}の紹介">
    <button class="opp-close" data-action="opp-detail-close" aria-label="閉じる">×</button>
    <h2 class="opp-d-name">${o.name}</h2>
    ${o.placeholder ? `<p class="opp-art-note">仮表示・正式なキャラクター画像は準備中です。</p>` : ''}
    <dl class="opp-d-list">
      ${o.age === null ? '' : `<dt>年齢</dt><dd>${o.age}歳</dd>`}
      <dt>${o.level === 'additional' ? '分類' : '難易度'}</dt><dd><span class="opp-level lv-${o.level}">${o.levelLabel}</span>${o.level === 'additional' ? '（難易度は未設定）' : ''}</dd>
      <dt>性格</dt><dd>${o.personality}</dd>
      <dt>打ち筋</dt><dd>${o.style}</dd>
    </dl>
    <div class="opp-d-actions"><button data-action="opp-toggle" data-id="${o.id}" class="${on ? '' : 'primary'}"${blocked ? ' disabled' : ''}>${on ? '選択を外す' : blocked ? '3人選択済み' : 'この相手を選ぶ'}</button></div>
  </div></div>`;
}

// 対戦相手の名前（席の順）：最終結果・再現情報で使う
function opponentsText() {
  return [1, 2, 3].map((s) => `${POS[s]} ${PLAYERS[s].name}（${LEVEL_LABELS[LEVEL_BY_ID[PLAYERS[s].id]]}）`).join('・');
}

// 不具合報告用の再現情報。山は seed と局の通し番号（round）で決まり、親の席・親番・連荘回数・局数も URL で指定する。
// （持ち点は再現しない。連荘で「局番号から親が決まらない」ため dealer を明示する）
function reportInfoHTML() {
  const m = S.match;
  const label = S.scored && S.lastRound ? S.lastRound : { label: handLabel(m), renchan: m.renchan };
  const hand = S.scored && S.lastRound ? m.log[m.log.length - 1].hand : m.hand;
  return `<p class="note report-info">再現情報：seed <b>${S.seedBase}</b> ／ ${label.label}・連荘${label.renchan}（通し第<b>${S.round}</b>局・親 ${POS[S.dealer]}）／ ${m.length}局戦 ／ ${modeLabel(rules)} ／ 対戦相手 ${opponentsText()}（ID ${S.matchSettings.seats.join(',')}）／ 画面 v${APP_VERSION} ・ エンジン v${ENGINE_VERSION}<br>
    この局から再現：URL の末尾に <code>${replayQuery({ seed: S.seedBase, round: S.round, dealer: S.dealer, hand, renchan: label.renchan, len: m.length, mode: LEGACY ? null : rules.config.mode, chars: S.matchSettings.seats }).replace(/&/g, '&amp;')}</code><br>
    <span class="report-caveat">このURLでは山・配牌・親・局状態を再現します。持ち点や過去の対局履歴は復元されず、全員100点から開始します。</span></p>`;
}

// ---------- ガイド（役一覧・ルール・牌一覧） ----------
const GUIDE_TABS = [['yaku', '役一覧'], ['rules', 'ルール'], ['tiles', '牌一覧']];

function guideHTML() {
  const tab = S.guideTab || 'yaku';
  const tabs = GUIDE_TABS.map(([id, label]) => `<button data-action="guide-tab" data-tab="${id}" class="tab ${tab === id ? 'on' : ''}" aria-pressed="${tab === id}">${label}</button>`).join('');
  const body = tab === 'rules' ? rulesHTML() : tab === 'tiles' ? tilesHTML() : yakuGuideHTML();
  return `<div class="guide"><div class="tabs" role="tablist">${tabs}</div>${body}</div>`;
}

function yakuGuideHTML() {
  const c = rules.config;
  const meldByKey = new Map(rules.melds.map((m) => [m.key, m]));
  // 条件文の角度はモードの表記（数学Ⅰ・旧規則は度数法、数学Ⅱは弧度法）
  const condFmt = { unit: c.angleUnit, degs: rules.types.filter((t) => t.kind === 'angle').map((t) => t.deg) };
  const card = (y, isSpecial) => {
    const g = YAKU_GUIDE[y.id] || { condition: '' };
    const pts = y.yakuman ? `役満 ${y.points}` : `+${y.points}`;
    const naki = y.closedOnly ? '<span class="tag closed">門前限定</span>' : '<span class="tag open">鳴いても可</span>';
    let ex = '';
    const example = (g.examples && g.examples[c.mode]) || g.example;
    if (example) {
      ex = example.map((k) => `<li>${formulaHTML(rules, meldByKey.get(k).idx)}</li>`).join('');
      ex = `<ol class="gy-ex">${ex}</ol>`;
    } else if (g.exampleAngles) {
      ex = `<div class="gy-tiles">${g.exampleAngles.map((d) => tileHTML(rules.typeByKey.get(`a:${d}`), { size: 's' })).join('')}</div>`;
    }
    return `<li class="gy" data-yaku="${y.id}"><div class="gy-head"><b>${y.name}</b>${isSpecial ? '<span class="tag sp">特殊和了</span>' : ''}${naki}<span class="gy-pts">${pts}</span></div>
      <p class="gy-cond">${guideCondition(g.condition, condFmt)}</p>${ex}</li>`;
  };
  const list = [
    ...c.yaku.filter((y) => y.enabled).map((y) => card(y, false)),
    ...c.specialHands.filter((s) => s.enabled).map((s) => card(s, true)),
  ].join('');
  const off = c.yaku.filter((y) => !y.enabled && y.disabledReason).map((y) => y.name);
  return `<h2>役ガイド <small>${modeLabel(rules)}</small></h2>
    <ul class="guide-notes">${GUIDE_NOTES.map((n) => `<li>${n}</li>`).join('')}<li>通常和了の基本点：${c.scoring.base}点</li>
    ${off.length ? `<li>${modeLabel(rules)}では成立しない役（表示しません）：${off.join('・')}</li>` : ''}</ul>
    <ul class="guide-yaku">${list}</ul>`;
}

function tilesHTML() {
  const sizes = [['l', '手牌'], ['m', '公開面子'], ['s', '結果画面'], ['xs', '河']];
  const kinds = [['func', '関数牌'], ['angle', '角度牌'], ['value', '結果牌']];
  return `<h2>牌一覧 <small>${modeLabel(rules)}</small></h2><p class="note">関数牌 各${rules.types.find((t) => t.kind === 'func').copies}枚・角度牌 ${rules.types.filter((t) => t.kind === 'angle').length}種と結果牌 13種 各4枚、計${rules.deckSize}枚。${rules.config.angleUnit === 'rad' ? '角度は弧度法（ラジアン）で表示。' : '角度は度数法で表示。'}</p>
    ${kinds.map(([k, label]) => `<h3>${label}</h3>${sizes.map(([sz, sl]) => `<div class="gallery sz-row-${sz}"><span class="gl">${sl}</span><span class="gtiles">${rules.types.filter((t) => t.kind === k).map((t) => tileHTML(t, { size: sz })).join('')}</span></div>`).join('')}`).join('')}`;
}

function rulesHTML() {
  const c = rules.config;
  const yaku = c.yaku.filter((y) => y.enabled).map((y) => `<li><span>${y.name}${y.yakuman ? '（役満候補）' : ''}${y.closedOnly ? '・門前限定' : ''}</span><b>${y.yakuman ? y.points : '+' + y.points}</b></li>`).join('');
  const sp = c.specialHands.filter((s) => s.enabled).map((s) => `<li><span>${s.name}（${s.angles.map((d) => angleText(rules.typeByKey.get(`a:${d}`))).join('・')}）${s.closedOnly ? '・門前限定' : ''}</span><b>${s.points}</b></li>`).join('');
  const ex30 = angleText(rules.typeByKey.get('a:30'));
  const common = `
    <li>フリテンは未実装。流局は山が尽きたとき。</li>
    <li><b>手牌の並び替え</b>：牌を長押し（約0.35秒）して左右に動かし、指を離した位置に入れます。手牌の外で離すと取り消し。表示の順番だけが変わり、ゲームには影響しません。「自動整列」で種類順に戻ります。新しいツモ牌は右端に入ります。</li>`;
  const body = c.rules.koutsu ? `
    <li><b>モード</b>：${modeLabel(rules)}（${c.angleUnit === 'rad' ? '弧度法・0〜2π の17種類' : '度数法・0°〜180° の9種類'}・関数牌 各${rules.types.find((t) => t.kind === 'func').copies}枚・計${rules.deckSize}枚）。モードは設定で選び、新しい対局から切り替わります。</li>
    <li><b>面子</b>は2種類：<b>数式面子</b>＝関数牌＋角度牌＋結果牌で正しい等式（例：sin ${ex30} = 1/2）、<b>刻子</b>＝同じ牌3枚（例：sin・sin・sin、1/2・1/2・1/2）。</li>
    <li><b>和了</b>：配牌8枚＋ツモ1枚＝9枚で3面子（雀頭は不要）。数式面子と刻子は自由に混ぜられます。または特殊和了（九角無双）。</li>
    <li><b>門前</b>（チー・ポンなし）なら役なしでも和了できます（通常和了 ${c.scoring.base}点）。</li>
    <li><b>チー</b>：上家の捨て牌で数式面子が完成するとき。<b>ポン</b>：他家3人の捨て牌で、手牌に同じ牌が2枚あるとき刻子を公開。チーとポンは合計${c.rules.maxCalls}回まで。鳴いた後は牌を1枚捨てます。</li>
    <li><b>鳴いた手は役が必要</b>。数式系の役は3組すべてが数式面子のときだけ付きます（刻子を含む混合形には付きません）。刻子を公開した手で付く役は対々和・関数一色です。</li>
    <li><b>優先順位</b>：ロン ＞ ポン ＞ チー。複数のロンはアタマハネ、複数のポンは打牌者から手番順に近い人。ほかの人のロン判断が終わるまでポン・チーは確定しません。</li>
    <li><b>三暗刻</b>は門前の刻子3組。ロンで最後の刻子を完成させた場合も成立します（Ver.0.3 の暫定規則。通常の麻雀とは異なります）。</li>${common}
    ${c.rules.riichi ? `<li><b>リーチ</b>：門前で、1枚捨てると聴牌（あと1枚で和了）になるとき、自分の番に「リーチ」を押して捨てる牌を選びます（聴牌になる牌だけ選べます）。リーチ後はツモ切りだけで、チー・ポンはできません。ロン・ツモはできます。リーチして和了すると基本点に<b>＋${c.rules.riichiBonus ?? 1}点</b>（役満には加算しません）。親子の精算の倍率は変わりません。リーチ棒・一発・裏ドラはありません。</li>` : ''}
    <li><b>チー・ポンの自動パス</b>（対戦画面の手牌の下のボタン・初期値 OFF）：チー・ポンをそれぞれ自動で見送ります。ロン・ツモは自動で見送りません。切り替えは次の宣言から反映されます。</li>`
    : `
    <li><b>面子</b>：関数牌＋角度牌＋結果牌で正しい等式（例：sin 30° = 1/2）。</li>
    <li><b>和了</b>：8枚＋1枚＝9枚で3面子。または特殊和了。</li>
    <li><b>チー</b>：上家の捨て牌で面子が完成するときのみ。面子は公開され、手牌から2枚減ります。チー後は役がないと和了できません。チーは最大2回。</li>
    <li><b>ロン</b>：他の3人の捨て牌で和了。ロンはチーより優先、複数ならアタマハネ（打牌者に近い人）。</li>
    <li><b>門前</b>（チーなし）なら役なしでも和了できます。</li>${common}`;
  return `<h2>ルール（暫定）</h2>
  <ul class="rules-list">${body}
  </ul>
  <h3>役と仮得点</h3><ul class="yaku"><li><span>通常和了</span><b>${c.scoring.base}</b></li>${yaku}${sp}</ul>
  <p class="note">役満成立時は通常和了点・通常役を加算せず、役満の点のみ（複数役満は加算）。点数は試作段階の暫定値です。<br>エンジン ${ENGINE_VERSION} / 牌 ${rules.deckSize}枚 / 数式面子 ${rules.formulaCount}種類${c.rules.koutsu ? `・刻子 ${rules.melds.length - rules.formulaCount}種類` : ''}</p>`;
}

function tableHTML() {
  const angles = rules.types.filter((t) => t.kind === 'angle');
  const cell = (fn, deg) => {
    const ex = trigExact(fn, deg);
    if (!ex) return '<td class="undef">なし</td>';
    const v = rules.types.find((t) => t.kind === 'value' && t.exact.p === ex.p && t.exact.q === ex.q && t.exact.r === ex.r);
    return `<td>${valueHTML(v.display)}</td>`;
  };
  return `<h2>三角関数の値表</h2><div class="table-wrap"><table class="values"><tr><th>角度</th><th>sin</th><th>cos</th><th>tan</th></tr>
    ${angles.map((a) => `<tr><th>${angleHTML(a)}</th>${cell('sin', a.deg)}${cell('cos', a.deg)}${cell('tan', a.deg)}</tr>`).join('')}</table></div>`;
}

function settingsHTML() {
  const labels = { fast: '速い', normal: '普通', slow: 'ゆっくり' };
  const opt = (v) => `<option value="${v}" ${S.speed === v ? 'selected' : ''}>${labels[v]}</option>`;
  const modeOpt = (m) => `<label class="setting radio"><input type="radio" name="mode" value="${m.id}" data-action="mode" ${S.nextMode === m.id ? 'checked' : ''}><span>${m.label}（${m.id === 'math1' ? '度数法・0°〜180°・124枚' : '弧度法・0〜2π・168枚'}）</span></label>`;
  return `<h2>設定</h2>
    <fieldset class="mode-select"><legend>モード（新しい対局から）</legend>
      ${Object.values(MODES).map(modeOpt).join('')}
      <p class="note mode-note">いまの対局：${modeLabel(rules)}。${S.nextMode !== rules.config.mode && !LEGACY ? '下の「新しい対局」で切り替わります（いまの局は変わりません）。' : 'モードの変更は「新しい対局」から反映されます。'}</p>
    </fieldset>
    <label class="setting">AIの速さ <select data-action="speed">${publicSpeedNames().map(opt).join('')}</select></label>
    <label class="setting">視覚演出 <select data-action="fx-mode"><option value="full" ${S.fx.mode === 'full' ? 'selected' : ''}>通常</option><option value="lite" ${S.fx.mode === 'lite' ? 'selected' : ''}>簡易（文字だけ）</option></select></label>
    <label class="setting">効果音 <select data-action="sound"><option value="1" ${S.sound.on ? 'selected' : ''}>オン</option><option value="0" ${S.sound.on ? '' : 'selected'}>オフ</option></select></label>
    ${voice.available() ? `<label class="setting">宣言ボイス <select data-action="voice"><option value="1" ${S.voice.on ? 'selected' : ''}>オン</option><option value="0" ${S.voice.on ? '' : 'selected'}>オフ</option></select></label>
    ${voice.manifest.credit ? `<p class="note voice-credit">${voice.manifest.credit}</p>` : ''}` : ''}
    <p class="note sound-note">打牌・チー・ポン・リーチ・ロン・ツモの効果音です。オフでもゲームは同じように進みます。音が出ないときは、画面を一度タップしてからお試しください（マナーモードでは鳴らない端末があります）。</p>
    <p class="note setting-note">チー・ポンの自動パスは、対戦画面の手牌の下のボタンで切り替えます（いま：チー ${S.chiAutoPass ? 'ON' : 'OFF'}・ポン ${S.ponAutoPass ? 'ON' : 'OFF'}）。チー・ポンをそれぞれ自動で見送ります。ロン・ツモは自動で見送りません。</p>
    ${reportInfoHTML()}
    <div class="modal-actions"><button data-action="reset">新しい対局（得点リセット）</button>
      ${S.confirmTitle ? '<span class="confirm-title">この対局を終了しますか？<button data-action="to-title" class="danger">終了してタイトルへ</button><button data-action="cancel-title">続ける</button></span>' : '<button data-action="ask-title">タイトルへ戻る</button>'}</div>`;
}

// ---------- ヒント ----------
// Ver.0.3-B：2段階のヒント。
//   第1段階（発見）：完成している数式の通り数・あと1枚の組合せ・狙える役・公開済み面子。式や枠は出さない。
//   第2段階（確認）：完成数式の全候補・手牌の色枠（最大2色）・同時に使える最大組数・共有の説明・表示の切替。
// 数式の整理は src/engine/formulahint.js（純粋関数）。役候補・得点・AI・進行には影響しない。
function closeHint() {
  S.hintOpen = false;
  S.hintKey = null;
  S.hintText = null;
  S.hintColors = null;
  S.hintStage = 1;
  S.hintHandKey = null;
  S.hintSel = null;
  S.hintMode = 'both';
}

// 自分の手牌の構成（物理牌 id の集合＋自分の公開面子）。表示順は含めない（並び替えでは変わらない）
function handStateKey() {
  const g = S.game;
  return `${S.gameSerial}|${g.hands[HUMAN].slice().sort((a, b) => a - b).join(',')}|${g.melds[HUMAN].map((m) => m.meld).join(',')}`;
}

function countHint(kind) {
  const key = handStateKey();
  if (S.hintCounted[kind].has(key)) return;
  S.hintCounted[kind].add(key);
  S.hintStats[kind]++;
  S.hintsUsed++;
}

function hintInputs() {
  const g = S.game;
  const view = g.viewFor(HUMAN);
  // 画面に出している宣言の選択肢と同じ経路だけを渡す（オートパスで出さないチー・ポンの経路は含めない）
  const claim = claimForSeat(claimPendingForHint(g.pending(), claimSettings()), HUMAN, (id) => g.typeOf(id));
  return { view, claim };
}

function refreshHintIfChanged() {
  const g = S.game;
  // 自分の手牌の構成が変わったら（打牌・ツモ・チー・ポン）第1段階へ戻す。他家の打牌・並び替えでは維持。
  const hk = handStateKey();
  if (hk !== S.hintHandKey) {
    S.hintHandKey = hk;
    S.hintStage = 1;
    S.hintSel = null;
    S.hintMode = 'both';
    S.hintFormulas = analyzeFormulas(rules, g.hands[HUMAN].map((id) => ({ id, type: g.typeOf(id) })));
  }
  const { view, claim } = hintInputs();
  const key = hintKey(view, claim);
  if (key !== S.hintKey) {
    S.hintKey = key;
    computeHint(view, claim);
  }
  buildHintText();
}

// 役候補などの公開情報に依存する部分（公開情報が変わったときだけ再計算）
function computeHint(view, claim) {
  const g = S.game;
  S.hintComputations = (S.hintComputations || 0) + 1;
  const ids = g.hands[HUMAN];
  const types = new Set(ids.map((id) => g.typeOf(id)));
  const handCounts = rules.countsOf(ids.map((id) => g.typeOf(id)));
  // あと1枚で完成する組合せ：数式面子は3種のうち2種が手にある、刻子は同じ牌が2枚ある
  const partial = rules.melds.filter((m) => (m.kind === 'koutsu' ? handCounts[m.type] === 2 : m.tiles.filter((t) => types.has(t)).length === 2)).length;
  // 役候補（公開情報のみ。必要な牌の種類や捨て牌は表示しない）
  const cands = yakuCandidates(rules, view, { claim });
  const candHTML = cands.length
    ? `<ol class="yaku-cands">${cands.map((c) => `<li><b>${c.name}</b><span class="yc-pts">${c.yakuman ? '役満' : `+${c.yakuPoints}`}</span>${c.closedOnly ? '<span class="tag closed">門前限定</span>' : ''}<span class="yc-miss">${c.missing === 0 ? '完成！' : `あと${c.missing}枚`}</span></li>`).join('')}</ol>`
    : '<p class="yc-none">いま狙える役は見つかりません</p>';
  S.hintPartial = partial;
  S.hintYakuHTML = `<div class="hint-yaku"><span class="hy-title">狙える役（近い順）</span>${candHTML}
      <p class="yc-note" title="「あと◯枚」は目標の完成形に不足する牌の枚数です。和了までのツモ回数や巡数ではありません。">※あと◯枚＝完成形に足りない牌の数（ツモ回数・巡数ではない）</p></div>
    <div class="hint-tools"><button data-action="table" class="small">値表を見る</button><button data-action="guide" class="small">役ガイド</button></div>`;
}

const FH_COLOR = { a: '赤', b: '青' };
// ヒント欄の HTML（段階と表示対象から毎回作る。計算は軽い）
function buildHintText() {
  const g = S.game;
  const fa = S.hintFormulas;
  const n = fa.formulas.length;
  const ex = exposedSummary(rules, g.melds[HUMAN]);
  const exLine = ex.formula || ex.koutsu
    ? `<div class="hb-row">公開済み：数式面子 <b>${ex.formula}組</b>・刻子 <b>${ex.koutsu}組</b></div>` : '';
  let basic = `<div class="hint-basic">
      <div class="hb-row">${g.melds[HUMAN].length ? '手牌内の' : ''}完成している数式：<b>${n}通り</b></div>
      <div class="hb-row">あと1枚で完成する組み合わせ：<b>${S.hintPartial}通り</b></div>${exLine}
      ${n > 0 && S.hintStage === 1 ? '<button data-action="fh-confirm" class="small fh-confirm">数式を確認する</button>' : ''}
    </div>`;
  S.hintColors = null;
  if (S.hintStage === 2 && n > 0) basic += formulaPanelHTML(fa);
  S.hintText = basic + S.hintYakuHTML;
}

function formulaPanelHTML(fa) {
  const g = S.game;
  const single = fa.formulas.length === 1;
  if (!S.hintSel) S.hintSel = initialSelection(rules, fa);
  const sel = S.hintSel;
  const hand = g.hands[HUMAN].map((id) => ({ id, type: g.typeOf(id) }));
  const res = assignColors(rules, hand, fa, sel, { mode: S.hintMode, single });
  S.hintColors = res.colors;
  const showA = S.hintMode !== 'b';
  const showB = S.hintMode !== 'a' && sel.b !== null;
  const role = (mi) => {
    if (single) return '<span class="fh-role fh-yellow">黄</span>';
    if (mi === sel.a) return `<span class="fh-role fh-red${showA ? '' : ' off'}">赤</span>`;
    if (mi === sel.b) return `<span class="fh-role fh-blue${showB ? '' : ' off'}">青</span>`;
    return '';
  };
  const items = fa.formulas.map((f, i) => {
    const picks = single ? '' : `<span class="fh-picks">
        <button data-action="fh-pick" data-slot="a" data-meld="${f.meld}" class="fh-pick fh-red" aria-pressed="${f.meld === sel.a}" aria-label="${i + 1}番を赤で表示">赤</button>
        <button data-action="fh-pick" data-slot="b" data-meld="${f.meld}" class="fh-pick fh-blue" aria-pressed="${f.meld === sel.b}" aria-label="${i + 1}番を青で表示">青</button></span>`;
    const copies = f.copies > 1 ? `<span class="fh-copies">×${f.copies}組</span>` : '';
    return `<li class="fh-item${f.meld === sel.a ? ' is-a' : ''}${f.meld === sel.b ? ' is-b' : ''}" data-meld="${f.meld}"><span class="fh-no">${i + 1}</span>${formulaHTML(rules, f.meld)}${copies}${role(f.meld)}${picks}</li>`;
  }).join('');
  const no = (mi) => fa.formulas.findIndex((f) => f.meld === mi) + 1;
  const modes = single || sel.b === null ? '' : `<div class="fh-modes" role="group" aria-label="表示する数式">
      <button data-action="fh-mode" data-mode="both" class="small" aria-pressed="${S.hintMode === 'both'}">2式（赤${no(sel.a)}・青${no(sel.b)}）</button>
      <button data-action="fh-mode" data-mode="a" class="small" aria-pressed="${S.hintMode === 'a'}">赤${no(sel.a)}だけ</button>
      <button data-action="fh-mode" data-mode="b" class="small" aria-pressed="${S.hintMode === 'b'}">青${no(sel.b)}だけ</button></div>`;
  const legend = single
    ? `<p class="fh-note">黄色の枠：${no(sel.a)}番の数式（${res.sets.a}組）</p>`
    : `<p class="fh-note">${showA ? `<span class="fh-red-t">赤の枠＝${no(sel.a)}番（${res.sets.a}組）</span>` : ''}${showA && showB ? '／' : ''}${showB ? `<span class="fh-blue-t">青の枠＝${no(sel.b)}番（${res.sets.b}組）</span>` : ''}</p>`;
  const shared = res.shared
    ? `<p class="fh-note fh-shared">赤と青の数式は牌を共有するため、同時には使用できません（2色の枠の牌）。手牌全体では、同時に最大${fa.max}組の数式を作れます。</p>` : '';
  return `<div class="fh">
      <div class="hb-row">同時に使える数式面子：<b>最大${fa.max}組</b>（手牌全体）</div>
      <ol class="fh-list">${items}</ol>${modes}${legend}${shared}
    </div>`;
}

// ---------- 入力 ----------
app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const g = S.game;
  switch (act) {
    case 'tile': {
      const id = Number(el.dataset.id);
      if (!humanDiscardFilter()(id)) break; // リーチ中・宣言牌の選択中に選べない牌（描画上もタップ不可）
      if (S.selected === id) humanAct({ type: 'discard', tile: id, ...(S.riichiSelect ? { riichi: true } : {}) });
      else { S.selected = id; render(); }
      break;
    }
    case 'riichi': {
      // 宣言牌の選択へ。選択中の牌が聴牌にならない牌なら選び直し
      const gg = S.game;
      const p = gg.pending();
      if (!p || p.seat !== HUMAN || p.type !== 'turn' || !gg.riichiOptions(HUMAN).length) break;
      S.riichiSelect = true;
      if (S.selected !== null && !humanDiscardFilter()(S.selected)) S.selected = null;
      render();
      break;
    }
    case 'riichi-cancel': S.riichiSelect = false; render(); break;
    case 'riichi-discard':
      if (S.selected !== null && S.riichiSelect && humanDiscardFilter()(S.selected)) humanAct({ type: 'discard', tile: S.selected, riichi: true });
      break;
    case 'tsumogiri': {
      const gg = S.game;
      if (gg.riichi[HUMAN] && gg.drawn !== null && gg.drawn !== undefined) humanAct({ type: 'discard', tile: gg.drawn });
      break;
    }
    case 'toggle-chi-autopass':
    case 'toggle-pon-autopass': {
      // 設定の保存だけ（ゲームは進めない・全体を描画し直さない：ドラッグ中や宣言の表示を妨げない）。次の宣言から反映。
      const kind = act === 'toggle-chi-autopass' ? 'chi' : 'pon';
      const on = !(kind === 'chi' ? S.chiAutoPass : S.ponAutoPass);
      if (kind === 'chi') { S.chiAutoPass = on; store.set(CHI_AUTOPASS_KEY, on ? '1' : '0'); } else { S.ponAutoPass = on; store.set(PON_AUTOPASS_KEY, on ? '1' : '0'); }
      el.outerHTML = autoPassToggleHTML(kind);
      break;
    }
    case 'autosort': {
      // 表示順だけを従来の種類順へ戻す（ツモ牌は右端）。エンジンの手牌は変えない。
      const gg = S.game;
      S.handOrder = defaultOrder(gg.hands[HUMAN], (id) => gg.typeOf(id), currentDrawn());
      render();
      break;
    }
    case 'discard':
      if (S.selected !== null) humanAct({ type: 'discard', tile: S.selected });
      break;
    case 'tsumo': humanAct({ type: 'tsumo' }); break;
    case 'ron': humanAct({ type: 'ron' }); break;
    case 'pon': humanAct({ type: 'pon' }); break;
    case 'chi': humanAct({ type: 'chi', option: Number(el.dataset.opt) }); break;
    case 'pass': humanAct({ type: 'pass' }); break;
    case 'hint':
      if (S.hintOpen) {
        closeHint(); // 閉じると色枠も解除。次に開くときは第1段階から
      } else {
        closeHint();
        S.hintOpen = true; // render() で最新の局面から計算（第1段階）
        countHint('discover');
      }
      render();
      break;
    case 'fh-confirm':
      // 第2段階（数式の確認）へ。同じ手牌の状態では回数を1回だけ数える
      if (!S.hintOpen) break;
      S.hintStage = 2;
      S.hintSel = null;
      S.hintMode = 'both';
      countHint('confirm');
      render();
      break;
    case 'fh-pick': {
      // 一覧の数式を赤（a）または青（b）に割り当てる（もう一方と同じなら入れ替え）。回数は数えない
      if (!S.hintOpen || S.hintStage !== 2 || !S.hintSel) break;
      const slot = el.dataset.slot === 'b' ? 'b' : 'a';
      const other = slot === 'a' ? 'b' : 'a';
      const mi = Number(el.dataset.meld);
      if (!S.hintFormulas.formulas.some((f) => f.meld === mi)) break;
      if (S.hintSel[other] === mi) S.hintSel[other] = S.hintSel[slot];
      S.hintSel[slot] = mi;
      if (S.hintMode !== 'both' && S.hintMode !== slot) S.hintMode = 'both';
      render();
      break;
    }
    case 'fh-mode':
      if (!S.hintOpen || S.hintStage !== 2) break;
      S.hintMode = ['both', 'a', 'b'].includes(el.dataset.mode) ? el.dataset.mode : 'both';
      render();
      break;
    case 'guide-tab':
      S.guideTab = el.dataset.tab;
      render();
      break;
    case 'guide': case 'table': case 'settings':
      if (act === 'table' && S.modal !== 'table') { S.hintStats.table++; S.hintsUsed++; }
      S.modal = act; render(); break;
    case 'close': S.modal = g.pending() ? null : 'result'; render(); break;
    case 'close-result': S.modal = null; render(); break;
    case 'show-result': S.modal = 'result'; render(); break;
    case 'next':
      // 試合が終わっていれば最終結果へ。続くなら次の局（連荘なら同じ親、親交代なら下家が親）
      if (S.match.over) { S.modal = 'final'; render(); break; }
      S.round++;
      startRound();
      break;
    case 'reset':
      // 設定画面の「新しい対局」：予約したモード（S.nextMode）・タイトルで選んだ局数と、この試合の3人（座席は選び直す）
      startMatch({ settings: { mode: S.nextMode, length: S.length, chars: S.matchSettings.chars } });
      break;
    case 'again':
      // 同じ3人と再戦：終了した試合と同じ設定（モード・局数・3人）で、新しい山・全員100点から。座席は選び直す。
      // 予約中の次回用モード（S.nextMode）やタイトルの選択（S.length）は使わない。
      S.seedBase = Math.floor(Math.random() * 1e9);
      startMatch({ settings: { mode: S.matchSettings.mode, length: S.matchSettings.length, chars: S.matchSettings.chars } });
      break;
    case 'change-opponents':
      // 相手を変更：直前の3人を選んだ状態で選択画面へ（1人だけ入れ替えることもできる）
      S.opp.selected = S.matchSettings.chars.slice();
      leaveGame('select');
      break;
    case 'br-open': {
      // 初心者の部屋：この端末の進み具合を読む。続きがあれば一覧から、なければ第1段階から。
      const room = createRoomState(loadProgress(roomStorage(), partsOf));
      if (hasProgress(room.progress)) openRoomList(room);
      else enterStage(room, rulesForMode('math1'), 0);
      S.beginnerRoom = room;
      S.screen = 'beginner-room'; saveRoom(); render(); break;
    }
    case 'br-pick':
      if (S.screen !== 'beginner-room') break;
      pickRoomTile(S.beginnerRoom, rulesForMode('math1'), Number(el.dataset.idx)); render(); break;
    case 'br-check':
      if (S.screen !== 'beginner-room') break;
      checkRoom(S.beginnerRoom, rulesForMode('math1')); saveRoom(); render(); break;
    case 'br-hint':
      if (S.screen !== 'beginner-room') break;
      roomHint(S.beginnerRoom); render(); break;
    case 'br-reset':
      // やり直し：今の段階（課題）を最初の局面から。通常対局には巻き戻しはない。
      if (S.screen !== 'beginner-room') break;
      retryRoom(S.beginnerRoom, rulesForMode('math1')); saveRoom(); render(); break;
    case 'br-next':
      if (S.screen !== 'beginner-room' || !S.beginnerRoom.done) break;
      if (!nextRoom(S.beginnerRoom, rulesForMode('math1'))) openRoomList(S.beginnerRoom);
      saveRoom(); render(); window.scrollTo(0, 0); break;
    case 'br-list':
      if (S.screen !== 'beginner-room') break;
      openRoomList(S.beginnerRoom); render(); window.scrollTo(0, 0); break;
    case 'br-goto':
      if (S.screen !== 'beginner-room') break;
      if (gotoStage(S.beginnerRoom, rulesForMode('math1'), Number(el.dataset.stage))) { saveRoom(); render(); window.scrollTo(0, 0); }
      break;
    case 'br-resume':
      if (S.screen !== 'beginner-room') break;
      resumeRoom(S.beginnerRoom, rulesForMode('math1')); saveRoom(); render(); window.scrollTo(0, 0); break;
    case 'br-title':
      if (S.screen !== 'beginner-room') break;
      S.screen = 'title'; render(); break;
    case 'br-challenge':
      // 卒業試験の後：通常の「対戦相手を選ぶ」画面へ（選択の状態はそのまま）
      if (S.screen !== 'beginner-room' || !S.beginnerRoom.done) break;
      S.opp.detail = null;
      S.opp.notice = null;
      S.screen = 'select'; render(); window.scrollTo(0, 0); break;
    case 'bp-tile':
      if (S.screen !== 'beginner-room') break;
      roomPracticeSelect(S.beginnerRoom, Number(el.dataset.id)); render(); break;
    case 'bp-discard': case 'bp-riichi': case 'bp-tsumo': case 'bp-ron': case 'bp-pon': case 'bp-chi': case 'bp-pass': {
      if (S.screen !== 'beginner-room') break;
      const type = { 'bp-discard': 'discard', 'bp-riichi': 'discard', 'bp-tsumo': 'tsumo', 'bp-ron': 'ron', 'bp-pon': 'pon', 'bp-chi': 'chi', 'bp-pass': 'pass' }[act];
      roomPracticeAct(S.beginnerRoom, { type, riichi: act === 'bp-riichi', option: Number(el.dataset.opt) });
      saveRoom(); render(); break;
    }
    case 'bp-continue':
      if (S.screen !== 'beginner-room') break;
      roomPracticeContinue(S.beginnerRoom); render(); break;
    case 'choose-opponents':
      // タイトルの「対戦相手を選ぶ」：選択画面へ（それまでの選択は残す）
      S.opp.detail = null;
      S.opp.notice = null;
      S.screen = 'select';
      render();
      break;
    case 'opp-toggle': {
      const r = toggleOpponent(S.opp.selected, el.dataset.id);
      S.opp.selected = r.selected;
      S.opp.notice = r.reason === 'full' ? `選べるのは${PICK_COUNT}人までです。入れ替えるときは、先に1人の選択を外してください。` : null;
      render();
      break;
    }
    case 'opp-detail':
      S.opp.detail = el.dataset.id;
      render();
      break;
    case 'opp-backdrop':
      if (ev.target !== el) break; // パネルの中のタップでは閉じない
    // fallthrough
    case 'opp-detail-close':
      S.opp.detail = null;
      render();
      break;
    case 'opp-random':
      // おまかせ：9人から異なる3人を一様に抽選し、それまでの選択を置き換える（対局は始めない）
      S.opp.selected = drawOpponents(Math.random);
      S.opp.notice = null;
      render();
      break;
    case 'ask-title': S.confirmTitle = true; render(); break;
    case 'cancel-title': S.confirmTitle = false; render(); break;
    case 'to-title':
      // 再現 URL のエラー画面から戻るときは、再読み込みで同じエラーに戻らないよう URL の検索部分を外す
      if (S.screen === 'replay-error') { try { history.replaceState(null, '', location.pathname); } catch { /* 無視 */ } }
      S.opp.detail = null;
      S.opp.notice = null;
      leaveGame('title'); // 選んだ3人は残す
      break;
    case 'start-match':
      // 選択画面の「対局開始」：3人そろったときだけ。タイトルで選んだモード・局数で確定し、座席をランダムに決める
      if (S.screen !== 'select' || !canStartWith(S.opp.selected)) break;
      S.seedBase = Math.floor(Math.random() * 1e9);
      S.opp.detail = null;
      S.opp.notice = null;
      startMatch({ settings: { mode: S.nextMode, length: S.length, chars: S.opp.selected } });
      break;
    default:
  }
});

app.addEventListener('change', (ev) => {
  if (ev.target.dataset.action === 'fx-mode') {
    // 値の保存だけ（ゲームは進めない）。表示中の演出は変えず、次の演出から反映する。
    S.fx.mode = parseEffectMode(ev.target.value);
    store.set(EFFECT_MODE_KEY, S.fx.mode);
  }
  if (ev.target.dataset.action === 'sound') {
    // 値の保存だけ（ゲームは進めない）。オンにしたときはこの操作の中で再生を許可しておく。
    S.sound.on = parseSoundSetting(ev.target.value);
    store.set(SOUND_KEY, S.sound.on ? '1' : '0');
    audioUnlock();
  }
  if (ev.target.dataset.action === 'voice') {
    // 値の保存だけ（ゲームは進めない）。オンにしたときはこの操作の中で読み込みを始める。
    S.voice.on = parseVoiceSetting(ev.target.value);
    store.set(VOICE_KEY, S.voice.on ? '1' : '0');
    audioUnlock();
  }
  if (ev.target.dataset.action === 'speed') {
    S.speed = resolveSpeed(ev.target.value, null, false);
    store.set('mj-speed', S.speed);
  }
  // タイトル画面の選択（「対局開始」で確定。保存もここで行う）
  if (ev.target.dataset.action === 'title-mode') {
    const m = parseMode(ev.target.value);
    if (m) { S.nextMode = m; store.set(MODE_KEY, m); }
  }
  if (ev.target.dataset.action === 'title-length') {
    const l = parseLen(ev.target.value);
    if (l) { S.length = l; store.set('mj-length', String(l)); }
  }
  if (ev.target.dataset.action === 'mode') {
    // 次の新しい対局のモードを選ぶだけ（いまの局は変えない）
    const m = parseMode(ev.target.value);
    if (m) { S.nextMode = m; store.set(MODE_KEY, m); render(); }
  }
});

// ---------- 手牌の並び替え（長押しドラッグ） ----------
function humanClaimPending() {
  const p = S.game && S.game.pending();
  return !!(p && p.seat === HUMAN && p.type === 'claim');
}
const drag = createHandDrag(app, {
  // 宣言待ち・モーダル表示中・終局中は並び替え不可
  canStart: () => !!(S.game && !S.modal && S.game.pending() && !humanClaimPending()),
  // これが変わったら並び替えを中止：局・モーダル・手牌 ID・宣言状態・終局
  snapshot: () => {
    const g = S.game;
    if (!g) return '';
    return [S.gameSerial, S.modal || '', g.hands[HUMAN].slice().sort((a, b) => a - b).join(','), humanClaimPending(), !g.pending()].join('|');
  },
  getOrder: () => currentOrder(),
  onDragStart: () => { S.selected = null; S.dragCount = (S.dragCount || 0) + 1; },
  onDragEnd: ({ committed, order, reason }) => {
    if (committed) S.handOrder = order;
    S.lastDragEnd = { committed, reason };
    if (reason !== 'render') render();
    if (S.stepDeferred) {
      S.stepDeferred = false;
      // render() の途中で中止された場合も、描画が終わってから AI を再開する
      setTimeout(() => { if (!drag.isDragging() && !S.timer) step(); }, 0);
    }
  },
});

// テスト・デバッグ用（E2E テストが盤面を確認するため）
// goRound(n, dealer)：テスト用。通し第 n 局（山）を、親の席 dealer で始める（試合の状態もそれに合わせる）
function goRound(n, dealer = (n - 1) % 4) {
  const hand = Math.max(0, Math.min(S.length - 1, n - 1));
  S.match = matchAt({ length: S.match ? S.match.length : S.length, hand, startDealer: (((dealer - hand) % 4) + 4) % 4 });
  S.scores = S.match.scores;
  S.round = n;
  startRound();
}
if (IS_LOCAL) window.__mathjong = { S, get rules() { return rules; }, decide, startRound, startMatch, goRound, render, step, drag, fx: { fire: fxFire, clear: fxClear, scan: fxScan, tick: fxTick }, sound, soundScan, voice };

// 対局を終了して別の画面へ（AI の進行・ドラッグ・ヒント・演出・音を止める）
function leaveGame(screen) {
  clearTimeout(S.timer);
  S.timer = null;
  if (drag && drag.isDragging()) drag.cancel('render');
  closeHint();
  fxClear();
  sound.silence();
  S.confirmTitle = false;
  S.modal = null;
  S.game = null;
  S.publicAiHistory = newPublicHistory();
  S.screen = screen;
  render();
}

// 試合を始める。fromUrl：?seed= の再現・テスト用 URL（親番・連荘・親の席を URL から）
// settings：{ mode, length, chars, seats } 試合の設定（採用元は呼び出し側が決める：選択画面／同じ3人と再戦／設定画面／再現 URL）
//   chars：選んだ3人のID。seats：席1〜3（下家・対面・上家）の順のID。seats がなければ chars を一様にランダムに並べる（6通り）。
//   ai（従来の再現 URL・テスト用）：その難易度の既定の3人を、従来どおりの席の順で使う。
// 座席は試合の開始時に確定し、試合の途中では変えない。人間は席0。
function startMatch({ fromUrl = false, settings = null } = {}) {
  const cfg = settings || { mode: S.nextMode, length: S.length, ai: S.ai };
  let chars = cfg.chars, seats = cfg.seats;
  if (!chars) { chars = rosterForLevel(cfg.ai || 'intermediate').map((c) => c.id); seats = chars.slice(); }
  if (!seats) seats = assignSeats(chars, Math.random);
  // この試合の設定（「同じ3人と再戦」「相手を変更」「最終結果」「再現情報」で使う）
  S.matchSettings = { mode: cfg.mode, length: cfg.length, chars: chars.slice(), seats: seats.slice() };
  PLAYERS = playersFor(seats); // 試合開始時にキャラクター3人と座席を確定
  S.aiDecisionsBySeat = [{}, {}, {}, {}];
  S.publicAiHistory = newPublicHistory();
  if (IS_LOCAL) { S.aiDecisionTiming = []; S.aiFirstDecisionTiming = {}; S.aiDecisionMaxMs = 0; }
  S.mode = cfg.mode;
  rules = rulesForMode(S.mode);
  S.screen = 'game';
  S.confirmTitle = false;
  S.history = [];
  S.prevScores = null;
  S.lastRound = null;
  if (fromUrl) {
    // 検証済みの値（src/ui/replay.js）。従来の ?round=n だけの URL は、親が (n−1) mod 4、親番が n−1（局数の範囲に丸め）。
    // 起家（東1局の親）は、指定された親の席と親番から逆算する（どの組み合わせも矛盾しない）。
    const { round: n, hand: h, dealer, renchan } = RV;
    S.match = matchAt({ length: cfg.length, hand: h, renchan, startDealer: (((dealer - h) % 4) + 4) % 4 });
    S.round = n;
  } else {
    S.match = createMatch({ length: cfg.length });
    S.round = 1;
  }
  S.scores = S.match.scores;
  startRound();
}

if (REPLAY.kind !== 'none' && REPLAY.ok) startMatch({ fromUrl: true, settings: RV.chars ? { mode: S.nextMode, length: S.length, chars: RV.chars, seats: RV.chars } : { mode: S.nextMode, length: S.length, ai: S.ai } });
else render(); // タイトル画面、または再現 URL のエラー画面
