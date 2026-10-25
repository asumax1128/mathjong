// MATHJONG 画面制御。ゲームの判定はすべて engine 側で行い、ここは表示と入力だけを担当する。
import { createRules } from '../engine/rules.js';
import { makeConfig, MODES, DEFAULT_MODE, ENGINE_VERSION } from '../engine/config.js';
import { Game } from '../engine/game.js';
import { decide, applyAction, PERSONALITIES } from '../engine/ai.js';
import { createRng } from '../engine/rng.js';
import { trigExact } from '../engine/exact.js';
import { tileHTML, formulaHTML, backHTML, valueHTML, angleHTML, angleText } from './render.js';
import { yakuCandidates, warmUp, claimForSeat } from '../engine/yakuhint.js';
import { hintKey } from './hintstate.js';
import { analyzeFormulas, initialSelection, assignColors, exposedSummary } from '../engine/formulahint.js';
import { createMatch, applyRoundResult, dealerOf, handLabel, ranks, matchAt, START_POINTS } from '../engine/match.js';
import { reconcileOrder, defaultOrder } from './handorder.js';
import { createHandDrag } from './handdrag.js';
import { CHI_AUTOPASS_KEY, parseChiAutoPass, visibleClaimActions, claimPendingForHint, claimPolicy, autoPassDue } from './autopass.js';
import { YAKU_GUIDE, GUIDE_NOTES, guideCondition } from './guide.js';
import { isLocalHost, resolveSpeed, speedDelays, publicSpeedNames, intParam } from './params.js';

// 画面（UI）の版。エンジン（判定・AI）の版 ENGINE_VERSION とは別に管理する。
// ヘッダー・ページタイトル・再現情報はすべてこの値から表示する（index.html の title は tests/autopass.test.js で照合）。
const APP_VERSION = '0.4.0-a';
document.title = `数雀（MATHJONG）Ver.${APP_VERSION}`;
const params = new URLSearchParams(location.search);
// テスト専用機能（山の指定・AI待ち時間0）はローカル開発環境でのみ有効。公開サイトでは無効。
const IS_LOCAL = isLocalHost(location.hostname);
// ?seed=（0〜999999999の整数）と ?round=（1〜999）だけを受け付ける。不正値は無視。
const seedParam = intParam(params.get('seed'), 999999999);
const roundParam = intParam(params.get('round'), 999);
// Ver.0.4-A 対局の再現：?len=4|8（局数）・?hand=0〜7（親番：0=東1局）・?renchan=（連荘回数）・?dealer=0〜3（その局の親の席）・?ai=
const lenParam = intParam(params.get('len'), 8);
const handParam = intParam(params.get('hand'), 7);
const renchanParam = intParam(params.get('renchan'), 99);
const dealerParam = intParam(params.get('dealer'), 3);
// ?seed= がある URL（再現・テスト）はタイトルを飛ばしてその局から始める。ない場合はタイトル画面。
const DIRECT_START = seedParam !== null && seedParam !== undefined;
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
const PLAYERS = [
  { name: 'あなた', kind: 'human' },
  { name: 'AI-A', kind: 'ai', personality: 'speed' },
  { name: 'AI-B', kind: 'ai', personality: 'value' },
  { name: 'AI-C', kind: 'ai', personality: 'closed' },
];

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作する */ } },
};

// AI 難易度（Ver.0.4-A では設定の保持と表示だけ。対局 AI はすべて現行の中級の判断）
const AI_LEVELS = [
  { id: 'beginner', label: '初級', ready: false },
  { id: 'intermediate', label: '中級', ready: true },
  { id: 'advanced', label: '上級', ready: false },
];
const parseLen = (v) => (v === 4 || v === 8 || v === '4' || v === '8' ? Number(v) : null);
const parseAi = (v) => (AI_LEVELS.some((a) => a.id === v) ? v : null);
const aiLabel = (id) => {
  const a = AI_LEVELS.find((x) => x.id === id) || AI_LEVELS[1];
  return a.ready ? a.label : `${a.label}（準備中・中級のAIで対局）`;
};

const S = {
  // 局の通し番号（連荘を含む、1から）。山は seed と この番号だけで決まる（従来の ?round=n と同じ）。
  round: roundParam && roundParam > 0 ? roundParam : 1,
  dealer: 0, // その局の親の席（試合の状態 S.match から決まる）
  scores: [START_POINTS, START_POINTS, START_POINTS, START_POINTS],
  match: null, // 試合の状態（src/engine/match.js）
  screen: DIRECT_START ? 'game' : 'title',
  seedBase: seedParam ?? Math.floor(Math.random() * 1e9),
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
// 対局中のモード（S.mode）と、次の新しい対局で使うモード（S.nextMode）
S.mode = parseMode(params.get('mode')) || parseMode(store.get(MODE_KEY, null)) || DEFAULT_MODE;
S.nextMode = S.mode;
let rules = rulesForMode(S.mode);
// 対局設定（タイトル画面で選び、「対局開始」で確定）。保存キー mj-mode・mj-length・mj-ai
S.length = parseLen(lenParam) || parseLen(store.get('mj-length', null)) || 4;
S.ai = parseAi(params.get('ai')) || parseAi(store.get('mj-ai', null)) || 'intermediate';
// チーのオートパス（Ver.0.2-B）。保存値 '1' だけが ON、それ以外・保存不可は OFF。
S.chiAutoPass = parseChiAutoPass(store.get(CHI_AUTOPASS_KEY, null));
// 自動パスの回数（手動操作の S.input とは別に数える）と、次の自分の手番に出す通知
S.autoPass = { count: 0, failed: 0, noticePending: false, noticeKey: null };
// 人間の入力の処理回数（多重処理の検出用。accepted=打牌などが成立、ignored=手番外の入力）
S.input = { accepted: 0, ignored: 0, failed: 0 };

const app = document.getElementById('app');
const T = (idx) => rules.types[idx];
const nameOf = (s) => (s === HUMAN ? 'あなた' : `${PLAYERS[s].name}`);

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
  S.autoPass.noticePending = false;
  S.autoPass.noticeKey = null;
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
const claimAutoPassOn = () => { const c = currentClaimPolicy(); return !!(c && c.autoPass); };

// changed：直前にゲーム状態を変えた（AI の行動・自動パスの直後）。このときだけ AI の手番でも描画する。
// それ以外（ドラッグ後の再開など）では従来どおり AI の手番で再描画しない（操作中のタップを妨げない）。
function step(changed = false) {
  clearTimeout(S.timer);
  S.timer = null;
  // 手牌の並び替え（dragging）中は AI を進めない。指を離すか中止した時点で step() を1回だけ呼び直す。
  // AI の判断・乱数は局面だけで決まるので、待つ時間は結果に影響しない。
  if (drag && drag.isDragging()) { S.stepDeferred = true; return; }
  const g = S.game;
  const p = g.pending();
  if (!p) {
    S.autoPass.noticePending = false; // 他家のロン・流局で終わったら通知は持ち越さない
    return finishRound();
  }
  if (p.seat === HUMAN) {
    if (p.type === 'claim') {
      // 宣言の方針は、その宣言が発生した時点の設定で決め、同じ宣言の間は変えない（表示中の選択肢を途中で変えない）
      const policy = S.claimPolicy = claimPolicy(S.claimPolicy, stateKey(), S.chiAutoPass);
      // チーのオートパス：ON・ロン不可・チー候補ありのときだけ、宣言ボタンを描画する前に1回だけ見送る
      if (autoPassDue(policy, p, HUMAN)) {
        policy.tried = true;
        if (applyHumanAction({ type: 'pass' }) === 'ok') {
          S.autoPass.count++;
          S.autoPass.noticePending = true;
          return step(true); // 次の判断番へ（後続のロン判断か、自分のツモ番）
        }
        S.autoPass.failed++; // 失敗したら通常の宣言 UI を表示（手動で選べる）
      }
    } else if (S.autoPass.noticePending) {
      // 自動パス後の最初の自分の手番：この手番の間だけ状態欄に通知を出す
      S.autoPass.noticePending = false;
      S.autoPass.noticeKey = stateKey();
    }
    return render();
  }
  if (changed) render();
  const [turnDelay, claimDelay] = speedDelays(S.speed, IS_LOCAL);
  S.timer = setTimeout(() => {
    S.timer = null;
    if (g !== S.game) return;
    if (drag && drag.isDragging()) { S.stepDeferred = true; return; }
    const action = decide(g, p.seat, PLAYERS[p.seat].personality, S.aiRng);
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
    S.prevScores = S.match.scores.slice();
    S.lastRound = { label: handLabel(S.match), renchan: S.match.renchan, dealer: S.dealer };
    S.match = applyRoundResult(S.match, g.result);
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
  render();
  step();
}

// ---------- 描画 ----------

function lastEventText() {
  const g = S.game;
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.type === 'discard') return `${nameOf(e.seat)} が ${tileHTML(T(g.typeOf(e.tile)), { size: 's' })} を捨てました`;
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
    return `<span class="meld ${m.call === 'pon' ? 'pon' : 'chi'}" title="${m.call === 'pon' ? 'ポン' : 'チー'}">${tiles}</span>`;
  }).join('');
}

function riverHTML(seat, size) {
  const g = S.game;
  const last = [...g.events].reverse().find((e) => e.type === 'discard');
  const claimTile = g.claim ? g.claim.tile : null;
  return g.rivers[seat].map((r) => tileHTML(T(g.typeOf(r.id)), {
    size,
    cls: [r.tsumogiri ? 'tsumogiri' : '', last && last.tile === r.id ? 'last' : '', claimTile === r.id ? 'claimable' : ''].join(' '),
  })).join('');
}

function panelHTML(seat) {
  const g = S.game;
  const p = g.pending();
  const active = p && p.seat === seat && p.type === 'turn';
  const pl = PLAYERS[seat];
  const pers = pl.personality ? `<span class="pers">${PERSONALITIES[pl.personality].label}</span>` : '';
  return `<section class="panel seat-${seat} ${active ? 'active' : ''}">
    <header>
      <span class="pos">${POS[seat]}</span><span class="name">${pl.name}</span>${pers}
      ${g.dealer === seat ? '<span class="oya">親</span>' : ''}
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
  const tile = (id) => tileHTML(T(g.typeOf(id)), {
    size: 'l', id,
    cls: [myTurn ? 'tap' : '', S.selected === id ? 'selected' : '', frame(id),
      id === drawn ? (drawnAtEnd ? 'drawn' : 'drawn drawn-mark') : ''].join(' '),
    attrs: myTurn ? `data-action="tile" tabindex="0"` : '',
  });
  const body = order.map((id) => (drawnAtEnd && id === drawn ? `<span class="drawn-gap"></span>${tile(id)}` : tile(id))).join('');
  return `<div class="hand">${body}</div>
    <div class="hand-help"><span>長押しで並び替え・タップ2回で捨てる</span><span class="hh-tools"><button data-action="autosort" class="small">自動整列</button><button data-action="hint" class="small hint-btn" aria-pressed="${!!S.hintOpen}">ヒント</button></span></div>`;
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
  if (p.type === 'turn') {
    const tsumo = p.canTsumo ? '<button data-action="tsumo" class="win">ツモ</button>' : '';
    const sel = S.selected !== null;
    // チーを自動で見送った後の最初の手番だけ、通常の案内の代わりに通知を出す（状態欄の大きさは変えない）
    const notice = S.autoPass.noticeKey === stateKey() ? 'チーを自動で見送りました' : null;
    const text = p.canTsumo ? (notice ? `${notice}・和了できます！` : '和了できます！')
      : notice || (g.justDrew ? 'あなたの番：捨てる牌を選択' : `${lastCallName(g)}後：捨てる牌を選択`);
    return `<div class="actions">
      <span class="status${notice ? ' autopass-notice' : ''}">${text}</span>
      ${tsumo}
      <button data-action="discard" class="primary" ${sel ? '' : 'disabled'}>捨てる</button>
    </div>`;
  }
  const tile = tileHTML(T(g.typeOf(p.tile)), { size: 'm' });
  // 表示する選択肢はこの宣言の方針で決める（OFF なら従来どおり全部。ON でロン＋チーならチーを出さない）
  const v = visibleClaimActions(p, claimAutoPassOn());
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
  return `<div class="overlay" role="dialog" aria-modal="true"><div class="modal">${body}
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
    detail += `<ul class="yaku">${base}${yaku || (a.yakuman ? '' : '<li class="none"><span>役なし（門前のため和了可）</span><b></b></li>')}
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
  const nextLine = m.over ? `<p class="next-round over">${S.lastRound.label}の親番が終わりました。<b>試合終了</b>です。</p>`
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

// 試合終了のリザルト（最終順位・得点・開始点との差・和了回数・最高和了・局数・連荘・設定）
function finalHTML() {
  const m = S.match;
  const rk = ranks(m.scores);
  const order = [0, 1, 2, 3].sort((a, b) => rk[a] - rk[b] || a - b);
  const sign = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : '±0');
  const rows = order.map((s) => `<tr class="${s === HUMAN ? 'me' : ''}"><td class="rank">${rk[s]}位</td><th>${s === HUMAN ? 'あなた' : `${PLAYERS[s].name}<small>${PERSONALITIES[PLAYERS[s].personality].label}</small>`}</th>
      <td class="pts">${m.scores[s]}</td><td>${sign(m.scores[s] - START_POINTS)}</td><td>${m.wins[s]}回</td><td>${m.best[s] ? `+${m.best[s]}<small>（和了点${m.bestBase[s]}）</small>` : '—'}</td></tr>`).join('');
  return `<div class="final">
    <h2>試合終了</h2>
    <p class="final-me">あなたは <b>${rk[HUMAN]}位</b>（${m.scores[HUMAN]}点）</p>
    <div class="table-wrap"><table class="final-table">
      <tr><th>順位</th><th>名前</th><th>得点</th><th>開始との差</th><th>和了</th><th>最高和了</th></tr>${rows}</table></div>
    <ul class="final-info">
      <li>実施した局数：<b>${m.played}局</b>（${m.length === 4 ? '4局戦・東1〜東4局' : '8局戦・東1〜南4局'}）</li>
      <li>連荘回数：<b>${m.renchanTotal}回</b></li>
      <li>数学モード：${modeLabel(rules)} ／ AI難易度：${aiLabel(S.ai)}</li>
      <li class="note">開始時の持ち点は各${START_POINTS}点（合計${START_POINTS * 4}点）。同点は同順位。点数配分は試作段階の暫定値です。</li>
    </ul>
    <div class="modal-actions"><button data-action="again" class="primary">もう一度遊ぶ</button><button data-action="to-title">タイトルへ戻る</button></div>
  </div>`;
}

// ---------- タイトル画面 ----------
// ロゴは後日画像に差し替える（.title-logo の中身だけを置き換えればよい構造）
function titleHTML() {
  const radio = (name, value, label, checked, extra = '') => `<label class="setting radio"><input type="radio" name="${name}" value="${value}" data-action="title-${name}" ${checked ? 'checked' : ''}><span>${label}${extra}</span></label>`;
  return `<main class="title-screen">
    <div class="title-logo" role="img" aria-label="数雀（MATHJONG）"><span class="tl-main">数雀</span><span class="tl-sub">MATHJONG</span></div>
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
      <fieldset class="title-set"><legend>AI難易度</legend>
        ${AI_LEVELS.map((a) => radio('ai', a.id, a.label, S.ai === a.id, a.ready ? '' : '<small class="soon">準備中</small>')).join('')}
        <p class="note">初級・上級は準備中です。現在はどれを選んでも中級（これまでのAI）で対局します。</p>
      </fieldset>
    </div>
    <button data-action="start-match" class="primary start-btn">対局開始</button>
    <p class="note title-ver">持ち点 各${START_POINTS}点 ／ 画面 v${APP_VERSION}・エンジン v${ENGINE_VERSION}</p>
  </main>`;
}

// 不具合報告用の再現情報。山は seed と局の通し番号（round）で決まり、親の席・親番・連荘回数・局数も URL で指定する。
// （持ち点は再現しない。連荘で「局番号から親が決まらない」ため dealer を明示する）
function reportInfoHTML() {
  const modeQ = LEGACY ? '' : `&amp;mode=${rules.config.mode}`;
  const m = S.match;
  const label = S.scored && S.lastRound ? S.lastRound : { label: handLabel(m), renchan: m.renchan };
  const hand = S.scored && S.lastRound ? m.log[m.log.length - 1].hand : m.hand;
  return `<p class="note report-info">再現情報：seed <b>${S.seedBase}</b> ／ ${label.label}・連荘${label.renchan}（通し第<b>${S.round}</b>局・親 ${POS[S.dealer]}）／ ${m.length}局戦 ／ ${modeLabel(rules)} ／ 画面 v${APP_VERSION} ・ エンジン v${ENGINE_VERSION}<br>
    この局から再現：URL の末尾に <code>?seed=${S.seedBase}&amp;round=${S.round}&amp;dealer=${S.dealer}&amp;hand=${hand}&amp;renchan=${label.renchan}&amp;len=${m.length}${modeQ}</code></p>`;
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
    <li><b>チーのオートパス</b>（設定・初期値 OFF）：ON にすると、チーだけできる場面を自動で見送ります。ロン・ポン・ツモは自動で見送りません。ロンやポンもできるときはチーを表示せず、「ロンしない／見送る」でチーも見送ります。</li>`
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
    <label class="setting toggle"><input type="checkbox" data-action="chi-autopass" ${S.chiAutoPass ? 'checked' : ''}><span>チーのオートパス</span></label>
    <p class="note setting-note">チーだけできる場面を自動で見送ります。ロン・ポン・ツモは自動で見送りません（ポンとチーが両方できるときはチーだけを見送ります）。</p>
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
  // 画面に出している宣言の選択肢と同じ経路だけを渡す（ON でロン＋チーのときチーの経路は含めない）
  const claim = claimForSeat(claimPendingForHint(g.pending(), claimAutoPassOn()), HUMAN, (id) => g.typeOf(id));
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
      if (S.selected === id) humanAct({ type: 'discard', tile: id });
      else { S.selected = id; render(); }
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
      // 新しい対局：選んだモードをここで反映する（進行中の局のモードは変えない）。局数・AI 設定は同じ
      startMatch();
      break;
    case 'again':
      // もう一度遊ぶ：同じ設定で新しい山（seed）から
      S.seedBase = Math.floor(Math.random() * 1e9);
      startMatch();
      break;
    case 'ask-title': S.confirmTitle = true; render(); break;
    case 'cancel-title': S.confirmTitle = false; render(); break;
    case 'to-title':
      // 対局を終了してタイトルへ（AI の進行・ドラッグ・ヒントを止める）
      clearTimeout(S.timer);
      S.timer = null;
      if (drag && drag.isDragging()) drag.cancel('render');
      closeHint();
      S.confirmTitle = false;
      S.modal = null;
      S.game = null;
      S.screen = 'title';
      render();
      break;
    case 'start-match':
      S.seedBase = Math.floor(Math.random() * 1e9);
      startMatch();
      break;
    default:
  }
});

app.addEventListener('change', (ev) => {
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
  if (ev.target.dataset.action === 'title-ai') {
    const a = parseAi(ev.target.value);
    if (a) { S.ai = a; store.set('mj-ai', a); }
  }
  if (ev.target.dataset.action === 'mode') {
    // 次の新しい対局のモードを選ぶだけ（いまの局は変えない）
    const m = parseMode(ev.target.value);
    if (m) { S.nextMode = m; store.set(MODE_KEY, m); render(); }
  }
  if (ev.target.dataset.action === 'chi-autopass') {
    // 値の保存だけ。次に発生する宣言から反映し、表示中の宣言の選択肢は変えない（ゲームは進めない）
    S.chiAutoPass = ev.target.checked === true;
    store.set(CHI_AUTOPASS_KEY, S.chiAutoPass ? '1' : '0');
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
if (IS_LOCAL) window.__mathjong = { S, get rules() { return rules; }, decide, startRound, startMatch, goRound, render, step, drag };

// 試合を始める。fromUrl：?seed= の再現・テスト用 URL（親番・連荘・親の席を URL から）
function startMatch({ fromUrl = false } = {}) {
  S.mode = S.nextMode;
  rules = rulesForMode(S.mode);
  S.screen = 'game';
  S.confirmTitle = false;
  S.history = [];
  S.prevScores = null;
  S.lastRound = null;
  if (fromUrl) {
    // 従来の ?round=n だけの URL：親は (n−1) mod 4、親番は n−1（局数の範囲に丸める）
    const n = roundParam && roundParam > 0 ? roundParam : 1;
    const hand = handParam !== null && handParam !== undefined ? handParam : Math.min(n - 1, S.length - 1);
    const dealer = dealerParam !== null && dealerParam !== undefined ? dealerParam : (n - 1) % 4;
    const h = Math.max(0, Math.min(S.length - 1, hand));
    S.match = matchAt({ length: S.length, hand: h, renchan: renchanParam || 0, startDealer: (((dealer - h) % 4) + 4) % 4 });
    S.round = n;
  } else {
    S.match = createMatch({ length: S.length });
    S.round = 1;
  }
  S.scores = S.match.scores;
  startRound();
}

if (DIRECT_START) startMatch({ fromUrl: true });
else render();
