// ロン・ポン・チーの演出（Ver.0.5-B, src/ui/effects.js）：どの記録で何を出すか・重なったときの扱い・経過の計算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EFFECTS, EFFECT_MODE_KEY, parseEffectMode, effectKindOf, pickEffect, shouldReplace, fxProgress, isLiteEffect,
} from '../src/ui/effects.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor } from './helpers.js';

test('演出の仕様：ロン 1.1秒・ツモ 1.0秒・リーチ 0.7秒・ポン 0.52秒・チー 0.42秒、優先度 ロン・ツモ ＞ リーチ ＞ ポン ＞ チー（指示の長さの範囲内）', () => {
  assert.deepEqual(Object.keys(EFFECTS), ['ron', 'tsumo', 'riichi', 'pon', 'chi']);
  assert.equal(EFFECTS.tsumo.ms, 1000, 'ツモの 1.0 秒は据え置き');
  assert.equal(EFFECTS.tsumo.prio, EFFECTS.ron.prio, 'ツモはロンと同格');
  assert.equal(EFFECTS.tsumo.text, 'ツモ！');
  assert.ok(EFFECTS.ron.ms >= 1000 && EFFECTS.ron.ms <= 1200, 'ロンは 800ms → 約 1100ms に延長');
  assert.ok(EFFECTS.riichi.ms >= 600 && EFFECTS.riichi.ms <= 800, 'リーチは 0.6〜0.8 秒');
  assert.ok(EFFECTS.riichi.ms < EFFECTS.tsumo.ms && EFFECTS.riichi.ms < EFFECTS.ron.ms, 'リーチはロン・ツモより短い');
  assert.ok(EFFECTS.riichi.ms > EFFECTS.pon.ms, 'リーチはポン・チーより特別感がある（長い）');
  assert.ok(EFFECTS.pon.ms >= 450 && EFFECTS.pon.ms <= 600);
  assert.ok(EFFECTS.chi.ms >= 350 && EFFECTS.chi.ms <= 500);
  assert.ok(EFFECTS.ron.prio > EFFECTS.riichi.prio && EFFECTS.riichi.prio > EFFECTS.pon.prio && EFFECTS.pon.prio > EFFECTS.chi.prio);
  assert.deepEqual([EFFECTS.ron.text, EFFECTS.riichi.text, EFFECTS.pon.text, EFFECTS.chi.text], ['ロン！', 'リーチ！', 'ポン！', 'チー！']);
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

test('重なったとき：表示中のロンを後から来たポン・チーで潰さない。終わった演出・同じか低い優先度の入れ替えは正しい', () => {
  const cur = { kind: 'ron', startedAt: 1000 };
  assert.equal(shouldReplace(null, 'chi', 0), true);
  assert.equal(shouldReplace(cur, 'pon', 1100), false);
  assert.equal(shouldReplace(cur, 'chi', 1500), false);
  assert.equal(shouldReplace(cur, 'ron', 1100), true, '同じ優先度は新しい方');
  assert.equal(shouldReplace(cur, 'pon', 1000 + EFFECTS.ron.ms), true, 'ロンの演出が終わっていれば');
  assert.equal(shouldReplace({ kind: 'chi', startedAt: 0 }, 'pon', 100), true, '高い優先度は入れ替える');
  assert.equal(shouldReplace({ kind: 'pon', startedAt: 0 }, 'chi', 100), false);
  assert.equal(shouldReplace({ kind: 'pon', startedAt: 0 }, 'chi', EFFECTS.pon.ms), true, 'ポンが終わっていれば');
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

test('P2-1：通常／簡易の実効モードは演出の開始時に1回だけ決め、表示（レイヤー・揺れ・発光）がその保存値を使う', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  // fxLite()（現在の設定の読み取り）は、演出を始める fxFire の1か所だけ
  assert.equal((app.match(/fxLite\(\)/g) || []).length, 1, '現在の設定の読み取り（fxLite() の呼び出し）は fxFire の1回だけ（定義は fxLite = () => で別）');
  const fire = app.slice(app.indexOf('function fxFire('), app.indexOf('// 盤面の演出（ロンの画面揺れ'));
  assert.match(fire, /const lite = fxLite\(\);/);
  assert.match(fire, /S\.fx\.current = \{[^}]*lite[^}]*\}/, '開始時のモードを S.fx.current に保存');
  assert.match(fire, /fxHTML\(kind, ev, lite\)/, '文字・牌・フラッシュも同じ値');
  // fxHTML と fxApply は保存値だけを見る（現在の設定を読み直さない）
  const html = app.slice(app.indexOf('function fxHTML('), app.indexOf('// 演出を出す。'));
  assert.ok(!html.includes('fxLite('));
  const apply = app.slice(app.indexOf('function fxApply()'));
  assert.ok(!apply.slice(0, apply.indexOf('\n}\n')).includes('fxLite('));
  assert.match(apply, /c\.lite/);
});
