// MATHJONG の設定データ。
// 牌の枚数・角度の採否・役の点数などはすべてここで管理し、ロジックにハードコードしない。
// 「provisional: true」は暫定採用（未承認・後日変更前提）を表す。
//
// Ver.0.3-A：9枚制（配牌8枚＋ツモ1枚、3面子で和了、雀頭なし）に「刻子」「ポン」と新役を追加し、
// 数学Ⅰ（度数法・0°〜180°・124枚）と数学Ⅱ（弧度法・0〜2π・168枚）の2モードを持つ。
// 内部の角度は常に度（deg）で持ち、弧度法は画面表示だけで切り替える（angleUnit）。

export const ENGINE_VERSION = '0.6.0';

// Ver.0.1〜0.2.1 の規則（刻子・ポンなし、数式面子のみ、関数牌各16枚・0°〜360°）。
// 互換テストと tools/simulate.mjs --legacy で使う（Ver.0.1 と同じ結果になることを確認する）。
export const LEGACY_V02_CONFIG = {
  mode: 'legacy',
  angleUnit: 'deg',
  handSize: 8,

  // 関数牌（各16枚：暫定採用。旧比較の有力候補）
  functions: [
    { key: 'sin', copies: 16 },
    { key: 'cos', copies: 16 },
    { key: 'tan', copies: 16 },
  ],

  // 角度牌（各4枚）。360°は採否未決定のため enabled で切り替え可能（Ver.0.1 は暫定的に使用）
  angles: [
    { deg: 0, copies: 4, enabled: true },
    { deg: 30, copies: 4, enabled: true },
    { deg: 45, copies: 4, enabled: true },
    { deg: 60, copies: 4, enabled: true },
    { deg: 90, copies: 4, enabled: true },
    { deg: 120, copies: 4, enabled: true },
    { deg: 135, copies: 4, enabled: true },
    { deg: 150, copies: 4, enabled: true },
    { deg: 180, copies: 4, enabled: true },
    { deg: 210, copies: 4, enabled: true },
    { deg: 225, copies: 4, enabled: true },
    { deg: 240, copies: 4, enabled: true },
    { deg: 270, copies: 4, enabled: true },
    { deg: 300, copies: 4, enabled: true },
    { deg: 315, copies: 4, enabled: true },
    { deg: 330, copies: 4, enabled: true },
    { deg: 360, copies: 4, enabled: true, provisional: true },
  ],

  // 結果牌（13種類×各4枚）。exact は (p/q)·√r。display は画面表示用の構造。
  values: [
    { key: '0', exact: [0, 1, 1], display: { neg: false, num: '0' } },
    { key: '1', exact: [1, 1, 1], display: { neg: false, num: '1' } },
    { key: '-1', exact: [-1, 1, 1], display: { neg: true, num: '1' } },
    { key: '1/2', exact: [1, 2, 1], display: { neg: false, num: '1', den: '2' } },
    { key: '-1/2', exact: [-1, 2, 1], display: { neg: true, num: '1', den: '2' } },
    { key: '1/√2', exact: [1, 2, 2], display: { neg: false, num: '1', den: '√2' } },
    { key: '-1/√2', exact: [-1, 2, 2], display: { neg: true, num: '1', den: '√2' } },
    { key: '√3/2', exact: [1, 2, 3], display: { neg: false, num: '√3', den: '2' } },
    { key: '-√3/2', exact: [-1, 2, 3], display: { neg: true, num: '√3', den: '2' } },
    { key: '1/√3', exact: [1, 3, 3], display: { neg: false, num: '1', den: '√3' } },
    { key: '-1/√3', exact: [-1, 3, 3], display: { neg: true, num: '1', den: '√3' } },
    { key: '√3', exact: [1, 1, 3], display: { neg: false, num: '√3' } },
    { key: '-√3', exact: [-1, 1, 3], display: { neg: true, num: '√3' } },
  ].map((v) => ({ copies: 4, ...v })),

  rules: {
    maxChi: 2, // 3回目のチーは手牌0枚になるため不可（その牌で完成するならロンになる）
    ronOverChi: true, // ロンはチーより優先
    headBump: true, // 複数ロンは打牌者から手番順に最も近い1人（アタマハネ）
    furiten: false, // Ver.0.1 ではフリテン未実装
    calledHandNeedsYaku: true, // チーした手は役が必要
  },

  scoring: {
    base: 1, // 通常和了の基本点
    yakumanOverridesNormal: true, // 役満成立時は通常和了点・通常役を加算しない
    yakumanStack: true, // 複数役満は加算
  },

  // 役（3面子で判定）。points は仮得点。closedOnly=true の役はチーした手では成立しない。
  yaku: [
    { id: 'sankan', name: '三関制覇', points: 1, closedOnly: false, enabled: true },
    { id: 'doukan', name: '同関一色', points: 2, closedOnly: false, enabled: true },
    { id: 'yokaku', name: '余角対', points: 2, closedOnly: false, enabled: true },
    { id: 'sanshougen', name: '三象限巡り', points: 2, closedOnly: false, enabled: true },
    { id: 'shougen1', name: '第1象限一色', points: 3, closedOnly: false, enabled: true },
    { id: 'shougen2', name: '第2象限一色', points: 3, closedOnly: false, enabled: true },
    { id: 'shougen3', name: '第3象限一色', points: 3, closedOnly: false, enabled: true },
    { id: 'shougen4', name: '第4象限一色', points: 3, closedOnly: false, enabled: true },
    { id: 'shougenSankaku', name: '象限三角揃い', points: 4, closedOnly: false, enabled: true },
    { id: 'douchi', name: '同値三連', points: 4, closedOnly: false, enabled: true },
    { id: 'doukaku', name: '同角三関', points: 16, yakuman: true, closedOnly: false, enabled: true, provisional: true },
    { id: 'sanjuu', name: '三重同式', points: 16, yakuman: true, closedOnly: false, enabled: true, provisional: true },
  ],

  // 特殊和了（3面子を必要としない9枚形）
  specialHands: [
    {
      id: 'kyukaku', name: '九角無双', points: 16, yakuman: true, closedOnly: true, enabled: true,
      angles: [0, 30, 45, 60, 90, 120, 135, 150, 180],
    },
    {
      // ユーザー未承認のため無効。360°を使うので 360° が無効なら成立不可能。
      id: 'urakyukaku', name: '裏九角無双', points: 16, yakuman: true, closedOnly: true, enabled: false,
      angles: [180, 210, 225, 240, 270, 300, 315, 330, 360],
    },
  ],
};


// ---- Ver.0.3 の新役（刻子系）。点数は Ver.0.3 試作段階の暫定値 ----
// category: 'formula'＝数式系（3組とも数式面子のときだけ評価）／'koutsu'＝刻子系。役候補ヒントの並び順に使う。
const KOUTSU_YAKU = [
  { id: 'toitoi', name: '対々和', points: 3, closedOnly: false, enabled: true, category: 'koutsu', provisional: true },
  // 三暗刻：門前の刻子3組。ロンで最後の刻子を完成させた場合も成立（rules.sanankouRonCounts、暫定）。
  { id: 'sanankou', name: '三暗刻', points: 5, closedOnly: true, enabled: true, category: 'koutsu', provisional: true },
  { id: 'sinIsshoku', name: '正弦一色', points: 16, yakuman: true, closedOnly: false, enabled: true, category: 'koutsu', fn: 'sin', provisional: true },
  { id: 'cosIsshoku', name: '余弦一色', points: 16, yakuman: true, closedOnly: false, enabled: true, category: 'koutsu', fn: 'cos', provisional: true },
  { id: 'tanIsshoku', name: '正接一色', points: 16, yakuman: true, closedOnly: false, enabled: true, category: 'koutsu', fn: 'tan', provisional: true },
];

// 数学Ⅰでは 0°〜180° しかないため、第3・第4象限を使う役は成立しない（tests/modes.test.js で全組合せを確認）
const MATH1_IMPOSSIBLE = ['sanshougen', 'shougen3', 'shougen4'];

export const MODES = {
  math1: { id: 'math1', label: '数学Ⅰ', unit: 'deg', maxDeg: 180, functionCopies: 12 },
  math2: { id: 'math2', label: '数学Ⅱ', unit: 'rad', maxDeg: 360, functionCopies: 16 },
};
export const DEFAULT_MODE = 'math2'; // 既存版との継続性のため暫定で数学Ⅱ

// Ver.0.3 の設定（mode: 'math1' | 'math2'）
export function modeConfig(mode = DEFAULT_MODE) {
  const m = MODES[mode];
  if (!m) throw new Error(`unknown mode ${mode}`);
  const c = clone(LEGACY_V02_CONFIG);
  c.mode = m.id;
  c.angleUnit = m.unit;
  for (const f of c.functions) f.copies = m.functionCopies;
  c.angles = c.angles.filter((a) => a.deg <= m.maxDeg);
  c.rules = {
    ...c.rules,
    koutsu: true, // 同じ種類の牌3枚を面子（刻子）として認める
    pon: true, // ポン（他家3人の打牌）。優先順位はロン＞ポン＞チー
    maxCalls: 2, // チーとポンの合計
    calledHandNeedsYaku: true, // チー・ポンをした手は役が必要
    sanankouRonCounts: true, // 三暗刻：ロンで完成した刻子も暗刻に数える（暫定。通常の麻雀とは異なる）
    riichi: true, // リーチ（門前・聴牌で宣言。以後ツモ切りのみ・チー／ポン不可・ロン／ツモ可）
    riichiBonus: 1, // リーチして和了したときの加点（基本点に加算。役満には加算しない）
  };
  delete c.rules.maxChi;
  // 既存の役は数式系：3組とも数式面子のときだけ評価する
  for (const y of c.yaku) {
    y.formulaOnly = true;
    y.category = 'formula';
    if (mode === 'math1' && MATH1_IMPOSSIBLE.includes(y.id)) { y.enabled = false; y.disabledReason = '数学Ⅰ（0°〜180°）では成立しない'; }
  }
  c.yaku.push(...clone(KOUTSU_YAKU));
  // 役候補ヒント：刻子系の役は「あと何枚」に1枚分を足した順位で並べる（数式系を優先。表示する枚数は正確な値）
  c.hint = { koutsuPenalty: 1 };
  for (const s of c.specialHands) s.category = 'formula';
  return c;
}

export const DEFAULT_CONFIG = modeConfig(DEFAULT_MODE);

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// 設定の上書き。例: makeConfig({ mode: 'math1' }) / makeConfig({ legacy: true, disableAngles: [360] })
// mode: 'math1' | 'math2'（既定は DEFAULT_MODE）、legacy: true で Ver.0.2.1 までの規則
export function makeConfig({ mode = DEFAULT_MODE, legacy = false, disableAngles = [], enableSpecial = [], functionCopies, yakuPoints = {}, rules: ruleFlags = {} } = {}) {
  const c = legacy ? clone(LEGACY_V02_CONFIG) : modeConfig(mode);
  Object.assign(c.rules, ruleFlags);
  for (const a of c.angles) if (disableAngles.includes(a.deg)) a.enabled = false;
  for (const s of c.specialHands) if (enableSpecial.includes(s.id)) s.enabled = true;
  if (functionCopies) for (const f of c.functions) f.copies = functionCopies;
  for (const y of c.yaku) if (y.id in yakuPoints) y.points = yakuPoints[y.id];
  return c;
}
