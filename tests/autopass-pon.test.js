// チー・ポンのオートパス（Ver.0.4-B, src/ui/autopass.js）：ポンの追加と、チーの設定との統合
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHI_AUTOPASS_KEY, PON_AUTOPASS_KEY, parseChiAutoPass, parsePonAutoPass, autoPassSettings, hiddenCalls, shouldAutoPass, shouldAutoPassChi,
  autoPassedKind, mergeKind, autoPassNotice, visibleClaimActions, claimPendingForHint, claimPolicy, policySettings, autoPassDue,
} from '../src/ui/autopass.js';
import { claimForSeat } from '../src/engine/yakuhint.js';
import { applyAction } from '../src/engine/ai.js';
import { rulesFor, makeGame, findTile } from './helpers.js';

const M2 = rulesFor('math2');
const CHI = [{ meld: 10, use: [1, 2] }, { meld: 20, use: [3, 4] }];
const PON = { meld: 70, use: [5, 6] };
const claim = (o = {}) => ({ seat: 0, type: 'claim', tile: 99, from: 3, ron: false, chi: CHI, pon: PON, ...o });
const turn = (canTsumo) => ({ seat: 0, type: 'turn', canTsumo });
const SETTINGS = [
  { chi: false, pon: false },
  { chi: true, pon: false },
  { chi: false, pon: true },
  { chi: true, pon: true },
];
// 表示される選択肢を短く表す
const shown = (v) => [v.ron ? 'ron' : null, v.pon ? 'pon' : null, v.chi.length ? 'chi' : null].filter(Boolean).join('+') || 'pass-only';

test('保存キーは mj-pon-autopass（チーは mj-chi-autopass のまま）、保存値は厳密に "1" だけが ON', () => {
  assert.equal(PON_AUTOPASS_KEY, 'mj-pon-autopass');
  assert.equal(CHI_AUTOPASS_KEY, 'mj-chi-autopass');
  for (const parse of [parsePonAutoPass, parseChiAutoPass]) {
    assert.equal(parse('1'), true);
    for (const v of [null, undefined, '', '0', 'true', 'on', ' 1', '1 ', '01', 1, true, '２']) assert.equal(parse(v), false, String(v));
  }
});

test('設定の正規化：{chi, pon} は厳密に true だけ ON、boolean は従来のチー設定（ポン OFF）', () => {
  assert.deepEqual(autoPassSettings(true), { chi: true, pon: false });
  assert.deepEqual(autoPassSettings(false), { chi: false, pon: false });
  assert.deepEqual(autoPassSettings(undefined), { chi: false, pon: false });
  assert.deepEqual(autoPassSettings({ chi: 1, pon: 'true' }), { chi: false, pon: false });
  assert.deepEqual(autoPassSettings({ chi: true, pon: true }), { chi: true, pon: true });
});

test('ロン不可・チーとポンの両方が可能：4つの組合せ（OFF/OFF 全部、ON/OFF ポン、OFF/ON チー、ON/ON 宣言全体を自動パス）', () => {
  const p = claim();
  const expect = ['pon+chi', 'pon', 'chi', null];
  SETTINGS.forEach((s, i) => {
    const auto = shouldAutoPass(p, 0, s);
    assert.equal(auto, expect[i] === null, JSON.stringify(s));
    if (!auto) assert.equal(shown(visibleClaimActions(p, s)), expect[i], JSON.stringify(s));
  });
  assert.equal(visibleClaimActions(p, { chi: true, pon: false }).passNote, 'チーも見送ります');
  assert.equal(visibleClaimActions(p, { chi: false, pon: true }).passNote, 'ポンも見送ります');
  assert.equal(visibleClaimActions(p, { chi: false, pon: false }).passNote, null);
});

test('チーだけ可能・ポンだけ可能', () => {
  const chiOnly = claim({ pon: null });
  const ponOnly = claim({ chi: [] });
  for (const s of SETTINGS) {
    assert.equal(shouldAutoPass(chiOnly, 0, s), s.chi, `チーのみ ${JSON.stringify(s)}`);
    assert.equal(shouldAutoPass(ponOnly, 0, s), s.pon, `ポンのみ ${JSON.stringify(s)}`);
    if (!s.chi) assert.equal(shown(visibleClaimActions(chiOnly, s)), 'chi');
    if (!s.pon) assert.equal(shown(visibleClaimActions(ponOnly, s)), 'pon');
  }
});

test('ロン＋チー／ロン＋ポン／ロン＋ポン＋チー：ロンは必ず表示し自動パスしない。チー・ポンは各設定に従う。「ロンしない」は残る', () => {
  const cases = [
    { p: claim({ ron: true, pon: null }), expect: ['ron+chi', 'ron', 'ron+chi', 'ron'] },
    { p: claim({ ron: true, chi: [] }), expect: ['ron+pon', 'ron+pon', 'ron', 'ron'] },
    { p: claim({ ron: true }), expect: ['ron+pon+chi', 'ron+pon', 'ron+chi', 'ron'] },
  ];
  for (const { p, expect } of cases) {
    SETTINGS.forEach((s, i) => {
      assert.equal(shouldAutoPass(p, 0, s), false);
      const v = visibleClaimActions(p, s);
      assert.equal(shown(v), expect[i], `${JSON.stringify(s)}`);
      assert.equal(v.passLabel, 'ロンしない');
    });
  }
  assert.equal(visibleClaimActions(claim({ ron: true }), { chi: true, pon: true }).passNote, 'チー・ポンも見送ります');
});

test('ツモ（手番）・終局・他の席の宣言・鳴きのない宣言は自動パスしない', () => {
  for (const s of SETTINGS) {
    assert.equal(shouldAutoPass(turn(true), 0, s), false);
    assert.equal(shouldAutoPass(turn(false), 0, s), false);
    assert.equal(shouldAutoPass(null, 0, s), false);
    assert.equal(shouldAutoPass(claim({ seat: 2 }), 0, s), false, '他の席の宣言');
    assert.equal(shouldAutoPass(claim({ chi: [], pon: null, ron: true }), 0, s), false, 'ロンのみ');
    assert.equal(visibleClaimActions(turn(true), s), null);
  }
});

test('互換：従来の boolean 設定（チーのオートパス）は Ver.0.4-A と同じ判定', () => {
  // Ver.0.4-A：チー ON・ロン不可・ポン不可・チー候補ありのときだけ自動パス
  for (const ron of [false, true]) for (const pon of [null, PON]) for (const chi of [[], CHI]) for (const on of [false, true]) {
    const p = claim({ ron, pon, chi });
    const old = on && !ron && !pon && chi.length > 0;
    assert.equal(shouldAutoPassChi(p, 0, on), old);
    // 表示：ON でロンまたはポンも可能ならチーを出さない（従来どおり）
    const v = visibleClaimActions(p, on);
    const oldHide = on && (ron || !!pon);
    assert.equal(v.chi.length, oldHide ? 0 : chi.length);
  }
});

test('自動パスに失敗したとき（画面に出る場合）は、隠す鳴きがなく通常の宣言操作に戻る', () => {
  // 可能な鳴きがすべて ON のロン不可の宣言は自動パスの対象。それでも描画する場合（失敗時）は全部を表示する
  assert.equal(shown(visibleClaimActions(claim(), { chi: true, pon: true })), 'pon+chi');
  assert.equal(shown(visibleClaimActions(claim({ pon: null }), { chi: true, pon: true })), 'chi');
  assert.equal(shown(visibleClaimActions(claim({ chi: [] }), { chi: true, pon: true })), 'pon');
  assert.deepEqual(hiddenCalls(claim(), { chi: true, pon: true }), { chi: false, pon: false });
});

test('ヒントへ渡す宣言は、表示する選択肢と同じ経路（全組合せ）。入力は変更しない', () => {
  const typeOf = () => 5;
  for (const ron of [false, true]) for (const pon of [null, PON]) for (const chi of [[], CHI]) for (const s of SETTINGS) {
    const p = claim({ ron, pon, chi });
    if (!ron && !pon && !chi.length) continue;
    const before = JSON.stringify(p);
    const v = visibleClaimActions(p, s);
    const c = claimForSeat(claimPendingForHint(p, s), 0, typeOf);
    assert.deepEqual(c.chiMelds, v.chi.map((o) => o.meld), JSON.stringify({ ron, pon: !!pon, chi: chi.length, s }));
    assert.equal(c.ponMeld ?? null, v.pon ? v.pon.meld : null);
    assert.equal(c.ron, v.ron);
    assert.equal(JSON.stringify(p), before);
  }
});

test('宣言単位の固定：宣言中に設定を変えても選択肢は変わらず、次の宣言から反映。同じ宣言の自動パスは1回だけ', () => {
  let pol = claimPolicy(null, '1:10', { chi: false, pon: false });
  const p = claim({ chi: [] }); // ポンのみ
  assert.equal(autoPassDue(pol, p, 0), false);
  // 表示中にポンを ON にしても同じ宣言の方針は変わらない
  assert.equal(claimPolicy(pol, '1:10', { chi: true, pon: true }), pol);
  assert.equal(shown(visibleClaimActions(p, policySettings(pol))), 'pon');
  // 次の宣言から ON
  pol = claimPolicy(pol, '1:14', { chi: false, pon: true });
  assert.deepEqual(policySettings(pol), { chi: false, pon: true });
  assert.equal(autoPassDue(pol, p, 0), true);
  pol.tried = true;
  assert.equal(autoPassDue(pol, p, 0), false, '同じ宣言で2回目はしない');
  assert.equal(autoPassDue(claimPolicy(pol, '1:14', { chi: false, pon: true }), p, 0), false);
  // 新しい宣言（古いキーは拒否しない）
  assert.equal(autoPassDue(claimPolicy(pol, '1:18', { chi: false, pon: true }), p, 0), true);
  assert.equal(autoPassDue(null, p, 0), false);
});

test('通知の種類：チー・ポン・両方。複数回の見送りはまとめる', () => {
  assert.equal(autoPassedKind(claim({ pon: null })), 'chi');
  assert.equal(autoPassedKind(claim({ chi: [] })), 'pon');
  assert.equal(autoPassedKind(claim()), 'both');
  assert.equal(autoPassedKind(turn(false)), null);
  assert.equal(autoPassNotice('chi'), 'チーを自動で見送りました');
  assert.equal(autoPassNotice('pon'), 'ポンを自動で見送りました');
  assert.equal(autoPassNotice('both'), 'チー・ポンを自動で見送りました');
  assert.equal(autoPassNotice(null), null);
  assert.equal(mergeKind(null, 'chi'), 'chi');
  assert.equal(mergeKind('chi', 'chi'), 'chi');
  assert.equal(mergeKind('chi', 'pon'), 'both');
  assert.equal(mergeKind('pon', null), 'pon');
});

// ---- エンジンの局面（数学Ⅱ）：自分（親・席0）が 1/2 を捨てる ----
// 席1：1/2 の対子と sin・30（ポン＋チー）。席2：1/2 でロン（tan45=1・sin90=1・cos60=1/2）。
function scene({ seat1Ron = false } = {}) {
  const g = makeGame({
    r: M2,
    hands: [
      ['=1/2', 'sin', 'sin', '0', '0', '270', '=-√3', '=-√3'],
      seat1Ron ? ['=1/2', '=1/2', 'sin', '30', 'cos', '60', 'sin', '150'] : ['=1/2', '=1/2', 'sin', '30', 'cos', 'cos', '180', '=√3'],
      ['tan', '45', '=1', 'sin', '90', '=1', 'cos', '60'],
      ['tan', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2'],
    ],
    draws: ['=-√3/2'],
  });
  g.discard(0, findTile(g, 0, '=1/2'));
  return g;
}

test('エンジン：チー＋ポン可能（ロン不可）。両方 ON で自動パスし、後続の席のロンを妨げない', () => {
  const g = scene();
  const p = g.pending();
  assert.deepEqual([p.seat, p.ron, p.chi.length > 0, !!p.pon], [1, false, true, true]);
  assert.equal(shouldAutoPass(p, 1, { chi: true, pon: true }), true);
  assert.equal(shouldAutoPass(p, 0, { chi: true, pon: true }), false, '他の席の宣言は対象外');
  assert.equal(shown(visibleClaimActions(p, { chi: true, pon: false })), 'pon');
  assert.equal(shown(visibleClaimActions(p, { chi: false, pon: true })), 'chi');
  applyAction(g, 1, { type: 'pass' });
  const q = g.pending();
  assert.deepEqual([q.seat, q.type, q.ron], [2, 'claim', true], '後続（席2）のロン判断に進む');
  assert.equal(shouldAutoPass(q, 2, { chi: true, pon: true }), false, 'ロンは自動パスしない');
  applyAction(g, 2, { type: 'ron' });
  assert.equal(g.result.winner, 2);
  g.checkInvariants();
});

test('エンジン：ポンを選んでも後続のロンが優先（ロン＞ポン）。ポン・ロンを見送ればポン（ポン＞チー）', () => {
  const g = scene();
  applyAction(g, 1, { type: 'pon' });
  assert.equal(g.melds[1].length, 0, 'ポンはロン判断が終わるまで確定しない');
  applyAction(g, 2, { type: 'ron' });
  assert.equal(g.result.winner, 2);
  const h = scene();
  applyAction(h, 1, { type: 'pon' });
  applyAction(h, 2, { type: 'pass' });
  assert.equal(h.melds[1][0].call, 'pon');
  h.checkInvariants();
});

test('エンジン：ロン＋ポン＋チー。ロンは表示・自動パスなし、各設定でチー・ポンを隠す', () => {
  const g = scene({ seat1Ron: true });
  const p = g.pending();
  assert.deepEqual([p.seat, p.ron, p.chi.length > 0, !!p.pon], [1, true, true, true]);
  const expect = ['ron+pon+chi', 'ron+pon', 'ron+chi', 'ron'];
  SETTINGS.forEach((s, i) => {
    assert.equal(shouldAutoPass(p, 1, s), false);
    assert.equal(shown(visibleClaimActions(p, s)), expect[i]);
  });
  // 「ロンしない」で見送ると後続（席2）のロン
  applyAction(g, 1, { type: 'pass' });
  assert.deepEqual([g.pending().seat, g.pending().ron], [2, true]);
  g.checkInvariants();
});
