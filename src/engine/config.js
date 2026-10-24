// MATHJONG Ver.0.1 の設定データ。
// 牌の枚数・角度の採否・役の点数などはすべてここで管理し、ロジックにハードコードしない。
// 「provisional: true」は Ver.0.1 の暫定採用（未承認・後日変更前提）を表す。

export const ENGINE_VERSION = '0.1.0';

export const DEFAULT_CONFIG = {
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

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// 設定の上書き。例: makeConfig({ disableAngles: [360], enableSpecial: ['urakyukaku'] })
export function makeConfig({ disableAngles = [], enableSpecial = [], functionCopies, yakuPoints = {} } = {}) {
  const c = clone(DEFAULT_CONFIG);
  for (const a of c.angles) if (disableAngles.includes(a.deg)) a.enabled = false;
  for (const s of c.specialHands) if (enableSpecial.includes(s.id)) s.enabled = true;
  if (functionCopies) for (const f of c.functions) f.copies = functionCopies;
  for (const y of c.yaku) if (y.id in yakuPoints) y.points = yakuPoints[y.id];
  return c;
}
