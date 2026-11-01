// 牌譜（Ver.0.8 第1段階・docs/74）：通常対局の記録と、記録された選択による再現・検証。DOM・保存・AI は使わない。
// PR #37（Draft・旧 main 基点）の src/engine/paifu.js から、エラー型・正規化 JSON・JSON の安全検査・バイト上限・
// 「記録された選択を隔離した Game で再生して検証する」考え方を移植し、記録の形式は現行エンジン（ruleset 2：王牌・ドラ・
// 暗カン・フリテン・四家立直、リーチ宣言料の供託、1/4/8局戦、アガリやめ）に合わせて作り直した（schemaVersion 2）。
//
// 記録の方針：局の開始は seed・親・局番号から決定的に配られる（Game のコンストラクタ）ので、山・手牌のスナップショットは
// 保存しない。保存するのは「実際に実行された行動」（席・行動・出どころ）と、各行動の後の状態の要約（digest）だけ。
// 再現は同じ設定で Game を作り直し、記録された行動を順にエンジンへ適用して、digest・局の結果・精算・試合の状態を照合する。
// AI に再判断させない・ゲーム本体や AI の乱数を消費しない（検証用の Game は独立したインスタンス）。
//
// 注意：この記録（visibility: 'private-full'）から全員の手牌・山を再現できる。画面への表示・共有・AI への受け渡しはしない。
import { ENGINE_VERSION, makeConfig } from './config.js';
import { createRules } from './rules.js';
import { Game } from './game.js';
import { applyRoundResult, dealerOf, ranks, potTotal, START_POINTS } from './match.js';

export const PAIFU_FORMAT = 'mathjong-paifu';
export const PAIFU_SCHEMA_VERSION = 2; // 1＝PR #37 の試作（main では書かない・読まない）
export const PAIFU_KIND = 'normal-match';
export const PAIFU_RULESET = 2; // 記録の対象は現行ルール（ruleset 2）の通常対局だけ
export const PAIFU_MAX_BYTES = 4 * 1024 * 1024; // 1件の上限（保存・読込の検査用。ブラウザの容量とは別）
export const PAIFU_MAX_ROUNDS = 64;
export const PAIFU_MAX_STEPS = 4000; // 1局あたりの行動数の上限
export const ROUND_SEED_STEP = 7919; // app.js と同じ：局の seed＝seedBase＋局番号×7919
export const PAIFU_SOURCES = ['human', 'auto-pass', 'auto-tsumogiri', 'ai'];
const STATUSES = ['recording', 'complete', 'aborted'];
const TERMINATIONS = ['left-match', 'reset', 'recording-error'];
const END_REASONS = ['normal', 'agari-yame', 'round-limit'];

export class PaifuError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'PaifuError'; this.path = path; }
}
const requireThat = (ok, path, message) => { if (!ok) throw new PaifuError(path, message); };
const copy = (x) => JSON.parse(JSON.stringify(x));
// 正規化 JSON（オブジェクトのキーを並べ替える）。比較・保存の表現を一意にする
export const canonical = (x) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const same = (a, b, path) => requireThat(canonical(a) === canonical(b), path, 'mismatch');
const integer = (n, min, max, path) => requireThat(Number.isSafeInteger(n) && n >= min && n <= max, path, 'integer out of range');
const text = (s, path, max = 128) => requireThat(typeof s === 'string' && s.length > 0 && s.length <= max, path, 'invalid text');
const exactKeys = (o, names, path) => {
  requireThat(o && typeof o === 'object' && !Array.isArray(o), path, 'object required');
  same(Object.keys(o).sort(), names.slice().sort(), `${path}.keys`);
};
function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}

// ---- ルール（記録の mode から、画面と同じ規則を作る。任意の設定は実行しない）----
const rulesCache = {};
export function paifuRules(mode) {
  requireThat(mode === 'math1' || mode === 'math2', 'settings.mode', 'unsupported mode');
  return rulesCache[mode] || (rulesCache[mode] = createRules(makeConfig({ mode })));
}

// ---- 状態の要約（digest）：エンジンの状態（全員の手牌・山・河・面子・記録・フリテン・王牌など）の正規化 JSON の FNV-1a ----
// 改ざん・取り違えの検出用（暗号学的な証明ではない）。ゲームの状態は読むだけ。
export function stateDigest(g) {
  const dw = g.deadWall ? [g.deadWall.rinshan, g.deadWall.pairs, g.deadWall.replenished, g.deadWall.indicators] : null;
  const s = canonical([g.hands, g.wall, g.rivers, g.melds, g.current, g.phase, g.drawn ?? null, !!g.justDrew, g.turnCount,
    g.riichi, g.riichiWaits, g.discarded ? g.discarded.map((x) => [...x].sort((a, b) => a - b)) : null,
    g.tempFuriten, g.riichiFuriten, g.normalDraws, g.claim ?? null, g.events, g.result, dw]);
  // 2系統の 32bit FNV-1a（文字コード単位）を連結して 16桁の16進
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x2c1b3c6d) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// 局の結果の要約（戦績用。和了の詳細な解析は再現で求められるので保存しない）
export function resultSummary(r) {
  requireThat(r && (r.type === 'win' || r.type === 'draw'), 'result', 'round not ended');
  return r.type === 'win'
    ? { type: 'win', how: r.how, winner: r.winner, from: r.from ?? null, points: r.points }
    : { type: 'draw', reason: r.reason ?? null };
}

// ---- 試合の状態の検査（match.js の createMatch／applyRoundResult の形） ----
const MATCH_KEYS = ['length', 'startDealer', 'riichiDeposit', 'agariYame', 'pot', 'hand', 'renchan', 'played', 'renchanTotal',
  'scores', 'wins', 'best', 'bestBase', 'over', 'endReason', 'log'];
function matchCheck(m, path = 'match') {
  exactKeys(m, MATCH_KEYS, path);
  requireThat([1, 4, 8].includes(m.length), `${path}.length`, '1/4/8 required');
  integer(m.startDealer, 0, 3, `${path}.startDealer`);
  integer(m.riichiDeposit, 0, 1000, `${path}.riichiDeposit`);
  requireThat(typeof m.agariYame === 'boolean' && typeof m.over === 'boolean', path, 'invalid flags');
  integer(m.hand, 0, m.length, `${path}.hand`);
  for (const k of ['renchan', 'played', 'renchanTotal']) integer(m[k], 0, 1000000, `${path}.${k}`);
  for (const k of ['scores', 'wins', 'best', 'bestBase']) {
    requireThat(Array.isArray(m[k]) && m[k].length === 4, `${path}.${k}`, 'four values required');
    for (const n of m[k]) integer(n, k === 'scores' ? -1000000 : 0, 1000000, `${path}.${k}`);
  }
  requireThat(Array.isArray(m.pot) && Array.isArray(m.log), path, 'arrays required');
  // 400点保存：持ち点＋供託＝400。試合の終了時は供託0
  requireThat(m.scores.reduce((a, b) => a + b, 0) + potTotal(m) === START_POINTS * 4, `${path}.scores`, '400 point conservation');
  requireThat(m.over ? END_REASONS.includes(m.endReason) && potTotal(m) === 0 : m.endReason === null, `${path}.endReason`, 'invalid end state');
  same(m.log.length, m.played, `${path}.log.length`);
}

function playersCheck(players) {
  requireThat(Array.isArray(players) && players.length === 4, 'settings.players', 'four seats required');
  players.forEach((p, seat) => {
    exactKeys(p, seat === 0 ? ['kind', 'name'] : ['kind', 'name', 'id'], `settings.players.${seat}`);
    requireThat(p.kind === (seat === 0 ? 'human' : 'ai'), `settings.players.${seat}.kind`, 'human seat 0 and AI seats 1-3');
    text(p.name, `settings.players.${seat}.name`);
    if (seat) text(p.id, `settings.players.${seat}.id`, 64);
  });
}
const isoTime = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;

// ---- 記録の作成（不変：各操作は新しい記録を返す） ----
// players：席0＝人間 { kind:'human', name }、席1〜3＝AI { kind:'ai', name, id }。match：createMatch の直後の状態
export function createPaifu({ id, createdAt, appVersion, mode, length, seedBase, players, match }) {
  text(id, 'id', 64);
  requireThat(isoTime(createdAt), 'createdAt', 'ISO UTC required');
  text(appVersion, 'appVersion', 32);
  paifuRules(mode);
  integer(seedBase, 0, 999999999, 'settings.seedBase');
  playersCheck(players);
  matchCheck(match, 'initialMatch');
  requireThat(!match.over && match.played === 0 && match.hand === 0 && match.renchan === 0 && match.length === length, 'initialMatch', 'must be a new match');
  requireThat(match.riichiDeposit > 0 && match.agariYame === true, 'initialMatch', 'current rules (deposit, agari-yame) required');
  return freeze({
    format: PAIFU_FORMAT, schemaVersion: PAIFU_SCHEMA_VERSION, kind: PAIFU_KIND, engineVersion: ENGINE_VERSION, appVersion,
    visibility: 'private-full', id, createdAt,
    settings: { mode, length, ruleset: PAIFU_RULESET, seedBase, players: copy(players) },
    initialMatch: copy(match), status: 'recording', rounds: [], final: null, termination: null,
  });
}

const header = (p) => {
  requireThat(p && p.format === PAIFU_FORMAT && p.schemaVersion === PAIFU_SCHEMA_VERSION && p.kind === PAIFU_KIND, 'schemaVersion', 'unsupported format/version');
  requireThat(p.engineVersion === ENGINE_VERSION, 'engineVersion', 'unsupported engine version');
  requireThat(p.visibility === 'private-full', 'visibility', 'private full record required');
};
const lastMatch = (p) => (p.rounds.length ? p.rounds.at(-1).settlement.matchAfter : p.initialMatch);
const replaceLast = (p, r, extra = {}) => freeze({ ...p, ...extra, rounds: [...p.rounds.slice(0, -1), freeze(r)] });
function active(p) {
  header(p);
  requireThat(p.status === 'recording', 'status', 'not recording');
  const r = p.rounds.at(-1);
  requireThat(r && r.settlement === null, 'rounds', 'no active round');
  return r;
}
// 局の Game を記録の設定どおりに作る（app.js の startRound と同じ式。presetWall は使わない）
export function newRoundGame(p, round, dealer) {
  const seed = p.settings.seedBase + round * ROUND_SEED_STEP;
  return new Game({ rules: paifuRules(p.settings.mode), seed, dealer, players: copy(p.settings.players), round, ruleset: p.settings.ruleset });
}

// 局の開始：game はその局の開始直後（親の最初のツモの後）。標準の配牌（seed・親・局番号）と一致しなければ記録しない
export function beginRound(p, game) {
  header(p);
  requireThat(p.status === 'recording', 'status', 'not recording');
  const prev = p.rounds.at(-1);
  requireThat(!prev || prev.settlement !== null, 'rounds', 'previous round not settled');
  requireThat(p.rounds.length < PAIFU_MAX_ROUNDS, 'rounds', 'round limit');
  const match = lastMatch(p);
  requireThat(!match.over, 'match', 'already ended');
  const round = p.rounds.length + 1, dealer = dealerOf(match);
  requireThat(game.round === round && game.dealer === dealer && game.seed === p.settings.seedBase + round * ROUND_SEED_STEP
    && game.ruleset === p.settings.ruleset && game.rules.config.mode === p.settings.mode, 'round.setup', 'non-standard round setup');
  requireThat(game.events.length === 1 && game.events[0].type === 'draw' && game.phase === 'turn', 'round.setup', 'must start right after the deal');
  const startDigest = stateDigest(game);
  same(startDigest, stateDigest(newRoundGame(p, round, dealer)), 'round.setup.deal');
  const r = { round, dealer, seed: game.seed, matchBefore: copy(match), startDigest, steps: [], result: null, settlement: null };
  return freeze({ ...p, rounds: [...p.rounds, freeze(r)] });
}

function actionCheck(a, path = 'action', stored = false) {
  requireThat(a && typeof a === 'object' && !Array.isArray(a), path, 'object required');
  const t = a.type;
  const allowed = t === 'discard' ? ['type', 'tile', ...(Object.hasOwn(a, 'riichi') ? ['riichi'] : [])]
    : t === 'chi' ? ['type', 'option'] : t === 'ankan' ? ['type', 'tileType'] : ['type'];
  exactKeys(a, allowed, path);
  requireThat(['discard', 'chi', 'pon', 'pass', 'ron', 'tsumo', 'ankan'].includes(t), `${path}.type`, 'unknown action');
  if (t === 'discard') { integer(a.tile, 0, 1000, `${path}.tile`); if (Object.hasOwn(a, 'riichi')) requireThat(stored ? a.riichi === true : typeof a.riichi === 'boolean', `${path}.riichi`, stored ? 'true only' : 'boolean required'); }
  if (t === 'chi') integer(a.option, 0, 100, `${path}.option`);
  if (t === 'ankan') integer(a.tileType, 0, 1000, `${path}.tileType`);
}
const normalizeAction = (a) => (a.type === 'discard' ? { type: 'discard', tile: a.tile, ...(a.riichi ? { riichi: true } : {}) }
  : a.type === 'chi' ? { type: 'chi', option: a.option } : a.type === 'ankan' ? { type: 'ankan', tileType: a.tileType } : { type: a.type });
function sourceCheck(seat, action, source, path) {
  integer(seat, 0, 3, `${path}.seat`);
  requireThat(PAIFU_SOURCES.includes(source), `${path}.source`, 'unknown source');
  requireThat(seat === 0 ? source !== 'ai' : source === 'ai', `${path}.source`, 'actor/source mismatch');
  if (source === 'auto-pass') requireThat(action.type === 'pass', `${path}.source`, 'auto-pass must be pass');
  if (source === 'auto-tsumogiri') requireThat(action.type === 'discard' && !action.riichi, `${path}.source`, 'auto-tsumogiri must be a plain discard');
}

// 実行された行動の記録：呼び出し側は、エンジンが受け付けた後（成功した applyAction の直後）に呼ぶ。
// eventsBefore：行動の直前の game.events.length（記録していない変更がないことの確認）
export function appendStep(p, game, { seat, action, source, eventsBefore }) {
  const r = active(p);
  actionCheck(action);
  sourceCheck(seat, action, source, 'step');
  requireThat(r.steps.length < PAIFU_MAX_STEPS, 'steps', 'step limit');
  const prevEvents = r.steps.length ? r.steps.at(-1).events : 1;
  requireThat(eventsBefore === prevEvents && game.events.length >= eventsBefore, 'step.events', 'unrecorded state change'); // 見送り・保留中の鳴きは記録（events）が増えないことがある
  const step = { seat, source, action: normalizeAction(action), events: game.events.length, digest: stateDigest(game) };
  return replaceLast(p, { ...r, steps: [...r.steps, freeze(step)] });
}

// 局の精算：game は終了した局。matchAfter は app.js が applyRoundResult で求めた試合の状態。opts は同じ引数
export function settleRound(p, game, matchAfter, { maxRound = null } = {}) {
  const r = active(p);
  requireThat(game.phase === 'ended' && game.result && !game.pending(), 'settlement', 'round not ended');
  const lastEvents = r.steps.length ? r.steps.at(-1).events : 1;
  requireThat(game.events.length === lastEvents, 'settlement', 'unrecorded state change');
  if (maxRound !== null) integer(maxRound, 1, 1000000, 'settlement.maxRound');
  const expected = applyRoundResult(r.matchBefore, game.result, { round: r.round, maxRound, riichi: game.riichi });
  same(matchAfter, expected, 'settlement.matchAfter');
  matchCheck(expected, 'settlement.matchAfter');
  const settlement = { maxRound, riichi: game.riichi.map((x) => (x ? { tile: x.tile, turn: x.turn } : null)),
    deltas: expected.scores.map((n, i) => n - r.matchBefore.scores[i]), matchAfter: copy(expected) };
  const final = expected.over ? { scores: expected.scores.slice(), ranks: ranks(expected.scores), endReason: expected.endReason,
    played: expected.played } : null;
  return replaceLast(p, { ...r, result: resultSummary(game.result), settlement },
    { status: expected.over ? 'complete' : 'recording', final });
}

// 途中退出・再戦・記録の失敗：流局や精算を作らない（未精算の局はそのまま残す）
export function endRecording(p, reason) {
  header(p);
  requireThat(p.status === 'recording', 'status', 'not recording');
  requireThat(TERMINATIONS.includes(reason), 'termination.reason', 'unknown reason');
  return freeze({ ...p, status: 'aborted', termination: { reason } });
}

// ---- 検証：記録された選択を隔離した Game で再生し、digest・結果・精算・試合の状態を照合する ----
// エンジンの入口（ai.js の applyAction と同じ分岐。AI の実装は読み込まない）
function perform(g, seat, a) {
  if (a.type === 'discard') g.discard(seat, a.tile, a.riichi ? { riichi: true } : undefined);
  else if (a.type === 'tsumo') g.tsumo(seat);
  else if (a.type === 'ankan') g.ankan(seat, a.tileType);
  else g.respond(seat, a);
}
// 検証は生成関数（generator）で書き、同期の検証（drain）と、主スレッドを長く止めない非同期の検証（verifyPaifuAsync：
// 一定時間ごとにイベントループへ戻る）の両方で同じ処理を使う。途中で yield するのは状態を変えない区切り（行動の間・局の間）だけ。
const STEP_CHUNK = 24;
function drain(gen) { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }
function* replayRound(p, r, index, upTo = null) {
  const match = index ? p.rounds[index - 1].settlement.matchAfter : p.initialMatch;
  same(r.matchBefore, match, `rounds.${index}.matchBefore`);
  integer(r.round, 1, PAIFU_MAX_ROUNDS, `rounds.${index}.round`);
  same(r.round, index + 1, `rounds.${index}.round`);
  same(r.dealer, dealerOf(match), `rounds.${index}.dealer`);
  same(r.seed, p.settings.seedBase + r.round * ROUND_SEED_STEP, `rounds.${index}.seed`);
  const g = newRoundGame(p, r.round, r.dealer);
  same(r.startDigest, stateDigest(g), `rounds.${index}.startDigest`);
  requireThat(Array.isArray(r.steps) && r.steps.length <= PAIFU_MAX_STEPS, `rounds.${index}.steps`, 'array required');
  const n = upTo === null ? r.steps.length : upTo;
  for (let i = 0; i < n; i++) {
    const s = r.steps[i], path = `rounds.${index}.steps.${i}`;
    exactKeys(s, ['seat', 'source', 'action', 'events', 'digest'], path);
    actionCheck(s.action, `${path}.action`, true);
    sourceCheck(s.seat, s.action, s.source, path);
    const q = g.pending();
    requireThat(q && q.seat === s.seat, `${path}.seat`, 'not this seat\'s decision');
    try { perform(g, s.seat, s.action); } catch (e) { throw new PaifuError(`${path}.action`, `rejected by engine (${e.message})`); }
    g.checkInvariants();
    same(s.events, g.events.length, `${path}.events`);
    same(s.digest, stateDigest(g), `${path}.digest`);
    if ((i + 1) % STEP_CHUNK === 0) yield;
  }
  return g;
}
function* verify(p) {
  header(p);
  exactKeys(p, ['format', 'schemaVersion', 'kind', 'engineVersion', 'appVersion', 'visibility', 'id', 'createdAt', 'settings',
    'initialMatch', 'status', 'rounds', 'final', 'termination'], 'paifu');
  exactKeys(p.settings, ['mode', 'length', 'ruleset', 'seedBase', 'players'], 'settings');
  same(p.settings.ruleset, PAIFU_RULESET, 'settings.ruleset');
  // 作成時と同じ検査（設定・初期状態）
  createPaifu({ id: p.id, createdAt: p.createdAt, appVersion: p.appVersion, mode: p.settings.mode, length: p.settings.length,
    seedBase: p.settings.seedBase, players: p.settings.players, match: p.initialMatch });
  requireThat(STATUSES.includes(p.status), 'status', 'unknown status');
  requireThat(Array.isArray(p.rounds) && p.rounds.length <= PAIFU_MAX_ROUNDS, 'rounds', 'array required');
  let decisions = 0;
  for (let i = 0; i < p.rounds.length; i++) {
    const r = p.rounds[i];
    exactKeys(r, ['round', 'dealer', 'seed', 'matchBefore', 'startDigest', 'steps', 'result', 'settlement'], `rounds.${i}`);
    const last = i === p.rounds.length - 1;
    requireThat(r.settlement !== null || last, `rounds.${i}.settlement`, 'only the last round may be unsettled');
    const g = yield* replayRound(p, r, i);
    decisions += r.steps.length;
    yield;
    if (r.settlement === null) {
      // 未精算の最後の局（記録中・中断）：途中でも、終局の直後（精算の前）でもよい。精算・流局は作らない
      requireThat(r.result === null && p.status !== 'complete', `rounds.${i}`, 'unsettled round in a complete record');
      continue;
    }
    exactKeys(r.settlement, ['maxRound', 'riichi', 'deltas', 'matchAfter'], `rounds.${i}.settlement`);
    requireThat(g.phase === 'ended' && !g.pending(), `rounds.${i}.settlement`, 'round not ended by the recorded steps');
    same(r.result, resultSummary(g.result), `rounds.${i}.result`);
    same(r.settlement.riichi, g.riichi.map((x) => (x ? { tile: x.tile, turn: x.turn } : null)), `rounds.${i}.settlement.riichi`);
    if (r.settlement.maxRound !== null) integer(r.settlement.maxRound, 1, 1000000, `rounds.${i}.settlement.maxRound`);
    const expected = applyRoundResult(r.matchBefore, g.result, { round: r.round, maxRound: r.settlement.maxRound, riichi: g.riichi });
    same(r.settlement.matchAfter, expected, `rounds.${i}.settlement.matchAfter`);
    matchCheck(expected, `rounds.${i}.settlement.matchAfter`);
    same(r.settlement.deltas, expected.scores.map((n, k) => n - r.matchBefore.scores[k]), `rounds.${i}.settlement.deltas`);
    requireThat(!expected.over || last, `rounds.${i}`, 'rounds after the match ended');
  }
  const end = lastMatch(p.rounds.length && p.rounds.at(-1).settlement === null ? { ...p, rounds: p.rounds.slice(0, -1) } : p);
  if (p.status === 'complete') {
    requireThat(end.over && p.termination === null, 'status', 'complete requires an ended match');
    same(p.final, { scores: end.scores, ranks: ranks(end.scores), endReason: end.endReason, played: end.played }, 'final');
  } else {
    requireThat(!end.over && p.final === null, 'status', 'an ended match must be complete');
    if (p.status === 'aborted') { exactKeys(p.termination, ['reason'], 'termination'); requireThat(TERMINATIONS.includes(p.termination.reason), 'termination.reason', 'unknown reason'); }
    else requireThat(p.termination === null, 'termination', 'recording has no termination');
  }
  return { valid: true, status: p.status, rounds: p.rounds.length, decisions };
}
const wrapError = (e) => (e instanceof PaifuError ? e : new PaifuError('record', e && e.message ? e.message : 'invalid'));
export function verifyPaifu(p) {
  try { return drain(verify(p)); } catch (e) { throw wrapError(e); }
}
// 非同期の検証：同じ検証を、budgetMs ごとに pause()（既定はタイマーで次のタスクへ）を待って進める。検証は省略しない
export async function verifyPaifuAsync(p, { budgetMs = 8, pause = () => new Promise((r) => setTimeout(r, 0)), now = () => Date.now() } = {}) {
  const gen = verify(p);
  let t0 = now();
  try {
    for (let r = gen.next(); ; r = gen.next()) {
      if (r.done) return r.value;
      if (now() - t0 >= budgetMs) { await pause(); t0 = now(); }
    }
  } catch (e) { throw wrapError(e); }
}

// 信頼できる内部・テスト用：roundIndex の局を step 手目まで再現した Game を返す（振り返り画面は第2段階・別PR）
export function replayPaifuRound(p, roundIndex, step = null) {
  verifyPaifu(p);
  integer(roundIndex, 0, p.rounds.length - 1, 'roundIndex');
  const r = p.rounds[roundIndex];
  if (step !== null) integer(step, 0, r.steps.length, 'step');
  return drain(replayRound(p, r, roundIndex, step));
}

// ---- JSON（保存用）：プレーンな JSON だけ・深さと要素数の上限・危険なキーを拒否・バイト上限 ----
function jsonCheck(x, depth = 0, budget = { nodes: 0 }) {
  requireThat(++budget.nodes <= 1000000 && depth <= 32, 'json', 'structure limit exceeded');
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return;
  if (typeof x === 'number') { requireThat(Number.isFinite(x), 'json', 'non-finite number'); return; }
  requireThat(x && typeof x === 'object' && (Array.isArray(x) || Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null), 'json', 'plain JSON required');
  for (const [k, v] of Object.entries(x)) {
    requireThat(!['__proto__', 'prototype', 'constructor'].includes(k), 'json', 'unsafe key');
    jsonCheck(v, depth + 1, budget);
  }
}
export function encodePaifu(p) {
  jsonCheck(p);
  verifyPaifu(p);
  const s = canonical(p);
  requireThat(new TextEncoder().encode(s).length <= PAIFU_MAX_BYTES, 'json', 'byte limit exceeded');
  return s;
}
// 非同期版（保存用）：検証を verifyPaifuAsync で行う。結果は encodePaifu と同じ文字列
export async function encodePaifuAsync(p, opts = {}) {
  jsonCheck(p);
  await verifyPaifuAsync(p, opts);
  const s = canonical(p);
  requireThat(new TextEncoder().encode(s).length <= PAIFU_MAX_BYTES, 'json', 'byte limit exceeded');
  return s;
}
export function decodePaifu(s) {
  requireThat(typeof s === 'string' && s.length <= PAIFU_MAX_BYTES && new TextEncoder().encode(s).length <= PAIFU_MAX_BYTES, 'json', 'invalid input/byte limit exceeded');
  let p;
  try { p = JSON.parse(s); } catch { throw new PaifuError('json', 'invalid JSON'); }
  jsonCheck(p);
  freeze(p);
  verifyPaifu(p);
  return p;
}
