// 役ガイドの説明文と数式例（Ver.0.2-A）。
// 得点・門前限定・有効/無効は config.js から表示し、ここには書かない（二重管理を防ぐ）。
// 数式例は tests/guide.test.js で「既存の役判定で実際にその役が成立する」ことを確認している。
// 面子は rules.melds の key（数式面子は 'sin30=1/2'、刻子は 'f:sin×3' のように牌の key＋×3）、特殊和了は角度の配列で書く。
// examples.math1：数学Ⅰ（0°〜180°）に無い角度を使う例の差し替え（tests/guide.test.js で各モードを確認）。
// 条件文の角度は {a:90}（1つ）・{list:30,45,60}（「・」区切り）・{tanUndefined}（tan が定義されない角度）で書き、
// guideCondition() がモードの表記（数学Ⅰ・旧規則は度数法、数学Ⅱは弧度法）に変換する。

import { radianParts } from '../engine/rules.js';

// 角度の表記（文字列）：度数法 '90°'、弧度法 'π/2'（0 は '0'）
export function angleLabel(deg, unit) {
  if (unit !== 'rad') return `${deg}°`;
  const r = radianParts(deg);
  return r.den ? `${r.num}/${r.den}` : r.num;
}

// 条件文をモードの表記に変換する。unit：'deg' | 'rad'、degs：そのモードの角度（度）の一覧
export function guideCondition(text, { unit = 'deg', degs = [] } = {}) {
  return text
    .replace(/\{a:(\d+)\}/g, (_, d) => angleLabel(Number(d), unit))
    .replace(/\{list:([\d,]+)\}/g, (_, l) => l.split(',').map((d) => angleLabel(Number(d), unit)).join('・'))
    .replace(/\{tanUndefined\}/g, () => degs.filter((d) => d % 180 === 90).map((d) => angleLabel(d, unit)).join('・'))
    .replace(/\{axes\}/g, () => (degs.length ? degs : [0, 90, 180, 270, 360]).filter((d) => d % 90 === 0).map((d) => angleLabel(d, unit)).join('・'))
    // {quadrants}：そのモードにある象限と角度（数学Ⅰは第1・第2象限、数学Ⅱは第1〜第4象限）
    .replace(/\{quadrants\}/g, () => Object.entries(QUADRANTS).filter(([, q]) => q.every((d) => !degs.length || degs.includes(d)))
      .map(([n, q]) => `第${n}象限（${q.map((d) => angleLabel(d, unit)).join('・')}）`).join('／'));
}
const QUADRANTS = { 1: [30, 45, 60], 2: [120, 135, 150], 3: [210, 225, 240], 4: [300, 315, 330] };

export const YAKU_GUIDE = {
  sankan: {
    condition: '3つの面子で sin・cos・tan を1組ずつ使う。',
    example: ['sin30=1/2', 'cos180=-1', 'tan45=1'],
  },
  doukan: {
    condition: '3つの面子がすべて同じ関数（すべて sin など）。',
    example: ['cos0=1', 'cos90=0', 'cos180=-1'],
  },
  yokaku: {
    condition: 'sin θ と cos({a:90}−θ) の2組を含む（{a:0}≦θ≦{a:90}）。sin θ = cos({a:90}−θ) の関係。',
    example: ['sin30=1/2', 'cos60=1/2', 'tan180=0'],
  },
  sanshougen: {
    condition: '3組の角度が、それぞれ異なる3つの象限にある（{list:0,90,180,270,360} を含まない）。',
    example: ['sin30=1/2', 'cos135=-1/√2', 'tan240=√3'],
  },
  shougen: {
    condition: '3組の角度がすべて同じ1つの象限にある：{quadrants}。どの象限でも同じ点数。同じ角度を重ねてもよい。軸上の角度（{axes}）を含むと不可。',
    example: ['sin30=1/2', 'cos30=√3/2', 'sin60=√3/2'],
  },
  shougenSankaku: {
    condition: '1つの象限の3つの角度を1回ずつ使う（例：{list:30,45,60}）。象限一色も同時に成立。',
    example: ['sin30=1/2', 'cos45=1/√2', 'tan60=√3'],
  },
  douchi: {
    condition: '3組の結果（= の値）がすべて同じ。',
    example: ['sin30=1/2', 'cos60=1/2', 'sin150=1/2'],
  },
  doukaku: {
    condition: '同じ角度で sin・cos・tan の3組を作る（{tanUndefined} は tan がないので不可）。',
    example: ['sin225=-1/√2', 'cos225=-1/√2', 'tan225=1'],
    examples: { math1: ['sin45=1/√2', 'cos45=1/√2', 'tan45=1'] },
  },
  sanjuu: {
    condition: 'まったく同じ面子を3組作る（関数・角度・結果の牌がそれぞれ3枚必要）。',
    example: ['sin30=1/2', 'sin30=1/2', 'sin30=1/2'],
  },
  // ---- Ver.0.3 の刻子系の役（点数は暫定） ----
  toitoi: {
    condition: '3組すべてが刻子（同じ牌3枚）。ポンしてもよい。',
    example: ['v:0×3', 'a:45×3', 'f:cos×3'],
  },
  sanankou: {
    condition: '3組すべてが門前の刻子（ポン・チーなし）。ロンで最後の刻子を完成させた場合も成立（Ver.0.3 の暫定規則。通常の麻雀とは異なる）。対々和も同時に成立。',
    example: ['v:0×3', 'a:45×3', 'f:cos×3'],
  },
  sinIsshoku: {
    condition: '9枚すべて sin 牌（sin の刻子3組）。ポンしてもよい。',
    example: ['f:sin×3', 'f:sin×3', 'f:sin×3'],
  },
  cosIsshoku: {
    condition: '9枚すべて cos 牌（cos の刻子3組）。ポンしてもよい。',
    example: ['f:cos×3', 'f:cos×3', 'f:cos×3'],
  },
  tanIsshoku: {
    condition: '9枚すべて tan 牌（tan の刻子3組）。ポンしてもよい。',
    example: ['f:tan×3', 'f:tan×3', 'f:tan×3'],
  },
  kyukaku: {
    condition: '角度牌 {list:0,30,45,60,90,120,135,150,180} を1枚ずつ、計9枚（面子は不要）。',
    exampleAngles: [0, 30, 45, 60, 90, 120, 135, 150, 180],
  },
  urakyukaku: {
    condition: '角度牌 {list:180,210,225,240,270,300,315,330,360} を1枚ずつ（Ver.0.1・0.2 では無効）。',
    exampleAngles: [180, 210, 225, 240, 270, 300, 315, 330, 360],
  },
};

export const GUIDE_NOTES = [
  '面子は「関数牌＋角度牌＋結果牌」で正しい等式になる3枚（数式面子）か、同じ牌3枚（刻子）。9枚で3面子そろえば和了（雀頭なし）。',
  '門前（チー・ポンをしていない）なら役がなくても和了できる（通常和了 1点）。',
  'チー・ポンをした手は、役が1つ以上ないと和了できない。門前限定の役は、鳴くと成立しない。',
  '数式系の役は3組すべてが数式面子のときだけ付く。刻子を含む混合形には付かない。',
  '通常役は通常和了の点に加算する。役満が成立したときは役満の点だけ（通常役は加算しない）。点数は試作段階の暫定値。',
];
