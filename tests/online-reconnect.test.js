// オンライン対戦 段階3：切断と復帰・代打ち・ホストの再生・再戦の単体試験（docs/79「8」）。ネットワークなし（偽の時計・偽バス）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { createHostRunner, PROXY_ID, AWAY_AFTER_TIMEOUTS } from '../src/ui/online-host.js';
import { createHostSession, createGuestSession, loadResume, hostWaitState, HOST_GRACE_MS, AWAY_AFTER_MS } from '../src/ui/online-session.js';
import { createMemoryBus } from '../src/ui/online-transport.js';
import { buildRemoteTable } from '../src/ui/online-protocol.js';
import { createRoom, joinRoom, startMatch, enterPresence, reopenLobby, watchRoom } from '../src/ui/online-lobby.js';
import { createRng } from '../src/engine/rng.js';
import { fakeClock, prefChoice, prefsFor, turnDecider } from './online-sim.js';

const RULES = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const tick = () => new Promise((r) => setImmediate(r));

// 進行役を方針で動かす（窓ごとに応答）。stopAt(state) が true になったら止める
function drive(runner, { prefs, turn, stopAt = () => false, max = 20000 }) {
  for (let i = 0; i < max; i++) {
    const st = runner.state;
    if (stopAt(st)) return 'stopped';
    const w = st.window;
    if (!w || st.phase === 'final') return 'final';
    if (w.kind === 'next') { for (const s of w.seats) runner.receiveNow(s, { k: 'ready', sid: w.sid }); if (!w.seats.length) throw Error('empty next'); continue; }
    if (w.kind === 'turn') { const a = turn(st.game, w.seats[0]); runner.receiveNow(w.seats[0], { k: a.type, sid: w.sid, tile: a.tile, riichi: a.riichi, tileType: a.tileType }); continue; }
    if (w.kind === 'reask') { const s = w.seats[0]; runner.receiveNow(s, { k: prefChoice(prefs[s], { ron: true, chi: [], pon: null }).type, sid: w.sid }); continue; }
    if (w.kind === 'claim') { for (const s of w.seats) { const c = prefChoice(prefs[s], st.claimOffer.get(s)); runner.receiveNow(s, { k: c.type, option: c.option, sid: w.sid }); } continue; }
    throw Error(`window ${w.kind}`);
  }
  throw Error('did not finish');
}
const stateOf = (st) => JSON.parse(JSON.stringify({ round: st.round, phase: st.phase, events: st.game.events, hands: st.game.hands, match: st.match, timeouts: st.timeouts, away: st.away, history: st.history }));

test('再生：記録から作り直すと、途中のどの時点でも同じ局面・同じ試合の状態に戻る（CPU の手は記録と一致）', () => {
  const rules = RULES.math1;
  const seats = [{ kind: 'human', name: 'A' }, { kind: 'cpu', name: 'B', cpuId: 'kanata' }, { kind: 'human', name: 'C' }, { kind: 'cpu', name: 'D', cpuId: 'aoto' }];
  const seedBase = 20261116;
  const prefs = prefsFor(3);
  const cutoffs = [5, 23, 60, 140, 260];
  const entries = [];
  const runner = createHostRunner({ rules, mode: 'math1', length: 4, seats, seedBase, startDealer: 1, clock: fakeClock(), publish() {}, onLog: (e) => entries.push(e) });
  runner.start();
  const turn = turnDecider(seedBase);
  let checked = 0;
  for (const cut of cutoffs) {
    // 途中で席2を離席（代打ち）にして、代打ちの手も記録から再生できることを確かめる
    if (cut === 60) runner.setAway(2, true, 'test');
    if (cut === 140) runner.setAway(2, false, 'test');
    const r = drive(runner, { prefs, turn, stopAt: (st) => st.log.length >= cut });
    if (r === 'final') break;
    const before = stateOf(runner.state);
    const pub = runner.snapshot();
    const copy = createHostRunner({ rules, mode: 'math1', length: 4, seats, seedBase, startDealer: 1, clock: fakeClock(), publish() {} });
    const res = copy.restore(entries.slice(), { sid: pub.sid, seq: pub.seq, away: runner.state.away });
    assert.equal(res.mismatch, 0, `${cut}: CPU の手が記録と一致`);
    assert.equal(res.rest, 0, `${cut}: 記録をすべて再生`);
    const after = stateOf(copy.state);
    assert.deepEqual(after.events, before.events, `${cut}: 局の記録が一致`);
    assert.deepEqual(after.hands, before.hands);
    assert.deepEqual(after.match, before.match, `${cut}: 試合の状態（持ち点・親・連荘・供託）が一致`);
    assert.deepEqual(after.round, before.round);
    assert.deepEqual(after.history, before.history);
    assert.ok(copy.state.sid > pub.sid, '再開後の sid は前の配信より大きい（古い act と取り違えない）');
    checked++;
  }
  assert.ok(checked >= 3);
  assert.ok(runner.state.stats.proxy > 0, '代打ちが打った');
});

// 状態だけで決まる手番の方針（乱数を持ち越さない。途中から再開しても同じ判断になる）
import { decideCharacter } from '../src/engine/characters.js';
const statelessTurn = (seedBase) => (g, seat) => decideCharacter(g, seat, ['aoto', 'yujin', 'natsuki', 'ousuke'][seat], createRng((seedBase ^ (g.events.length * 2654435761) ^ (seat * 97)) >>> 0), null, ['aoto', 'yujin', 'natsuki', 'ousuke']);

test('再生してから最後まで：元の進行と同じ応答を続ければ、同じ最終結果（記録の再生は試合をまたぐ）', () => {
  const rules = RULES.math2;
  const seats = [0, 1, 2, 3].map((s) => ({ kind: 'human', name: `P${s}` }));
  const seedBase = 777;
  const prefs = prefsFor(5);
  const entries = [];
  const full = createHostRunner({ rules, mode: 'math2', length: 4, seats, seedBase, startDealer: 2, clock: fakeClock(), publish() {}, onLog: (e) => entries.push(e) });
  full.start();
  drive(full, { prefs, turn: statelessTurn(seedBase) });
  assert.equal(full.state.phase, 'final');
  // 途中（記録の半分）から再開して、残りを同じ方針で
  const half = entries.slice(0, Math.floor(entries.length / 2));
  const copy = createHostRunner({ rules, mode: 'math2', length: 4, seats, seedBase, startDealer: 2, clock: fakeClock(), publish() {} });
  copy.restore(half, { sid: 10, seq: 10 });
  drive(copy, { prefs, turn: statelessTurn(seedBase) });
  assert.equal(copy.state.phase, 'final');
  assert.deepEqual(copy.state.match.scores, full.state.match.scores);
  assert.deepEqual(copy.state.history, full.state.history);
});

test('離席：手番の途中で離席すると代打ちがすぐ打ち、宣言の窓はその席を待たない。部屋を出る（away）・戻る（back）', () => {
  const rules = RULES.math1;
  const seats = [0, 1, 2, 3].map((s) => ({ kind: 'human', name: `P${s}` }));
  const changes = [];
  const runner = createHostRunner({ rules, mode: 'math1', length: 1, seats, seedBase: 4040, startDealer: 0, clock: fakeClock(), publish() {}, onAway: (s, a, why) => changes.push([s, a, why]) });
  runner.start();
  const st = runner.state;
  assert.deepEqual([st.window.kind, st.window.seats], ['turn', [0]]);
  const n = st.game.events.length;
  assert.equal(runner.receiveNow(0, { k: 'away' }), 'ok'); // 本人の「部屋を出る」
  assert.ok(st.game.events.length > n, '代打ちが打った');
  assert.ok(st.log.some((e) => e.s === 0 && e.src === 'proxy'));
  assert.equal(PROXY_ID, 'ousuke', '代打ちは中級の既定キャラクター');
  assert.deepEqual(changes[0], [0, true, 'leave']);
  assert.ok(runner.snapshot().players[0].away, '全員に離席が見える');
  // 離席中の席には宣言の窓を出さない
  for (let i = 0; i < 200 && st.phase === 'play'; i++) {
    const w = st.window;
    if (!w) break;
    assert.ok(!w.seats.includes(0), '離席中の席は待たない');
    if (w.kind === 'turn') runner.receiveNow(w.seats[0], { k: 'discard', tile: st.game.drawn ?? st.game.hands[w.seats[0]].at(-1), sid: w.sid });
    else if (w.kind === 'claim' || w.kind === 'reask') for (const s of w.seats) runner.receiveNow(s, { k: 'pass', sid: w.sid });
    else break;
  }
  assert.equal(runner.receiveNow(0, { k: 'back' }), 'ok');
  assert.equal(st.away[0], false);
  assert.equal(st.timeouts[0], 0);
  assert.deepEqual(changes.at(-1), [0, false, 'back']);
});

test(`時間切れ ${AWAY_AFTER_TIMEOUTS} 回連続で離席。宣言の途中で離席になった席を待たずに締める`, () => {
  const rules = RULES.math1;
  const seats = [0, 1, 2, 3].map((s) => ({ kind: 'human', name: `P${s}` }));
  const clock = fakeClock();
  const runner = createHostRunner({ rules, mode: 'math1', length: 4, seats, seedBase: 99, startDealer: 0, clock, publish() {} });
  runner.start();
  const st = runner.state;
  // 席0だけ放置。ほかは打つ
  for (let i = 0; i < 2000 && !st.away[0]; i++) {
    const w = st.window;
    if (w.kind === 'turn' && w.seats[0] === 0) { clock.fireNext(); continue; }
    if (w.kind === 'turn') { runner.receiveNow(w.seats[0], { k: 'discard', tile: st.game.drawn ?? st.game.hands[w.seats[0]].at(-1), sid: w.sid }); continue; }
    if (w.kind === 'claim' || w.kind === 'reask') { if (w.seats.includes(0)) { clock.fireNext(); continue; } for (const s of w.seats) runner.receiveNow(s, { k: 'pass', sid: w.sid }); continue; }
    if (w.kind === 'next') { runner.receiveNow(1, { k: 'ready', sid: w.sid }, { host: true }); continue; }
  }
  assert.equal(st.away[0], true);
  assert.equal(st.timeouts[0], AWAY_AFTER_TIMEOUTS);
  assert.equal(st.notices[0], 'away');
});

test('再戦の受付：最終結果で「もう一戦」（ready）を集める', () => {
  const rules = RULES.math1;
  const seats = [{ kind: 'human', name: 'A' }, { kind: 'cpu', name: 'B', cpuId: 'kanata' }, { kind: 'human', name: 'C' }, { kind: 'human', name: 'D' }];
  const runner = createHostRunner({ rules, mode: 'math1', length: 1, seats, seedBase: 5, startDealer: 0, clock: fakeClock(), publish() {} });
  runner.start();
  drive(runner, { prefs: prefsFor(1), turn: turnDecider(5), stopAt: (st) => st.phase === 'final' });
  const st = runner.state;
  assert.equal(st.window.kind, 'rematch');
  assert.equal(st.window.deadline, null, '締切なし');
  assert.equal(runner.receiveNow(2, { k: 'ready', sid: st.window.sid }), 'ok');
  assert.equal(runner.receiveNow(1, { k: 'ready', sid: st.window.sid }), 'bad', 'CPU の席は数えない');
  assert.deepEqual(runner.snapshot().window.ready, [2]);
});

test('ホストの復帰の待ち：paused から90秒（pausedAt はサーバー時刻）', () => {
  assert.equal(hostWaitState({ status: 'playing' }, 0), null);
  const w = hostWaitState({ status: 'paused', pausedAt: 1000 }, 50000);
  assert.deepEqual(w, { deadline: 1000 + HOST_GRACE_MS, expired: false });
  assert.equal(hostWaitState({ status: 'paused', pausedAt: 1000 }, 1000 + HOST_GRACE_MS + 1).expired, true);
  assert.equal(hostWaitState({ status: 'paused', pausedAt: 1000 }, 4000, 2000).expired, true, '試験用に短くできる');
});

// ---- 偽バス上の通し：ゲストの切断（10秒で代打ち）と復帰、ホストの切断（paused）と再生による再開、再戦 ----
function bot(rules, seat, send) {
  let acted = -1;
  return (pub, priv) => {
    if (!pub || pub.phase === 'final') return;
    if (pub.phase === 'result') { if (pub.window && pub.window.kind === 'next' && pub.window.ready && !pub.window.ready.includes(seat) && acted !== pub.sid) { acted = pub.sid; queueMicrotask(() => send({ type: 'ready' })); } return; }
    if (!priv || !priv.pending || priv.sid !== pub.sid || acted === pub.sid) return;
    const t = buildRemoteTable(rules, pub, priv, seat);
    const p = t.pending();
    if (p.seat !== 0) return;
    acted = pub.sid;
    const a = p.type === 'turn' ? (p.canTsumo ? { type: 'tsumo' } : { type: 'discard', tile: t.drawn ?? t.hands[0].at(-1) }) : (p.ron ? { type: 'ron' } : { type: 'pass' });
    queueMicrotask(() => send(a));
  };
}

async function setupRoom({ length = 4 } = {}) {
  const clock = fakeClock();
  const bus = createMemoryBus({ now: clock.now });
  const H = bus.transport('host');
  const G = bus.transport('guest');
  const { code } = await createRoom(H, { name: 'ホスト', appVersion: '0.7.0', length });
  await joinRoom(G, { code, name: 'ゲスト', appVersion: '0.7.0' });
  await enterPresence(H, code);
  await enterPresence(G, code);
  const plan = await startMatch(H, code, { rand: createRng(11).next, seedBase: 123456 });
  const hostSeat = plan.seats.findIndex((x) => x.uid === 'host');
  const guestSeat = plan.seats.findIndex((x) => x.uid === 'guest');
  return { clock, bus, H, G, code, plan, hostSeat, guestSeat, rules: RULES.math1 };
}
function hostOf(ctx, t, extra = {}) {
  const { code, plan, hostSeat, rules, clock } = ctx;
  let s;
  const b = bot(rules, hostSeat, (a) => s.send(a));
  s = createHostSession(t, code, { rules, mode: 'math1', length: plan.length, seats: plan.seats, seedBase: plan.seedBase, startDealer: plan.startDealer, mySeat: hostSeat, clock, onView: (p, v) => queueMicrotask(() => b(p, v)), ...extra });
  return s;
}
async function run(ctx, host, until, { max = 50000 } = {}) {
  for (let i = 0; i < max; i++) {
    await tick();
    if (until()) return true;
    const before = host.runner.state.seq;
    await tick();
    if (host.runner.state.seq === before && !until()) { if (!ctx.clock.fireNext()) return false; }
  }
  return false;
}

test('偽バス：ゲストの切断が10秒続くと代打ち（seats の away・全員に表示）、同じ uid でつながり直すと自分の席に戻る', async () => {
  const ctx = await setupRoom({ length: 8 });
  // CPU・代打ちの手番に間をおく（偽の時計で1手ずつ進め、途中の状態を確かめる）
  const host = hostOf(ctx, ctx.H, { cpuDelay: { turn: 1000 } });
  let gs;
  let gv = null;
  const gb = bot(ctx.rules, ctx.guestSeat, (a) => gs.send(a));
  gs = createGuestSession(ctx.G, ctx.code, ctx.guestSeat, { onView: (p, v) => { gv = p; gb(p, v); } });
  await host.start();
  await run(ctx, host, () => host.runner.state.log.length > 30);
  // 切断（タブを閉じた）：onDisconnect で presence が offline
  gs.stop();
  ctx.bus.drop('guest');
  await tick();
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/presence/guest/online`), false);
  ctx.clock.advance(AWAY_AFTER_MS - 1000);
  await tick();
  assert.equal(host.runner.state.away[ctx.guestSeat], false, '10秒までは離席にしない');
  await run(ctx, host, () => host.runner.state.away[ctx.guestSeat]);
  assert.equal(host.runner.state.away[ctx.guestSeat], true, '10秒で離席');
  await tick();
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/seats/${ctx.guestSeat}/away`), true);
  assert.equal(host.last.pub.players[ctx.guestSeat].away, true);
  // 代打ちで試合が止まらない
  const n = host.runner.state.log.length;
  await run(ctx, host, () => host.runner.state.log.filter((e) => e.src === 'proxy').length >= 2);
  assert.ok(host.runner.state.log.length > n);
  // 同じ端末（同じ uid）で入り直す
  const G2 = ctx.bus.transport('guest');
  const back = await joinRoom(G2, { code: ctx.code, name: 'ゲスト', appVersion: '0.7.0' });
  assert.deepEqual([back.seat, back.rejoined], [ctx.guestSeat, true]);
  let gv2 = null;
  let gs2;
  const gb2 = bot(ctx.rules, ctx.guestSeat, (a) => gs2.send(a));
  gs2 = createGuestSession(G2, ctx.code, ctx.guestSeat, { onView: (p, v) => { gv2 = { p, v }; gb2(p, v); } });
  await enterPresence(G2, ctx.code);
  await run(ctx, host, () => !host.runner.state.away[ctx.guestSeat]);
  assert.equal(host.runner.state.away[ctx.guestSeat], false, '代打ちが止まる');
  assert.equal(host.runner.state.timeouts[ctx.guestSeat], 0);
  await tick();
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/seats/${ctx.guestSeat}/away`), null);
  // 途中からでも、その時点の pub・priv で画面のモデルが組み上がる
  await run(ctx, host, () => gv2 && gv2.v && gv2.v.hand && gv2.p.seq === host.last.pub.seq);
  const tbl = buildRemoteTable(ctx.rules, gv2.p, gv2.v, ctx.guestSeat);
  assert.deepEqual(tbl.hands[0], host.runner.state.game.hands[ctx.guestSeat]);
  // 自分で操作できる（最後まで）
  const humanAfter = () => host.runner.state.log.filter((e) => e.s === ctx.guestSeat && e.src === 'human').length;
  const h0 = humanAfter();
  await run(ctx, host, () => host.last.pub.phase === 'final');
  assert.ok(humanAfter() > h0, '戻った後は本人が打った');
  assert.equal(host.last.pub.phase, 'final');
  void gv;
  host.stop();
});

test('偽バス：ホストが切れると paused（pausedAt）、同じ uid で戻ると記録の再生で同じ局面から再開して完走', async () => {
  const ctx = await setupRoom();
  let host = hostOf(ctx, ctx.H);
  let gs;
  let last = null;
  const gb = bot(ctx.rules, ctx.guestSeat, (a) => gs.send(a));
  gs = createGuestSession(ctx.G, ctx.code, ctx.guestSeat, { onView: (p, v) => { last = p; gb(p, v); } });
  await host.start();
  await run(ctx, host, () => host.runner.state.round >= 2 && host.runner.state.log.length > 10);
  const before = JSON.parse(JSON.stringify({ events: host.runner.state.game.events, match: host.runner.state.match, round: host.runner.state.round }));
  const lastSid = host.last.pub.sid;
  // ホストの切断（再読み込み）：onDisconnect で paused
  await host.stop({ keepPause: true });
  ctx.bus.drop('host');
  await tick();
  const meta = ctx.bus.read(`rooms/${ctx.code}/meta`);
  assert.equal(meta.status, 'paused');
  assert.equal(typeof meta.pausedAt, 'number');
  assert.deepEqual(hostWaitState(meta, ctx.clock.now()), { deadline: meta.pausedAt + HOST_GRACE_MS, expired: false });
  // 同じ uid で戻る：記録を読んで再生
  const H2 = ctx.bus.transport('host');
  const r = await loadResume(H2, ctx.code);
  assert.ok(r.entries.length >= 10);
  assert.deepEqual(r.seats.map((x) => x.kind), ctx.plan.seats.map((x) => x.kind));
  host = hostOf(ctx, H2, { restore: r });
  await host.start();
  assert.equal(host.runner.state.stats.replayMismatch, 0);
  assert.deepEqual(host.runner.state.game.events, before.events, '同じ局面');
  assert.deepEqual(host.runner.state.match, before.match);
  assert.equal(host.runner.state.round, before.round);
  assert.ok(host.runner.state.sid > lastSid);
  await tick();
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/meta/status`), 'playing', '再開');
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/meta/pausedAt`), null);
  await run(ctx, host, () => host.last.pub.phase === 'final' && last && last.phase === 'final');
  assert.equal(last.phase, 'final');
  assert.deepEqual(last.match.scores, host.last.pub.match.scores, 'ゲストとホストで結果が一致');
  // 再戦：もう一戦を押したゲストだけが残り、ロビーへ（matchNo を進める）
  await gs.send({ type: 'ready' });
  await run(ctx, host, () => host.last.pub.window.ready.includes(ctx.guestSeat));
  const keep = [...host.runner.state.rematch].map((s) => ctx.plan.seats[s].uid);
  await host.stop();
  const re = await reopenLobby(ctx.H.uid === 'host' ? H2 : ctx.H, ctx.code, keep);
  assert.deepEqual(re, { seats: 2, matchNo: 1 });
  const db = ctx.bus.read(`rooms/${ctx.code}`);
  assert.equal(db.meta.status, 'lobby');
  assert.deepEqual(Object.values(db.seats).map((x) => x.uid), ['host', 'guest'], 'ホストが席0、もう一戦の人が続く');
  assert.equal(db.pub, undefined);
  assert.equal(db.host, undefined);
  let v;
  watchRoom(ctx.G, ctx.code, (x) => { v = x; });
  await tick();
  assert.equal(v.meta.status, 'lobby');
  assert.equal(v.mySeat, 1);
  // 2試合目を開始できる
  const plan2 = await startMatch(H2, ctx.code, { rand: createRng(3).next, seedBase: 999 });
  assert.equal(plan2.seats.filter((x) => x.kind === 'human').length, 2);
  assert.equal(ctx.bus.read(`rooms/${ctx.code}/meta/status`), 'playing');
});

test('偽バス：もう一戦を押さなかった人は再戦の部屋から外れる', async () => {
  const ctx = await setupRoom({ length: 1 });
  const host = hostOf(ctx, ctx.H);
  let gs;
  const gb = bot(ctx.rules, ctx.guestSeat, (a) => gs.send(a));
  gs = createGuestSession(ctx.G, ctx.code, ctx.guestSeat, { onView: (p, v) => gb(p, v) });
  await host.start();
  await run(ctx, host, () => host.last.pub.phase === 'final');
  await host.stop();
  await reopenLobby(ctx.H, ctx.code, []);
  const seats = ctx.bus.read(`rooms/${ctx.code}/seats`);
  assert.deepEqual(Object.values(seats).map((x) => x.uid), ['host']);
  let v;
  watchRoom(ctx.G, ctx.code, (x) => { v = x; });
  await tick();
  assert.equal(v.removed, true);
});
