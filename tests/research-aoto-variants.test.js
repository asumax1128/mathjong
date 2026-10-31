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
import { playMatch, summarize, AI4 } from '../tools/research-beginner-loss-diagnostics.mjs';
import { aotoPolicy, callKeepsYaku, keepTenpaiTile, tenpaiDiscardTypes, runCell, runAll, plan, VARIANTS } from '../tools/research-aoto-variants.mjs';

const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const R1 = rulesFor('math1');
const players = [0, 1, 2, 3].map(() => ({ kind: 'ai' }));

test('再現性：同じ seed・計画なら4条件とも結果は完全一致', () => {
  const cell = { exp: 'ai4', mode: 'math1', length: 4, seeds: 2, rotations: 4 };
  const strip = (o) => Object.fromEntries(VARIANTS.map((v) => [v, summarize(o[v].matches)]));
  assert.equal(hash(strip(runCell(cell, 700001))), hash(strip(runCell(cell, 700001))));
  assert.notEqual(hash(strip(runCell(cell, 700001))), hash(strip(runCell(cell, 700002))));
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

test('全条件・数学Ⅰ/Ⅱ・1/4/8局戦で完走：400点・供託0・JSON の形（統計的な判定は含めない）', () => {
  const r = runAll({ scale: 0.04, seed0: 700001 });
  assert.equal(Object.keys(r.cells).length, 12);
  for (const [key, c] of Object.entries(r.cells)) {
    for (const v of VARIANTS) assert.ok(c[v], `${key} ${v}`);
    assert.ok(c.pairedVsA.aoto.B && c.pairedVsA.aoto.C && c.pairedVsA.aoto.D);
    if (key.startsWith('ai4')) {
      assert.equal(c.A.stats.callsConsidered + c.A.stats.discardsChecked, 0, 'A は差し替えなし');
      assert.equal(c.C.stats.callsConsidered, 0, 'C は鳴きを変えない');
      assert.equal(c.B.stats.discardsChecked, 0, 'B は打牌を変えない');
      // C・D では、あおとが聴牌を保てる場面で必ず保つ
      for (const v of ['C', 'D']) { const kt = c[v].agents.aoto.tenpai.keepTenpai; if (kt) assert.equal(kt.rate, 1, `${key} ${v}`); }
    }
  }
  assert.doesNotMatch(JSON.stringify(r.definition), /採用する|adopt(ed)?\b/i);
  assert.match(r.definition.note, /採用判断はしない/);
});
