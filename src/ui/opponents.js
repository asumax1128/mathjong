// 対戦相手の自由選択（Ver.0.6）：12人から重複なしで3人を選ぶ。画面から独立した純粋関数（tests/opponents.test.js で検査）。
// 一覧の並び（OPPONENTS）は初級4人→中級4人→上級4人。旧9人の名簿・AI判断はそのまま。
// 選択は画面の記憶の中だけで持ち、保存しない（再読み込みで0人に戻る）。
import { CHARACTER_ROSTER } from '../engine/characters.js';

export const PICK_COUNT = 3;
export const LEVEL_LABELS = { beginner: '初級', intermediate: '中級', advanced: '上級', additional: '個性型' };

// 紹介文：正式なキャラクター設定（名前・年齢・難易度、docs/25）と、実装済み AI の実際の打ち方（docs/28・docs/29）に合わせる。
// trait：一覧に出す性格の一言。personality：性格。style：打ち筋。
const PROFILES = {
  kanata: {
    trait: '冷静に待ちを見る',
    personality: 'あおとの兄。落ち着いて場を観察する。',
    style: '聴牌と待ちの残り枚数を重視して打つ。チー・ポンはしない。弟のあおとが捨てた牌の傾向を少しだけ読む（公開された捨て牌だけ）。',
  },
  mitsuki: {
    trait: 'sinが大好き',
    personality: 'sin の牌がお気に入り。好きな牌はなかなか手放さない。',
    style: 'sin の関数牌と、sin の数式になりそうな牌を残して役を狙う。チー・ポンはしない。',
  },
  aoto: {
    trait: '鳴くのが大好き',
    personality: 'かなたの弟。思いつきで動く自由奔放なタイプ。',
    style: 'チー・ポンができるとほとんど鳴く。鳴いた後の役作りは苦手で、捨て牌も気まぐれ。',
  },
  ousuke: {
    trait: '負けると熱くなる',
    personality: '負けず嫌い。点差が開くと焦りやすい。',
    style: 'ふだんは速さ重視。下位で点差が開くと鳴きが増え、大きく負けると打ち方が荒くなる。トップのときはほとんど鳴かない。',
  },
  natsuki: {
    trait: '門前で高い手',
    personality: '落ち着いた幸運型。じっくり手を育てる。',
    style: '門前（鳴かない）で高い役を狙う。チー・ポンは和了の見込みがはっきり良くなるときだけ。',
  },
  yuki: {
    trait: '点差で攻守切替',
    personality: '状況をよく見る逆転狙い。焦らない。',
    style: '上位では門前と安全を重視し、下位になると鳴いて追い上げる。点差に応じて攻めと守りを切り替える。',
  },
  fukuyama: {
    trait: '守備重視の理論派',
    personality: '理論派。危ない牌はできるだけ切らない。',
    style: '公開情報から当たりやすい牌を見積もり、放銃を避けて守る。最終局は2位以内を目標に、届いていれば守り、届かなければ攻める。鳴きは少ない。',
  },
  kaoru: {
    trait: 'ヨイショの達人',
    personality: '実力派のお調子者。アスマには少し甘い。',
    style: '高い役を狙いつつ、役のある鳴きも使う柔軟な打ち方。アスマが最下位で大きく負けているときは、まれにアスマに当たりそうな牌をわざと切ることがある。',
  },
  asuma: {
    trait: '高得点の勝負師',
    personality: '勝負師。大きな手のためなら危険も恐れない。',
    style: '高得点の役を最優先する。大きな手が見えると、危険な牌でも押して勝負する。',
  },
  yujin: {
    trait: '鳴かずに刻子を育てる',
    personality: 'こつこつ同じ牌を集める、粘り強いタイプ。',
    style: 'チー・ポンをせず、刻子がそろう形を目指す。数式が完成したときも、ロン・ツモを見逃さない。',
  },
  tara: {
    trait: '待ちを育てて勝負',
    personality: 'すぐには決めず、好機を待つ慎重なタイプ。',
    style: '待ちの残り枚数を重視する。弱い待ちは最大2巡までリーチを保留するが、他家のリーチや山の残りが少ないときは保留しない。',
  },
  nocchi: {
    trait: '相手の動きに適応',
    personality: '相手の癖を観察し、柔軟に守り方を変えるタイプ。',
    style: '公開された鳴きやリーチの傾向を、この試合の過去局から見て攻守を調整する。他家の手牌や山の順番は見ない。',
  },
};

// 旧9人は元の難易度グループを維持。新3人は明示されたlevelに従い各グループ末尾へ追加する。
// 今後の正式イラストは PROFILES[id].artSrc に静的な素材パスを追加する。
// 一覧は画像を表示せず、詳細画面（oppDetailHTML）のみで必要な時に読み込む。
export const OPPONENTS = Object.freeze(
  ['beginner', 'intermediate', 'advanced'].flatMap((level) => [...CHARACTER_ROSTER[level], ...CHARACTER_ROSTER.additional.filter((c) => c.level === level)].map((c) => Object.freeze({
    id: c.id, name: c.name, age: c.age, level, levelLabel: LEVEL_LABELS[level], personalityKey: c.personality, styleLabel: c.styleLabel,
    ...PROFILES[c.id],
  }))),
);
const BY_ID = new Map(OPPONENTS.map((o) => [o.id, o]));
export const opponentById = (id) => BY_ID.get(id) || null;
export const isOpponentId = (id) => BY_ID.has(id);

// 選択の切り替え：選択済みなら外す。未選択なら、3人未満のときだけ加える（4人目は加えない）。
// 戻り値 { selected：新しい配列, changed, reason：'added'|'removed'|'full'|'unknown' }
export function toggleOpponent(selected, id, max = PICK_COUNT) {
  if (!isOpponentId(id)) return { selected: selected.slice(), changed: false, reason: 'unknown' };
  if (selected.includes(id)) return { selected: selected.filter((x) => x !== id), changed: true, reason: 'removed' };
  if (selected.length >= max) return { selected: selected.slice(), changed: false, reason: 'full' };
  return { selected: [...selected, id], changed: true, reason: 'added' };
}

// ちょうど3人・重複なし・名簿にいる人だけ
export function canStartWith(selected, max = PICK_COUNT) {
  return Array.isArray(selected) && selected.length === max && new Set(selected).size === max && selected.every(isOpponentId);
}

// おまかせ：名簿から異なる k 人を一様に選ぶ（部分的な Fisher–Yates。どの k 人の組も同じ確率。12人・3人なら 220 通り）。
// rand：[0,1) の乱数（画面では Math.random。AI の判断の乱数とは別）。並びは一覧の順に整える。
export function drawOpponents(rand, k = PICK_COUNT, ids = OPPONENTS.map((o) => o.id)) {
  const a = ids.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const pick = new Set(a.slice(0, k));
  return ids.filter((id) => pick.has(id));
}

// 座席：人間は席0。選んだ3人を席1〜3（下家・対面・上家）へ一様にランダムに並べる（6通り）。戻り値は席1〜3の順の ID。
export function assignSeats(chosen, rand) {
  const a = chosen.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 再現 URL の chars（席1〜3の順の ID、カンマ区切り）の検証。正しければ ID の配列、そうでなければ null。
export function parseChars(v) {
  if (typeof v !== 'string') return null;
  const ids = v.split(',');
  return canStartWith(ids) ? ids : null;
}
