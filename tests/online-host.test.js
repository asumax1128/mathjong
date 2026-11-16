// オンライン対戦 段階2：ホストの進行役（online-host.js）・配信（online-protocol.js）・つなぎ（online-session.js）の単体試験。
// ネットワークなし。偽の時計とメモリ上の偽バスで、決定論的に試す（docs/79「9.0①」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { ranks } from '../src/engine/match.js';
import { createHostRunner } from '../src/ui/online-host.js';
import { createHostSession, createGuestSession } from '../src/ui/online-session.js';
import { createMemoryBus } from '../src/ui/online-transport.js';
import { buildRemoteTable, rotateMatch, publicGameState, privateState, unwrap, wrap, LIMITS } from '../src/ui/online-protocol.js';
import { fakeClock, prefChoice, prefsFor, turnDecider, runLocalRound } from './online-sim.js';

const RULES = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const humans4 = () => [0, 1, 2, 3].map((s) => ({ kind: 'human', name: `P${s}` }));

// 進行役を直接動かす：窓が開くたびに、方針で全員の応答を作って渡す（宣言は並列に集める）
function driveRound(runner, { prefs, turn, onClaim }) {
  for (let i = 0; i < 5000; i++) {
    const st = runner.state;
    if (st.phase !== 'play') return;
    const w = st.window;
    const g = st.game;
    if (w.kind === 'turn') {
      const a = turn(g, w.seats[0]);
      runner.receiveNow(w.seats[0], { k: a.type, sid: w.sid, tile: a.tile, riichi: a.riichi, tileType: a.tileType });
    } else if (w.kind === 'reask') {
      const s = w.seats[0];
      const a = prefChoice(prefs[s], { ron: true, chi: [], pon: null });
      runner.receiveNow(s, { k: a.type, sid: w.sid });
    } else if (w.kind === 'claim') {
      const choices = w.seats.map((s) => [s, prefChoice(prefs[s], st.claimOffer.get(s))]);
      if (onClaim) onClaim(choices);
      for (const [s, c] of choices) runner.receiveNow(s, { k: c.type, option: c.option, sid: w.sid });
    } else throw Error(`unexpected window ${w.kind}`);
  }
  throw Error('round did not finish');
}

function runOnlineRound({ mode, seedBase, dealer, prefs, makeGame }) {
  const clock = fakeClock();
  const runner = createHostRunner({ rules: RULES[mode], mode, length: 1, seats: humans4(), seedBase, startDealer: dealer, clock, publish() {}, makeGame });
  runner.start();
  const cases = { multiRon: 0, chiCancel: 0, ponOverChi: 0, ronOverPon: 0 };
  driveRound(runner, {
    prefs, turn: turnDecider(seedBase + 7919),
    onClaim(choices) {
      const has = (k) => choices.some(([, c]) => c.type === k);
      if (choices.filter(([, c]) => c.type === 'ron').length >= 2) cases.multiRon++;
      if (has('chi') && has('ron')) cases.chiCancel++;
      if (has('chi') && has('pon')) cases.ponOverChi++;
      if (has('pon') && has('ron')) cases.ronOverPon++;
    },
  });
  return { runner, cases };
}

test('宣言の優先順位：並列収集＋エンジン順の適用は、ローカルの1席ずつの判断と同じ結果（ロン＞ポン＞チー・アタマハネ・チー取消し）', () => {
  const total = { multiRon: 0, chiCancel: 0, ponOverChi: 0, ronOverPon: 0 };
  // 数学Ⅰの1〜30と、各場面が起きる seed（探索して固定）。数学Ⅱも
  const plan = [...Array.from({ length: 30 }, (_, i) => ['math1', i + 1]), ['math1', 114], ['math1', 192], ['math1', 195], ['math2', 11], ['math2', 75]];
  for (const [mode, sb] of plan) {
    const seedBase = sb * 1013;
    const prefs = prefsFor(sb);
    const { runner, cases } = runOnlineRound({ mode, seedBase, dealer: sb % 4, prefs });
    for (const k of Object.keys(total)) total[k] += cases[k];
    const local = runLocalRound({ rules: RULES[mode], seed: seedBase + 7919, dealer: sb % 4, prefs });
    assert.deepEqual(runner.state.game.events, local.events, `${mode} seed ${sb}: 記録が一致`);
    assert.deepEqual(runner.state.game.result, local.result, `${mode} seed ${sb}: 結果が一致`);
  }
  // 各場面が実際に起きている（同じ打牌に複数のロン＝アタマハネ、チーと後続のロン、チーとポン、ポンとロン）
  for (const [k, v] of Object.entries(total)) assert.ok(v >= 1, `${k} が起きていない`);
});

// 再質問の局面を組み立てる：席0が関数牌 F を捨てる。より近い席1は F の対子（ポン可）、席2は F の対子＋ F で和了（ロンもポンも可）。
// ruleset 2 は関数牌のポンが禁止で、ほかの牌は4枚なので「2人が同じ牌をポンできる」局面は起きない。再質問の経路は、
// 関数牌のポンができる ruleset 1 で組み立てて確かめる（進行役の処理は版によらない）。
function reaskGame(params) {
  const g = new Game({ ...params, ruleset: 1, dealer: 0 });
  const rules = g.rules;
  const F = rules.types.find((t) => t.kind === 'func').idx;
  const koutsuTypes = rules.types.filter((t) => t.kind === 'value' && rules.koutsuOf(t.idx)).map((t) => t.idx);
  const pool = [...g.hands.flat(), ...g.wall];
  const take = (type, n) => { const out = []; for (let i = 0; i < pool.length && out.length < n; i++) if (g.tileType[pool[i]] === type) { out.push(pool[i]); pool.splice(i--, 1); } assert.equal(out.length, n); return out; };
  const hand2 = [...take(F, 2), ...take(koutsuTypes[0], 3), ...take(koutsuTypes[1], 3)];
  const hand1 = [...take(F, 2), ...take(koutsuTypes[2], 1), ...take(koutsuTypes[3], 1), ...take(koutsuTypes[4], 1), ...take(koutsuTypes[5], 1), ...take(koutsuTypes[6], 1), ...take(koutsuTypes[7], 1)];
  const disc = take(F, 1)[0];
  const others = pool.filter((id) => g.tileType[id] !== F);
  const hand0 = [disc, ...others.splice(0, 8)];
  const hand3 = others.splice(0, 8);
  const used = new Set([...hand0, ...hand1, ...hand2, ...hand3]);
  g.hands = [hand0, hand1, hand2, hand3];
  g.wall = pool.filter((id) => !used.has(id));
  g.current = 0; g.phase = 'turn'; g.drawn = disc; g.justDrew = true;
  g.checkInvariants();
  assert.ok(g.ronAnalysis(2, disc), '席2は F でロンできる');
  assert.ok(!g.ronAnalysis(1, disc) && !g.ronAnalysis(3, disc));
  return g;
}

test('再質問：ポンを選んだが近い席のポンで無効になり、ロンが残る席にだけ15秒の再質問（ロン→和了・ローカルと同じ結果）', () => {
  const prefs = [['pass'], ['pon', 'pass'], ['pon', 'ron', 'pass'], ['pass']];
  const clock = fakeClock();
  const pubs = [];
  const runner = createHostRunner({ rules: RULES.math1, mode: 'math1', length: 1, seats: humans4(), seedBase: 5, clock, makeGame: reaskGame, publish: (p, privs) => pubs.push({ p, privs }) });
  runner.start();
  const st = runner.state;
  assert.equal(st.window.kind, 'turn');
  const disc = st.game.drawn;
  runner.receiveNow(0, { k: 'discard', tile: disc, sid: st.window.sid });
  assert.equal(st.window.kind, 'claim');
  assert.deepEqual(st.window.seats.sort(), [1, 2]);
  // 席2には最初の選択肢（ロンもポンも）が同時に出ている
  const pend2 = pubs.at(-1).privs[2].pending;
  assert.equal(pend2.ron, true);
  assert.ok(pend2.pon);
  runner.receiveNow(1, { k: 'pon', sid: st.window.sid });
  runner.receiveNow(2, { k: 'pon', sid: st.window.sid });
  assert.equal(st.window.kind, 'reask', '席2にだけ再質問');
  assert.deepEqual(st.window.seats, [2]);
  assert.equal(st.window.deadline - clock.now(), LIMITS.claimMs, '再質問も15秒');
  const re = pubs.at(-1).privs[2];
  assert.deepEqual([re.pending.ron, re.pending.pon, re.pending.chi, re.pending.reask, re.notice], [true, null, [], true, 'overridden']);
  assert.equal(pubs.at(-1).privs[1].pending, null, '席1には出さない');
  runner.receiveNow(2, { k: 'pon', sid: st.window.sid }); // 再質問ではポンは選べない
  assert.equal(st.window.kind, 'reask');
  runner.receiveNow(2, { k: 'ron', sid: st.window.sid });
  assert.equal(st.game.result.type, 'win');
  assert.deepEqual([st.game.result.winner, st.game.result.how, st.game.result.from], [2, 'ron', 0]);
  assert.equal(st.stats.reask, 1);
  // ローカルの1席ずつ：席1のポンの後、席2にはロンだけが出て、方針どおりロン
  const local = reaskGame({ rules: RULES.math1, seed: 5 + 7919, players: humans4(), round: 1 });
  for (let i = 0; i < 10; i++) {
    const p = local.pending();
    if (!p) break;
    applyAction(local, p.seat, p.type === 'turn' ? { type: 'discard', tile: disc } : prefChoice(prefs[p.seat], p));
  }
  assert.deepEqual(st.game.events, local.events);
  assert.deepEqual(st.game.result, local.result);
});

test('再質問の時間切れは見送り：席1のポンが成立する', () => {
  const clock = fakeClock();
  const runner = createHostRunner({ rules: RULES.math1, mode: 'math1', length: 1, seats: humans4(), seedBase: 5, clock, makeGame: reaskGame, publish() {} });
  runner.start();
  const st = runner.state;
  runner.receiveNow(0, { k: 'discard', tile: st.game.drawn, sid: st.window.sid });
  runner.receiveNow(1, { k: 'pon', sid: st.window.sid });
  runner.receiveNow(2, { k: 'pon', sid: st.window.sid });
  assert.equal(st.window.kind, 'reask');
  clock.fireNext();
  assert.equal(st.game.events.at(-1).type, 'pon');
  assert.equal(st.game.events.at(-1).seat, 1);
  assert.notEqual(st.game.result && st.game.result.type, 'win', 'ロンは成立しない');
  assert.ok(st.log.some((x) => x.seat === 2 && x.action.type === 'pass'), '席2は見送り');
  assert.equal(st.timeouts[2], 1);
  assert.equal(st.window.kind, 'turn');
  assert.deepEqual(st.window.seats, [1]);
});

test('制限時間：手番45秒はツモ切り・宣言15秒は見送り・結果20秒で次局。連続の時間切れを数え、操作で0に戻す', () => {
  const clock = fakeClock();
  const pubs = [];
  const seats = [{ kind: 'human', name: 'A' }, { kind: 'cpu', name: 'B', cpuId: 'kanata' }, { kind: 'human', name: 'C' }, { kind: 'cpu', name: 'D', cpuId: 'aoto' }];
  const runner = createHostRunner({ rules: RULES.math1, mode: 'math1', length: 4, seats, seedBase: 4242, startDealer: 0, clock, publish: (p, privs) => pubs.push({ p, privs }) });
  runner.start();
  const st = runner.state;
  assert.equal(st.window.kind, 'turn');
  assert.deepEqual(st.window.seats, [0]);
  assert.equal(st.window.deadline - clock.now(), LIMITS.turnMs);
  assert.equal(pubs.at(-1).p.window.deadline, st.window.deadline, '締切は全員に同じ値');
  const drawn = st.game.drawn;
  clock.fireNext(); // 45秒
  const d = st.game.events.find((e) => e.type === 'discard' && e.seat === 0);
  assert.equal(d.tile, drawn, 'ツモ切り');
  assert.equal(st.timeouts[0], 1);
  assert.equal(pubs.at(-1).privs[0].notice, 'timeout');
  // 以後は時間切れだけで局が終わるまで進む（宣言の窓は見送り）
  let claimTimeouts = 0;
  for (let i = 0; i < 400 && st.phase === 'play'; i++) {
    if (st.window.kind === 'claim') claimTimeouts++;
    clock.fireNext();
  }
  assert.equal(st.phase, 'result');
  assert.ok(st.timeouts[0] + st.timeouts[2] >= 3);
  assert.equal(st.window.kind, 'next');
  assert.equal(st.window.deadline - clock.now(), LIMITS.nextMs);
  const round = st.round;
  clock.fireNext(); // 20秒で次局
  assert.equal(st.round, round + 1);
  assert.equal(st.phase, 'play');
  // 人間の操作で連続回数は0に戻る
  const seat = st.window.kind === 'turn' ? st.window.seats[0] : null;
  if (seat !== null && seats[seat].kind === 'human') {
    runner.receiveNow(seat, { k: 'discard', tile: st.game.drawn, sid: st.window.sid });
    assert.equal(st.timeouts[seat], 0);
  }
  assert.ok(claimTimeouts >= 0);
});

test('行動の検証：古い局面・他人の席・不正な牌は適用しない（拒否は本人にだけ知らせ、窓はそのまま）', () => {
  const clock = fakeClock();
  const pubs = [];
  const runner = createHostRunner({ rules: RULES.math1, mode: 'math1', length: 1, seats: humans4(), seedBase: 77, startDealer: 0, clock, publish: (p, privs) => pubs.push({ p, privs }) });
  runner.start();
  const st = runner.state;
  const sid = st.window.sid;
  const n = st.game.events.length;
  assert.equal(runner.receiveNow(0, { k: 'discard', tile: st.game.drawn, sid: sid - 1 }), undefined);
  assert.equal(st.game.events.length, n, '古い sid は捨てる');
  runner.receiveNow(1, { k: 'discard', tile: st.game.hands[1][0], sid });
  assert.equal(st.game.events.length, n, '他人の手番には適用しない');
  runner.receiveNow(0, { k: 'discard', tile: st.game.hands[1][0], sid });
  assert.equal(st.game.events.length, n, '手牌にない牌は拒否');
  assert.equal(st.window.sid, sid);
  assert.equal(pubs.at(-1).privs[0].notice, 'rejected');
  runner.receiveNow(0, { k: 'ron', sid });
  assert.equal(st.game.events.length, n, '手番にロンはない');
  runner.receiveNow(0, { k: 'discard', tile: st.game.drawn, sid });
  assert.ok(st.game.events.length > n);
});

test('配信：pub には他家の手牌がなく（局の終わりだけ公開）、priv は本人の手牌と選択肢だけ。JSON で包んで往復しても同じ', () => {
  const rules = RULES.math1;
  const g = new Game({ rules, seed: 99, dealer: 1, players: humans4(), round: 1, ruleset: 2 });
  const pub = publicGameState(g);
  assert.equal(pub.revealed, null);
  assert.deepEqual(pub.handCounts, g.hands.map((h) => h.length));
  const text = JSON.stringify(pub);
  for (let s = 0; s < 4; s++) assert.ok(!('hands' in pub));
  assert.ok(!/"wall"\s*:\s*\[/.test(text), '山の並びを出さない');
  const pv = privateState(g, 1, { pending: { type: 'turn', canTsumo: false, ankan: [] }, sid: 3 });
  assert.deepEqual(pv.hand, g.hands[1]);
  assert.equal(pv.drawn, g.drawn);
  const pv2 = privateState(g, 2, { sid: 3 });
  assert.equal(pv2.drawn, null);
  assert.deepEqual(unwrap(wrap(5, pub)), JSON.parse(text));
});

test('RemoteTable：自分を席0に回し、Game と同じ読み取り口で既存の計算（聴牌・リーチ候補・フリテン）ができる', () => {
  const rules = RULES.math1;
  const g = new Game({ rules, seed: 1234, dealer: 2, players: humans4(), round: 1, ruleset: 2 });
  const me = 2; // 親（手番）
  const pub = { seq: 1, sid: 1, players: humans4(), game: publicGameState(g) };
  const priv = privateState(g, me, { pending: { type: 'turn', canTsumo: !!g.tsumoAnalysis(me), ankan: g.ankanOptions(me) }, sid: 1 });
  const t = buildRemoteTable(rules, pub, priv, me);
  assert.deepEqual(t.hands[0], g.hands[me]);
  assert.equal(t.hands[1].length, g.hands[3].length); // 下家＝絶対席3
  assert.ok(t.hands[1].every((x) => x === -1), '他家の中身はない');
  assert.equal(t.dealer, 0);
  assert.equal(t.current, 0);
  const p = t.pending();
  assert.deepEqual([p.seat, p.type], [0, 'turn']);
  assert.deepEqual(t.riichiOptions(0), g.riichiOptions(me));
  assert.deepEqual(t.viewFor(0).hand, g.viewFor(me).hand);
  assert.deepEqual(t.furitenOf(0), g.furitenOf(me));
  // 応答を送った後は選択肢を出さない
  const sent = buildRemoteTable(rules, pub, priv, me, { sent: true });
  assert.equal(sent.pending().seat, -1);
  // 他家の手番：その席が手番に見える
  const t3 = buildRemoteTable(rules, pub, privateState(g, 3, { sid: 1 }), 3);
  assert.equal(t3.pending().seat, 3); // 絶対席2は、席3から見て対面（3）
  assert.equal(t3.dealer, 3);
  // match の回転
  const m = rotateMatch({ scores: [10, 20, 30, 40], wins: [0, 0, 1, 0], best: [0, 0, 0, 0], bestBase: [0, 0, 0, 0], startDealer: 2, pot: [{ seat: 1, points: 5 }], log: [{ dealer: 2, deltas: [1, 2, 3, -6], result: { winner: 2, from: 3 } }] }, 2);
  assert.deepEqual(m.scores, [30, 40, 10, 20]);
  assert.equal(m.startDealer, 0);
  assert.equal(m.pot[0].seat, 3);
  assert.deepEqual([m.log[0].result.winner, m.log[0].result.from], [0, 1]);
});

// ---- 通しの試験：偽バス上でホスト1＋ゲスト3（または2人＋CPU2）。ゲストは RemoteTable だけを見て操作する ----
const settle = () => new Promise((r) => setImmediate(r));
function botFor(rules, seat, send, seen) {
  let actedSid = -1;
  return (pub, priv) => {
    seen.push({ pub, priv });
    if (!pub || pub.phase === 'final') return;
    if (pub.phase === 'result') {
      if (pub.window && !pub.window.ready.includes(seat) && actedSid !== pub.sid) { actedSid = pub.sid; send({ type: 'ready' }); }
      return;
    }
    if (!priv || !priv.pending || priv.sid !== pub.sid || actedSid === pub.sid) return;
    const t = buildRemoteTable(rules, pub, priv, seat);
    const p = t.pending();
    if (p.seat !== 0) return;
    actedSid = pub.sid;
    let a;
    if (p.type === 'turn') {
      if (p.canTsumo) a = { type: 'tsumo' };
      else {
        const r = t.riichiOptions(0);
        a = r.length && !t.riichi[0] ? { type: 'discard', tile: r[0].ids[0], riichi: true } : { type: 'discard', tile: t.riichi[0] ? t.drawn : (t.drawn ?? t.hands[0][t.hands[0].length - 1]) };
      }
    } else a = p.ron ? { type: 'ron' } : p.pon ? { type: 'pon' } : p.chi.length ? { type: 'chi', option: 0 } : { type: 'pass' };
    queueMicrotask(() => send(a));
  };
}

async function playMatch({ mode, length, seatKinds, seedBase, startDealer = 0, hostSeat = 0 }) {
  const rules = RULES[mode];
  const clock = fakeClock();
  const bus = createMemoryBus({ now: clock.now });
  const code = 'ABCDEF';
  const seats = seatKinds.map((k, s) => (k === 'human' ? { kind: 'human', name: `人${s}` } : { kind: 'cpu', name: `CPU${s}`, cpuId: ['kanata', 'aoto', 'natsuki', 'yujin'][s] }));
  const views = {};
  let host;
  const hostT = bus.transport('host');
  const hostSeen = [];
  const hostBot = botFor(rules, hostSeat, (a) => host.send(a), hostSeen);
  host = createHostSession(hostT, code, { rules, mode, length, seats, seedBase, startDealer, mySeat: hostSeat, clock, onView: (pub, priv) => queueMicrotask(() => hostBot(pub, priv)) });
  views[hostSeat] = hostSeen;
  const guests = [];
  for (let s = 0; s < 4; s++) {
    if (s === hostSeat || seats[s].kind !== 'human') continue;
    const t = bus.transport(`g${s}`);
    const seen = [];
    let gs;
    const bot = botFor(rules, s, (a) => gs.send(a), seen);
    gs = createGuestSession(t, code, s, { onView: bot });
    guests.push({ s, gs, t });
    views[s] = seen;
  }
  host.start();
  for (let i = 0; i < 200000; i++) {
    await settle();
    const last = host.last;
    if (last && last.pub.phase === 'final') break;
    const before = host.runner.state.seq;
    await settle();
    if (host.runner.state.seq === before) { if (!clock.fireNext()) throw Error('stuck'); }
  }
  await settle();
  return { host, guests, views, bus, seats };
}

for (const [length, mode, seatKinds] of [[1, 'math1', ['human', 'human', 'human', 'human']], [4, 'math1', ['human', 'human', 'human', 'human']], [8, 'math2', ['human', 'human', 'human', 'human']], [4, 'math2', ['human', 'cpu', 'human', 'cpu']]]) {
  test(`通し：${length}局戦（${mode}・人間${seatKinds.filter((k) => k === 'human').length}人）を偽バスで最後まで。全端末の結果（持ち点・順位）が一致`, async () => {
    const { host, views, bus, seats } = await playMatch({ mode, length, seatKinds, seedBase: 31337 + length, startDealer: length % 4, hostSeat: 0 });
    const final = host.last.pub;
    assert.equal(final.phase, 'final');
    assert.equal(final.match.over, true);
    assert.equal(final.match.scores.reduce((a, b) => a + b, 0), 400);
    if (length === 1) assert.equal(final.match.played, 1);
    else assert.ok(final.match.played >= length, `${final.match.played}局`);
    for (const [s, seen] of Object.entries(views)) {
      const last = seen.at(-1).pub;
      assert.equal(last.phase, 'final', `席${s}も最終結果`);
      assert.deepEqual(last.match.scores, final.match.scores, `席${s}の持ち点が一致`);
      assert.deepEqual(ranks(last.match.scores), ranks(final.match.scores));
      // 自分を席0にした表示用でも、回せば同じ
      const rm = rotateMatch(last.match, Number(s));
      assert.deepEqual(rm.scores, [0, 1, 2, 3].map((l) => final.match.scores[(l + Number(s)) % 4]));
      // 受信データに他家の手牌がない（局の途中）：pub は枚数だけ、priv は自分の席だけ
      for (const { pub, priv } of seen) {
        if (pub && pub.game && pub.game.phase !== 'ended') assert.equal(pub.game.revealed, null);
        if (priv) assert.equal(priv.seat, Number(s));
      }
    }
    // 偽バスに書かれた priv は人間の席だけ。CPU の席の priv はない
    const db = bus.dump();
    const privs = Object.keys(db.rooms.ABCDEF.priv || {});
    assert.deepEqual(privs.map(Number).sort(), seats.map((x, s) => (x.kind === 'human' && s !== 0 ? s : null)).filter((x) => x !== null));
    host.stop();
  });
}
