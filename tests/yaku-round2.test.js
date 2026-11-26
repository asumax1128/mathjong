// エンジン 0.8.0 の役（docs/86）：正負対称（seifu）・補角対（hokaku）・等差三連（tousa）。
// ・数式面子3つの和了だけ（刻子が混じると不成立）・門前限定でない・ruleset 1・2 の Game だけ（従来ルール 0・legacy・AI の評価の既定では数えない）
// ・点数は config の値（暫定）。既存の役と重なれば加算
// ・牌譜：0.8.0 の記録は新しい役込みで再生が一致し、0.7.0 の記録は追加前の数え方で再生できる
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig, ENGINE_VERSION, PRE_ROUND2_YAKU_ENGINE, PAIFU_ENGINE_FEATURES } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { verifyPaifu, replayPaifuRound } from '../src/engine/paifu.js';
import { yakuCandidates } from '../src/engine/yakuhint.js';
import { tenpaiWaitsView } from '../src/ui/waits-view.js';
import { playRecorded } from './paifu-harness.mjs';

const R = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const NEW = ['seifu', 'hokaku', 'tousa'];
const idx = (r, key) => { const m = r.melds.find((x) => x.key === key); assert.ok(m, `面子 ${key}`); return m.idx; };
const ev = (keys, { mode = 'math2', round2 = true, closed = true, rules = R[mode] } = {}) => rules.evaluateMelds(keys.map((k) => idx(rules, k)), closed, { round2 });
const has = (e, id) => e.yaku.some((y) => y.id === id);

test('版と設定：エンジン 0.8.0。点数は config の値（暫定・門前限定でない・数式面子だけ）', () => {
  assert.equal(ENGINE_VERSION, '0.8.0');
  assert.equal(PRE_ROUND2_YAKU_ENGINE, '0.7.0');
  assert.deepEqual({ ...PAIFU_ENGINE_FEATURES['0.7.0'] }, { tsumoIppatsu: true, round2Yaku: false });
  assert.deepEqual({ ...PAIFU_ENGINE_FEATURES['0.8.0'] }, { tsumoIppatsu: true, round2Yaku: true });
  for (const mode of ['math1', 'math2']) {
    const ys = R[mode].config.yaku;
    for (const [id, pts] of [['seifu', 2], ['hokaku', 2], ['tousa', 3]]) {
      const y = ys.find((x) => x.id === id);
      assert.ok(y && y.enabled && y.provisional && y.round2 && y.formulaOnly && !y.closedOnly && y.points === pts, `${mode} ${id}`);
    }
  }
  assert.ok(!makeConfig({ legacy: true }).yaku.some((y) => NEW.includes(y.id)), 'legacy には入れない');
});

test('点数は config の値だけで変わる（コードに点を書いていない）', () => {
  const cfg = makeConfig({ mode: 'math1' });
  for (const y of cfg.yaku) if (y.id === 'seifu') y.points = 7;
  const r = createRules(cfg);
  const e = ev(['sin30=1/2', 'cos120=-1/2', 'tan45=1'], { rules: r });
  assert.equal(e.yaku.find((y) => y.id === 'seifu').points, 7);
});

test('正負対称：+1/2 と −1/2 は成立。0 どうし・同符号・刻子混じりは不成立。厳密値で判定', () => {
  assert.ok(has(ev(['sin30=1/2', 'cos120=-1/2', 'tan45=1']), 'seifu'));
  assert.ok(has(ev(['tan30=1/√3', 'tan150=-1/√3', 'cos0=1']), 'seifu'), '±1/√3（有理化前の表記でも値で判定）');
  assert.ok(has(ev(['sin45=1/√2', 'cos135=-1/√2', 'tan60=√3']), 'seifu'));
  assert.ok(!has(ev(['sin0=0', 'sin180=0', 'tan45=1']), 'seifu'), '0 と 0（v≠0 が条件）');
  assert.ok(!has(ev(['sin0=0', 'cos90=0', 'tan180=0']), 'seifu'));
  assert.ok(!has(ev(['sin30=1/2', 'cos60=1/2', 'tan45=1']), 'seifu'), '同じ符号');
  assert.ok(!has(ev(['sin30=1/2', 'cos150=-√3/2', 'tan45=1']), 'seifu'), '絶対値が違う');
  // 刻子が混じる和了では数えない（数式面子3つの役）
  const r = R.math2;
  const mixed = r.evaluateMelds([idx(r, 'sin30=1/2'), idx(r, 'cos120=-1/2'), idx(r, 'f:tan×3')], true, { round2: true });
  assert.ok(!has(mixed, 'seifu'));
});

test('補角対：30°＋150° は成立。90°＋90°・和が180°でないものは不成立。関数・値は問わない', () => {
  assert.ok(has(ev(['sin30=1/2', 'cos150=-√3/2', 'tan45=1']), 'hokaku'));
  assert.ok(has(ev(['tan45=1', 'sin135=1/√2', 'cos0=1']), 'hokaku'), '45°＋135°（関数が違っても）');
  assert.ok(has(ev(['sin0=0', 'cos180=-1', 'tan45=1']), 'hokaku'), '0°＋180°');
  assert.ok(!has(ev(['sin90=1', 'cos90=0', 'tan45=1']), 'hokaku'), '90°と90°は除く');
  assert.ok(!has(ev(['sin30=1/2', 'cos120=-1/2', 'tan45=1']), 'hokaku'), '30＋120＝150');
  assert.ok(!has(ev(['sin30=1/2', 'cos210=-√3/2', 'tan45=1']), 'hokaku'), '30＋210＝240');
  const r = R.math2;
  assert.ok(!has(r.evaluateMelds([idx(r, 'sin30=1/2'), idx(r, 'cos150=-√3/2'), idx(r, 'f:sin×3')], true, { round2: true }), 'hokaku'), '刻子混じり');
});

test('等差三連：30・60・90 は成立。公差0・等差でない・360°の回り込み（330・0・30）は不成立。300・330・360 は成立', () => {
  assert.ok(has(ev(['sin30=1/2', 'cos60=1/2', 'sin90=1']), 'tousa'));
  assert.ok(has(ev(['sin90=1', 'sin30=1/2', 'cos60=1/2']), 'tousa'), '並びの順に依らない（小さい順に並べる）');
  assert.ok(has(ev(['sin300=-√3/2', 'cos330=√3/2', 'tan360=0']), 'tousa'));
  assert.ok(has(ev(['sin0=0', 'cos90=0', 'sin180=0']), 'tousa'), '0・90・180');
  assert.ok(!has(ev(['sin30=1/2', 'cos30=√3/2', 'tan30=1/√3']), 'tousa'), '公差0');
  assert.ok(!has(ev(['sin30=1/2', 'cos60=1/2', 'tan135=-1']), 'tousa'), '30・60・135');
  assert.ok(!has(ev(['sin330=-1/2', 'cos0=1', 'tan30=1/√3']), 'tousa'), '330・0・30（回り込みは数えない）');
  const r = R.math2;
  assert.ok(!has(r.evaluateMelds([idx(r, 'sin30=1/2'), idx(r, 'cos60=1/2'), idx(r, 'f:cos×3')], true, { round2: true }), 'tousa'), '刻子混じり');
});

test('既存の役と重なると加算（補角対＋三象限巡、正負対称＋三関制覇、補角対＋等差三連）', () => {
  const base = R.math2.config.scoring.base; // 役の点の合計＋基本点
  const sum = (e) => base + e.yaku.reduce((a, y) => a + y.points, 0);
  // 30°（第1）・150°（第2）・240°（第3）：補角対＋三象限巡
  const a = ev(['sin30=1/2', 'cos150=-√3/2', 'tan240=√3']);
  assert.ok(has(a, 'hokaku') && has(a, 'sanshougen'), a.yaku.map((y) => y.id).join(','));
  assert.equal(a.points, sum(a));
  assert.ok(a.points >= base + 2 + 2);
  const b = ev(['sin30=1/2', 'cos120=-1/2', 'tan45=1'], { mode: 'math1' });
  assert.ok(has(b, 'seifu') && has(b, 'sankan'));
  assert.equal(b.points, R.math1.config.scoring.base + 1 + 2);
  // 0・90・180：補角対（0＋180）＋等差三連
  const c = ev(['sin0=0', 'cos90=0', 'sin180=0']);
  assert.ok(has(c, 'hokaku') && has(c, 'tousa'));
  assert.equal(c.points, sum(c));
});

test('ruleset 0・legacy・AI の評価の既定（round2 なし）では数えない。鳴いた手でも成立（門前限定でない）', () => {
  const keys = ['sin30=1/2', 'cos150=-√3/2', 'tan45=1'];
  assert.ok(!has(ev(keys, { round2: false }), 'hokaku'), 'evaluateMelds の既定（AI が直接呼ぶ評価）');
  const r = R.math1;
  assert.ok(!r.evaluateMelds(keys.map((k) => idx(r, k)), true).yaku.some((y) => NEW.includes(y.id)), '引数なし＝数えない');
  assert.ok(has(ev(keys, { closed: false }), 'hokaku'), '鳴いた手');
  const players = [0, 1, 2, 3].map(() => ({ kind: 'ai' }));
  assert.equal(new Game({ rules: r, seed: 1, players, ruleset: 0 }).round2YakuRule, false);
  assert.equal(new Game({ rules: r, seed: 1, players, ruleset: 1 }).round2YakuRule, true);
  assert.equal(new Game({ rules: r, seed: 1, players, ruleset: 2 }).round2YakuRule, true);
  assert.equal(new Game({ rules: r, seed: 1, players, ruleset: 2, round2Yaku: false }).round2YakuRule, false);
  const lg = createRules(makeConfig({ legacy: true }));
  const lk = ['sin30=1/2', 'cos150=-√3/2', 'tan45=1'].filter((k) => lg.melds.some((m) => m.key === k));
  if (lk.length === 3) assert.ok(!lg.evaluateMelds(lk.map((k) => idx(lg, k)), true, { round2: true }).yaku.some((y) => NEW.includes(y.id)));
});

// 鳴いた手（公開面子1つ）で、新しい役だけが役になる待ち：Game の採点・待ちの表示・役ヒントに出る
function openHand(rules) {
  // 公開：sin30=1/2（チー相当）
  const exposed = [idx(rules, 'sin30=1/2')];
  return exposed;
}
test('Game の採点（ruleset 2）：鳴いた手で補角対だけの和了ができる。round2Yaku: false（0.7.0 の数え方）では役なし', () => {
  const r = R.math1;
  const exposed = openHand(r);
  const tiles = ['sin150=1/2', 'tan45=1'].flatMap((k) => r.melds[idx(r, k)].tiles);
  const counts = r.countsOf(tiles);
  const on = r.analyzeWin(counts, exposed, { closed: false, ron: true, round2: true });
  const off = r.analyzeWin(counts, exposed, { closed: false, ron: true, round2: false });
  assert.ok(on && on.yaku.some((y) => y.id === 'hokaku'), '補角対で和了');
  assert.equal(off, null, '既存の役はない（sin・sin・tan、30・150・45）');
});

test('役ヒント（yakuhint）：round2 を渡すと新しい役が候補に出る。渡さなければ出ない', () => {
  const r = R.math1;
  // 門前・手の内9枚：30°・150°・45° の数式が揃った形（補角対が完成）
  const tileIds = (keys) => {
    const types = keys.flatMap((k) => r.melds[idx(r, k)].tiles);
    const used = new Map();
    const tileType = [];
    for (const ty of r.types) for (let c = 0; c < ty.copies; c++) tileType.push(ty.idx);
    return types.map((t) => { const n = used.get(t) || 0; used.set(t, n + 1); let k = -1; let c = 0; for (let i = 0; i < tileType.length; i++) if (tileType[i] === t && c++ === n) { k = i; break; } return { id: k, type: t }; });
  };
  const hand = tileIds(['sin30=1/2', 'cos150=-√3/2', 'tan45=1']);
  const view = { seat: 0, hand, melds: [[], [], [], []], rivers: [[], [], [], []], doraIndicators: [], drawn: null };
  const ids = (c) => c.map((x) => x.id);
  const on = yakuCandidates(r, view, { limit: 20, round2: true });
  const off = yakuCandidates(r, view, { limit: 20 });
  assert.ok(on.some((c) => c.id === 'hokaku'), `候補：${ids(on)}`);
  assert.ok(!off.some((c) => NEW.includes(c.id)), `既定は出さない：${ids(off)}`);
  // 等差三連・正負対称も候補に出る形
  const t2 = yakuCandidates(r, { ...view, hand: tileIds(['sin30=1/2', 'cos60=1/2', 'sin90=1']) }, { limit: 20, round2: true });
  assert.ok(t2.some((c) => c.id === 'tousa'), `候補：${ids(t2)}`);
  const s2 = yakuCandidates(r, { ...view, hand: tileIds(['sin30=1/2', 'cos120=-1/2', 'tan45=1']) }, { limit: 20, round2: true });
  assert.ok(s2.some((c) => c.id === 'seifu'), `候補：${ids(s2)}`);
});

test('牌譜：0.8.0 の記録は新しい役込みで再生（digest・点数・役）が一致し、0.7.0 の記録は追加前の数え方で再生できる', () => {
  let found = null;
  for (let seedBase = 1; seedBase <= 60 && !found; seedBase++) {
    const rec = playRecorded({ mode: 'math1', length: 4, seedBase }).record;
    assert.equal(rec.engineVersion, '0.8.0');
    assert.equal(verifyPaifu(rec).valid, true, `${seedBase}：0.8.0 の記録の再生`);
    for (let i = 0; i < rec.rounds.length; i++) {
      const g = replayPaifuRound(rec, i);
      if (g.result.type !== 'win' || !g.result.analysis.yaku.some((y) => NEW.includes(y.id))) continue;
      assert.equal(g.result.points, rec.rounds[i].result.points, '点数が記録と一致');
      // 版を偽って 0.7.0 として読むと、新しい役のない数え方で再生され、記録と合わず拒否される
      let rejected = false;
      try { verifyPaifu({ ...rec, engineVersion: '0.7.0' }); } catch { rejected = true; }
      assert.ok(rejected, '0.7.0 と偽ると一致しない');
      found = { seedBase, round: i, yaku: g.result.analysis.yaku.map((y) => y.id) };
      break;
    }
  }
  assert.ok(found, '新しい役のある局を含む記録が見つかる');
  // 0.7.0 の記録：追加前の数え方で打って記録し、版の欄を 0.7.0 にする（保存済みの牌譜と同じ形）
  const old = JSON.parse(JSON.stringify(playRecorded({ mode: 'math1', length: 4, seedBase: found.seedBase, round2Yaku: false }).record));
  old.engineVersion = '0.7.0';
  assert.equal(verifyPaifu(old).valid, true, '0.7.0 の記録は旧い点数で再生できる');
  for (let i = 0; i < old.rounds.length; i++) {
    const g = replayPaifuRound(old, i);
    if (g.result.type === 'win') assert.ok(!g.result.analysis.yaku.some((y) => NEW.includes(y.id)), '0.7.0 の再生では新しい役を数えない');
  }
  // 知らない版は拒否
  assert.throws(() => verifyPaifu({ ...old, engineVersion: '0.9.0' }));
});

test('待ちの表示（waits-view）：round2 を渡すと、新しい役だけが役の鳴いた手の待ちが「和了できる」になる', () => {
  const r = R.math1;
  // 公開 sin30=1/2。手の内：sin150=1/2 の3枚＋tan45 の2枚（tan45 の 1 枚待ち）。既存の役はない形
  const all = [];
  for (const ty of r.types) for (let c = 0; c < ty.copies; c++) all.push(ty.idx);
  const take = (types) => { const used = new Set(); return types.map((t) => { const i = all.findIndex((x, k) => x === t && !used.has(k)); used.add(i); return { id: i, type: t }; }); };
  const expTiles = r.melds[idx(r, 'sin30=1/2')].tiles;
  const handTypes = [...r.melds[idx(r, 'sin150=1/2')].tiles, ...r.melds[idx(r, 'tan45=1')].tiles.slice(0, 2)];
  const exp = take(expTiles);
  const hand = take(handTypes).map((h, k) => ({ ...h, id: 200 + k }));
  const view = { seat: 0, hand, melds: [[{ meld: idx(r, 'sin30=1/2'), call: 'chi', tiles: exp.map((x) => x.id), from: 3 }], [], [], []], rivers: [[], [], [], []], doraIndicators: [], drawn: null };
  const on = tenpaiWaitsView(r, view, { round2: true });
  const off = tenpaiWaitsView(r, view, {});
  assert.ok(on && off, '聴牌');
  const missing = r.melds[idx(r, 'tan45=1')].tiles[2];
  const w1 = on.waits.find((w) => w.type === missing);
  const w0 = off.waits.find((w) => w.type === missing);
  assert.ok(w1 && w0);
  assert.equal(w1.winnable, true, 'round2：補角対で和了できる');
  assert.equal(w0.winnable, false, '既定：役なし');
});
