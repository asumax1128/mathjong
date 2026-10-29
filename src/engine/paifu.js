// Ver.0.8 internal foundation. Opt-in only: no DOM, storage, AI calls, or live Game mutation.
// These records contain ALL hands and the wall. They are private, not a public/AI view.
import { ENGINE_VERSION, modeConfig, LEGACY_V02_CONFIG } from './config.js';
import { createRules } from './rules.js';
import { Game } from './game.js';
import { applyRoundResult, dealerOf, ranks } from './match.js';

export const PAIFU_SCHEMA_VERSION = 1;
export const PAIFU_RULE_VERSION = `mathjong-rules-${ENGINE_VERSION}`;
// Import/export guard, NOT a browser storage quota or an automatic eviction policy.
export const PAIFU_MAX_BYTES = 8 * 1024 * 1024;
const FORMAT = 'mathjong-paifu';
const CORE = ['wall', 'hands', 'melds', 'rivers', 'current', 'phase', 'drawn', 'justDrew', 'turnCount', 'claim', 'riichi', 'result'];
const compiled = new WeakMap();
const ownedSettings = new WeakSet();
const copy = x => JSON.parse(JSON.stringify(x));
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a, b, path) => requireThat(canonical(a) === canonical(b), path, 'mismatch');
const integer = (n, min, max, path) => requireThat(Number.isSafeInteger(n) && n >= min && n <= max, path, 'integer out of range');
const text = (s, path) => requireThat(typeof s === 'string' && s.length > 0 && s.length <= 128, path, 'invalid text');

export class PaifuError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'PaifuError'; this.path = path; }
}
function requireThat(ok, path, message) { if (!ok) throw new PaifuError(path, message); }
function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
function keys(x, allowed, path) {
  requireThat(x && typeof x === 'object' && !Array.isArray(x), path, 'object required');
  same(Object.keys(x).sort(), allowed.slice().sort(), path + '.keys');
}
function timing(atMs, previous, path) {
  if (atMs === null) return;
  requireThat(Number.isFinite(atMs) && atMs >= 0 && (previous === null || atMs >= previous), path, 'non-monotonic time');
}
function lastTime(round) {
  return [...round.steps.map(s => s.atMs), round.atMs, round.settlement?.atMs ?? null].filter(x => x !== null).reduce((a, b) => Math.max(a, b), 0);
}
const clockFloor = p => p.rounds.reduce((n, r) => Math.max(n, lastTime(r)), 0);
function core(s) { return Object.fromEntries(CORE.map(k => [k, copy(s[k])])); }
function header(p) {
  requireThat(p?.format === FORMAT && p.schemaVersion === PAIFU_SCHEMA_VERSION, 'schemaVersion', 'unsupported format/version');
  requireThat(p.engineVersion === ENGINE_VERSION && p.ruleVersion === PAIFU_RULE_VERSION, 'engineVersion', 'unsupported engine/rules');
  requireThat(p.visibility === 'private-full', 'visibility', 'private full record required');
}
function rulesOf(p) {
  header(p);
  if (compiled.has(p.settings)) return compiled.get(p.settings);
  // v1 supports the current, exact rule sets. Never execute an unbounded arbitrary imported config.
  const c = p.settings.rules;
  const expected = c?.mode === 'legacy' ? LEGACY_V02_CONFIG : ['math1', 'math2'].includes(c?.mode) ? modeConfig(c.mode) : null;
  requireThat(expected !== null, 'settings.rules.mode', 'unsupported mode');
  same(c, expected, 'settings.rules');
  const r = createRules(copy(c));
  if (ownedSettings.has(p.settings)) compiled.set(p.settings, r);
  return r;
}
function playersCheck(players) {
  requireThat(Array.isArray(players) && players.length === 4, 'settings.players', 'four seats required');
  for (let seat = 0; seat < 4; seat++) {
    const p = players[seat];
    requireThat(p && typeof p === 'object' && !Array.isArray(p), `players.${seat}`, 'player required');
    requireThat(['human', 'ai'].includes(p.kind), `players.${seat}.kind`, 'unknown kind');
    text(p.name, `players.${seat}.name`);
    if (p.kind === 'ai') text(p.id, `players.${seat}.id`);
  }
}
function matchCheck(m) {
  keys(m, ['length','startDealer','hand','renchan','played','renchanTotal','scores','wins','best','bestBase','over','endReason','log'], 'match');
  requireThat(m && [4, 8].includes(m.length), 'match.length', '4/8 required');
  integer(m.startDealer, 0, 3, 'match.startDealer');
  integer(m.hand, 0, m.length, 'match.hand');
  requireThat(m.over || m.hand < m.length, 'match.hand', 'live match already beyond final hand');
  for (const k of ['played', 'renchan', 'renchanTotal']) integer(m[k], 0, Number.MAX_SAFE_INTEGER, `match.${k}`);
  for (const k of ['scores', 'wins', 'best', 'bestBase']) {
    requireThat(Array.isArray(m[k]) && m[k].length === 4, `match.${k}`, 'four values required');
    for (const n of m[k]) integer(n, k === 'scores' ? -Number.MAX_SAFE_INTEGER : 0, Number.MAX_SAFE_INTEGER, `match.${k}`);
  }
  requireThat(m.scores.reduce((a, b) => a + b, 0) === 400, 'match.scores', '400 point conservation');
  requireThat(typeof m.over === 'boolean' && Array.isArray(m.log), 'match', 'invalid state');
  requireThat(m.over ? ['normal','round-limit'].includes(m.endReason) : m.endReason === null, 'match.endReason', 'invalid end reason');
  same(m.log.length, m.played, 'match.log.length');
}

// Read only fixed data fields: never call RNG, AI, or memoizing UI helpers.
export function captureGame(game) {
  const out = { seed: game.seed, dealer: game.dealer, round: game.round, tileType: game.tileType.slice() };
  for (const k of CORE) out[k] = copy(game[k]);
  out.events = copy(game.events);
  return freeze(out);
}

export function createPaifu({ id, rules, players, match, seedBase = null, firstRound = 1,
  origin = 'match-start', createdAt = null, appVersion = null, sourceRevision = null }) {
  text(id, 'id'); playersCheck(players); matchCheck(match);
  requireThat(!match.over, 'initialMatch', 'already ended');
  integer(firstRound, 1, 1000000, 'firstRound');
  if (seedBase !== null) integer(seedBase, 0, 999999999, 'seedBase');
  requireThat(['match-start', 'replay-url', 'fixture'].includes(origin), 'origin', 'unknown origin');
  if (createdAt !== null) requireThat(typeof createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) && Number.isFinite(Date.parse(createdAt)) && new Date(createdAt).toISOString() === createdAt, 'createdAt', 'ISO UTC required');
  if (appVersion !== null) text(appVersion, 'appVersion');
  if (sourceRevision !== null) requireThat(/^[a-f0-9]{40}$/.test(sourceRevision), 'sourceRevision', 'full SHA required');
  const p = freeze({ format: FORMAT, schemaVersion: PAIFU_SCHEMA_VERSION, engineVersion: ENGINE_VERSION,
    ruleVersion: PAIFU_RULE_VERSION, visibility: 'private-full', id, createdAt, appVersion, sourceRevision,
    settings: { rules: copy(rules.config), players: copy(players), seedBase, firstRound, origin },
    initialMatch: copy(match), status: 'recording', rounds: [], final: null, termination: null });
  ownedSettings.add(p.settings);
  rulesOf(p);
  return p;
}

function restore(p, initial, isolatedRules = null, setup = 'seed') {
  const g = new Game({ rules: isolatedRules ?? rulesOf(p), seed: initial.seed, dealer: initial.dealer,
    round: initial.round, players: copy(p.settings.players), ...(setup === 'snapshot' ? { presetWall: [] } : {}) });
  // RNG is local to this sandbox, not the live game's or AI's RNG. Replay uses recorded decisions.
  for (const k of [...CORE, 'events', 'tileType']) g[k] = copy(initial[k]);
  g._riichiMemo = null;
  return g;
}
function initialCheck(p, r, beforeMatch) {
  const s = r.initial;
  integer(s.seed, 0, Number.MAX_SAFE_INTEGER, 'round.seed');
  integer(s.round, 1, 1000000, 'round.number');
  same(s.dealer, dealerOf(beforeMatch), 'round.dealer');
  same(r.matchBefore, beforeMatch, 'round.matchBefore');
  const fresh = new Game({ rules: rulesOf(p), seed: s.seed, dealer: s.dealer, round: s.round, players: copy(p.settings.players) });
  same(s.tileType, fresh.tileType, 'round.tileType');
  requireThat(s.phase === 'turn' && s.current === s.dealer && s.turnCount === 1 && s.justDrew === true && s.claim === null && s.result === null, 'round.initial', 'must start immediately after deal/first draw');
  same(s.events, [{ type: 'draw', seat: s.dealer }], 'round.initial.events');
  same(s.riichi, [null, null, null, null], 'round.initial.riichi');
  same(s.melds, [[], [], [], []], 'round.initial.melds');
  same(s.rivers, [[], [], [], []], 'round.initial.rivers');
  requireThat(s.drawn === s.hands[s.dealer].at(-1), 'round.initial.drawn', 'last tile in dealer hand required');
  restore(p, s, null, r.setup).checkInvariants();
  if (r.setup === 'seed') same(s, captureGame(fresh), 'round.initial.seed');
  else requireThat(r.setup === 'snapshot' && p.settings.origin === 'fixture', 'round.setup', 'non-seed setup only for explicit fixtures');
  if (p.settings.seedBase !== null) same(s.seed, p.settings.seedBase + s.round * 7919, 'round.seedBase');
}
function enriched(raw, after, offset) {
  return raw.map((e, i) => {
    const event = { seq: offset + i, type: e.type, engine: copy(e) };
    if (e.type === 'draw') { event.tile = after.drawn; requireThat(e.seat === after.current && after.justDrew, 'event.draw', 'missing drawn tile'); }
    if (e.type === 'discard') {
      event.tile = e.tile;
      const r = after.rivers[e.seat].find(x => x.id === e.tile);
      requireThat(!!r, 'event.discard', 'missing river tile'); event.tsumogiri = r.tsumogiri;
    }
    if (e.type === 'riichi') event.tile = e.tile;
    if (e.type === 'chi' || e.type === 'pon') {
      const m = after.melds[e.seat].find(x => x.claimed === e.tile && x.meld === e.meld);
      requireThat(!!m, 'event.call', 'missing exposed meld'); event.tile = e.tile; event.tiles = m.tiles.slice();
    }
    if (e.type === 'win') { event.tile = after.result.tile; event.result = copy(after.result); }
    requireThat(['draw', 'discard', 'riichi', 'chi', 'pon', 'win', 'exhaustive-draw'].includes(e.type), 'event.type', 'unsupported engine event');
    return event;
  });
}
function active(p) {
  header(p); requireThat(p.status === 'recording', 'status', 'not recording');
  requireThat(p.rounds.length > 0, 'rounds', 'no active round');
  const r = p.rounds.at(-1); requireThat(r.settlement === null, 'settlement', 'already settled'); return r;
}
function replaceLast(p, r, extra = {}) { return freeze({ ...p, ...extra, rounds: [...p.rounds.slice(0, -1), freeze(r)] }); }
function engineEvents(r) { return [...r.initial.events, ...r.steps.flatMap(s => s.events.map(e => e.engine))]; }

export function beginRound(p, game, { setup = 'seed', atMs = null } = {}) {
  header(p); requireThat(p.status === 'recording', 'status', 'not recording');
  const prev = p.rounds.at(-1);
  requireThat(!prev || prev.settlement !== null, 'rounds', 'previous round not settled');
  const match = prev ? prev.settlement.matchAfter : p.initialMatch;
  requireThat(!match.over, 'match', 'already ended');
  const initial = captureGame(game);
  same(initial.round, p.settings.firstRound + p.rounds.length, 'round.number');
  same(game.players, p.settings.players, 'round.players');
  same(game.rules.config, p.settings.rules, 'round.rules');
  timing(atMs, clockFloor(p), 'round.atMs');
  const r = { id: `${p.id}:r${initial.round}`, setup, atMs, matchBefore: copy(match), initial,
    initialEvents: enriched(initial.events, initial, 0), steps: [], settlement: null };
  initialCheck(p, r, match);
  return freeze({ ...p, rounds: [...p.rounds, freeze(r)] });
}

function actionCheck(action) {
  const allowed = action?.type === 'discard' ? ['type', 'tile', ...(Object.hasOwn(action, 'riichi') ? ['riichi'] : [])]
    : action?.type === 'chi' ? ['type', 'option'] : ['type'];
  keys(action, allowed, 'action');
  requireThat(['discard', 'chi', 'pon', 'pass', 'ron', 'tsumo'].includes(action.type), 'action.type', 'unknown action');
  if (action.type === 'discard') { integer(action.tile, 0, 167, 'action.tile'); if (Object.hasOwn(action, 'riichi')) requireThat(typeof action.riichi === 'boolean', 'action.riichi', 'boolean required'); }
  if (action.type === 'chi') integer(action.option, 0, 81, 'action.option');
}
function sourceCheck(p, seat, action, source) {
  integer(seat, 0, 3, 'seat');
  const kind = p.settings.players[seat].kind;
  requireThat(source === kind || (source === 'auto-pass' && kind === 'human' && action.type === 'pass'), 'source', 'actor/source mismatch');
}
function perform(g, seat, action) {
  actionCheck(action); integer(seat, 0, 3, 'seat');
  // Same engine entry points as applyAction(), without importing any AI implementation.
  if (action.type === 'discard') g.discard(seat, action.tile, { riichi: action.riichi === true });
  else if (action.type === 'tsumo') g.tsumo(seat);
  else g.respond(seat, action);
  g.checkInvariants();
}

// Caller captures BEFORE, executes its normal engine action ONCE, then captures AFTER.
// We independently run the command in a private sandbox to detect missing/wrong decisions.
export function appendDecision(p, { before, after, seat, action, source = p.settings.players[seat]?.kind, atMs = null }) {
  const r = active(p), expected = r.steps.at(-1)?.state ?? core(r.initial);
  actionCheck(action); sourceCheck(p, seat, action, source);
  timing(atMs, clockFloor(p), 'step.atMs');
  same(core(before), expected, 'step.before');
  for (const k of ['seed', 'dealer', 'round', 'tileType']) same(before[k], r.initial[k], `step.before.${k}`);
  same(before.events, engineEvents(r), 'step.before.events');
  const g = restore(p, before, null, r.setup);
  perform(g, seat, action);
  same(captureGame(g), after, 'step.after');
  const offset = before.events.length;
  const step = { seq: r.steps.length + 1, seat, source, action: copy(action), atMs,
    events: enriched(after.events.slice(offset), after, offset), state: core(after) };
  return replaceLast(p, { ...r, steps: [...r.steps, freeze(step)] });
}

export function settleRound(p, matchAfter, { maxRound = null, atMs = null } = {}) {
  const r = active(p), state = r.steps.at(-1)?.state ?? r.initial;
  requireThat(state.phase === 'ended' && state.result !== null, 'settlement', 'round not ended');
  timing(atMs, clockFloor(p), 'settlement.atMs');
  if (maxRound !== null) integer(maxRound, 1, 1000000, 'maxRound');
  const expected = applyRoundResult(r.matchBefore, state.result, { round: r.initial.round, maxRound });
  same(matchAfter, expected, 'settlement.matchAfter'); matchCheck(expected);
  const deltas = expected.scores.map((n, i) => n - r.matchBefore.scores[i]);
  const settlement = { type: 'settlement', seq: engineEvents(r).length, atMs, maxRound,
    beforeScores: r.matchBefore.scores.slice(), deltas, afterScores: expected.scores.slice(), matchAfter: copy(expected) };
  const final = expected.over ? { scores: expected.scores.slice(), ranks: ranks(expected.scores), endReason: expected.endReason,
    played: expected.played, renchanTotal: expected.renchanTotal, wins: expected.wins.slice(), best: expected.best.slice(), bestBase: expected.bestBase.slice() } : null;
  return replaceLast(p, { ...r, settlement }, { status: expected.over ? 'complete' : 'recording', final });
}

// Leaving/resetting is not an exhaustive draw and never invents a settlement.
export function endRecording(p, { reason, atMs = null }) {
  header(p); requireThat(p.status === 'recording', 'status', 'not recording');
  requireThat(['left-match', 'reset', 'recording-error'].includes(reason), 'termination.reason', 'unknown reason');
  timing(atMs, clockFloor(p), 'termination.atMs');
  return freeze({ ...p, status:'aborted', termination:{ reason, atMs } });
}

function replaySteps(p, r, count, isolate = false) {
  const g = restore(p, r.initial, isolate ? createRules(copy(p.settings.rules)) : null, r.setup);
  for (let i = 0; i < count; i++) {
    const s = r.steps[i], beforeLength = g.events.length;
    keys(s, ['seq', 'seat', 'source', 'action', 'atMs', 'events', 'state'], 'step');
    same(s.seq, i + 1, 'step.seq'); sourceCheck(p, s.seat, s.action, s.source);
    timing(s.atMs, i ? lastTime({ steps: r.steps.slice(0, i), atMs: r.atMs }) : r.atMs, 'step.atMs');
    perform(g, s.seat, s.action);
    const after = captureGame(g);
    same(s.events, enriched(g.events.slice(beforeLength), after, beforeLength), 'step.events');
    same(s.state, core(after), 'step.state');
  }
  return g;
}

// Validity means replay/consistency, NOT a cryptographic proof of who played a file.
function verify(p) {
  header(p);
  keys(p, ['format','schemaVersion','engineVersion','ruleVersion','visibility','id','createdAt','appVersion','sourceRevision','settings','initialMatch','status','rounds','final','termination'], 'paifu');
  keys(p.settings, ['rules','players','seedBase','firstRound','origin'], 'settings');
  requireThat(Array.isArray(p.rounds), 'rounds', 'array required');
  let elapsed = null;
  for (const r of p.rounds) for (const t of [r.atMs, ...(r.steps || []).map(s => s.atMs), r.settlement?.atMs ?? null]) {
    timing(t, elapsed, 'timeline.atMs'); if (t !== null) elapsed = t;
  }
  // Rebuild through the public pure builder, rather than merely accepting plausible counters.
  let checked = createPaifu({ id:p.id, rules:rulesOf(p), players:p.settings.players, match:p.initialMatch,
    seedBase:p.settings.seedBase, firstRound:p.settings.firstRound, origin:p.settings.origin,
    createdAt:p.createdAt, appVersion:p.appVersion, sourceRevision:p.sourceRevision });
  let decisions = 0, events = 0;
  for (const r of p.rounds) {
    keys(r, ['id','setup','atMs','matchBefore','initial','initialEvents','steps','settlement'], 'round');
    requireThat(Array.isArray(r.steps), 'round.steps', 'array required');
    const match = checked.rounds.at(-1)?.settlement?.matchAfter ?? p.initialMatch;
    initialCheck(p, r, match);
    const g = restore(p, r.initial, null, r.setup);
    checked = beginRound(checked, g, { setup:r.setup, atMs:r.atMs });
    same(r.id, checked.rounds.at(-1).id, 'round.id');
    same(r.initial, checked.rounds.at(-1).initial, 'round.initial');
    same(r.initialEvents, checked.rounds.at(-1).initialEvents, 'round.initialEvents');
    replaySteps(p, r, r.steps.length);
    // Replay already checked every action/state; share only the verified immutable copies.
    checked = replaceLast(checked, { ...checked.rounds.at(-1), steps:copy(r.steps) });
    if (r.settlement !== null) {
      checked = settleRound(checked, r.settlement.matchAfter, { maxRound:r.settlement.maxRound, atMs:r.settlement.atMs });
      same(r.settlement, checked.rounds.at(-1).settlement, 'round.settlement');
    }
    decisions += r.steps.length; events += engineEvents(r).length;
  }
  if (p.status === 'aborted') checked = endRecording(checked, p.termination);
  same(p.status, checked.status, 'status'); same(p.final, checked.final, 'final'); same(p.termination, checked.termination, 'termination');
  return { valid:true, rounds:p.rounds.length, decisions, engineEvents:events, status:p.status };
}
export function verifyPaifu(p) {
  try { return verify(p); }
  catch (e) { if (e instanceof PaifuError) throw e; throw new PaifuError('record', e.message); }
}

// Trusted internal/test use ONLY. No public, AI, or in-game opponent view is provided.
// step=0 is after the dealer's first draw; each pass/call decision is its own subsequent step.
export function replayPrivateRound(p, roundIndex, step = null) {
  verifyPaifu(p); integer(roundIndex, 0, p.rounds.length - 1, 'roundIndex');
  const r = p.rounds[roundIndex], n = step ?? r.steps.length;
  integer(n, 0, r.steps.length, 'step');
  // The caller may mutate/continue this Game. Never expose our shared validation cache.
  return replaySteps(p, r, n, true);
}

function jsonCheck(x, depth = 0, budget = { nodes:0 }) {
  requireThat(++budget.nodes <= 2000000 && depth <= 64, 'json', 'structure limit exceeded');
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return;
  if (typeof x === 'number') { requireThat(Number.isFinite(x), 'json', 'non-finite number'); return; }
  requireThat(x && typeof x === 'object' && (Array.isArray(x) || Object.getPrototypeOf(x) === Object.prototype), 'json', 'plain JSON required');
  for (const [k, v] of Object.entries(x)) {
    requireThat(!['__proto__','prototype','constructor'].includes(k), 'json', 'unsafe key');
    jsonCheck(v, depth + 1, budget);
  }
}
export function encodePaifu(p) {
  jsonCheck(p); verifyPaifu(p);
  const s = canonical(p);
  requireThat(new TextEncoder().encode(s).length <= PAIFU_MAX_BYTES, 'json', 'byte limit exceeded');
  return s;
}
export function decodePaifu(s) {
  requireThat(typeof s === 'string' && s.length <= PAIFU_MAX_BYTES && new TextEncoder().encode(s).length <= PAIFU_MAX_BYTES, 'json', 'invalid input/byte limit exceeded');
  let p; try { p = JSON.parse(s); } catch { throw new PaifuError('json', 'invalid JSON'); }
  jsonCheck(p); freeze(p);
  if (p?.settings && typeof p.settings === 'object') ownedSettings.add(p.settings);
  verifyPaifu(p);
  return p;
}
