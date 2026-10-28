// Ver.0.6 監査 P2-1 の回帰テスト：人間がロン（またはツモ）を見送った牌を、上級 AI が「通った牌」として危険度 0 にしない。
// 人間はロン・ツモを見送れる（フリテンの規則はない）ので、見送った牌は後で当たりになりうる。
// 「通った牌」は、宣言できるロン・ツモを必ず宣言する AI の席だけで使う（AI 同士では従来どおり、実際にも当たりでないことを確認）。
// テストでは、見送った牌が人間の本当の待ちに残っているかを確かめるためだけに人間の手牌を見る（AI の判断には渡さない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction, unseenCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { decideCharacter, passedTiles, dangerTableV06, ronGuaranteed } from '../src/engine/character-ai.js';
import { makeGame, findTile, idx, rulesFor } from './helpers.js';

const rulesOf = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const AI = ['fukuyama', 'kaoru', 'asuma'];
// 人間の席（0）の打ち方：鳴き・リーチの多いキャラの判断を借り、宣言できるロンは必ず見送る（ツモは半分見送る）。
const HUMAN_STYLE = ['kaoru', 'aoto', 'asuma', 'ousuke'];

const realWaits = (g, s) => new Set(g.waitsOf(g.countsOf(g.hands[s]), g.melds[s].map((m) => m.meld)));

// 1局を回し、人間が見送った牌を記録して、その後の上級 AI の手番ごとに「通った牌」と危険度を確かめる
function playWithHuman(mode, seed, cases) {
  const rules = rulesOf[mode];
  const style = HUMAN_STYLE[seed % HUMAN_STYLE.length];
  const ids = [style, ...AI];
  const players = [{ name: 'あなた', kind: 'human' }, ...AI.map((id) => ({ name: id, kind: 'ai', personality: 'speed' }))];
  const g = new Game({ rules, seed, dealer: seed % 4, players });
  const rng = createRng(seed ^ 0x5bd1e995);
  const hrng = createRng(seed ^ 0x2545f491);
  const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: seed % 4, renchan: 0 };
  const passes = []; // { type, riichi, meldsAt, at（events の位置） }
  let n = 0;
  while (g.pending()) {
    const p = g.pending();
    let a = decideCharacter(g, p.seat, ids[p.seat], rng, info, ids);
    if (p.seat === 0) {
      if (p.type === 'claim' && p.ron) {
        passes.push({ type: g.typeOf(p.tile), riichi: !!g.riichi[0], meldsAt: g.melds[0].length, at: g.events.length, kind: 'ron' });
        a = { type: 'pass' };
      } else if (p.type === 'claim' && passes.some((x) => !x.riichi) && (p.pon || p.chi.length)) {
        // ロンを見送った後に鳴いて手を変える（鳴きの前後の両方を確かめるため、出たチー・ポンは受ける）
        a = p.pon ? { type: 'pon' } : { type: 'chi', option: 0 };
      } else if (p.type === 'turn' && p.canTsumo && hrng.next() < 0.5) {
        passes.push({ type: g.typeOf(g.drawn), riichi: !!g.riichi[0], meldsAt: g.melds[0].length, at: g.events.length, kind: 'tsumo' });
        a = { type: 'discard', tile: g.drawn };
      }
    } else if (p.type === 'turn' && !p.canTsumo && !g.riichi[p.seat] && passes.length) {
      // 上級 AI の手番：見送られた牌のうち、いまも人間の本当の待ちにあるもの
      const waits = realWaits(g, 0);
      const passed = passedTiles(g, p.seat);
      const view = g.viewFor(p.seat);
      const table = dangerTableV06(g, rules, view, unseenCounts(rules, view), p.seat);
      assert.ok(table, `${mode} 危険度 v06 がない`);
      for (const ps of passes) {
        if (!waits.has(ps.type)) continue;
        const after = g.events.slice(ps.at);
        const changed = after.some((e) => e.seat === 0 && (e.type === 'discard' || e.type === 'chi' || e.type === 'pon'));
        const calledAfter = after.some((e) => e.seat === 0 && (e.type === 'chi' || e.type === 'pon'));
        const label = `${mode} seed ${seed} 席${p.seat}：人間が${ps.riichi ? 'リーチ中に' : ''}${ps.kind === 'ron' ? 'ロン' : 'ツモ'}を見送った牌`;
        assert.ok(!passed[0].has(ps.type), `${label}を「通った牌」にした`);
        assert.ok(table[0][ps.type] > 0, `${label}の危険度が 0`);
        cases.total++;
        cases[`${ps.kind}${ps.riichi ? 'Riichi' : ''}`]++;
        cases[changed ? 'changed' : 'unchanged']++;
        if (ps.meldsAt > 0) cases.callBefore++;
        if (calledAfter) cases.callAfter++;
      }
    }
    applyAction(g, p.seat, a);
    if (++n > 4000) throw new Error('no progress');
  }
  g.checkInvariants();
  return g;
}

// ---- 固定の局面（山の並びを指定）：人間（席0・親）は sin30=1/2・cos180=−1 が完成、tan・45 で =1 待ち ----
const TENPAI = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];
const O1 = ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'];
const O2 = ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'];
const O3 = ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', '=-√3'];
const HUMAN_SEATS = [{ name: 'あなた', kind: 'human' }, ...AI.map((id) => ({ name: id, kind: 'ai', personality: 'speed' }))];
const passClaims = (g) => { while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' }); };
// 上級 AI（席 s）の手番で、人間が見送った牌 key が「通った牌」になっておらず、危険度が正であることを確かめる
function expectNotSafe(g, s, key, label) {
  const r = g.rules;
  const t = idx(key, r);
  assert.deepEqual([g.pending().seat, g.pending().type], [s, 'turn'], `${label}：席${s}の手番`);
  assert.ok(realWaits(g, 0).has(t), `${label}：前提（見送った牌が人間の本当の待ちに残っている）`);
  assert.ok(!passedTiles(g, s)[0].has(t), `${label}：見送った牌を「通った牌」にした`);
  const view = g.viewFor(s);
  const table = dangerTableV06(g, r, view, unseenCounts(r, view), s);
  assert.ok(table[0][t] > 0, `${label}：危険度が 0`);
  // 判断も最後まで進む（上級3人）
  for (const id of AI) assert.ok(decideCharacter(g, s, id, createRng(1), { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0 }, ['h', ...AI]));
  return table[0][t];
}
// 人間がロンを見送る：席1が =1 をツモ切り → 人間にロンの選択肢 → 見送る
function aiDiscardsDrawnAndHumanPasses(g, seat) {
  g.discard(seat, g.drawn);
  const p = g.pending();
  assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], '人間にロンの選択肢');
  g.respond(0, { type: 'pass' });
  passClaims(g);
}

for (const mode of ['math1', 'math2']) {
  const r = rulesFor(mode);
  test(`P2-1 回帰（${mode}・固定局面）：人間の通常のロン見送り（手牌は変えない）`, () => {
    const g = makeGame({ r, hands: [TENPAI, O1, O2, O3], draws: ['0', '=1', '=-√3/2'], players: HUMAN_SEATS });
    g.discard(0, findTile(g, 0, '0'));
    passClaims(g);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    expectNotSafe(g, 2, '=1', `${mode} 通常の見送り`);
  });

  test(`P2-1 回帰（${mode}・固定局面）：人間のリーチ中のロン見送り・リーチ中のツモ見送り（ツモ切り）`, () => {
    const g = makeGame({ r, hands: [TENPAI, O1, O2, O3], draws: ['0', '=1', '=-√3/2', '=-1/√3', '=1', '=-√3/2'], players: HUMAN_SEATS });
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passClaims(g);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    expectNotSafe(g, 2, '=1', `${mode} リーチ中のロン見送り`);
    g.discard(2, g.drawn); passClaims(g);
    g.discard(3, g.drawn); passClaims(g);
    // 人間がリーチ中に =1 をツモ。ツモ和了を見送ってツモ切り
    assert.ok(g.pending().canTsumo, '人間はツモ和了できる');
    g.discard(0, g.drawn);
    passClaims(g);
    expectNotSafe(g, 1, '=1', `${mode} リーチ中のツモ見送り`);
  });

  test(`P2-1 回帰（${mode}・固定局面）：見送った後に手牌を変更（30→150、待ちは =1 のまま）してから再び見送る`, () => {
    const g = makeGame({ r, hands: [TENPAI, O1, O2, O3], draws: ['0', '=1', '=-√3/2', '=-1/√3', '150', '=1', '=-1/√2'], players: HUMAN_SEATS });
    g.discard(0, findTile(g, 0, '0'));
    passClaims(g);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    expectNotSafe(g, 2, '=1', `${mode} 変更前`);
    g.discard(2, g.drawn); passClaims(g);
    g.discard(3, g.drawn); passClaims(g);
    // 人間：150 をツモって 30 を捨てる（sin150=1/2 で完成のまま、=1 待ち）
    g.discard(0, findTile(g, 0, '30'));
    passClaims(g);
    expectNotSafe(g, 1, '=1', `${mode} 変更後（見送った牌が残る）`);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    expectNotSafe(g, 2, '=1', `${mode} 変更後に再び見送り`);
  });

  test(`P2-1 回帰（${mode}・固定局面）：見送り→チー（鳴きの後）→再び見送り（鳴いた手で見送り）`, () => {
    const g = makeGame({ r, hands: [TENPAI, O1, O2, O3], draws: ['0', '=1', '=-√3/2', 'cos', '=1', '=-1/√2'], players: HUMAN_SEATS });
    g.discard(0, findTile(g, 0, '0'));
    passClaims(g);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    g.discard(2, g.drawn); passClaims(g);
    // 上家（席3）の cos を、人間が 180・=−1 でチー（cos180=−1 を公開）
    g.discard(3, g.drawn);
    const c = g.pending();
    assert.deepEqual([c.seat, c.type, c.chi.length > 0], [0, 'claim', true], '人間がチーできる');
    g.respond(0, { type: 'chi', option: 0 });
    passClaims(g);
    assert.equal(g.melds[0].length, 1, 'チーした');
    g.discard(0, findTile(g, 0, 'cos'));
    passClaims(g);
    if (!realWaits(g, 0).has(idx('=1', r))) return assert.fail(`${mode}：チー後の手で =1 待ちにならない（局面の作り直しが必要）`);
    expectNotSafe(g, 1, '=1', `${mode} チーの前に見送った牌（鳴きの後）`);
    aiDiscardsDrawnAndHumanPasses(g, 1);
    expectNotSafe(g, 2, '=1', `${mode} チーの後に見送った牌`);
  });
}

for (const mode of ['math1', 'math2']) {
  test(`P2-1 回帰（${mode}・ランダム対局）：人間がロン・ツモを見送った牌は、本当の待ちに残る限り危険度 0 にならない`, () => {
    const cases = { total: 0, ron: 0, ronRiichi: 0, tsumo: 0, tsumoRiichi: 0, changed: 0, unchanged: 0, callBefore: 0, callAfter: 0 };
    const rounds = mode === 'math1' ? 40 : 12;
    for (let k = 0; k < rounds; k++) playWithHuman(mode, 41000 + k, cases);
    // 固定局面のテストを補う幅広い確認（局面の種類は seed による。少なくとも見送りの検査が起きていること）
    assert.ok(cases.total > 0 && cases.ron + cases.ronRiichi > 0, `${mode} ${JSON.stringify(cases)}`);
  });
}

test('P2-1：AI 同士の「確実に安全な通過牌」（固定局面）：リーチした AI（席0）の待ち以外でリーチ後に通った牌は危険度 0', () => {
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    const players = [0, 1, 2, 3].map((s) => ({ name: `P${s}`, kind: 'ai', personality: 'speed' }));
    const g = makeGame({ r, hands: [TENPAI, O1, O2, O3], draws: ['0', '=-√3/2', '=-1/√3'], players });
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passClaims(g);
    g.discard(1, g.drawn); // =−√3/2（席0の当たりではない）
    passClaims(g);
    const t = idx('=-√3/2', r);
    assert.ok(!realWaits(g, 0).has(t), '前提：当たりではない');
    assert.ok(passedTiles(g, 2)[0].has(t), `${mode}：AI のリーチ後に通った牌`);
    const view = g.viewFor(2);
    assert.equal(dangerTableV06(g, r, view, unseenCounts(r, view), 2)[0][t], 0);
    assert.ok(!passedTiles(g, 2)[0].has(idx('=1', r)), '通っていない当たり牌は含まない');
  }
});

test('P2-1：席の種類が「AI」と明示された席だけが、ロン・ツモを必ず宣言する前提（通った牌）の対象', () => {
  const rules = rulesOf.math1;
  const players = [{ kind: 'human' }, { kind: 'ai' }, {}, { kind: 'ai' }];
  const g = new Game({ rules, seed: 3, dealer: 0, players });
  assert.deepEqual([0, 1, 2, 3].map((o) => ronGuaranteed(g, o)), [false, true, false, true]);
  // 打牌を進め、人間・種類不明の席の「通った牌」が空のままであることを確認
  const rng = createRng(3);
  const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0 };
  const ids = ['fukuyama', 'kaoru', 'asuma', 'fukuyama'];
  for (let i = 0; i < 40 && g.pending(); i++) {
    const p = g.pending();
    const a = decideCharacter(g, p.seat, ids[p.seat], rng, info, ids);
    if (p.type === 'turn') {
      const passed = passedTiles(g, p.seat);
      for (const o of [0, 2]) assert.equal(passed[o].size, 0);
    }
    applyAction(g, p.seat, a.type === 'ron' || a.type === 'tsumo' ? (p.type === 'turn' ? { type: 'discard', tile: g.drawn } : { type: 'pass' }) : a);
  }
});

test('P2-1：AI 同士では「通った牌」を従来どおり使い、それは実際にも当たりではない（人間が同席していても）', () => {
  let checked = 0;
  for (const mode of ['math1', 'math2']) {
    for (let k = 0; k < (mode === 'math1' ? 8 : 3); k++) {
      const rules = rulesOf[mode];
      const ids = ['ousuke', ...AI];
      const players = [{ name: 'あなた', kind: 'human' }, ...AI.map((id) => ({ name: id, kind: 'ai', personality: 'speed' }))];
      const seed = 52000 + k;
      const g = new Game({ rules, seed, dealer: seed % 4, players });
      const rng = createRng(seed);
      const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: seed % 4, renchan: 0 };
      while (g.pending()) {
        const p = g.pending();
        if (p.type === 'turn' && p.seat !== 0) {
          const passed = passedTiles(g, p.seat);
          assert.equal(passed[0].size, 0, '人間の席に通った牌を作らない');
          for (let o = 1; o < 4; o++) {
            if (o === p.seat) continue;
            const w = realWaits(g, o);
            for (const t of passed[o]) { assert.ok(!w.has(t), `${mode} AI 席${o} の当たり ${t} を通った牌にした`); checked++; }
          }
        }
        applyAction(g, p.seat, decideCharacter(g, p.seat, ids[p.seat], rng, info, ids));
      }
    }
  }
  assert.ok(checked > 100, `確認した AI 同士の通った牌 ${checked}`);
});

test('P2-1 前提の確認：Ver.0.5-E の難易度 AI（初級・中級・上級、3つの性格）も、宣言できるロン・ツモを必ず宣言する', async () => {
  const { decide } = await import('../src/engine/ai.js');
  let rons = 0, tsumos = 0;
  for (const mode of ['math1', 'math2']) {
    const r = rulesOf[mode];
    for (let k = 0; k < (mode === 'math1' ? 24 : 8); k++) {
      const seed = 53000 + k;
      const levels = ['beginner', 'intermediate', 'advanced', ['beginner', 'intermediate', 'advanced'][k % 3]];
      const pers = ['speed', 'value', 'closed', 'speed'];
      const g = new Game({ rules: r, seed, dealer: seed % 4, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
      const rng = createRng(seed);
      const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: seed % 4, renchan: 0 };
      while (g.pending()) {
        const p = g.pending();
        const a = decide(g, p.seat, pers[p.seat], rng, levels[p.seat], info);
        if (p.type === 'turn' && p.canTsumo) { assert.equal(a.type, 'tsumo'); tsumos++; }
        if (p.type === 'claim' && p.ron) { assert.equal(a.type, 'ron'); rons++; }
        applyAction(g, p.seat, a);
      }
    }
  }
  assert.ok(rons > 0 && tsumos > 0, `ロン ${rons}・ツモ ${tsumos}`);
});
