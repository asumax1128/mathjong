// チーのオートパス（Ver.0.2-B, src/ui/autopass.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHI_AUTOPASS_KEY, parseChiAutoPass, shouldAutoPassChi, visibleClaimActions, claimPendingForHint, claimPolicy, autoPassDue,
} from '../src/ui/autopass.js';
import { claimForSeat } from '../src/engine/yakuhint.js';
import { ENGINE_VERSION } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rules, makeGame, findTile, junk, junk2 } from './helpers.js';

const CHI = [{ meld: 10, use: [1, 2] }, { meld: 20, use: [3, 4] }];
const claim = (o = {}) => ({ seat: 0, type: 'claim', tile: 99, from: 3, ron: false, chi: CHI, ...o });
const turn = (canTsumo) => ({ seat: 0, type: 'turn', canTsumo });

test('保存キーは mj-chi-autopass、保存値は厳密に "1" だけが ON', () => {
  assert.equal(CHI_AUTOPASS_KEY, 'mj-chi-autopass');
  assert.equal(parseChiAutoPass('1'), true);
  for (const v of [null, undefined, '0', '', ' 1', '1 ', '01', '2', 'true', 'on', 'ON', 'yes', '1.0', 'null', 1, true, {}]) {
    assert.equal(parseChiAutoPass(v), false, `saved ${JSON.stringify(v)}`);
  }
});

test('OFF では一切自動パスしない', () => {
  for (const enabled of [false, undefined, null, 0, 1, 'true']) {
    assert.equal(shouldAutoPassChi(claim(), 0, enabled), false, `enabled ${JSON.stringify(enabled)}`);
  }
});

test('ON：チーのみの自分の宣言待ちだけを自動パスする', () => {
  assert.equal(shouldAutoPassChi(claim(), 0, true), true);
  assert.equal(shouldAutoPassChi(claim({ chi: [CHI[0]] }), 0, true), true);
});

test('ON：ロンのみ・ロン＋チー・チー候補なしは自動パスしない', () => {
  assert.equal(shouldAutoPassChi(claim({ ron: true, chi: [] }), 0, true), false, 'ロンのみ');
  assert.equal(shouldAutoPassChi(claim({ ron: true }), 0, true), false, 'ロン＋チー');
  assert.equal(shouldAutoPassChi(claim({ chi: [] }), 0, true), false, 'チー候補なし');
  assert.equal(shouldAutoPassChi(claim({ ron: undefined }), 0, true), false, 'ロンの可否が不明なら見送らない');
});

test('ON：ツモ番（ツモ可能・不可能）・終局・他家の宣言は自動パスしない', () => {
  assert.equal(shouldAutoPassChi(turn(true), 0, true), false);
  assert.equal(shouldAutoPassChi(turn(false), 0, true), false);
  assert.equal(shouldAutoPassChi(null, 0, true), false);
  assert.equal(shouldAutoPassChi(claim({ seat: 1 }), 0, true), false);
  assert.equal(shouldAutoPassChi({ seat: 1, type: 'turn', canTsumo: false }, 0, true), false);
});

test('表示する宣言ボタン：OFF は従来どおり全部', () => {
  assert.deepEqual(visibleClaimActions(claim(), false), { ron: false, pon: null, chi: [{ index: 0, meld: 10 }, { index: 1, meld: 20 }], passLabel: '見送る', passNote: null,
  });
  assert.deepEqual(visibleClaimActions(claim({ ron: true }), false), { ron: true, pon: null, chi: [{ index: 0, meld: 10 }, { index: 1, meld: 20 }], passLabel: 'ロンしない', passNote: null,
  });
  assert.deepEqual(visibleClaimActions(claim({ ron: true, pon: null, chi: [] }), false), { ron: true, pon: null, chi: [], passLabel: 'ロンしない', passNote: null });
});

test('表示する宣言ボタン：ON・ロン＋チーはチーを出さず「ロンしない」に「チーも見送ります」', () => {
  assert.deepEqual(visibleClaimActions(claim({ ron: true }), true), { ron: true, pon: null, chi: [], passLabel: 'ロンしない', passNote: 'チーも見送ります' });
  assert.deepEqual(visibleClaimActions(claim({ ron: true, pon: null, chi: [] }), true), { ron: true, pon: null, chi: [], passLabel: 'ロンしない', passNote: null }, 'ロンのみ');
  // チーのみ（自動パスに失敗したときの手動表示）：チーの選択肢を出す。index はエンジンの候補番号のまま
  assert.deepEqual(visibleClaimActions(claim(), true).chi, [{ index: 0, meld: 10 }, { index: 1, meld: 20 }]);
  assert.equal(visibleClaimActions(turn(true), true), null);
  assert.equal(visibleClaimActions(null, true), null);
});

test('表示と自動パスの整合：自動パスしない宣言には必ず「ロン」または「チー」がある', () => {
  for (const ron of [false, true]) for (const chi of [[], [CHI[0]], CHI]) for (const enabled of [false, true]) {
    const p = claim({ ron, chi });
    if (!ron && !chi.length) continue; // エンジンはこの宣言待ちを作らない
    const v = visibleClaimActions(p, enabled);
    if (shouldAutoPassChi(p, 0, enabled)) { assert.ok(enabled && !ron && chi.length); continue; }
    assert.ok(v.ron || v.chi.length, `ron=${ron} chi=${chi.length} enabled=${enabled}`);
    assert.equal(v.ron, ron, 'ロンは常に表示');
    assert.equal(v.chi.length, enabled && ron ? 0 : chi.length);
  }
});

test('役候補ヒントへ渡す宣言は、表示する選択肢と同じ経路', () => {
  const typeOf = () => 5;
  const p = claim({ ron: true });
  assert.deepEqual(claimForSeat(claimPendingForHint(p, true), 0, typeOf).chiMelds, [], 'ON・ロン＋チー：チーの経路なし');
  assert.equal(claimForSeat(claimPendingForHint(p, true), 0, typeOf).ron, true);
  assert.deepEqual(claimForSeat(claimPendingForHint(p, false), 0, typeOf).chiMelds, [10, 20], 'OFF：従来どおり');
  assert.deepEqual(claimForSeat(claimPendingForHint(claim(), true), 0, typeOf).chiMelds, [10, 20], 'チーのみ（手動表示時）');
  assert.equal(claimPendingForHint(turn(true), true).type, 'turn');
  assert.equal(claimPendingForHint(null, true), null);
  assert.equal(p.chi.length, 2, '入力は変更しない');
  for (const ron of [false, true]) for (const chi of [[], CHI]) for (const enabled of [false, true]) {
    const q = claim({ ron, chi });
    if (!ron && !chi.length) continue;
    const c = claimForSeat(claimPendingForHint(q, enabled), 0, typeOf);
    assert.deepEqual(c.chiMelds, visibleClaimActions(q, enabled).chi.map((o) => o.meld));
  }
});

test('宣言ごとの方針：同じ宣言は最初の方針を保ち、新しい宣言はその時点の設定で作り直す', () => {
  let pol = claimPolicy(null, '1:10', false);
  // Ver.0.4-B：方針にチー・ポンそれぞれの設定（chi・pon）を持つ。boolean の設定は従来のチー設定として扱う（ポンは OFF）
  assert.deepEqual(pol, { key: '1:10', chi: false, pon: false, autoPass: false, tried: false });
  // 表示中に ON にしても同じ宣言の方針は変わらない（選択肢を途中で変えない）
  assert.equal(claimPolicy(pol, '1:10', true), pol);
  assert.equal(autoPassDue(claimPolicy(pol, '1:10', true), claim(), 0), false);
  // 次の宣言からは ON
  pol = claimPolicy(pol, '1:14', true);
  assert.deepEqual(pol, { key: '1:14', chi: true, pon: false, autoPass: true, tried: false });
  // ON → OFF も次の宣言から
  assert.equal(claimPolicy(pol, '1:14', false).autoPass, true);
  assert.equal(claimPolicy(pol, '1:18', false).autoPass, false);
  // 局が変わっても（同じ events 数でも）別の宣言
  assert.notEqual(claimPolicy(pol, '2:14', true), pol);
});

test('二重処理の防止：同じ宣言で自動パスは1回だけ、古いキーは新しい宣言を拒否しない', () => {
  const pol = claimPolicy(null, '3:21', true);
  assert.equal(autoPassDue(pol, claim(), 0), true);
  pol.tried = true; // app.js の step() が実行前に記録する
  assert.equal(autoPassDue(claimPolicy(pol, '3:21', true), claim(), 0), false, '同じ宣言で2回目はない');
  const next = claimPolicy(pol, '3:25', true);
  assert.equal(autoPassDue(next, claim(), 0), true, '次の宣言では再び自動パス');
  assert.equal(autoPassDue(null, claim(), 0), false, '方針なしなら行わない');
  assert.equal(autoPassDue(claimPolicy(null, 'x', true), claim({ ron: true }), 0), false, 'ロン可能なら方針 ON でも行わない');
  assert.equal(autoPassDue(claimPolicy(null, 'x', true), turn(true), 0), false, 'ツモ番は行わない');
});

// ---- エンジンの実際の局面 ----
// 自分（seat 0）は上家（seat 3, 親）の打牌 1/2 でチーできる。ロンできる手かどうかを切り替える。
function chiScene(ronHand) {
  const hand0 = ronHand ? ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '30'] : ['sin', '30', '0', '0', '270', '=-√3', 'tan', '45'];
  const g = makeGame({
    dealer: 3,
    hands: [hand0, junk, junk2, ['tan', 'tan', 'tan', '360', '360', '90', '=1/2', '=-1/√2']],
    draws: ['=-1/√2'],
  });
  g.discard(3, findTile(g, 3, '=1/2'));
  return g;
}

test('エンジンの局面：チーのみなら自動パス対象、見送ると自分のツモ番に進む', () => {
  const g = chiScene(false);
  const p = g.pending();
  assert.equal(p.type, 'claim');
  assert.equal(p.seat, 0);
  assert.equal(p.ron, false);
  assert.ok(p.chi.length >= 1);
  assert.equal(shouldAutoPassChi(p, 0, true), true);
  assert.equal(shouldAutoPassChi(p, 0, false), false);
  applyAction(g, 0, { type: 'pass' });
  const q = g.pending();
  assert.deepEqual([q.seat, q.type], [0, 'turn'], '見送り後は自分のツモ番（同じ打牌の宣言には戻らない）');
  assert.equal(shouldAutoPassChi(q, 0, true), false);
  g.checkInvariants();
});

test('エンジンの局面：ロン＋チーは自動パスせず、ON ではチーを表示しない', () => {
  const g = chiScene(true);
  const p = g.pending();
  assert.equal(p.ron, true);
  assert.ok(p.chi.length >= 1);
  assert.equal(shouldAutoPassChi(p, 0, true), false);
  assert.deepEqual(visibleClaimActions(p, true).chi, []);
  assert.ok(visibleClaimActions(p, false).chi.length >= 1);
  applyAction(g, 0, { type: 'ron' });
  assert.equal(g.result.winner, 0);
});

// 多数局：全席 AI。（エンジンの1,000局一致は tools/simulate.mjs の出力比較で別に確認）ただし seat 0 の宣言は「判定関数による自動パス」と「独立に書いた条件による見送り」の
// 2系統で進め、結果が完全に一致すること・判定がロン／ツモを一度も対象にしないことを確かめる。
function playSeeded(seed, seat0Claim) {
  const pers = ['speed', 'value', 'closed', 'speed'];
  const players = pers.map((p) => ({ name: p, kind: 'ai', personality: p }));
  const g = new Game({ rules, seed, dealer: seed % 4, players });
  const rng = createRng(seed * 7 + 3);
  const stat = { auto: 0, ronSeen: 0, tsumoSeen: 0 };
  let steps = 0;
  while (g.pending()) {
    const p = g.pending();
    let action = null;
    if (p.seat === 0) action = seat0Claim(p, stat);
    applyAction(g, p.seat, action || decide(g, p.seat, players[p.seat].personality, rng));
    if (++steps > 2000) throw new Error('no progress');
  }
  g.checkInvariants();
  return { g, stat };
}

const GAMES = 120;
test('120局：判定関数による自動パスと独立実装の見送りで結果が一致し、ロン・ツモは対象にならない', () => {
  let auto = 0;
  let ronSeen = 0;
  let tsumoSeen = 0;
  for (let seed = 1; seed <= GAMES; seed++) {
    const a = playSeeded(seed, (p, st) => {
      if (p.type === 'turn' && p.canTsumo) { st.tsumoSeen++; assert.equal(shouldAutoPassChi(p, 0, true), false); }
      if (p.type === 'claim' && p.ron) { st.ronSeen++; assert.equal(shouldAutoPassChi(p, 0, true), false); }
      if (!shouldAutoPassChi(p, 0, true)) return null;
      assert.ok(p.type === 'claim' && p.ron === false && p.chi.length > 0);
      st.auto++;
      return { type: 'pass' };
    });
    const b = playSeeded(seed, (p) => (p.type === 'claim' && !p.ron && p.chi.length ? { type: 'pass' } : null));
    assert.deepEqual(a.g.events, b.g.events, `seed ${seed}`);
    assert.deepEqual(a.g.result && { ...a.g.result, analysis: undefined }, b.g.result && { ...b.g.result, analysis: undefined });
    auto += a.stat.auto; ronSeen += a.stat.ronSeen; tsumoSeen += a.stat.tsumoSeen;
  }
  assert.ok(auto > 10, `自動パスの局面 ${auto}`);
  assert.ok(ronSeen > 0 && tsumoSeen > 0, `ロン ${ronSeen}・ツモ ${tsumoSeen} の局面を確認`);
});

test('バージョン：画面 0.6.2（ヘッダー・title は同じ値）、エンジン 0.5.0-a（タイトル画像・演出は画面だけの変更でルールは不変）', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const v = app.match(/const APP_VERSION = '([^']+)';/)[1];
  assert.equal(v, '0.6.2');
  assert.equal(ENGINE_VERSION, '0.5.0-a');
  assert.match(html, new RegExp(`<title>数雀（MATHJONG）Ver\\.${v.replace(/\./g, '\\.')}</title>`), 'index.html の title が画面の版と一致');
  assert.ok(app.includes('document.title = `数雀（MATHJONG）Ver.${APP_VERSION}`'), 'JS の title も同じ');
  assert.ok(app.includes('<small>Ver.${APP_VERSION}</small>'), 'ヘッダーは APP_VERSION から表示');
});
