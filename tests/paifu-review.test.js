// 牌譜の振り返り（第2段階・docs/77）：検証済みの牌譜から作る各時点の「自分の視点」（src/ui/paifu-review.js）。
// ・各時点の表示は、独立に再生した同じ時点の Game.viewFor(自分) の手牌・公開情報と一致する
// ・他家の手牌の中身・山・王牌の未公開の牌を入れ替えても、表示は変わらない（＝秘密の情報に依存しない）
// ・他家の見送り・未確定の鳴きは独立した時点にしない。値に牌の id・山・記録を含めない
// ・局の終わりだけ結果と精算。改ざんされた記録は再生しない
import test from 'node:test';
import assert from 'node:assert/strict';
import { playRecorded } from './paifu-harness.mjs';
import { replayPaifuRound, decodePaifu, encodePaifu, verifyPaifu, newRoundGame } from '../src/engine/paifu.js';
import { applyAction } from '../src/engine/ai.js';
import { createReviewSession, publicSummary, entryFromIndex, humanSeatOf, projectForTest } from '../src/ui/paifu-review.js';
import { potTotal, applyRoundResult } from '../src/engine/match.js';
import { MAX_ROUND } from '../src/ui/params.js';

// 様々な局面を含む記録（数学Ⅰ・Ⅱ × 1/4/8局戦、途中退出）
const CASES = [];
for (const mode of ['math1', 'math2']) for (const length of [1, 4, 8]) for (const k of [0, 1]) CASES.push({ mode, length, seedBase: 4000 + length * 31 + k * 977 + (mode === 'math2' ? 50000 : 0) });
const RECORDS = CASES.map((c) => ({ ...c, record: decodePaifu(encodePaifu(playRecorded({ ...c, id: `rv-${c.mode}-${c.length}-${c.seedBase}` }).record)) }));
const ABORTED = decodePaifu(encodePaifu(playRecorded({ mode: 'math1', length: 4, seedBase: 4242, stopAfterSteps: 150, id: 'rv-ab' }).record));
const OPEN = decodePaifu(encodePaifu(playRecorded({ mode: 'math2', length: 4, seedBase: 4343, stopAfterSteps: 90, leaveOpen: true, id: 'rv-open' }).record));

// 手順の中で「時点」になるもの（独立に求める）：行動の後が安定した点（局の終わり・誰かの手番・自分の判断）で、
// 前の時点から公開の出来事が増えたか自分の行動があったもの。他家の鳴き・ロンの判断待ちの間は時点にしない
function visibleSteps(p, ri, me) {
  const out = [0];
  const r = p.rounds[ri];
  const g = newRoundGame(p, r.round, r.dealer);
  let seen = g.events.length, mine = false;
  r.steps.forEach((s, i) => {
    applyAction(g, s.seat, s.action);
    if (s.seat === me) mine = true;
    const q = g.pending();
    if ((!q || q.type === 'turn' || q.seat === me) && (mine || g.events.length > seen)) { out.push(i + 1); seen = g.events.length; mine = false; }
  });
  // 未精算の局：最後の行動の後を終わりの時点にする（他家の判断待ちで終わっていても、すでに公開された出来事まで）
  if (r.settlement === null && (mine || g.events.length > seen)) out.push(r.steps.length);
  return out;
}
const sortN = (a) => a.slice().sort((x, y) => x - y);
// 独立の再生（振り返りのモジュールを使わない）：局の各手の後の Game を順に返す。最初と最後は replayPaifuRound と照合
function* statesOf(p, ri) {
  const r = p.rounds[ri];
  const g = newRoundGame(p, r.round, r.dealer);
  yield [0, g];
  for (let i = 0; i < r.steps.length; i++) { applyAction(g, r.steps[i].seat, r.steps[i].action); yield [i + 1, g]; }
}

test('各時点の表示は、独立に再生した同じ時点の Game.viewFor(自分) の手牌・公開情報と一致する（数学Ⅰ・Ⅱ × 1/4/8局戦）', () => {
  let frames = 0;
  for (const { record: p, mode } of RECORDS) {
    const me = humanSeatOf(p);
    const s = createReviewSession(p);
    for (let ri = 0; ri < p.rounds.length; ri++) {
      const fs = s.frames(ri);
      const vis = visibleSteps(p, ri, me);
      assert.equal(fs.length, vis.length, `局 ${ri}：時点の数`);
      const at = new Map();
      for (const [n, g] of statesOf(p, ri)) if (vis.includes(n)) at.set(n, { v: g.viewFor(me), proj: projectForTest(g, me, p.rounds[ri].matchBefore, p.settings.mode) });
      if (ri === 0) assert.equal(JSON.stringify(replayPaifuRound(p, 0, vis.at(-1)).viewFor(me)), JSON.stringify(at.get(vis.at(-1)).v), '独立の再生は検証済みの再生と同じ');
      fs.forEach((f, k) => {
        const { v, proj } = at.get(vis[k]);
        assert.deepEqual(sortN([...f.hand, ...(f.drawn === null ? [] : [f.drawn])]), sortN(v.hand.map((x) => x.type)), '自分の手牌');
        assert.deepEqual(f.rivers.map((r) => r.map((x) => x.tile)), v.rivers, '河');
        assert.deepEqual(f.handCounts, v.handCounts, '手牌の枚数');
        assert.deepEqual(f.melds.map((ms) => ms.map((m) => m.tiles)), v.melds.map((ms) => ms.map((m) => m.tiles)), '公開面子');
        assert.deepEqual(f.dora, v.doraIndicators, 'ドラ表示牌');
        assert.deepEqual([f.wallCount, f.dealer, f.riichi], [v.wallCount, v.dealer, v.riichi]);
        if (mode === 'math2') assert.deepEqual(f.normalDraws, v.normalDraws);
        // 表示の値は、その時点の Game だけから作った値と同じ（後の情報を含まない）。結果は局の終わりだけ
        const lastK = k === fs.length - 1, settled = p.rounds[ri].settlement !== null;
        const { result, index, mine, events, cut, pending, scores, pot, ...rest } = f;
        const { result: r0, index: i0, mine: m0, events: e0, cut: c0, pending: p0, scores: s0, pot: t0, ...fresh } = proj;
        assert.deepEqual(rest, fresh, `局 ${ri} 時点 ${k}`);
        assert.equal(result !== null, lastK && settled, '結果は精算した局の最後の時点だけ');
        assert.equal(cut, lastK && !settled, '未精算の局の最後だけ cut');
        assert.deepEqual(pending, cut ? null : p0, '判断者（cut の時点は出さない）');
        if (lastK && settled) {
          // 精算した局の最後：席・供託は精算の後（独立の applyRoundResult と一致）
          const g = replayPaifuRound(p, ri);
          const after = applyRoundResult(p.rounds[ri].matchBefore, g.result, { round: p.rounds[ri].round, maxRound: MAX_ROUND, riichi: g.riichi });
          assert.deepEqual([scores, pot], [after.scores, potTotal(after)], `局 ${ri} の精算の後の持ち点・供託`);
          assert.deepEqual([result.scoresAfter, result.potAfter], [after.scores, potTotal(after)]);
        } else assert.deepEqual([scores, pot], [s0, t0], '局の途中は精算の前（宣言料を引いた値）');
        frames++;
      });
    }
  }
  assert.ok(frames > 2000, `時点 ${frames}`);
});

test('他家の手牌・山・王牌の未公開の牌を入れ替えても表示は変わらない（秘密の情報に依存しない）', () => {
  let checked = 0;
  for (const { record: p } of RECORDS.slice(0, 6)) {
    const me = humanSeatOf(p);
    for (let ri = 0; ri < p.rounds.length; ri++) {
      const vis = visibleSteps(p, ri, me);
      const pick = new Set(vis.filter((_, i) => i % 7 === 0));
      for (const [k, g] of statesOf(p, ri)) {
        if (!pick.has(k)) continue;
        if (g.phase === 'ended') continue; // 終局後の結果は和了者の手を公開する（別のテスト）
        const before = JSON.stringify(projectForTest(g, me, p.rounds[ri].matchBefore, p.settings.mode));
        // 他家の手牌の牌と山の牌を入れ替える（枚数は同じ・種類は変わる）
        const swaps = [];
        for (const s of [0, 1, 2, 3].filter((x) => x !== me)) {
          for (let i = 0; i < g.hands[s].length && g.wall.length; i += 2) {
            const j = (i * 7 + s * 13) % g.wall.length;
            [g.hands[s][i], g.wall[j]] = [g.wall[j], g.hands[s][i]];
            swaps.push([s, i, j]);
          }
        }
        const after = JSON.stringify(projectForTest(g, me, p.rounds[ri].matchBefore, p.settings.mode));
        for (const [s, i, j] of swaps.reverse()) [g.hands[s][i], g.wall[j]] = [g.wall[j], g.hands[s][i]];
        assert.equal(after, before, `局 ${ri} 手 ${k}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `確認 ${checked}`);
});

test('値の形：牌の id・山・記録・他家の手牌の中身を含まない（キーの許可リスト）。凍結されている', () => {
  const allowed = new Set(['index', 'mine', 'events', 'pending', 'hand', 'drawn', 'handCounts', 'melds', 'rivers', 'riichi', 'dealer', 'wallCount', 'dora',
    'normalDraws', 'scores', 'pot', 'self', 'result', 'cut']);
  const p = RECORDS.find((x) => x.length === 8).record;
  const s = createReviewSession(p);
  for (let ri = 0; ri < p.rounds.length; ri++) {
    for (const f of s.frames(ri)) {
      assert.ok(Object.isFrozen(f) && Object.isFrozen(f.hand) && Object.isFrozen(f.rivers));
      assert.deepEqual(Object.keys(f).filter((k) => !allowed.has(k)), []);
      const j = JSON.stringify(f);
      assert.doesNotMatch(j, /"(id|ids|wall|hands|steps|digest|seed|deadWall|rinshan|pairs|riichiWaits|tempFuriten|discarded|claim|seedBase)":/, "秘密・内部の項目（キー）");
      if (f.result && f.result.win) assert.deepEqual(Object.keys(f.result.win).sort(), ['base', 'doraBonus', 'exposed', 'from', 'hand', 'how', 'kind', 'melds', 'points', 'riichi', 'riichiBonus', 'special', 'tile', 'winner', 'yaku', 'yakuman']);
    }
  }
  // 窓口の値に記録そのものを含めない
  const j = JSON.stringify(s.info);
  assert.doesNotMatch(j, /"(rounds|steps|digest|seedBase|initialMatch|settlement)":[\[{"]/, "記録の本文・内部の項目を含めない");
  assert.deepEqual(Object.keys(s).sort(), ['frames', 'framesAsync', 'info']);
});

test('他家の見送り・未確定の鳴き・他家の判断待ちは時点にしない（他家が鳴けたかを示さない）。自分の見送り（自動パスを含む）は時点にする', () => {
  let hidden = 0, myPass = 0;
  for (const { record: p } of RECORDS) {
    const me = humanSeatOf(p);
    const s = createReviewSession(p);
    for (let ri = 0; ri < p.rounds.length; ri++) {
      const fs = s.frames(ri);
      hidden += p.rounds[ri].steps.length - (visibleSteps(p, ri, me).length - 1);
      // 時点は安定した点だけ：局の終わり以外は、誰かの手番か自分の判断（他家の判断待ちで止まらない）
      fs.forEach((f, k) => { if (k !== fs.length - 1) assert.ok(f.pending, `局 ${ri} 時点 ${k}：判断者なし`); });
      // 打牌の後は、同じ時点の中で次の出来事（ツモ・鳴き・和了・流局）まで進んでいる（自分の判断待ちを除く）
      for (const f of fs) { const last = f.events.at(-1); if (!f.cut && last && last.type === 'discard' && !(f.pending && f.pending.type === 'claim')) assert.fail(`打牌で止まった時点 ${JSON.stringify(f.events)}`); }
      myPass += fs.filter((f) => f.mine && f.mine.type === 'pass').length;
      // 他家の判断待ち（鳴き・ロン）は表示しない
      for (const f of fs) if (f.pending) assert.ok(f.pending.type === 'turn' || f.pending.seat === me);
      // 公開の出来事に他家の見送りは出ない
      for (const f of fs) for (const e of f.events) assert.notEqual(e.type, 'pass');
    }
  }
  assert.ok(hidden > 0 && myPass > 0, `隠した手 ${hidden}・自分の見送り ${myPass}`);
});

test('局面の網羅：リーチ・ポン・チー・暗カン・フリテン・ロン・ツモ・流局（山切れ・数学Ⅱの24回）・供託と点数の変動・連荘', () => {
  const seen = { riichi: 0, pon: 0, chi: 0, ankan: 0, furiten: 0, ron: 0, tsumo: 0, draw: 0, pot: 0, renchan: 0, potWon: 0 };
  const more = [];
  for (let k = 0; k < 10; k++) for (const mode of ['math1', 'math2']) more.push(decodePaifu(encodePaifu(playRecorded({ mode, length: 8, seedBase: 6100 + k * 41 + (mode === 'math2' ? 7 : 0), id: `cov-${k}-${mode}` }).record)));
  for (const p of [...RECORDS.map((x) => x.record), ...more]) {
    const s = createReviewSession(p);
    for (let ri = 0; ri < p.rounds.length; ri++) {
      if (s.info.roundList[ri].renchan) seen.renchan++;
      for (const f of s.frames(ri)) {
        for (const e of f.events) if (seen[e.type] !== undefined) seen[e.type]++;
        if (f.self.furiten.length) seen.furiten++;
        if (f.pot > 0) seen.pot++;
        // 局の途中の持ち点＋供託＝400（宣言料は宣言の時点で引いて表示）
        assert.equal(f.scores.reduce((a, b) => a + b, 0) + f.pot, 400);
        if (f.result) {
          if (f.result.win) seen[f.result.win.how]++; else seen.draw++;
          if (f.result.potWon) seen.potWon++;
          assert.equal(f.result.scoresAfter.reduce((a, b) => a + b, 0) + f.result.potAfter, 400);
          assert.deepEqual(f.result.scoresAfter, p.rounds[ri].settlement.matchAfter.scores);
          assert.deepEqual(f.result.deltas, p.rounds[ri].settlement.deltas);
        }
      }
    }
  }
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `${k}: ${n}（${JSON.stringify(seen)}）`);
});

test('中断・記録中の牌譜：実在する検証済みの局・判断までだけ。未精算の局に結果を作らない', () => {
  for (const p of [ABORTED, OPEN]) {
    const s = createReviewSession(p);
    assert.equal(s.info.status, p === ABORTED ? 'aborted' : 'recording');
    assert.equal(s.info.final, null);
    const last = p.rounds.length - 1;
    assert.equal(s.info.roundList[last].settled, false);
    const fs = s.frames(last);
    assert.equal(fs.at(-1).result, null, '未精算の局は結果なし');
    assert.equal(fs.length, visibleSteps(p, last, 0).length);
  }
  assert.equal(publicSummary(ABORTED).termination, 'left-match');
});

// 中断した局の最後の時点：記録の最後の行動の後の公開情報（独立の再生の viewFor）と一致・判断者なし・結果なし・精算の前の持ち点
function checkTerminal(p, label) {
  const me = humanSeatOf(p), ri = p.rounds.length - 1, r = p.rounds[ri];
  const fs = createReviewSession(p).frames(ri);
  const f = fs.at(-1);
  const g = newRoundGame(p, r.round, r.dealer);
  for (const st of r.steps) applyAction(g, st.seat, st.action);
  const v = g.viewFor(me);
  assert.deepEqual(sortN([...f.hand, ...(f.drawn === null ? [] : [f.drawn])]), sortN(v.hand.map((x) => x.type)), `${label}：自分の最後の手牌`);
  assert.deepEqual(f.rivers.map((x) => x.map((y) => y.tile)), v.rivers, `${label}：河`);
  assert.deepEqual(f.melds.map((ms) => ms.map((m) => m.tiles)), v.melds.map((ms) => ms.map((m) => m.tiles)), `${label}：公開面子`);
  assert.deepEqual(f.handCounts, v.handCounts);
  assert.deepEqual([f.cut, f.pending, f.result], [true, null, null], `${label}：判断者・結果なし`);
  const D = r.matchBefore.riichiDeposit;
  assert.deepEqual(f.scores, r.matchBefore.scores.map((x, i) => x - (g.riichi[i] ? D : 0)), `${label}：精算の前の持ち点`);
  return { f, g, fs };
}
test('Codex 固定反例（P2-1）：他家の判断待ちで終わった中断の局でも、最後の自分の打牌・手牌・河を記録どおりに出す', () => {
  // 数学Ⅰ seedBase=19041・14行動：最後は自分が 60° を打牌し、他家の判断待ちで終了 → 手牌8枚・河の最後に 60°
  const a = decodePaifu(encodePaifu(playRecorded({ mode: 'math1', length: 4, seedBase: 19041, stopAfterSteps: 14, id: 'cx-19041' }).record));
  const last = a.rounds.at(-1).steps.at(-1);
  assert.deepEqual([last.seat, last.action.type, last.action.tile], [0, 'discard', 51], '最後は自分の打牌（ID51）');
  const { f, g } = checkTerminal(a, '数学Ⅰ 19041');
  const R = g.rules;
  assert.equal(f.hand.length + (f.drawn === null ? 0 : 1), 8, '手牌8枚');
  assert.equal(R.types[f.rivers[0].at(-1).tile].deg, 60, '河の最後は 60°');
  assert.equal(f.mine && f.mine.type, 'discard', '自分の打牌を出す');
  assert.ok(g.pending() && g.pending().seat !== 0 && g.pending().type === 'claim', '（前提）他家の判断待ちで終わっている');
  // 数学Ⅱ seedBase=19541・37行動
  const b = decodePaifu(encodePaifu(playRecorded({ mode: 'math2', length: 4, seedBase: 19541, stopAfterSteps: 37, id: 'cx-19541' }).record));
  checkTerminal(b, '数学Ⅱ 19541');
});
test('中断の局の最後の公開情報（行動数を1〜180で総当たり・数学Ⅰ・Ⅱ）：判断待ちで終わっても終わらなくても、最後の時点は1つで記録どおり', () => {
  let claimEnds = 0, n = 0;
  for (const [mode, seedBase] of [['math1', 19041], ['math2', 19541], ['math1', 4242]]) {
    for (let k = 1; k <= 180; k += 1) {
      const res = playRecorded({ mode, length: 4, seedBase, stopAfterSteps: k, id: `sw-${mode}-${k}` });
      if (res.record.status !== 'aborted') continue;
      const p = decodePaifu(encodePaifu(res.record));
      const { g, fs } = checkTerminal(p, `${mode} ${seedBase} ${k}`);
      const q = g.pending();
      if (q && q.type === 'claim' && q.seat !== 0) claimEnds++;
      assert.equal(fs.length, visibleSteps(p, p.rounds.length - 1, 0).length);
      n++;
    }
  }
  assert.ok(n > 300 && claimEnds > 10, `中断 ${n}・他家の判断待ちで終わり ${claimEnds}`);
});
test('Codex 固定反例（P2-2）：精算した局の最後は、席の持ち点・供託が精算の後（数学Ⅰ・1局戦・seedBase=19041）', () => {
  const p = decodePaifu(encodePaifu(playRecorded({ mode: 'math1', length: 1, seedBase: 19041, id: 'cx-19041-1' }).record));
  const f = createReviewSession(p).frames(0).at(-1);
  assert.deepEqual([f.scores, f.pot], [[95, 134, 100, 71], 0]);
  assert.deepEqual([f.result.scoresAfter, f.result.potAfter], [[95, 134, 100, 71], 0]);
  // 1つ前の時点は精算の前（宣言料を引いた持ち点・供託）
  const fs = createReviewSession(p).frames(0);
  if (fs.length > 1) assert.equal(fs.at(-2).scores.reduce((a, b) => a + b, 0) + fs.at(-2).pot, 400);
});

test('一覧の要約：索引だけの行・検証済みの記録から公開してよい項目（相手・順位・最終点）', () => {
  const p = RECORDS.find((x) => x.length === 4).record;
  const sum = publicSummary(p);
  assert.deepEqual(sum.players.map((x) => x.name), p.settings.players.map((x) => x.name));
  assert.deepEqual([sum.final.myRank, sum.final.myScore], [p.final.ranks[0], p.final.scores[0]]);
  assert.doesNotMatch(JSON.stringify(sum), /"(rounds|steps|seedBase|digest)":\[/);
  const e = entryFromIndex({ id: 'x', savedAt: 1, mode: 'math1', length: 4, status: 'complete', rounds: 4, token: 'secret', digest: 'd', bytes: 9 });
  assert.deepEqual(Object.keys(e).sort(), ['id', 'length', 'mode', 'rounds', 'savedAt', 'status']);
});

test('改ざん：記録と再生が食い違えば時点を作らない（読込時の検証を通らない記録を直接渡しても）', () => {
  const p = JSON.parse(JSON.stringify(RECORDS[2].record));
  p.rounds[0].steps[3].digest = '0000000000000000';
  const s = createReviewSession(p);
  assert.throws(() => s.frames(0), /digest/);
  assert.throws(() => verifyPaifu(p), /digest/);
  const q = JSON.parse(JSON.stringify(RECORDS[2].record));
  q.rounds[0].startDigest = 'ffffffffffffffff';
  assert.throws(() => createReviewSession(q).frames(0), /startDigest/);
  assert.throws(() => createReviewSession(RECORDS[0].record).frames(99), /roundIndex/);
});

test('非同期の作成：同期と同じ値・区切る・取り消したら null（古い画面に描かない）・直近の局だけ保持', async () => {
  const p = RECORDS.find((x) => x.length === 8 && x.mode === 'math2').record;
  const a = createReviewSession(p), b = createReviewSession(p);
  let pauses = 0, t = 0;
  const fa = await a.framesAsync(0, { budgetMs: 1, now: () => (t += 1), pause: async () => { pauses++; } });
  assert.deepEqual(fa, b.frames(0));
  assert.ok(pauses > 0);
  let cancel = false;
  const c = createReviewSession(p);
  const pending = c.framesAsync(1, { budgetMs: 0, pause: async () => { cancel = true; }, isCancelled: () => cancel });
  assert.equal(await pending, null);
  assert.equal(potTotal(p.rounds[0].matchBefore), 0);
});
