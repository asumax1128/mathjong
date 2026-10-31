// 初心者の部屋の実戦形式の課題：実際の対局エンジン（Game）で固定の局面を進める練習（段階と課題の並びは beginner-room.js）。
// 版2（docs/67）：捨て牌の判断（D1）・聴牌と待ち（T1）・リーチ（5A：ボタンの強調・宣言前の待ちの確認・宣言料）・フリテン（F1・F2）を追加。
// 課題ごとのルールの版（ruleset）：新しい課題は現行（2：フリテン・待ちの表示）。鳴きのポン課題7-Cは現行ruleset 2で行い、関数牌をポンしない。ほかの既存鳴き課題は互換性を維持。
// ・山は presetWall で固定（seed も固定）。練習用CPUは台本どおりの公開行動だけをする（ツモした牌をそのまま捨てる・宣言はすべて見送る）。
// ・人間の選択肢（チー・ポン・ロン・ツモ・リーチ）は Game.pending() / riichiOptions() が返すものだけを画面に出す（偽のボタンは作らない）。
// ・判定・和了・点数はすべて既存のエンジン（Game・rules・match）のもの。この画面は通常対局の規則・AI・記録を変更しない。
// 第4・5段階の課題では、練習の流れから外れる操作（例：チーの練習で「見送る」）は実行せず、理由を表示してやり直してもらう。
// 第6段階（卒業試験）は自由に打てる（誤りはヒントで知らせ、「やり直し」で最初の局面からやり直せる）。
import { Game } from '../engine/game.js';
import { settle, createMatch, applyRoundResult } from '../engine/match.js';
import { tileHTML, tileLabel, formulaHTML } from './render.js';
import { tenpaiWaitsView } from './waits-view.js';
import { RIICHI_DEPOSIT } from '../engine/match.js';

export const HUMAN = 0;
export const SEAT_NAMES = ['あなた', '下家（右）', '対面（向かい）', '上家（左）'];
const CPU_LABEL = '練習用CPU';

// 練習用CPUの配牌（8枚）。CPUはツモした牌をそのまま捨てるだけなので、手牌の中身は画面にも進行にも出ない。
const CPU_HANDS = [
  ['sin', 'sin', 'cos', 'cos', 'tan', 'tan', '=-√3', '=-1/√3'],
  ['sin', 'cos', 'tan', '180', '90', '=√3', '=-1/√2', '=-√3/2'],
  ['sin', 'cos', 'tan', '150', '135', '120', '=1/√2', '=0'],
];

// 牌種類 key の短縮表記：'sin' / '30' / '=1/2'
const key = (s) => (s.startsWith('=') ? `v:${s.slice(1)}` : /^\d+$/.test(s) ? `a:${s}` : `f:${s}`);

// 課題の定義。hand：あなたの配牌8枚。draws：配牌の後に引かれる順（親の9枚目から）。pauses：n 回目のCPUの打牌の直後に止めて説明する。
// check(p, act)：練習の流れに合わない操作なら理由（文字列）を返す。goal(p)：達成なら完了の説明を返す。
export const LESSONS = Object.freeze([
  {
    id: 'D1', label: '2-B', title: '捨てる牌を選ぶ', ruleset: 2,
    lead: '9枚から1枚捨てるよ。完成している sin 30° = 1/2 と、あと1枚で完成する cos 60°・tan 45° は残して、使い道のない牌を捨てよう。',
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '60', 'tan', '45', '135'],
    draws: ['90'],
    check: (p, act) => {
      if (act.type !== 'discard') return null;
      const k = tileKeyOf(p, act.id);
      if (['f:sin', 'a:30', 'v:1/2'].includes(k)) return 'その牌は完成している sin 30° = 1/2 の一部だよ。完成した面子はくずさないでおこう。';
      if (['f:cos', 'a:60', 'f:tan', 'a:45'].includes(k)) return 'cos 60° と tan 45° は、あと1枚（=1/2・=1）で完成するよ。ほかの牌を捨てよう。';
      return null;
    },
    goal: (p) => (humanDiscards(p) >= 1 ? 'よい判断！　完成した面子と、あと1枚で完成する組を残したね。これで =1/2 か =1 を引けば、もう1組完成するよ。' : null),
    hint: '135° と 90° は、手の中で面子になりにくい牌だよ。どちらかを捨てよう。',
  },
  {
    id: 'T1', label: '3-A', title: '聴牌（テンパイ）を作る', ruleset: 2, showWaits: true,
    lead: 'あと1枚で和了の形を「聴牌」というよ。牌を1回タップすると、その牌を捨てた後の待ち牌が手牌の上に出るよ。聴牌になる牌を捨てよう。',
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '60', '=1/2', 'tan', '135'],
    draws: ['45'],
    check: (p, act) => {
      if (act.type !== 'discard') return null;
      return waitsAfter(p, act.id).length ? null : 'その牌を捨てても聴牌にならないよ（待ち牌が表示されない）。待ちが表示される牌を探そう。';
    },
    goal: (p) => {
      if (humanDiscards(p) < 1) return null;
      const w = p.game.shapeWaits(HUMAN) || [];
      return w.length ? `聴牌！　待ちは ${w.map((t) => tileLabel(p.game.rules.types[t])).join('・')}。この牌が来れば和了だよ。` : null;
    },
    hint: '135° を捨てると tan 45° の =1 待ち、45° を捨てると tan 135° の =−1 待ちになるよ。',
  },
  {
    id: '4A', label: '7-A', title: 'チーを体験',
    lead: '上家（左の人）が捨てた牌で数式面子ができるとき「チー」ができるよ。sin と 30° を持っているね。',
    dealer: 3,
    hand: ['sin', '30', 'cos', '0', '=1', 'tan', '45', '90'],
    draws: ['=1/2'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'chi' ? 'ここではチーを押して、sin 30° = 1/2 を完成させよう。' : null),
    goal: (p) => (calledAndDiscarded(p, 'chi') ? 'チー成功！　上家の =1/2 で sin 30° = 1/2 を公開し、ツモをせずに1枚捨てたよ。' : null),
    hint: 'チーのボタンには、できあがる数式が書いてあるよ。チーの後は、使わない牌（90°）を捨てよう。',
  },
  {
    id: '4B', label: '7-B', title: 'チーできない場面',
    lead: 'チーできるのは上家（左の人）の捨て牌だけ。ほかの人が同じ牌を捨てたときはどうなるかな。',
    dealer: 1,
    hand: ['sin', '30', 'cos', '0', '=1', 'tan', '45', '90'],
    draws: ['=1/2', '=1/2', '=1/2'],
    pauses: {
      1: '下家（右の人）が =1/2 を捨てたよ。sin と 30° を持っているのに、チーのボタンは出ないね。下家は上家ではないからだよ。',
      2: '対面（向かいの人）の =1/2 でも、チーのボタンは出ないよ。次は上家（左の人）の番だよ。',
    },
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'chi' ? '上家の =1/2 なのでチーができるよ。チーを押してみよう。' : null),
    goal: (p) => (calledAndDiscarded(p, 'chi') ? 'そのとおり！　同じ =1/2 でも、チーできたのは上家の捨て牌だけだったね。' : null),
    hint: '下家・対面の捨て牌では「続ける」を押そう。上家の =1/2 でチーのボタンが出るよ。',
  },
  {
    id: '4C', label: '7-C', title: 'ポン', ruleset: 2,
    lead: '同じ角度牌を2枚持っているとき、だれかが同じ角度牌を捨てたら「ポン」で刻子（同じ牌3枚）を作れるよ。ポンは上家以外からでもできるよ。sin・cos・tan の関数牌はポンできないよ。',
    dealer: 2,
    hand: ['45', '45', 'cos', '0', '=1', 'tan', 'sin', '90'],
    draws: ['45'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'pon' ? '45° を2枚持っているよ。ポンを押してみよう。' : null),
    goal: (p) => (calledAndDiscarded(p, 'pon') ? 'ポン成功！　対面の 45° で 45°×3 の刻子を公開し、1枚捨てたよ。関数牌はポンできないことも覚えておこう。' : null),
    hint: '対面が捨てた 45° と、手の 45° 2枚で刻子になるよ。sin・cos・tan はポンできないよ。ポンの後は1枚捨てるよ。',
  },
  {
    id: '4D', label: '7-D', title: '鳴いた後のルール',
    lead: 'チー・ポンをした手で和了するには「役」が必要だよ。まず上家の =1/2 をチーして、使わない 135° を捨てよう。',
    dealer: 3,
    hand: ['sin', '30', 'tan', '45', '=1', 'sin', '=√3/2', '135'],
    draws: ['=1/2', '120', '60'],
    pauses: {
      2: '下家が 120° を捨てたよ。sin 120° = √3/2 で形は完成するのに、ロンのボタンは出ないね。鳴いた手で、役がないからだよ。',
    },
    check: (p, act) => {
      const pd = p.pending;
      if (pd.type === 'claim' && pd.chi.length && act.type !== 'chi') return 'まず上家の =1/2 をチーしよう。';
      if (pd.type === 'claim' && pd.ron && act.type !== 'ron') return '今度はロンできるよ。ロンを押そう。';
      if (act.type === 'discard' && tileKeyOf(p, act.id) !== 'a:135') return '135° はほかの牌と面子にならないよ。135° を捨てよう。';
      return null;
    },
    goal: (p) => (wonBy(p, 'ron') ? '和了！　sin 60° = √3/2 なら3組とも第1象限（30°・45°・60°）で役がつくので、鳴いた手でもロンできたね。' : null),
    hint: 'チーの後は 135° を捨てよう。120° では役がないのでロンできない。60° ならロンできるよ。',
  },
  {
    id: '5A', label: '4-A', title: 'リーチ', ruleset: 2, showWaits: true, riichiGuide: true,
    lead: `門前（鳴いていない手）で聴牌になる牌を捨てるとき「リーチ」を宣言できるよ。リーチできるときはボタンが金色に光り、聴牌になる牌に金の印がつくよ。牌を選ぶと待ちを確認できる。宣言すると宣言料${RIICHI_DEPOSIT}点を供託に出すよ（和了すれば戻ってくる）。`,
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '60', '=1/2', 'tan', '45'],
    draws: ['=-1', '180', '=√3', '=-√3', '90'],
    check: (p, act) => {
      if (act.type !== 'discard') return null;
      if (!p.game.riichi[HUMAN] && !act.riichi) return 'ここではリーチの練習だよ。聴牌になる牌を選んで「リーチして捨てる」を押そう。';
      return null;
    },
    goal: (p) => (p.game.riichi[HUMAN] && humanDiscards(p) >= 2 ? 'リーチの練習完了！　リーチの後は、ツモした牌をそのまま捨てる（ツモ切り）だけになるよ。' : null),
    hint: '金の印がついた =−1 を選ぶと、待ちが =1 と表示されるよ。確認したら「リーチして捨てる」。リーチの後は、ツモした牌だけ捨てられるよ。',
  },
  {
    id: '5B', label: '5-A', title: 'ロン',
    lead: 'あと1枚（=1）で和了だよ。ほかの人が和了の牌を捨てたら「ロン」で和了できるよ。',
    dealer: 1,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '45'],
    draws: ['=1'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'ron' ? '下家が捨てた =1 で和了できるよ。ロンを押そう。' : null),
    goal: (p) => (wonBy(p, 'ron') ? 'ロン和了！　ほかの人の捨て牌で和了したので、捨てた人が点数を払うよ。' : null),
    hint: 'tan 45° = 1 だから、=1 が出たら和了だよ。',
  },
  {
    id: '5C', label: '5-B', title: 'ツモ',
    lead: '同じ手で、今度は自分で和了の牌（=1）を引いたら「ツモ」で和了できるよ。',
    dealer: 3,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '45'],
    draws: ['180', '=1'],
    check: (p, act) => (p.pending.type === 'turn' && p.pending.canTsumo && act.type !== 'tsumo' ? '引いた =1 で和了の形だよ。捨てずに「ツモ」を押そう。' : null),
    goal: (p) => (wonBy(p, 'tsumo') ? 'ツモ和了！　自分で引いて和了したので、ほかの3人が点数を分けて払うよ（ロンは捨てた1人が払う）。' : null),
    hint: '和了の牌を自分で引いたときは「ツモ」。ほかの人の捨て牌のときは「ロン」だよ。',
  },
  {
    id: 'F1', label: '6-A', title: '捨て牌のフリテン', ruleset: 2, showWaits: true,
    lead: '自分が捨てた牌が待ちに入っていると、ロンできない（フリテン）。ツモ和了はできるよ。まず sin がないので使いにくい 30° を捨てよう。',
    dealer: 0,
    hand: ['cos', '180', '=-1', 'tan', '45', '=1', '=1/2', '30'],
    // あなた 135°・下家・対面・上家・あなた sin・下家・対面 150°（フリテンでロン不可）・上家・あなた 30°（ツモ）
    draws: ['135', '=-1/√3', '=-1/√3', '=-1/√3', 'sin', '=1/√3', '150', '=1/√3', '30'],
    pauses: {
      5: '対面が 150° を捨てたよ。sin 150° = 1/2 で和了の形なのに、ロンのボタンは出ないね。あなたの捨て牌に、同じ待ちの 30° があるからだよ（捨て牌のフリテン）。',
    },
    check: (p, act) => {
      if (act.type !== 'discard') return null;
      const n = humanDiscards(p);
      if (n === 0 && tileKeyOf(p, act.id) !== 'a:30') return 'まず 30° を捨てよう（sin がないので面子にしにくい牌だよ）。';
      if (n === 1 && tileKeyOf(p, act.id) !== 'a:135') return '135° を捨てると、sin・=1/2 の 30°・150° 待ちの聴牌になるよ。';
      if (p.pending.canTsumo) return 'ツモ和了できるよ。フリテンでもツモはできる。「ツモ」を押そう。';
      return null;
    },
    goal: (p) => (wonBy(p, 'tsumo') ? 'ツモ和了！　フリテンのときはロンできないけど、自分で引けば和了できるね。' : null),
    hint: '聴牌したら手牌の上の表示を見よう。「フリテン」と理由が出ているよ。和了の牌を自分で引いたら「ツモ」。',
  },
  {
    id: 'F2', label: '6-B', title: '見逃しのフリテン', ruleset: 2, showWaits: true,
    lead: 'ロンできる牌を見送ると、自分の次のツモまでロンできない（同巡のフリテン）。リーチの後に見送ると、その局の終わりまでロンできないよ。下家の 30° を、まずは見送ってみよう。',
    dealer: 1,
    hand: ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'],
    // 下家 30°（見送る）・対面 150°（同巡のフリテン）・上家・あなた（ツモ切り）・下家 30°（ロン）
    draws: ['30', '150', '=-1/√3', '=-1/√3', '30'],
    pauses: {
      2: '対面の 150° も和了の牌だけど、ロンのボタンは出ないね。30° を見送ったので、自分の次のツモまではロンできないよ。',
    },
    check: (p, act) => {
      const pd = p.pending;
      if (pd.type === 'claim' && pd.ron && p.cpuDiscards === 1 && act.type !== 'pass') return 'この課題では、まず「見送る」を押してみよう。';
      if (pd.type === 'claim' && pd.ron && p.cpuDiscards > 1 && act.type !== 'ron') return '自分のツモの後なので、またロンできるよ。ロンを押そう。';
      if (act.type === 'discard' && act.id !== p.game.drawn) return '聴牌をくずさないように、ツモした牌（右端）を捨てよう。';
      return null;
    },
    goal: (p) => (wonBy(p, 'ron') ? 'ロン和了！　見送った後も、自分のツモが来ればまたロンできるようになるよ。' : null),
    hint: '見送った後は、自分のツモでフリテンが解除されるよ。次の 30° でロンしよう。',
  },
  {
    id: '6', label: '8-A', title: '仕上げの練習：1局を打ち切ろう', exam: true, riichiGuide: true,
    lead: 'あなたは親（最初の手番）。練習用CPU 3人との1局だよ。聴牌になる牌を捨てて、リーチ。和了の牌が来たらロンかツモで和了しよう。',
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '135'],
    // あなたの9枚目は 90°。和了の牌（=−1）は、対面の打牌・あなたのツモ・下家の打牌・あなたのツモの順に4回来る。
    draws: ['90', '180', '=-1', '=√3', '=-1', '=-1', '120', '=-√3', '=-1'],
    check: () => null,
    goal: (p) => (wonBy(p) ? '卒業試験 合格！' : null),
  },
]);

export const lessonById = (id) => LESSONS.find((l) => l.id === id) || null;

function calledAndDiscarded(p, call) {
  const ev = p.game.events;
  const i = ev.findIndex((e) => e.type === call && e.seat === HUMAN);
  return i >= 0 && ev.slice(i + 1).some((e) => e.type === 'discard' && e.seat === HUMAN);
}
const wonBy = (p, how) => !!(p.game.result && p.game.result.type === 'win' && p.game.result.winner === HUMAN && (!how || p.game.result.how === how));
const humanDiscards = (p) => p.game.events.filter((e) => e.type === 'discard' && e.seat === HUMAN).length;
const tileKeyOf = (p, id) => p.game.rules.types[p.game.typeOf(id)].key;
// あなたが id を捨てた後の待ち（エンジンの waitsOf。公開情報と自分の手牌だけ）
function waitsAfter(p, id) {
  const g = p.game;
  return g.waitsOf(g.countsOf(g.hands[HUMAN].filter((x) => x !== id)), g.exposedMelds(HUMAN), true);
}

// 課題の山（配牌は親から順に1枚ずつ、その後 draws の順にツモ）
export function lessonWall(lesson) {
  const hands = [lesson.hand, ...CPU_HANDS];
  const keys = [];
  for (let r = 0; r < 8; r++) for (let j = 0; j < 4; j++) keys.push(key(hands[(lesson.dealer + j) % 4][r]));
  for (const d of lesson.draws) keys.push(key(d));
  return keys;
}

export function createPractice(rules, lesson) {
  const players = [0, 1, 2, 3].map((s) => (s === HUMAN ? { name: 'あなた', kind: 'human' } : { name: CPU_LABEL, kind: 'ai', personality: 'script' }));
  const game = new Game({ rules, seed: 1, dealer: lesson.dealer, players, presetWall: lessonWall(lesson), ruleset: lesson.ruleset || 0 });
  const p = { lessonId: lesson.id, game, selected: null, pause: null, cpuDiscards: 0, message: '', warn: '', hint: false, done: false, ended: false, last: null, settlement: null };
  runCpu(p);
  return p;
}

export const lessonOf = (p) => LESSONS.find((l) => l.id === p.lessonId);
export function pendingOf(p) {
  const pd = p.game.pending();
  return pd && pd.seat === HUMAN && !p.pause && !p.done ? pd : null;
}

// 練習用CPUの台本：自分の番はツモした牌をそのまま捨てる。宣言（ロン・ポン・チー）はすべて見送る。
// あなたの判断の番、説明の一時停止、局の終わりのどれかで止まる。
function runCpu(p) {
  const g = p.game;
  const lesson = lessonOf(p);
  for (let guard = 0; guard < 1000 && !p.pause && !p.done; guard++) {
    const pd = g.pending();
    if (!pd) break;
    if (pd.seat === HUMAN) break;
    if (pd.type === 'turn') {
      const id = g.drawn;
      if (id === null || id === undefined) throw new Error('practice CPU has no drawn tile');
      g.discard(pd.seat, id);
      p.cpuDiscards++;
      p.last = { seat: pd.seat, tile: id };
      const text = lesson.pauses && lesson.pauses[p.cpuDiscards];
      if (text) p.pause = text;
    } else {
      g.respond(pd.seat, { type: 'pass' });
    }
  }
  finish(p);
}

function finish(p) {
  const g = p.game;
  const lesson = lessonOf(p);
  const ok = lesson.goal(p);
  if (ok) {
    p.done = true;
    p.message = ok;
    p.warn = '';
  }
  if (g.result) {
    p.ended = true;
    if (g.result.type === 'win') {
      if (lesson.exam) {
        const m = applyRoundResult(createMatch({ length: 4, startDealer: g.dealer }), g.result);
        p.settlement = { deltas: m.log[0].deltas, scores: m.scores };
      } else {
        const deltas = settle(g.result, g.dealer);
        p.settlement = { deltas, scores: deltas.map((d) => 100 + d) };
      }
    }
    if (!p.done) p.warn = g.result.type === 'draw' ? '流局（山がなくなった）。「やり直し」で最初の局面から挑戦しよう。' : '';
  }
}

// ---- あなたの操作 ----
export function practiceSelect(p, id) {
  const pd = pendingOf(p);
  if (!pd || pd.type !== 'turn' || !p.game.hands[HUMAN].includes(id)) return false;
  if (p.game.riichi[HUMAN] && id !== p.game.drawn) {
    p.message = 'リーチの後は、ツモした牌（右端の光っている牌）しか捨てられないよ。';
    return false;
  }
  p.selected = p.selected === id ? null : id;
  p.message = '';
  return true;
}

// act：{ type: 'discard', riichi } | { type: 'tsumo' } | { type: 'ron' | 'pon' | 'pass' } | { type: 'chi', option }
export function practiceAct(p, act) {
  const pd = pendingOf(p);
  if (!pd) return false;
  const g = p.game;
  const lesson = lessonOf(p);
  if (act.type === 'discard') {
    if (pd.type !== 'turn' || p.selected === null) return false;
    act = { ...act, id: p.selected };
    if (g.riichi[HUMAN] && act.id !== g.drawn) return false;
    if (act.riichi && !g.riichiOptions(HUMAN).some((o) => o.type === g.typeOf(act.id))) {
      p.message = 'この牌を捨てても聴牌（あと1枚で和了の形）にならないので、リーチできないよ。';
      return false;
    }
  } else if (act.type === 'tsumo') {
    if (pd.type !== 'turn' || !pd.canTsumo) return false;
  } else if (pd.type !== 'claim') {
    return false;
  } else if ((act.type === 'ron' && !pd.ron) || (act.type === 'pon' && !pd.pon) || (act.type === 'chi' && !pd.chi[act.option])) {
    return false; // 画面に出ていない宣言は受け付けない
  }
  const why = lesson.check({ ...p, pending: pd }, act);
  if (why) {
    p.message = why;
    return false;
  }
  if (lesson.exam) p.warn = examWarning(p, pd, act);
  if (act.type === 'discard') g.discard(HUMAN, act.id, { riichi: !!act.riichi });
  else if (act.type === 'tsumo') g.tsumo(HUMAN);
  else if (act.type === 'chi') g.respond(HUMAN, { type: 'chi', option: act.option });
  else g.respond(HUMAN, { type: act.type });
  p.selected = null;
  p.message = '';
  p.last = act.type === 'discard' ? { seat: HUMAN, tile: act.id } : p.last;
  finish(p);
  if (!p.done) runCpu(p);
  return true;
}

export function practiceContinue(p) {
  if (!p.pause) return false;
  p.pause = null;
  runCpu(p);
  return true;
}

// 卒業試験：実際に打った後で、和了の機会を逃した・聴牌が崩れた、を知らせる（操作は止めない）
function examWarning(p, pd, act) {
  const g = p.game;
  if (pd.type === 'claim' && pd.ron && act.type !== 'ron') return 'ロンできる牌を見送ったよ。次の和了のチャンスを待とう（「やり直し」で最初からもできるよ）。';
  if (pd.type === 'turn' && pd.canTsumo && act.type !== 'tsumo') return 'ツモで和了できたのに捨てたよ。次のチャンスを待とう（「やり直し」で最初からもできるよ）。';
  if (act.type === 'discard' && !g.riichi[HUMAN]) {
    const counts = g.countsOf(g.hands[HUMAN].filter((x) => x !== act.id));
    const tenpaiNow = g.waitsOf(counts, g.exposedMelds(HUMAN)).length > 0;
    const couldTenpai = g.riichiOptions(HUMAN).length > 0 || g.hands[HUMAN].some((x) => g.waitsOf(g.countsOf(g.hands[HUMAN].filter((y) => y !== x)), g.exposedMelds(HUMAN)).length);
    if (!tenpaiNow && couldTenpai) return '今の打牌で聴牌（あと1枚で和了の形）がくずれたよ。「やり直し」で最初の局面からやり直せるよ。';
    if (tenpaiNow && !act.riichi && g.melds[HUMAN].length === 0) return '聴牌したけど、リーチはしなかったね。リーチすると和了の点が1点増えるよ。';
  }
  return '';
}

// 局面に応じたヒント（エンジンの判定から作る）
export function practiceHint(p) {
  const lesson = lessonOf(p);
  if (!lesson.exam) return lesson.hint;
  const g = p.game;
  const pd = pendingOf(p);
  if (p.done) return '';
  if (g.result) return '「やり直し」で最初の局面から挑戦しよう。';
  if (!pd) return '「続ける」を押して進めよう。';
  if (pd.type === 'claim') return pd.ron ? 'ロンで和了できるよ。ロンを押そう。' : 'ここは「見送る」でOK。';
  if (pd.canTsumo) return '引いた牌で和了の形だよ。「ツモ」を押そう。';
  if (g.riichi[HUMAN]) return 'リーチ中はツモした牌をそのまま捨てよう。';
  const opts = g.riichiOptions(HUMAN);
  if (opts.length) {
    const t = g.rules.types[opts[0].type];
    const w = opts[0].waits.map((x) => tileLabel(g.rules.types[x])).join('・');
    return `${tileLabel(t)} を捨てると ${w} 待ちの聴牌。「リーチして捨てる」を押そう。`;
  }
  return '使わない牌を1枚捨てよう。';
}

// ---- 表示 ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const typeOfId = (g, id) => g.rules.types[g.typeOf(id)];

function seatHTML(p, seat) {
  const g = p.game;
  const river = g.rivers[seat].map((r) => tileHTML(typeOfId(g, r.id), { size: 'xs', cls: (p.last && p.last.tile === r.id ? 'bp-last' : '') + (r.riichi ? ' bp-riichi-tile' : '') })).join('');
  const melds = g.melds[seat].map((m) => `<span class="bp-meld">${m.call === 'chi' ? 'チー' : 'ポン'}：${formulaHTML(g.rules, m.meld)}</span>`).join('');
  const who = seat === HUMAN ? 'あなた' : `${SEAT_NAMES[seat]}・${CPU_LABEL}`;
  return `<div class="bp-seat${seat === HUMAN ? ' me' : ''}" data-seat="${seat}"><div class="bp-name">${who}${g.dealer === seat ? '<span class="bp-badge">親</span>' : ''}${g.riichi[seat] ? '<span class="bp-badge r">リーチ</span>' : ''}</div>` +
    `<div class="bp-river" aria-label="${esc(who)}の捨て牌">${river || '<span class="bp-empty">捨て牌なし</span>'}</div>${melds ? `<div class="bp-melds">${melds}</div>` : ''}</div>`;
}

function eventText(p) {
  const g = p.game;
  if (!p.last) return '';
  return `${p.last.seat === HUMAN ? 'あなた' : SEAT_NAMES[p.last.seat]}が ${esc(tileLabel(typeOfId(g, p.last.tile)))} を捨てた`;
}

function resultHTML(p) {
  const g = p.game;
  const r = g.result;
  if (!r || r.type !== 'win') return '';
  const a = r.analysis;
  const yaku = a.yaku.map((y) => `<li>${esc(y.name)}（${y.points}点）</li>`).join('');
  const st = p.settlement;
  const rows = st ? [0, 1, 2, 3].map((s) => `<tr${s === HUMAN ? ' class="me"' : ''}><th>${s === HUMAN ? 'あなた' : SEAT_NAMES[s]}</th><td>${st.deltas[s] > 0 ? '+' : ''}${st.deltas[s]}</td><td>${st.scores[s]}点</td></tr>`).join('') : '';
  return `<div class="bp-result" role="status"><p class="bp-win">${r.how === 'ron' ? 'ロン' : 'ツモ'}和了！ ${a.kind === 'normal' ? a.melds.map((mi) => formulaHTML(g.rules, mi)).join(' ') : ''}</p>` +
    `<ul class="bp-yaku">${yaku}</ul><p class="bp-points">和了点 ${r.points}点${r.how === 'ron' ? `（${SEAT_NAMES[r.from]}が払う）` : '（ほかの3人が払う）'}</p>` +
    `<table class="bp-settle"><caption>点数の移動（持ち点100点から・練習なので記録には残りません）</caption>${rows}</table></div>`;
}

function handHTML(p) {
  const g = p.game;
  const pd = pendingOf(p);
  const canPick = pd && pd.type === 'turn';
  const drawn = g.current === HUMAN && g.phase === 'turn' ? g.drawn : null;
  const ids = g.hands[HUMAN].filter((id) => id !== drawn).sort((a, b) => g.typeOf(a) - g.typeOf(b) || a - b);
  if (drawn !== null && drawn !== undefined && g.hands[HUMAN].includes(drawn)) ids.push(drawn);
  const locked = g.riichi[HUMAN];
  // リーチできる打牌（聴牌になる種類）に金の印（リーチの課題・卒業前の練習）
  const cand = canPick && !locked && lessonOf(p).riichiGuide ? new Set(g.riichiOptions(HUMAN).map((o) => o.type)) : null;
  return ids.map((id) => {
    const on = p.selected === id;
    const isDrawn = id === drawn;
    const off = !canPick || (locked && !isDrawn);
    return `<button class="br-pick bp-tile${on ? ' on' : ''}${isDrawn ? ' drawn' : ''}${canPick && locked && !isDrawn ? ' locked' : ''}${cand && cand.has(g.typeOf(id)) ? ' riichi-cand' : ''}" type="button" data-action="bp-tile" data-id="${id}" aria-pressed="${on}" aria-label="${esc(tileLabel(typeOfId(g, id)))}${isDrawn ? '（ツモ）' : ''}"${off ? ' disabled' : ''}>${tileHTML(typeOfId(g, id), { size: 'm' })}</button>`;
  }).join('');
}

function actionsHTML(p) {
  const g = p.game;
  if (p.pause) return '<button class="primary" data-action="bp-continue">続ける</button>';
  const pd = pendingOf(p);
  if (!pd) return '';
  if (pd.type === 'claim') {
    const tile = esc(tileLabel(typeOfId(g, pd.tile)));
    return (pd.ron ? `<button class="primary bp-decl" data-action="bp-ron">ロン（${tile}）</button>` : '') +
      (pd.pon ? `<button class="primary bp-decl" data-action="bp-pon">ポン：${formulaHTML(g.rules, pd.pon.meld)}</button>` : '') +
      pd.chi.map((c, i) => `<button class="primary bp-decl" data-action="bp-chi" data-opt="${i}">チー：${formulaHTML(g.rules, c.meld)}</button>`).join('') +
      '<button data-action="bp-pass">見送る</button>';
  }
  // 5-C はツモの練習。エンジン上は合法でも、この課題で受け付けない操作は出さない。
  if (lessonOf(p).id === '5C' && pd.canTsumo) return '<button class="primary bp-decl" data-action="bp-tsumo">ツモ</button>';
  const sel = p.selected;
  const ropts = g.riichiOptions(HUMAN);
  const canRiichi = sel !== null && ropts.some((o) => o.type === g.typeOf(sel));
  return (pd.canTsumo ? '<button class="primary bp-decl" data-action="bp-tsumo">ツモ</button>' : '') +
    (ropts.length ? `<button class="primary riichi-ready" data-action="bp-riichi"${canRiichi ? '' : ' disabled'}>リーチして捨てる<small>宣言料${RIICHI_DEPOSIT}点</small></button>` : '') +
    `<button class="${ropts.length || pd.canTsumo ? '' : 'primary'}" data-action="bp-discard"${sel === null ? ' disabled' : ''}>この牌を捨てる</button>`;
}

function statusText(p) {
  const g = p.game;
  const pd = pendingOf(p);
  if (p.pause || p.done || !pd) return '';
  if (pd.type === 'claim') return `${SEAT_NAMES[pd.from]}の ${esc(tileLabel(typeOfId(g, pd.tile)))} に対して、宣言できるよ。`;
  if (lessonOf(p).id === '5C' && pd.canTsumo) return 'ツモで和了しよう。';
  if (g.riichi[HUMAN]) return 'リーチ中：ツモした牌（右端）だけ捨てられるよ。';
  if (lessonOf(p).riichiGuide && g.riichiOptions(HUMAN).length) return 'リーチできるよ！　金の印の牌を選ぶと待ちを確認できる。';
  if (g.drawn === null || g.drawn === undefined) return '鳴いた後はツモをしないで、1枚捨てよう。';
  return 'あなたの番：捨てる牌を選ぼう。';
}

// 待ち・フリテンの欄（通常対局の手牌の上の欄と同じ考え方。公開情報と自分の手牌だけ：src/ui/waits-view.js）
function waitsLineHTML(p) {
  const g = p.game;
  if (!lessonOf(p).showWaits || !g.furitenRule) return '';
  const pd = g.pending();
  const myTurn = !!(pd && pd.seat === HUMAN && pd.type === 'turn');
  const tw = tenpaiWaitsView(g.rules, g.viewFor(HUMAN), { selected: myTurn ? p.selected : null, riichiWaits: g.riichiWaits[HUMAN], myTurn });
  const f = g.furitenOf(HUMAN);
  let html = '';
  if (tw) {
    const label = { riichi: 'リーチの待ち', tenpai: '聴牌 待ち', 'after-discard': 'この牌を捨てると待ち' }[tw.kind];
    html += `<span class="bp-waits"><b>${label}</b>${tw.waits.map((w) => `<span class="bp-wait${w.winnable ? '' : ' no-yaku'}">${tileHTML(g.rules.types[w.type], { size: 'xs' })}<small>${w.winnable ? `残${w.unseen}` : '役なし'}</small></span>`).join('')}</span>`;
  } else if (myTurn && p.selected !== null && !g.riichi[HUMAN]) html += '<span class="bp-waits none">この牌を捨てても聴牌にならない</span>';
  if (f.furiten) {
    const why = { discard: '自分の捨て牌に待ちがある', temporary: '見逃した（自分の次のツモまで）', riichi: 'リーチ後に見逃した（局の終わりまで）' };
    html += `<span class="bp-furiten"><b>フリテン</b>ロン不可：${f.reasons.map((r) => why[r]).join('・')}（ツモ和了はできる）</span>`;
  }
  return html ? `<div class="bp-info" role="status">${html}</div>` : '';
}

export function practiceHTML(p, { hintText = '' } = {}) {
  const g = p.game;
  const lesson = lessonOf(p);
  return `<div class="bp" data-lesson="${lesson.id}">` +
    `<p class="bp-task"><b>${esc(lesson.label)}</b> ${esc(lesson.title)}</p><p class="bp-lead">${esc(lesson.lead)}</p>` +
    `<div class="bp-table">${[3, 2, 1].map((s) => seatHTML(p, s)).join('')}${seatHTML(p, HUMAN)}</div>` +
    `<p class="bp-meta">山の残り ${g.wall.length}枚${eventText(p) ? `・直前：${eventText(p)}` : ''}</p>` +
    (p.pause ? `<p class="br-feedback bp-pause" role="status">${esc(p.pause)}</p>` : '') +
    (statusText(p) ? `<p class="bp-status">${statusText(p)}</p>` : '') +
    waitsLineHTML(p) +
    `<div class="bp-hand" role="group" aria-label="あなたの手牌">${handHTML(p)}</div>` +
    (g.melds[HUMAN].length ? `<p class="bp-calls">鳴いた回数 ${g.melds[HUMAN].length} / ${g.maxCalls}（チー・ポンは合計2回まで）</p>` : '') +
    `<div class="br-actions bp-actions">${actionsHTML(p)}</div>` +
    (p.message ? `<p class="br-feedback" role="status">${esc(p.message)}</p>` : '') +
    (p.warn ? `<p class="br-feedback bp-warn" role="status">${esc(p.warn)}</p>` : '') +
    (hintText && !p.done ? `<p class="br-hint">${esc(hintText)}</p>` : '') +
    resultHTML(p) +
    (lesson.id === '4D' && p.done ? '<p class="br-note">優先順位：ロン ＞ ポン ＞ チー。同じ牌でロンする人がいれば、ポン・チーより先に和了になるよ。チー・ポンは合わせて2回まで。リーチした後はチー・ポンできないよ。</p>' : '') +
    '</div>';
}
