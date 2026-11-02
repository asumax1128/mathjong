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
import { potTotal } from '../src/engine/match.js';

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
        const { result, index, mine, events, ...rest } = f;
        const { result: r0, index: i0, mine: m0, events: e0, ...fresh } = proj;
        assert.deepEqual(rest, fresh, `局 ${ri} 時点 ${k}`);
        assert.equal(result !== null, k === fs.length - 1 && p.rounds[ri].settlement !== null, '結果は精算した局の最後の時点だけ');
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
    'normalDraws', 'scores', 'pot', 'self', 'result']);
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
      fs.forEach((f, k) => { if (!(k === fs.length - 1 && p.rounds[ri].settlement !== null)) assert.ok(f.pending, `局 ${ri} 時点 ${k}：判断者なし`); });
      // 打牌の後は、同じ時点の中で次の出来事（ツモ・鳴き・和了・流局）まで進んでいる（自分の判断待ちを除く）
      for (const f of fs) { const last = f.events.at(-1); if (last && last.type === 'discard' && !(f.pending && f.pending.type === 'claim')) assert.fail(`打牌で止まった時点 ${JSON.stringify(f.events)}`); }
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
