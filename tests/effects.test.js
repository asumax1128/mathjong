// 宣言の演出（Ver.0.5-B〜E, src/ui/effects.js）：どの記録で何を出すか・演出キュー（重なったときの扱い）・経過の計算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EFFECTS, EFFECT_MODE_KEY, parseEffectMode, effectKindOf, pickEffect, fxProgress, isLiteEffect,
  fxOffer, fxAdvance, fxEndAt, isWinEffect, FX_QUEUE_MAX, FX_QUEUE_STALE_MS,
} from '../src/ui/effects.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor } from './helpers.js';

test('演出の仕様（Ver.0.5-E）：チー 1.0秒・ポン 1.2秒・ロン 2.2秒・ツモ 2.0秒・リーチ 0.9秒。優先度 ロン・ツモ ＞ リーチ ＞ ポン ＞ チー', () => {
  assert.deepEqual(Object.keys(EFFECTS), ['ron', 'tsumo', 'riichi', 'pon', 'chi']);
  assert.deepEqual(Object.fromEntries(Object.entries(EFFECTS).map(([k, v]) => [k, v.ms])), { ron: 2200, tsumo: 2000, riichi: 900, pon: 1200, chi: 1000 });
  assert.equal(EFFECTS.tsumo.prio, EFFECTS.ron.prio, 'ツモはロンと同格');
  assert.ok(EFFECTS.ron.prio > EFFECTS.riichi.prio && EFFECTS.riichi.prio > EFFECTS.pon.prio && EFFECTS.pon.prio > EFFECTS.chi.prio);
  assert.deepEqual([EFFECTS.ron.text, EFFECTS.tsumo.text, EFFECTS.riichi.text, EFFECTS.pon.text, EFFECTS.chi.text], ['ロン！', 'ツモ！', 'リーチ！', 'ポン！', 'チー！']);
  // 待っている演出があるときの最低表示時間：ロン・ツモは短くしない。チー・ポン・リーチも、読める時間（0.65秒以上）は残す
  assert.equal(EFFECTS.ron.minMs, EFFECTS.ron.ms);
  assert.equal(EFFECTS.tsumo.minMs, EFFECTS.tsumo.ms);
  for (const k of ['chi', 'pon', 'riichi']) assert.ok(EFFECTS[k].minMs >= 650 && EFFECTS[k].minMs < EFFECTS[k].ms, k);
  assert.ok(isWinEffect('ron') && isWinEffect('tsumo') && !isWinEffect('pon') && !isWinEffect('chi') && !isWinEffect('riichi'));
  assert.equal(FX_QUEUE_MAX, 2);
});

test('記録 → 演出の種類：ロン・ツモ和了・リーチ（成立の記録）・ポン・チーだけ。打牌・ツモ（牌を引く）・流局は出さない', () => {
  assert.equal(effectKindOf({ type: 'win', seat: 1, how: 'ron', from: 0 }), 'ron');
  assert.equal(effectKindOf({ type: 'win', seat: 1, how: 'tsumo', from: null }), 'tsumo');
  assert.equal(effectKindOf({ type: 'pon', seat: 2 }), 'pon');
  assert.equal(effectKindOf({ type: 'chi', seat: 1 }), 'chi');
  assert.equal(effectKindOf({ type: 'riichi', seat: 0, tile: 5 }), 'riichi', 'リーチは、エンジンが宣言を受け付けて記録した時だけ');
  for (const e of [{ type: 'win', how: 'unknown' }, { type: 'discard' }, { type: 'draw' }, { type: 'exhaustive-draw' }, null, undefined]) assert.equal(effectKindOf(e), null);
});

test('pickEffect：新しい記録だけを見る。同じ記録で2回出さない。優先度が高いものを選ぶ。別の局（記録が短い）は数え直す', () => {
  const ev = [{ type: 'draw' }, { type: 'discard' }, { type: 'chi' }];
  let r = pickEffect(ev, 0);
  assert.deepEqual([r.kind, r.index, r.next], ['chi', 2, 3]);
  r = pickEffect(ev, r.next);
  assert.deepEqual([r.kind, r.next], [null, 3], '同じ記録からは出ない');
  ev.push({ type: 'discard' }, { type: 'pon' });
  r = pickEffect(ev, 3);
  assert.deepEqual([r.kind, r.index], ['pon', 4]);
  // 同時に複数：ロンが最優先
  assert.equal(pickEffect([{ type: 'chi' }, { type: 'pon' }, { type: 'win', how: 'ron' }], 0).kind, 'ron');
  assert.equal(pickEffect([{ type: 'win', how: 'ron' }, { type: 'pon' }], 0).kind, 'ron');
  // 別の局：記録が from より短い → 先頭から
  assert.equal(pickEffect([{ type: 'draw' }, { type: 'pon' }], 99).kind, 'pon');
  assert.equal(pickEffect([], 0).kind, null);
});

const ST = (current = null, queue = []) => ({ current, queue });
const item = (kind, seat = 1) => ({ kind, event: { type: kind === 'ron' || kind === 'tsumo' ? 'win' : kind, seat } });

test('演出キュー：表示中の演出があれば、後のチー・ポン・リーチは待たせて順番に見せる（後の演出で前の演出をすぐ消さない）', () => {
  let s = fxOffer(ST(), item('chi', 3), 0);
  assert.deepEqual([s.shown, s.current.kind, s.current.startedAt, s.queue.length], [true, 'chi', 0, 0]);
  assert.equal(fxEndAt(s), EFFECTS.chi.ms, '待つ演出がなければ全長');
  s = fxOffer(s, item('pon', 2), 200);
  assert.deepEqual([s.shown, s.current.kind, s.queue.map((q) => q.kind)], [false, 'chi', ['pon']], 'ポンは待つ（チーを消さない）');
  assert.equal(fxEndAt(s), EFFECTS.chi.minMs, '後ろに待つ演出があれば、チーは最低表示時間で終える');
  s = fxAdvance(s, fxEndAt(s));
  assert.deepEqual([s.shown, s.current.kind, s.current.startedAt, s.current.event.seat, s.queue.length], [true, 'pon', EFFECTS.chi.minMs, 2, 0]);
  assert.equal(fxEndAt(s), EFFECTS.chi.minMs + EFFECTS.pon.ms);
  s = fxAdvance(s, fxEndAt(s));
  assert.deepEqual([s.shown, s.current, s.queue], [false, null, []], '待つ演出がなければ消える');
});

test('演出キュー：ロン・ツモは最優先ですぐ表示し、待っている古い低優先度の演出を捨てる。表示中のロン・ツモは後から来た演出で潰さない', () => {
  for (const win of ['ron', 'tsumo']) {
    let s = fxOffer(ST(), item('chi'), 0);
    s = fxOffer(s, item('pon'), 100);
    s = fxOffer(s, item('riichi'), 150);
    assert.equal(s.queue.length, 2);
    s = fxOffer(s, item(win, 2), 300);
    assert.deepEqual([s.shown, s.current.kind, s.current.startedAt, s.queue.length], [true, win, 300, 0], `${win}：すぐ表示`);
    assert.deepEqual(s.dropped.map((d) => d.kind), ['pon', 'riichi'], '待っていた演出は捨てる');
    assert.equal(fxEndAt(s), 300 + EFFECTS[win].ms, '短くしない');
    for (const k of ['chi', 'pon', 'riichi']) {
      const r = fxOffer(s, item(k), 500);
      assert.deepEqual([r.shown, r.current.kind, r.queue.length, r.dropped.length], [false, win, 0, 1], `${win} 表示中の ${k} は出さない`);
    }
    // ロン・ツモの演出が終わった後なら、新しい演出は出る（次の局の前など）
    assert.equal(fxOffer(s, item('chi'), 300 + EFFECTS[win].ms).shown, true);
  }
});

test('演出キュー：無制限に溜めない（上限 2・古いものから捨てる）。待っている間に古くなった演出は出さない', () => {
  let s = fxOffer(ST(), item('pon'), 0);
  for (let i = 0; i < 5; i++) s = fxOffer(s, item(i % 2 ? 'chi' : 'riichi', i % 4), 10 + i);
  assert.equal(s.queue.length, FX_QUEUE_MAX);
  assert.deepEqual(s.queue.map((q) => q.at), [13, 14], '新しい2つを残す');
  // 古くなった（届いてから FX_QUEUE_STALE_MS を超えた）演出は出さずに捨てる
  const late = fxAdvance(s, 14 + FX_QUEUE_STALE_MS + 1);
  assert.deepEqual([late.shown, late.current, late.dropped.length], [false, null, 2]);
  const inTime = fxAdvance(s, 13 + FX_QUEUE_STALE_MS + 1);
  assert.deepEqual([inTime.shown, inTime.current.kind, inTime.dropped.length, inTime.queue.length], [true, 'riichi', 1, 0], '古い方は捨て、間に合う方を出す');
});

test('演出キュー：元の状態を変更しない（純粋関数）', () => {
  const s0 = fxOffer(ST(), item('chi'), 0);
  const snap = JSON.stringify(s0);
  fxOffer(s0, item('pon'), 10);
  fxOffer(s0, item('ron'), 10);
  fxAdvance(s0, 5000);
  assert.equal(JSON.stringify(s0), snap);
});

test('演出キュー：実際の AI 対局の記録を速い進行で流しても、表示した演出は最低表示時間を守り（ロン・ツモで置き換えた場合を除く）、ロン・ツモは必ず表示し、キューは上限を超えない', () => {
  let shown = 0; let wins = 0; let calls = 0;
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 16; i++) {
      const lineup = ['speed', 'speed', 'speed', 'value'];
      const g = new Game({ rules: r, seed: 1300 + i, dealer: i % 4, players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
      const rng = createRng(i);
      let st = ST(); let from = 0; let t = 0;
      const log = []; // 表示した演出 { kind, start, end, seat }
      const show = (cur) => { if (log.length) log[log.length - 1].end = Math.min(log[log.length - 1].end, cur.startedAt); log.push({ kind: cur.kind, start: cur.startedAt, end: Infinity, seat: cur.event.seat }); };
      const pump = (now) => { while (st.current && fxEndAt(st) <= now) { const end = fxEndAt(st); st = fxAdvance(st, end); log[log.length - 1].end = Math.min(log[log.length - 1].end, end); if (st.shown) show(st.current); } };
      while (g.pending()) {
        const p = g.pending();
        applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
        t += 120; // 速い進行（AI の待ち時間 0.12 秒）
        pump(t);
        const pk = pickEffect(g.events, from); from = pk.next;
        if (!pk.kind) continue;
        calls++;
        assert.equal(pk.event.seat, g.events[pk.index].seat, '宣言者は記録の seat');
        st = fxOffer(st, { kind: pk.kind, event: pk.event }, t);
        assert.ok(st.queue.length <= FX_QUEUE_MAX);
        if (st.shown) show(st.current);
        if (isWinEffect(pk.kind)) { wins++; assert.equal(st.current.kind, pk.kind, 'ロン・ツモは必ずすぐ表示'); }
      }
      pump(t + 10000);
      for (let j = 0; j < log.length; j++) {
        const e = log[j];
        const next = log[j + 1];
        const replacedByWin = next && isWinEffect(next.kind) && next.start === e.end;
        if (!replacedByWin) assert.ok(e.end - e.start >= EFFECTS[e.kind].minMs, `${mode} 局${i}：${e.kind} は最低 ${EFFECTS[e.kind].minMs}ms 表示（${e.end - e.start}ms）`);
      }
      shown += log.length;
    }
  }
  assert.ok(wins > 0 && calls > wins && shown > wins, JSON.stringify({ shown, wins, calls }));
});

test('経過：再描画で作り直した要素を続きから再生するための値（演出がない・終わった後は無効）', () => {
  const cur = { kind: 'pon', startedAt: 100 };
  assert.deepEqual(fxProgress(null, 0), { active: false, elapsed: 0 });
  assert.deepEqual(fxProgress(cur, 300), { active: true, elapsed: 200 });
  assert.equal(fxProgress(cur, 100 + EFFECTS.pon.ms).active, false);
  assert.equal(fxProgress(cur, 50).elapsed, 0, '開始前は 0');
});

test('設定：保存キー mj-effects、"lite" だけが簡易。未保存・異常値は通常。reduced motion は簡易と同じ（文字だけ）', () => {
  assert.equal(EFFECT_MODE_KEY, 'mj-effects');
  assert.equal(parseEffectMode('lite'), 'lite');
  for (const v of [null, undefined, '', 'full', 'off', 'LITE', 1, true]) assert.equal(parseEffectMode(v), 'full', String(v));
  assert.equal(isLiteEffect('full', false), false);
  assert.equal(isLiteEffect('lite', false), true);
  assert.equal(isLiteEffect('full', true), true);
});

test('実際の対局：数学Ⅰ・Ⅱの AI 対局の記録からロン・ポン・チーを検出し、演出の有無でゲームの結果が変わらない（記録は読むだけ）', () => {
  const seen = { ron: 0, tsumo: 0, pon: 0, chi: 0 };
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 12; i++) {
      const lineup = ['speed', 'value', 'closed', 'speed'];
      const run = (scan) => {
        const g = new Game({ rules: r, seed: 700 + i, dealer: i % 4, players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
        const rng = createRng(i);
        let from = 0;
        while (g.pending()) {
          const p = g.pending();
          applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
          if (scan) { const pk = pickEffect(g.events, from); from = pk.next; if (pk.kind) seen[pk.kind]++; }
        }
        return JSON.stringify({ events: g.events, result: g.result && { ...g.result, analysis: undefined } });
      };
      assert.equal(run(true), run(false), `${mode} 局${i}：演出の判定は記録を変えない`);
    }
  }
  assert.ok(seen.ron > 0 && seen.tsumo > 0 && seen.pon + seen.chi > 0, JSON.stringify(seen));
});

test('構造：演出は #app の外の専用レイヤーに出し、タップを通す。ゲームの判定・得点・進行のコードを呼ばない', () => {
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#fx-layer\s*\{[^}]*pointer-events:\s*none/);
  const fx = readFileSync(new URL('../src/ui/effects.js', import.meta.url), 'utf8');
  assert.ok(!/import .*engine/.test(fx), 'effects.js はエンジンを読み込まない（純粋な表示用の判定だけ）');
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /document\.body\.appendChild\(fxLayer\)/);
  // fxScan は g.events を読むだけ（g の変更メソッドを呼ばない）
  const scan = app.slice(app.indexOf('function fxScan()'), app.indexOf('// 演出の中身（HTML）'));
  assert.ok(!/g\.(discard|respond|tsumo|pass)\(/.test(scan));
});

test('P2-1：通常／簡易の実効モードは演出の開始時（fxShow）に1回だけ決め、表示（レイヤー・揺れ・発光）がその保存値を使う', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  // fxLite()（現在の設定の読み取り）は、演出を実際に始める fxShow の1か所だけ
  assert.equal((app.match(/fxLite\(\)/g) || []).length, 1, '現在の設定の読み取り（fxLite() の呼び出し）は fxShow の1回だけ（定義は fxLite = () => で別）');
  const fire = app.slice(app.indexOf('function fxShow('), app.indexOf('// 盤面の演出（ロン・ツモの画面揺れ'));
  assert.match(fire, /const lite = fxLite\(\);/);
  assert.match(fire, /S\.fx\.current = \{[^}]*lite[^}]*\}/, '開始時のモードを S.fx.current に保存');
  assert.match(fire, /fxHTML\(kind, ev, lite\)/, '文字・牌・フラッシュも同じ値');
  // fxHTML と fxApply は保存値だけを見る（現在の設定を読み直さない）
  const html = app.slice(app.indexOf('function fxHTML('), app.indexOf('// 新しい宣言の演出が届いた'));
  assert.ok(!html.includes('fxLite('));
  const apply = app.slice(app.indexOf('function fxApply()'));
  assert.ok(!apply.slice(0, apply.indexOf('\n}\n')).includes('fxLite('));
  assert.match(apply, /c\.lite/);
});
