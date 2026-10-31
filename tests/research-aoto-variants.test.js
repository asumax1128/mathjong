// 研究ツール（docs/70）：あおとの改善案4条件。再現性・条件Aが本番と同一・他家の手牌と山を見ない・B と C の規則の正しさ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { BEGINNER_PARAMS } from '../src/engine/character-ai-prototype.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, k } from './helpers.js';
import { playMatch, playRound, summarize, AI4, NOVICE_VARIANTS } from '../tools/research-beginner-loss-diagnostics.mjs';
import { aotoPolicy, callKeepsYaku, callKeepsYakuLegacy, callYakuDistance, callYakuDistanceByHint, keepTenpaiTile, tenpaiDiscardTypes, runCell, runAll, plan, VARIANTS, PLAN_VARIANTS, parseVariant, clusterPairedCI, matchRecords, recordsCSV, t975 } from '../tools/research-aoto-variants.mjs';

const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const R1 = rulesFor('math1');
const players = [0, 1, 2, 3].map(() => ({ kind: 'ai' }));

test('再現性：同じ seed・計画なら4条件とも結果は完全一致', () => {
  const cell = { exp: 'ai4', mode: 'math1', length: 4, seeds: 2, rotations: 4 };
  const strip = (o) => Object.fromEntries(Object.keys(o).map((v) => [v, summarize(o[v].matches)]));
  const opts = { variants: PLAN_VARIANTS };
  assert.equal(hash(strip(runCell(cell, 700001, opts))), hash(strip(runCell(cell, 700001, opts))));
  assert.notEqual(hash(strip(runCell(cell, 700001, opts))), hash(strip(runCell(cell, 700002, opts))));
  assert.deepEqual(PLAN_VARIANTS, ['A', 'B1', 'B2', 'B3', 'C', 'D1', 'D2', 'D3']);
  assert.deepEqual(parseVariant('D3'), { letter: 'D', useB: true, useC: true, maxMissing: 3 });
  assert.deepEqual(parseVariant('B'), { letter: 'B', useB: true, useC: false, maxMissing: 2 });
  const p = plan(1);
  assert.equal(p.length, 12);
  assert.deepEqual([...new Set(p.map((c) => c.length))].sort(), [1, 4, 8]);
  assert.deepEqual([...new Set(p.map((c) => c.mode))].sort(), ['math1', 'math2']);
});

test('条件A は本番のあおとと完全に同じ（差し替えなしの試合と一致）', () => {
  for (const mode of ['math1', 'math2']) for (const length of [1, 4, 8]) {
    const agents = [AI4[1], AI4[2], AI4[3], AI4[0]];
    const base = playMatch({ mode, length, agents, seed: 4242 + length, startDealer: 1 });
    const stats = { callsConsidered: 0, callsBlocked: 0, discardsChecked: 0, discardsReplaced: 0 };
    const a = playMatch({ mode, length, agents, seed: 4242 + length, startDealer: 1, policies: { aoto: aotoPolicy('A', { stats }) } });
    assert.equal(hash(a), hash(base), `${mode} ${length}局戦`);
    assert.deepEqual(stats, { callsConsidered: 0, callsBlocked: 0, discardsChecked: 0, discardsReplaced: 0 });
  }
});

test('本番の係数・判断は変更しない：研究の実行後も BEGINNER_PARAMS は同じ', () => {
  const before = JSON.stringify(BEGINNER_PARAMS);
  runCell({ exp: 'novice', mode: 'math1', length: 1, seeds: 2, rotations: 1 }, 700001);
  assert.equal(JSON.stringify(BEGINNER_PARAMS), before);
});

// 固定局面：席0（親）が =1/2 を捨て、下家（席1・あおと役）がチー sin 30° = 1/2 を選べる
const OTHERS = [['=-√3', '=-√3', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '180', '180'], ['=-√3/2', '=-√3/2', '0', '0', '120', '120', '=1/√2', '=1/√2']];
function chiScene(h1) {
  const hands = [['cos', 'cos', 'tan', 'tan', '60', '60', '135', '135'], h1, ...OTHERS];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  const g = new Game({ rules: R1, seed: 1, dealer: 0, players, presetWall: [...keys, k('=1/2')], ruleset: 2 });
  g.discard(0, g.drawn);
  return g;
}

test('条件B：鳴いた後に役（鳴いても成立する役）が「あと2枚以内」で残る鳴きだけ許可', () => {
  // 許可：チー後 cos 0 = 1 が完成・tan と 45° があり、三関制覇があと1枚（=1）
  const ok = chiScene(['sin', '30', 'cos', '0', '=1', 'tan', '45', '90']);
  const p = ok.pending();
  assert.deepEqual([p.seat, p.chi.length], [1, 1]);
  assert.equal(callKeepsYaku(ok, 1, p, { type: 'chi', option: 0 }), true);
  // 見送り：チー後の手は結果牌だけで、役のある完成形まで3枚以上足りない
  const ng = chiScene(['sin', '30', '=-1', '=-1', '=√3', '=√3', '=0', '=0']);
  const q = ng.pending();
  assert.equal(callKeepsYaku(ng, 1, q, { type: 'chi', option: 0 }), false);
  // 方針：本番がチーを選んでも、役が残らない鳴きは見送る（乱数をチーが選ばれる値に固定して確認）
  const rng = { next: () => 0, int: () => 0, pick: (a) => a[0] };
  const stats = { callsConsidered: 0, callsBlocked: 0, discardsChecked: 0, discardsReplaced: 0 };
  assert.equal(decideCharacter(ng, 1, 'aoto', rng, null, AI4).type, 'chi', '本番はチー');
  assert.deepEqual(aotoPolicy('B', { stats })(ng, q, 1, rng, null, AI4), { type: 'pass' });
  assert.equal(aotoPolicy('B', { stats })(ok, p, 1, rng, null, AI4).type, 'chi');
  assert.deepEqual([stats.callsConsidered, stats.callsBlocked], [2, 1]);
  // 条件C だけでは鳴きは変わらない
  assert.equal(aotoPolicy('C')(ng, q, 1, rng, null, AI4).type, 'chi');
});

test('条件C：聴牌を崩す打牌だけを、聴牌を保つ打牌（見えていない残りが最多）へ差し替える。聴牌にならない局面は本番のまま', () => {
  // 席0：cos 180 = −1・tan 45 = 1・sin・=1/2 ＋ ツモ −√3 → 聴牌になる捨て牌は −√3 だけ（30°・150° 待ち）
  const hands = [['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'], ...OTHERS, ['90', '90', '0', '=0', '=√3', '=√3', '=1/√2', '=1/√2']];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  const g = new Game({ rules: R1, seed: 1, dealer: 0, players, presetWall: [...keys, k('=-√3')], ruleset: 2 });
  const opts = tenpaiDiscardTypes(g, 0);
  assert.deepEqual(opts.map((o) => R1.types[o.type].key), ['v:-√3']);
  const sinId = g.hands[0].find((id) => R1.types[g.typeOf(id)].key === 'f:sin');
  assert.equal(keepTenpaiTile(g, 0, sinId), g.drawn, '聴牌を崩す sin → −√3 に差し替え');
  assert.equal(keepTenpaiTile(g, 0, g.drawn), g.drawn, 'すでに聴牌を保つ打牌はそのまま');
  // 聴牌にならない局面（席1：結果牌ばかり）では本番の打牌のまま
  g.discard(0, g.drawn);
  const p = g.pending();
  if (p.type === 'claim') g.respond(p.seat, { type: 'pass' });
  const s = g.pending().seat;
  assert.equal(tenpaiDiscardTypes(g, s).length, 0);
  assert.equal(keepTenpaiTile(g, s, g.drawn), g.drawn);
});

test('他家の手牌・未来の山を見ない：他家の手牌と山を入れ替えても B・C の判断は同じ', () => {
  let checkedB = 0, checkedC = 0;
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (let seed = 1; seed <= 40; seed++) {
      const g = new Game({ rules, seed, dealer: seed % 4, players, ruleset: 2 });
      const rng = createRng(seed);
      for (let i = 0; i < 200 && g.pending(); i++) {
        const p = g.pending(), s = p.seat;
        if (p.type === 'claim' && (p.chi.length || p.pon)) {
          const call = p.pon ? { type: 'pon' } : { type: 'chi', option: 0 };
          const before = callKeepsYaku(g, s, p, call);
          const o = (s + 1) % 4 === p.from ? (s + 2) % 4 : (s + 1) % 4; // 打牌者でも自分でもない他家
          const save = [g.hands[o].slice(), g.wall.slice()];
          [g.hands[o][0], g.wall[0]] = [g.wall[0], g.hands[o][0]]; g.wall.reverse();
          assert.equal(callKeepsYaku(g, s, p, call), before);
          [g.hands[o], g.wall] = save;
          checkedB++;
        }
        if (p.type === 'turn' && !g.riichi[s]) {
          const t = g.hands[s][0];
          const before = keepTenpaiTile(g, s, t);
          const o = (s + 1) % 4;
          const save = [g.hands[o].slice(), g.wall.slice()];
          [g.hands[o][0], g.wall[0]] = [g.wall[0], g.hands[o][0]]; g.wall.reverse();
          assert.equal(keepTenpaiTile(g, s, t), before);
          [g.hands[o], g.wall] = save;
          checkedC++;
        }
        applyAction(g, s, decideCharacter(g, s, AI4[s], rng, null, AI4));
      }
    }
  }
  assert.ok(checkedB > 20 && checkedC > 500, `${checkedB} / ${checkedC}`);
});

test('全条件・数学Ⅰ/Ⅱ・1/4/8局戦で完走：400点・供託0・試合記録・seed クラスタのペア差（統計的な判定は含めない）', () => {
  const r = runAll({ scale: 0.03, seed0: 700001 });
  assert.equal(Object.keys(r.cells).length, 12);
  for (const [key, c] of Object.entries(r.cells)) {
    for (const v of PLAN_VARIANTS) assert.ok(c[v], `${key} ${v}`);
    for (const v of PLAN_VARIANTS.slice(1)) assert.ok(c.pairedVsA[v].aoto.rank && c.pairedVsA[v].aoto.score);
    if (key.startsWith('novice')) for (const nv of NOVICE_VARIANTS) assert.ok(c.A[nv] && c.pairedVsA.C[nv].rank, `${key} ${nv}`);
    if (key.startsWith('ai4')) {
      assert.equal(c.A.stats.callsConsidered + c.A.stats.discardsChecked, 0, 'A は差し替えなし');
      assert.equal(c.C.stats.callsConsidered, 0, 'C は鳴きを変えない');
      for (const v of ['B1', 'B2', 'B3']) assert.equal(c[v].stats.discardsChecked, 0, 'B は打牌を変えない');
      for (const v of ['C', 'D1', 'D2', 'D3']) { const kt = c[v].agents.aoto.tenpai.keepTenpai; if (kt) assert.equal(kt.rate, 1, `${key} ${v}`); }
      // 鳴き：成立は選択以下（P2-3）
      const ca = c.A.agents.aoto.calls;
      assert.ok(ca.made <= ca.chosen && ca.cancelled === ca.chosen - ca.made);
    }
  }
  // 試合記録：seed・席・親・相手・条件・順位・点（P3）
  const recs = r.records;
  assert.ok(recs.length > 0);
  for (const x of recs) {
    assert.equal(x.seats.length, 4); assert.equal(x.ranks.length, 4); assert.equal(x.scores.reduce((a, b) => a + b, 0), 400);
    assert.ok(Number.isInteger(x.seed) && Number.isInteger(x.startDealer) && PLAN_VARIANTS.includes(x.variant));
    assert.equal(x.aotoSeat, x.seats.indexOf('aoto'));
  }
  const csv = recordsCSV(recs.slice(0, 3));
  assert.match(csv.split('\n')[0], /^cell,variant,index,cluster,seed,startDealer,seat0/);
  assert.equal(csv.trim().split('\n').length, 4);
  assert.doesNotMatch(JSON.stringify(r.definition), /採用する|adopt(ed)?\b/i);
  assert.match(r.definition.note, /採用判断はしない/);
});

// ---- PR #65 監査 P2-1：B の判定（その鳴きだけを適用した仮想局面の独立評価）----
function replayTo(mode, seed, steps) {
  const rules = rulesFor(mode);
  const g = new Game({ rules, seed, dealer: seed % 4, players, ruleset: 2 });
  const rng = createRng(seed);
  for (let i = 0; i < steps; i++) { const p = g.pending(); applyAction(g, p.seat, decideCharacter(g, p.seat, AI4[p.seat], rng, null, AI4)); }
  return g;
}

test('P2-1 固定再現局面：旧判定（yakuCandidates の経路統合）が見送った有効な鳴きを、新判定は許可する（数学Ⅰ・Ⅱ）', () => {
  // tools の全列挙で見つけた局面（数学Ⅰ seed 1 の5手目・数学Ⅱ seed 1 の19手目、どちらもチーの1つ目の選択肢、不足2枚）
  for (const [mode, seed, steps] of [['math1', 1, 5], ['math2', 1, 19]]) {
    const g = replayTo(mode, seed, steps);
    const p = g.pending();
    assert.equal(p.type, 'claim', mode);
    const call = { type: 'chi', option: 0 };
    assert.equal(callYakuDistance(g, p.seat, p, call), 2, `${mode} 不足2枚`);
    assert.equal(callYakuDistanceByHint(g, p.seat, p, call), 2, '独立の検算も2枚');
    assert.equal(callKeepsYaku(g, p.seat, p, call, 2), true, '新判定は許可');
    assert.equal(callKeepsYakuLegacy(g, p.seat, p, call, 2), false, '旧判定は見送り（偽陰性）');
    assert.equal(callKeepsYaku(g, p.seat, p, call, 1), false, '上限1では見送り');
  }
});

test('P2-1 合法な鳴きの候補を全列挙：新判定の不足枚数は独立の検算（鳴いた後の局面を yakuCandidates で評価）と一致。旧判定に偽陽性はない', () => {
  let total = 0, legacyFN = 0;
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (let seed = 1; seed <= (mode === 'math1' ? 40 : 15); seed++) {
      const g = new Game({ rules, seed, dealer: seed % 4, players, ruleset: 2 });
      const rng = createRng(seed);
      for (let i = 0; i < 400 && g.pending(); i++) {
        const p = g.pending();
        if (p.type === 'claim') {
          const calls = [...p.chi.map((_, j) => ({ type: 'chi', option: j })), ...(p.pon ? [{ type: 'pon' }] : [])];
          for (const c of calls) {
            total++;
            const d = callYakuDistance(g, p.seat, p, c);
            assert.equal(d, callYakuDistanceByHint(g, p.seat, p, c), `${mode} seed ${seed} step ${i}`);
            for (const M of [1, 2, 3]) {
              const legacy = callKeepsYakuLegacy(g, p.seat, p, c, M);
              assert.ok(!(legacy && d > M), '旧判定の偽陽性');
              if (!legacy && d <= M) legacyFN++;
              assert.equal(callKeepsYaku(g, p.seat, p, c, M), d <= M);
            }
          }
        }
        applyAction(g, p.seat, decideCharacter(g, p.seat, AI4[p.seat], rng, null, AI4));
      }
    }
  }
  assert.ok(total > 300, `${total}件`);
  assert.ok(legacyFN > 0, '旧判定の偽陰性を検出できる');
});

// ---- PR #65 監査 P2-2：E2 の席ID ----
test('P2-2 E2 の席ID：4席の配列と席順を保ち、代理の席は human。かなたは実際のあおとの席を参照する', () => {
  const seen = [];
  const agents = ['novice-basic', 'mitsuki', 'aoto', 'kanata'];
  const spy = (id) => (g, p, s, rng, info, aiIds) => { seen.push({ id, aiIds: aiIds.slice(), aotoSeat: aiIds.indexOf('aoto') }); return decideCharacter(g, s, id, rng, info, aiIds); };
  const m = playMatch({ mode: 'math1', length: 1, agents, seed: 5151, startDealer: 0, policies: { kanata: spy('kanata'), aoto: spy('aoto') } });
  assert.ok(seen.length > 5);
  for (const x of seen) {
    assert.deepEqual(x.aiIds, ['human', 'mitsuki', 'aoto', 'kanata']);
    assert.equal(x.aotoSeat, 2, 'かなたが読むあおとの席は実際の席');
  }
  // 差し替えのない試合（本番の判断）と同じ結果：spy は判断を変えない
  assert.equal(hash(m), hash(playMatch({ mode: 'math1', length: 1, agents, seed: 5151, startDealer: 0 })));
  // E1（4人とも AI）の席IDは従来と同じ
  const e1 = [];
  playMatch({ mode: 'math1', length: 1, agents: AI4, seed: 5152, startDealer: 0, policies: { kanata: (g, p, s, rng, info, aiIds) => { e1.push(aiIds.slice()); return decideCharacter(g, s, 'kanata', rng, info, aiIds); } } });
  assert.ok(e1.every((x) => x.join() === AI4.join()));
});

// ---- PR #65 監査 P2-3：鳴きの選択と成立 ----
test('P2-3 鳴き：選択（chosen）と成立（made）を分ける。後続のロン（ロン優先）で取り消された鳴きは成立に含めない', () => {
  // 親（席0）が 30° を捨てる。下家（席1）は sin・=1/2 でチーを選ぶが、対面（席2）が 30° でロンする
  const hands = [['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'], ['sin', '=1/2', '=-√3/2', '=-√3/2', '=1/√2', '=1/√2', '135', '135'],
    ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'], ['=0', '=0', '=1/√3', '=1/√3', '120', '120', '60', '60']];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  const decideFor = (g, p, s) => {
    if (p.type === 'claim') return p.ron ? { type: 'ron' } : p.chi.length ? { type: 'chi', option: 0 } : { type: 'pass' };
    return { type: 'discard', tile: g.drawn };
  };
  const out = playRound({ rules: R1, seed: 1, dealer: 0, agents: ['x', 'y', 'z', 'w'], decideFor, info: null, presetWall: [...keys, k('30')] });
  assert.equal(out.g.result.winner, 2);
  const r1 = out.seats[1];
  assert.deepEqual([r1.chiOpp, r1.chiChosen, r1.chiMade, r1.calls], [1, 1, 0, 0], '選んだが成立していない');
  const sum = summarize([{ agents: ['x', 'y', 'z', 'w'], ranks: [1, 1, 1, 1], scores: [100, 100, 100, 100], rounds: [{ ...out.round, deltas: [0, 0, 0, 0], seats: out.seats }] }]);
  assert.deepEqual([sum.agents.y.calls.chosen, sum.agents.y.calls.made, sum.agents.y.calls.cancelled], [1, 0, 1]);
  assert.equal(sum.agents.y.calls.roundsWithCalls.k, 0, '鳴いた局は成立で数える');
});

// ---- PR #65 監査 P3：試合記録と seed クラスタの 95% CI ----
test('P3 seed クラスタのペア差：同じ seed の席替えを1クラスタとして平均し、t 分布の 95% CI', () => {
  const mk = (cluster, seed, ranks, scores) => ({ cluster, seed, seats: ['aoto', 'kanata', 'mitsuki', 'yujin'], aotoSeat: 0, ranks, scores });
  const A = [mk(0, 1, [4, 1, 2, 3], [80, 120, 100, 100]), mk(0, 1, [3, 1, 2, 4], [90, 120, 100, 90]), mk(1, 2, [2, 1, 3, 4], [100, 110, 95, 95])];
  const V = [mk(0, 1, [2, 1, 3, 4], [100, 120, 95, 85]), mk(0, 1, [3, 1, 2, 4], [90, 120, 100, 90]), mk(1, 2, [1, 2, 3, 4], [115, 100, 95, 90])];
  const ci = clusterPairedCI(A, V, 'aoto', 'ranks');
  // クラスタ0：(−2＋0)/2＝−1、クラスタ1：−1 → 平均 −1・sd 0
  assert.deepEqual([ci.clusters, ci.pairs, ci.mean, ci.lo, ci.hi], [2, 3, -1, -1, -1]);
  const sc = clusterPairedCI(A, V, 'aoto', 'scores');
  assert.equal(sc.mean, 12.5); // (10, 15)
  assert.ok(sc.lo < 12.5 && sc.hi > 12.5);
  assert.throws(() => clusterPairedCI(A, [V[1], V[0], V[2]].map((x, i) => (i === 2 ? { ...x, seed: 9 } : x)), 'aoto', 'ranks'), /pair mismatch/);
  assert.ok(Math.abs(t975(30) - 2.042) < 0.01 && t975(4) === 2.776);
  const rec = matchRecords('ai4:math1:1', 'C', [{ agents: AI4, ranks: [1, 2, 3, 4], scores: [130, 100, 90, 80], played: 1, endReason: 'normal', seed: 7, cluster: 0, startDealer: 2 }]);
  assert.deepEqual([rec[0].seed, rec[0].startDealer, rec[0].aotoSeat, rec[0].variant], [7, 2, 2, 'C']);
});
