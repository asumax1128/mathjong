// 門前ツモ（+1）・一発（+1）の試験（エンジン 0.7.0・docs/84）。
// ・門前ツモ：門前（公開面子なし。暗カンだけは門前）でのツモ和了（嶺上ツモを含む）。ポン・チーをした手・ロンでは付かない。役満には付けない
// ・一発（天鳳式）：リーチの宣言で開き、その席の次のツモが和了せずに終わった（＝その席が次に打牌した）時点で閉じる。
//   そのツモでのツモ和了・窓の間の他家の打牌へのロンは一発。他家のポン・チー・カンでは閉じない
// ・ruleset 1・2 で有効、従来ルール（0）と、エンジン 0.6.0 の牌譜の再生（tsumoIppatsu:false）では付かない
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig, ENGINE_VERSION, PRE_TSUMO_IPPATSU_ENGINE } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';
import { verifyPaifu } from '../src/engine/paifu.js';
import { playRecorded } from './paifu-harness.mjs';

const RULES = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const IDS = ['tara', 'natsuki', 'yuki', 'kaoru']; // リーチをよくする4人
const players = IDS.map(() => ({ kind: 'ai' }));

// AI 4人で1局を打ち、行動の列を返す（同じ行動を別の設定の Game に当て直すため）
function playRound(mode, seed, opts = {}, ids = IDS) {
  const g = new Game({ rules: RULES[mode], seed, dealer: seed % 4, players, round: 1, ruleset: 2, ...opts });
  const rng = createRng(seed);
  const actions = [];
  while (g.pending()) { const p = g.pending(); const a = decideCharacter(g, p.seat, ids[p.seat], rng, null, ids); actions.push([p.seat, a]); applyAction(g, p.seat, a); }
  return { g, actions };
}
function replay(mode, seed, actions, opts = {}) {
  const g = new Game({ rules: RULES[mode], seed, dealer: seed % 4, players, round: 1, ruleset: 2, ...opts });
  for (const [s, a] of actions) applyAction(g, s, a);
  return g;
}
// 記録だけから求めた「一発の窓」：その席の最後のリーチの宣言の後、その席の打牌が宣言牌の1枚だけ
function ippatsuByEvents(g, seat) {
  const i = g.events.findLastIndex((e) => e.type === 'riichi' && e.seat === seat);
  if (i < 0) return false;
  return g.events.slice(i + 1).filter((e) => e.type === 'discard' && e.seat === seat).length <= 1;
}

test('門前ツモ・一発：AI の対局の全和了で、定義どおりに付き、点は「追加前＋リーチ＋一発＋門前ツモ」（役満を除く）', () => {
  const seen = { menzen: 0, ippatsuTsumo: 0, ippatsuRon: 0, triple: 0, ippatsuAfterCall: 0, ron: 0, riichiNoIppatsu: 0 };
  for (const mode of ['math1', 'math2']) {
    for (let seed = 1; seed <= 30; seed++) {
      const { g, actions } = playRound(mode, seed);
      const r = g.result;
      if (r.type !== 'win') continue;
      const a = r.analysis;
      const w = r.winner;
      const closed = g.melds[w].every((m) => m.call === 'ankan');
      const expectMenzen = !a.yakuman && r.how === 'tsumo' && closed;
      const expectIppatsu = !a.yakuman && !!g.riichi[w] && ippatsuByEvents(g, w);
      const ids = a.yaku.map((y) => y.id);
      assert.equal(ids.includes('menzen-tsumo'), expectMenzen, `${mode}:${seed} 門前ツモ`);
      assert.equal(ids.includes('ippatsu'), expectIppatsu, `${mode}:${seed} 一発`);
      assert.equal(!!a.menzenTsumo, expectMenzen);
      assert.equal(!!a.ippatsu, expectIppatsu);
      if (expectMenzen) assert.equal(a.yaku.find((y) => y.id === 'menzen-tsumo').name, '門前ツモ');
      if (expectIppatsu) assert.equal(a.yaku.find((y) => y.id === 'ippatsu').name, '一発');
      // 同じ行動を「追加前」（エンジン 0.6.0 の数え方）で当て直すと、差は一発＋門前ツモの点だけ。局の進行・記録は同じ
      const old = replay(mode, seed, actions, { tsumoIppatsu: false });
      assert.deepEqual(old.events, g.events, `${mode}:${seed} 進行は同じ`);
      assert.equal(r.points - old.result.points, (expectMenzen ? 1 : 0) + (expectIppatsu ? 1 : 0), `${mode}:${seed} 加点`);
      assert.ok(!old.result.analysis.yaku.some((y) => y.id === 'menzen-tsumo' || y.id === 'ippatsu'));
      if (expectMenzen) seen.menzen++;
      if (expectIppatsu && r.how === 'tsumo') seen.ippatsuTsumo++;
      if (expectIppatsu && r.how === 'ron') seen.ippatsuRon++;
      if (expectIppatsu && expectMenzen && a.riichi) {
        seen.triple++;
        // リーチ一発ツモ：リーチ・一発・門前ツモで +3
        const noRiichi = r.points - (a.riichiBonus || 0) - 2;
        assert.equal(old.result.points - (a.riichiBonus || 0), noRiichi);
      }
      if (expectIppatsu) {
        const i = g.events.findLastIndex((e) => e.type === 'riichi' && e.seat === w);
        if (g.events.slice(i).some((e) => ['pon', 'chi', 'ankan'].includes(e.type) && e.seat !== w)) seen.ippatsuAfterCall++;
      }
      if (r.how === 'ron') seen.ron++;
      if (g.riichi[w] && !expectIppatsu) seen.riichiNoIppatsu++;
    }
  }
  // 各場面が実際に起きている
  for (const [k, v] of Object.entries(seen)) assert.ok(v >= 1, `${k} が起きていない（${JSON.stringify(seen)}）`);
});

test('一発の窓：宣言で開き、その席の次の打牌で閉じる。他家の打牌・ポン・チー・カンでは閉じない（記録だけで決まる）', () => {
  const g = new Game({ rules: RULES.math1, seed: 5, dealer: 0, players, round: 1, ruleset: 2 });
  const ev = (list) => { g.events = [{ type: 'draw', seat: 0 }, ...list]; };
  g.riichi = [{ tile: 1, turn: 1 }, null, null, null];
  ev([{ type: 'riichi', seat: 0, tile: 1 }, { type: 'discard', seat: 0, tile: 1 }]);
  assert.equal(g.ippatsuOpen(0), true, '宣言の直後');
  ev([{ type: 'riichi', seat: 0, tile: 1 }, { type: 'discard', seat: 0, tile: 1 }, { type: 'draw', seat: 1 }, { type: 'discard', seat: 1, tile: 2 },
    { type: 'pon', seat: 3, from: 1, tile: 2 }, { type: 'discard', seat: 3, tile: 4 }, { type: 'chi', seat: 1, from: 3, tile: 4 },
    { type: 'ankan', seat: 2, tiles: [5, 6, 7, 8] }, { type: 'rinshan', seat: 2 }, { type: 'discard', seat: 2, tile: 9 }]);
  assert.equal(g.ippatsuOpen(0), true, '他家の打牌・ポン・チー・カンでは閉じない');
  ev([{ type: 'riichi', seat: 0, tile: 1 }, { type: 'discard', seat: 0, tile: 1 }, { type: 'draw', seat: 1 }, { type: 'discard', seat: 1, tile: 2 },
    { type: 'draw', seat: 0 }]);
  assert.equal(g.ippatsuOpen(0), true, '次のツモ（そのツモでのツモ和了は一発）');
  ev([{ type: 'riichi', seat: 0, tile: 1 }, { type: 'discard', seat: 0, tile: 1 }, { type: 'draw', seat: 0 }, { type: 'discard', seat: 0, tile: 3 }]);
  assert.equal(g.ippatsuOpen(0), false, '次のツモを和了せずに打牌したら閉じる');
  g.riichi = [null, null, null, null];
  ev([{ type: 'discard', seat: 0, tile: 1 }]);
  assert.equal(g.ippatsuOpen(0), false, 'リーチしていなければ一発はない');
});

test('役満・従来ルール（ruleset 0）・追加前の数え方（tsumoIppatsu:false）には付けない', () => {
  const g = new Game({ rules: RULES.math1, seed: 5, dealer: 0, players, round: 1, ruleset: 2 });
  const yakuman = { yakuman: true, yaku: [{ id: 'x', name: '役満', points: 13, yakuman: true }], points: 13 };
  assert.equal(g._withTsumoIppatsu(0, 'tsumo', yakuman), yakuman, '役満には付けない');
  const plain = { yakuman: false, yaku: [], points: 1 };
  const t = g._withTsumoIppatsu(0, 'tsumo', plain);
  assert.equal(t.points, 2);
  assert.deepEqual(t.yaku.map((y) => [y.id, y.name, y.points]), [['menzen-tsumo', '門前ツモ', 1]]);
  assert.equal(g._withTsumoIppatsu(0, 'ron', plain).points, 1, 'ロンに門前ツモは付かない');
  const legacy = new Game({ rules: createRules(makeConfig({ legacy: true })), seed: 5, dealer: 0, players, round: 1, ruleset: 0 });
  assert.equal(legacy._withTsumoIppatsu(0, 'tsumo', plain).points, 1, '従来ルールには付けない');
  const old = new Game({ rules: RULES.math1, seed: 5, dealer: 0, players, round: 1, ruleset: 2, tsumoIppatsu: false });
  assert.equal(old._withTsumoIppatsu(0, 'tsumo', plain).points, 1);
  const r1 = new Game({ rules: RULES.math1, seed: 5, dealer: 0, players, round: 1, ruleset: 1 });
  assert.equal(r1._withTsumoIppatsu(0, 'tsumo', plain).points, 2, 'ruleset 1 でも有効');
});

test('ポン・チーをした手のツモには門前ツモが付かない（暗カンだけの手は付く）', () => {
  let calledFound = 0;
  for (let seed = 1; seed <= 200 && calledFound < 2; seed++) {
    const { g } = playRound('math1', seed, {}, ['aoto', 'aoto', 'aoto', 'aoto']); // 鳴きの多い打ち手
    const r = g.result;
    if (r.type !== 'win' || r.how !== 'tsumo') continue;
    const called = g.melds[r.winner].some((m) => m.call === 'pon' || m.call === 'chi');
    if (!called) continue;
    calledFound++;
    assert.ok(!r.analysis.yaku.some((y) => y.id === 'menzen-tsumo'), `seed ${seed}`);
  }
  assert.ok(calledFound >= 1, '鳴いた手のツモ和了が見つかる');
});

test('牌譜：新しい版の記録は再生で digest・結果・精算が一致し、エンジン 0.6.0 の記録は追加前の数え方で再生できる', () => {
  assert.ok(['0.7.0', '0.8.0'].includes(ENGINE_VERSION));
  const fresh = playRecorded({ mode: 'math1', length: 1, seedBase: 2468 });
  assert.equal(fresh.record.engineVersion, ENGINE_VERSION);
  assert.equal(verifyPaifu(fresh.record).valid, true);
  // 古い版（0.6.0）の記録を作る：追加前の数え方で打って記録し、版の欄を 0.6.0 にする（保存済みの牌譜と同じ形）
  let found = null;
  for (let seedBase = 1; seedBase <= 40; seedBase++) {
    const rec = playRecorded({ mode: 'math1', length: 1, seedBase, tsumoIppatsu: false, round2Yaku: false }); // 0.6.0 は 0.8.0 の役もない
    const old = JSON.parse(JSON.stringify(rec.record));
    old.engineVersion = PRE_TSUMO_IPPATSU_ENGINE;
    assert.equal(verifyPaifu(old).valid, true, `${seedBase}：0.6.0 の記録は追加前の数え方で再生できる`);
    // 門前ツモ・一発のある局を含むなら、版を偽って今の版として読むと点が合わず拒否される（版で数え方を分けている証拠）
    const relabeled = { ...old, engineVersion: ENGINE_VERSION };
    let rejected = false;
    try { verifyPaifu(relabeled); } catch { rejected = true; }
    if (rejected) { found = seedBase; break; }
  }
  assert.ok(found !== null, '門前ツモ・一発のある古い記録で、版の違いが結果に効くことを確かめた');
});
