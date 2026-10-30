// 新ルール⑤（docs/61）の画面側の純粋関数：再現 URL の newrules、ヒント（役候補・未知の牌・更新キー）の暗カン・ドラ対応。
// 従来ルール（newrules なし・doraIndicators のない view）の結果と形が変わらないことも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReplay, replayQuery } from '../src/ui/replay.js';
import { yakuCandidates, unseenFromView } from '../src/engine/yakuhint.js';
import { hintKey } from '../src/ui/hintstate.js';
import { Game } from '../src/engine/game.js';
import { rulesFor, k } from './helpers.js';

const P = (q) => new URLSearchParams(q);

test('再現URL：newrules=1 だけが新ルール。付いていなければ従来ルール、ほかの値はエラー', () => {
  const base = 'seed=5&round=1&dealer=0&hand=0&renchan=0&len=4&mode=math2';
  assert.equal(validateReplay(P(base)).values.newRules, false);
  assert.equal(validateReplay(P('seed=5&round=3')).values.newRules, false, '従来形式');
  const on = validateReplay(P(base + '&newrules=1'));
  assert.ok(on.ok); assert.equal(on.values.newRules, true);
  for (const bad of ['0', 'true', '', '2', 'yes']) {
    const r = validateReplay(P(`${base}&newrules=${bad}`));
    assert.equal(r.ok, false, bad); assert.deepEqual(r.errors.map((e) => e.key), ['newrules']);
  }
  assert.equal(validateReplay(P('newrules=1')).kind, 'none', 'seed がなければ再現ではない');
});

test('再現URLの出力：従来ルールは従来と同じ文字列、新ルールは末尾に newrules=1（読み直すと同じ値）', () => {
  const v = { seed: 9, round: 4, dealer: 2, hand: 2, renchan: 1, len: 8, mode: 'math1', chars: ['kanata', 'mitsuki', 'aoto'] };
  assert.equal(replayQuery(v), '?seed=9&round=4&dealer=2&hand=2&renchan=1&len=8&mode=math1&chars=kanata,mitsuki,aoto');
  assert.equal(replayQuery({ ...v, newRules: false }), replayQuery(v));
  const q = replayQuery({ ...v, newRules: true });
  assert.equal(q, replayQuery(v) + '&newrules=1');
  const r = validateReplay(P(q.slice(1)));
  assert.ok(r.ok); assert.equal(r.values.newRules, true); assert.equal(replayQuery(r.values), q);
});

// 自分の view（公開情報）を手で作る。melds0：自分の面子 [{ key, call }]
function viewOf(rules, { hand, melds0 = [], dora = null, rivers = [[], [], [], []] }) {
  const T = (s) => rules.typeByKey.get(k(s)).idx;
  const v = {
    seat: 0,
    hand: hand.map((s, i) => ({ id: 1000 + i, type: T(s) })),
    melds: [melds0.map(({ key, call }) => ({ meld: rules.koutsuOf(T(key)).idx, kind: 'koutsu', call, tiles: Array(call === 'ankan' ? 4 : 3).fill(T(key)), from: call === 'ankan' ? null : 1 })), [], [], []],
    rivers: rivers.map((r) => r.map(T)),
  };
  if (dora) v.doraIndicators = dora.map(([ind, d]) => ({ type: T(ind), doraType: T(d) }));
  return v;
}

test('ヒント：暗カンだけの手は門前（三暗刻などの門前限定の役も候補）。ポンでは門前限定の役は出ない', () => {
  const rules = rulesFor('math1');
  const hand = ['cos', 'cos', 'cos', 'tan', 'tan'];
  const kan = yakuCandidates(rules, viewOf(rules, { hand, melds0: [{ key: 'sin', call: 'ankan' }], dora: [['0', '30'], ['45', '60']] }), { limit: 10 });
  const pon = yakuCandidates(rules, viewOf(rules, { hand, melds0: [{ key: 'sin', call: 'pon' }], dora: [['0', '30']] }), { limit: 10 });
  const s = kan.find((c) => c.id === 'sanankou');
  assert.ok(s && s.missing === 1, '暗カン：三暗刻はあと1枚');
  assert.ok(!pon.some((c) => c.id === 'sanankou'), 'ポン：三暗刻は候補にしない');
  assert.ok(!kan.some((c) => /ドラ/.test(c.name)), 'ドラは役候補に出さない');
  assert.ok(!kan.some((c) => c.special), '暗カンのある手に特殊和了（九角無双）は出さない');
});

test('ヒント：公開されたドラ表示牌は見えている牌として数える（旧ルールの view は従来と同じ）', () => {
  const rules = rulesFor('math2');
  const legacy = viewOf(rules, { hand: ['sin', '0'] });
  const withDora = viewOf(rules, { hand: ['sin', '0'], dora: [['0', '=0'], ['sin', 'cos']] });
  const a = unseenFromView(rules, legacy), b = unseenFromView(rules, withDora);
  const T = (s) => rules.typeByKey.get(k(s)).idx;
  assert.equal(a[T('0')] - b[T('0')], 1); assert.equal(a[T('sin')] - b[T('sin')], 1);
  assert.equal(a.reduce((x, y) => x + y, 0) - b.reduce((x, y) => x + y, 0), 2, '表示牌の2枚だけ減る');
  // ドラ（表示牌の次の牌）は見えている牌ではない
  assert.equal(a[T('=0')], b[T('=0')]); assert.equal(a[T('cos')], b[T('cos')]);
});

test('ヒントの更新キー：新ルールではドラ表示牌が増えると変わる。旧ルールの view のキーは従来と同じ形', () => {
  const rules = rulesFor('math1');
  const legacy = viewOf(rules, { hand: ['sin', '0'] });
  assert.deepEqual(Object.keys(JSON.parse(hintKey(legacy, null))), ['hand', 'rivers', 'melds', 'claim']);
  const one = viewOf(rules, { hand: ['sin', '0'], dora: [['0', '30']] });
  const two = viewOf(rules, { hand: ['sin', '0'], dora: [['0', '30'], ['45', '60']] });
  assert.notEqual(hintKey(one, null), hintKey(two, null));
});

test('ヒント：新ルールの実際の Game でも、役候補は公開情報（view と宣言）だけを読む', () => {
  const rules = rulesFor('math1');
  const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
  for (let seed = 1; seed <= 20; seed++) {
    const g = new Game({ rules, seed, dealer: 0, players, newRules: true });
    const accessed = new Set();
    const track = (obj, path) => new Proxy(obj, {
      get(t, key) {
        if (typeof key === 'string' && !/^\d+$/.test(key)) accessed.add(`${path}.${key}`);
        const val = t[key];
        return val && typeof val === 'object' ? track(val, `${path}.${typeof key === 'string' && /^\d+$/.test(key) ? '#' : String(key)}`) : val;
      },
    });
    yakuCandidates(rules, track(g.viewFor(0), 'view'));
    const fields = [...accessed].filter((a) => /^view\.[a-zA-Z]+$/.test(a)).map((a) => a.slice(5));
    for (const f of fields) assert.ok(['seat', 'hand', 'melds', 'rivers', 'doraIndicators'].includes(f), `想定外の参照 ${f}`);
    assert.ok(fields.includes('doraIndicators'));
  }
});
