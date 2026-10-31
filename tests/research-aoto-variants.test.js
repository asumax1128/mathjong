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
import { aotoPolicy, callKeepsYaku, callKeepsYakuLegacy, callYakuDistance, callYakuDistanceByHint, yakuDistanceAfterCall, yakuDistanceAfterCallClamped, keepTenpaiTile, tenpaiDiscardTypes, runCell, runAll, plan, VARIANTS, PLAN_VARIANTS, parseVariant, clusterPairedCI, matchRecords, recordsCSV, t975, validateCellRecords, cellSeed } from '../tools/research-aoto-variants.mjs';

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

// ---- PR #65 監査2回目 P2：鳴いた後の必ず1枚捨てる打牌と、枯渇した牌（残り0枚） ----
// 独立の参照実装：不足枚数を数えず、見えていない牌から n 枚（n＝1,2,3）を引く全ての多重集合と、全ての捨て牌について、
// 「残りの手牌＋引いた牌」が役のある面子の組合せ（公開面子と合わせて3面子）を含むかを直接調べる。max(1, …) は使わない。
function bruteDistance(rules, st, maxN = 3) {
  const k = 3 - st.exposed.length;
  const M = rules.melds;
  const combos = [];
  const pick = (start, chosen) => {
    if (chosen.length === k) { if (rules.evaluateMelds([...st.exposed, ...chosen], false).hasYaku) combos.push(chosen.slice()); return; }
    for (let i = start; i < M.length; i++) { chosen.push(i); pick(i, chosen); chosen.pop(); }
  };
  pick(0, []);
  const need = combos.map((c) => { const r = new Array(rules.types.length).fill(0); for (const i of c) for (const t of M[i].tiles) r[t]++; return r; });
  const contains = (h) => need.some((r) => r.every((n, t) => n <= h[t]));
  const T = rules.types.length;
  const draws = new Array(T).fill(0);
  const discards = st.counts.map((n, t) => (n > 0 ? t : -1)).filter((t) => t >= 0);
  for (let n = 1; n <= maxN; n++) {
    let hit = false;
    const rec = (start, left) => {
      if (hit) return;
      if (left === 0) {
        for (const d of discards) {
          const h = st.counts.map((c, t) => c - (t === d ? 1 : 0) + draws[t]);
          if (contains(h)) { hit = true; return; }
        }
        return;
      }
      for (let t = start; t < T && !hit; t++) {
        if (draws[t] >= Math.max(0, st.unseen[t])) continue;
        draws[t]++; rec(t, left - 1); draws[t]--;
      }
    };
    rec(0, n);
    if (hit) return n;
  }
  return Infinity;
}
// 公開面子 a・手牌の面子 b, c（役あり）で、手牌の牌の種類が全て残り0枚の局面
function exhaustedScene(rules, a, b, c, extraZero = []) {
  const M = rules.melds;
  const counts = new Array(rules.types.length).fill(0);
  for (const t of [...M[b].tiles, ...M[c].tiles]) counts[t]++;
  const unseen = rules.types.map((ty) => ty.copies);
  for (const t of [...M[a].tiles, ...M[b].tiles, ...M[c].tiles]) unseen[t]--;
  for (let t = 0; t < counts.length; t++) if (counts[t] > 0) unseen[t] = 0;
  for (const t of extraZero) unseen[t] = 0; // ほかに残り0枚の牌の種類
  return { counts, exposed: [a], unseen };
}

test('監査2回目 P2 固定反例：鳴いた後の打牌で枯渇牌を引き直す形は距離1ではない（数学Ⅰ・Ⅱ）', () => {
  // 手牌の6枚がちょうど役のある2面子だが、手牌の牌の種類は全て残り0枚。鳴いた後に1枚捨てると、その牌は引き直せない。
  for (const [mode, a, b, c] of [['math1', 0, 0, 25], ['math2', 0, 1, 12]]) {
    const rules = rulesFor(mode);
    assert.equal(rules.evaluateMelds([a, b, c], false).hasYaku, true);
    const st = exhaustedScene(rules, a, b, c);
    assert.equal(yakuDistanceAfterCallClamped(rules, st), 1, `${mode} 旧（max(1, 不足)）は距離1と誤る`);
    const nw = yakuDistanceAfterCall(rules, st);
    assert.equal(nw.distance, 2, `${mode} 捨て牌ごとに数え直すと2枚`);
    assert.equal(bruteDistance(rules, st), 2, `${mode} 独立の参照実装も2枚`);
    assert.ok(nw.distance > 1, '上限1（B1・D1）では見送る');
    // 枯渇していなければ（捨てた牌が残っていれば）距離1
    const st2 = { ...st, unseen: rules.types.map((ty) => ty.copies) };
    assert.equal(yakuDistanceAfterCall(rules, st2).distance, 1);
    assert.equal(bruteDistance(rules, st2), 1);
  }
  // 「実際は距離3」の型：手牌の牌の種類に加え、ほかの多くの種類も残り0枚（旧方式は距離1）
  for (const [mode, a, b, c, extra] of [
    ['math1', 28, 31, 34, [4, 6, 7, 9, 10, 11, 13, 14, 15, 19, 20, 21, 22, 24]],
    ['math2', 80, 72, 68, [3, 4, 6, 7, 9, 11, 14, 20, 21, 24, 25, 27, 29, 31]],
  ]) {
    const rules = rulesFor(mode);
    assert.equal(rules.evaluateMelds([a, b, c], false).hasYaku, true);
    const st = exhaustedScene(rules, a, b, c, extra);
    assert.equal(yakuDistanceAfterCallClamped(rules, st), 1, `${mode} 旧は距離1`);
    assert.equal(yakuDistanceAfterCall(rules, st).distance, 3, `${mode} 新は距離3`);
    assert.equal(bruteDistance(rules, st), 3, `${mode} 独立の参照実装も3`);
    // B1・B2 は見送り、B3 は許可
    for (const [N, ok] of [[1, false], [2, false], [3, true]]) assert.equal(yakuDistanceAfterCall(rules, st).distance <= N, ok);
  }
});

test('監査2回目 P2：ランダムな局面（一部の牌を枯渇）で、新判定の距離は独立の参照実装と一致する（数学Ⅰ・Ⅱ）', () => {
  let checked = 0, finite = 0, clampDiff = 0;
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    const M = rules.melds;
    const rng = createRng(mode === 'math1' ? 4242 : 4343);
    const ri = (n) => rng.int(n);
    for (let trial = 0; trial < 40; trial++) {
      const a = ri(M.length);
      // 手牌6枚：役のある面子の牌を一部入れ替えた形
      const b = ri(M.length), c = ri(M.length);
      const counts = new Array(rules.types.length).fill(0);
      const tiles = [...M[b].tiles, ...M[c].tiles];
      for (let j = 0; j < ri(3); j++) tiles[ri(6)] = ri(rules.types.length);
      for (const t of tiles) counts[t]++;
      const unseen = rules.types.map((ty) => ty.copies);
      for (const t of [...M[a].tiles, ...tiles]) unseen[t]--;
      if (unseen.some((u) => u < 0)) continue;
      for (let t = 0; t < unseen.length; t++) if (rng.next() < 0.35) unseen[t] = 0; // 枯渇
      const st = { counts, exposed: [a], unseen };
      const d = yakuDistanceAfterCall(rules, st).distance;
      const bd = bruteDistance(rules, st, 3);
      assert.equal(Math.min(d, 4), Math.min(bd, 4), `${mode} trial ${trial}`);
      assert.ok(d >= 1);
      if (yakuDistanceAfterCallClamped(rules, st) !== d) clampDiff++;
      checked++;
      if (d <= 3) finite++;
    }
  }
  assert.ok(checked >= 60 && finite >= 30, `${checked}件・距離3以内 ${finite}件`);
  assert.ok(clampDiff >= 1, '旧（max(1, 不足)）との違いを含む');
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
  const mk = (variant, index, cluster, seed, ranks, scores) => ({ cell: 'ai4:math1:1', variant, index, cluster, seed, startDealer: seed % 4, seats: ['aoto', 'kanata', 'mitsuki', 'yujin'], aotoSeat: 0, novice: null, ranks, scores });
  const A = [mk('A', 0, 0, 1, [4, 1, 2, 3], [80, 120, 100, 100]), mk('A', 1, 0, 1, [3, 1, 2, 4], [90, 120, 100, 90]), mk('A', 2, 1, 2, [2, 1, 3, 4], [100, 110, 95, 95])];
  const V = [mk('C', 0, 0, 1, [2, 1, 3, 4], [100, 120, 95, 85]), mk('C', 1, 0, 1, [3, 1, 2, 4], [90, 120, 100, 90]), mk('C', 2, 1, 2, [1, 2, 3, 4], [115, 100, 95, 90])];
  const ci = clusterPairedCI(A, V, 'aoto', 'ranks');
  // クラスタ0：(−2＋0)/2＝−1、クラスタ1：−1 → 平均 −1・sd 0
  assert.deepEqual([ci.clusters, ci.pairs, ci.mean, ci.lo, ci.hi], [2, 3, -1, -1, -1]);
  const sc = clusterPairedCI(A, V, 'aoto', 'scores');
  assert.equal(sc.mean, 12.5); // (10, 15)
  assert.ok(sc.lo < 12.5 && sc.hi > 12.5);
  // 監査2回目 P3：キー（cell・index）で厳密に対応させる。並び順が違っても同じ結果
  assert.deepEqual(clusterPairedCI(A, [V[2], V[0], V[1]], 'aoto', 'ranks'), ci);
  const bad = (vs, as = A) => assert.throws(() => clusterPairedCI(as, vs, 'aoto', 'ranks'), /pair mismatch/);
  bad(V.map((x, i) => (i === 2 ? { ...x, seed: 9 } : x)));            // seed
  bad(V.map((x, i) => (i === 2 ? { ...x, startDealer: 3 } : x)));     // 親
  bad(V.map((x, i) => (i === 2 ? { ...x, cluster: 0 } : x)));         // クラスタ
  bad(V.map((x, i) => (i === 2 ? { ...x, cell: 'ai4:math1:4' } : x))); // セル
  bad(V.map((x, i) => (i === 2 ? { ...x, seats: ['aoto', 'mitsuki', 'kanata', 'yujin'] } : x))); // 席
  bad(V.map((x, i) => (i === 2 ? { ...x, aotoSeat: 1 } : x)));        // あおとの席
  bad(V.map((x, i) => (i === 2 ? { ...x, novice: 'novice-basic' } : x))); // 代理の版
  bad(V.slice(0, 2));                                                  // V 側の欠行
  bad(V, A.slice(0, 2));                                               // A 側の欠行
  bad([...V, V[1]]);                                                   // 重複
  bad(V.map((x, i) => (i === 1 ? { ...x, variant: 'D2' } : x)));      // V 側の条件の混在
  bad(V, A.map((x) => ({ ...x, variant: 'B1' })));                     // A 側が条件A でない
  assert.throws(() => clusterPairedCI(A, V, 'aoto', 'ranks', { expected: 4 }), /expected 4/); // 件数不足
  assert.equal(clusterPairedCI(A, V, 'aoto', 'ranks', { expected: 3 }).pairs, 3);
  assert.ok(Math.abs(t975(30) - 2.042) < 0.01 && t975(4) === 2.776);
  const rec = matchRecords('ai4:math1:1', 'C', [{ agents: AI4, ranks: [1, 2, 3, 4], scores: [130, 100, 90, 80], played: 1, endReason: 'normal', seed: 7, cluster: 0, startDealer: 2 }]);
  assert.deepEqual([rec[0].seed, rec[0].startDealer, rec[0].aotoSeat, rec[0].variant], [7, 2, 2, 'C']);
});

test('監査2回目 P3：セルの試合記録の検査（件数・連番・クラスタ・seed・親・席＝対戦相手）。実データ（runCell）で合格し、改変は例外', () => {
  for (const exp of ['ai4', 'novice']) {
    const cell = { exp, mode: 'math1', length: 1, seeds: 2, rotations: exp === 'ai4' ? 4 : 1 };
    const key = `${exp}:math1:1`;
    const out = runCell(cell, 123, { variants: ['A', 'C'] });
    const recA = matchRecords(key, 'A', out.A.matches), recC = matchRecords(key, 'C', out.C.matches);
    assert.equal(validateCellRecords(recA, cell, 123, key), true);
    assert.equal(validateCellRecords(recC, cell, 123, key), true);
    assert.equal(recA[5].seed, cellSeed(cell, 123, 1));
    assert.equal(clusterPairedCI(recA, recC, 'aoto', 'ranks', { expected: 8 }).clusters, 2);
    const bad = (f) => { const r = recC.map((x) => ({ ...x, seats: x.seats.slice() })); f(r); assert.throws(() => validateCellRecords(r, cell, 123, key), /records:/); };
    bad((r) => r.pop());                                   // 件数不足
    bad((r) => { r[3].index = 2; });                       // 連番・重複
    bad((r) => { r[4].cluster = 0; });                     // クラスタ
    bad((r) => { r[4].seed += 1; });                       // seed
    bad((r) => { r[4].startDealer = 3; });                 // 親
    bad((r) => { r[1].seats.reverse(); });                 // 席・対戦相手
    bad((r) => { r[2].cell = 'ai4:math2:1'; });            // セル
    bad((r) => { r[2].aotoSeat = (r[2].aotoSeat + 1) % 4; }); // あおとの席
  }
});
