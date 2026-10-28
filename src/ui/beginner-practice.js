// 初心者の部屋 第4〜6段階：実際の対局エンジン（Game）で固定の局面を進める練習。
// ・山は presetWall で固定（seed も固定）。練習用CPUは台本どおりの公開行動だけをする（ツモした牌をそのまま捨てる・宣言はすべて見送る）。
// ・人間の選択肢（チー・ポン・ロン・ツモ・リーチ）は Game.pending() / riichiOptions() が返すものだけを画面に出す（偽のボタンは作らない）。
// ・判定・和了・点数はすべて既存のエンジン（Game・rules・match）のもの。この画面は通常対局の規則・AI・記録を変更しない。
// 第4・5段階の課題では、練習の流れから外れる操作（例：チーの練習で「見送る」）は実行せず、理由を表示してやり直してもらう。
// 第6段階（卒業試験）は自由に打てる（誤りはヒントで知らせ、「やり直し」で最初の局面からやり直せる）。
import { Game } from '../engine/game.js';
import { settle, createMatch, applyRoundResult } from '../engine/match.js';
import { tileHTML, tileLabel, formulaHTML } from './render.js';

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
    id: '4A', stage: 3, label: '4-A', title: 'チーを体験',
    lead: '上家（左の人）が捨てた牌で数式面子ができるとき「チー」ができるよ。sin と 30° を持っているね。',
    dealer: 3,
    hand: ['sin', '30', 'cos', '0', '=1', 'tan', '45', '90'],
    draws: ['=1/2'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'chi' ? 'ここではチーを押して、sin 30° = 1/2 を完成させよう。' : null),
    goal: (p) => (calledAndDiscarded(p, 'chi') ? 'チー成功！　上家の =1/2 で sin 30° = 1/2 を公開し、ツモをせずに1枚捨てたよ。' : null),
    hint: 'チーのボタンには、できあがる数式が書いてあるよ。チーの後は、使わない牌（90°）を捨てよう。',
  },
  {
    id: '4B', stage: 3, label: '4-B', title: 'チーできない場面',
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
    id: '4C', stage: 3, label: '4-C', title: 'ポン',
    lead: '同じ牌を2枚持っているとき、だれかが同じ牌を捨てたら「ポン」で刻子（同じ牌3枚）を作れるよ。ポンは上家以外からでもできるよ。',
    dealer: 2,
    hand: ['sin', 'sin', 'cos', '0', '=1', 'tan', '45', '90'],
    draws: ['sin'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'pon' ? 'sin を2枚持っているよ。ポンを押してみよう。' : null),
    goal: (p) => (calledAndDiscarded(p, 'pon') ? 'ポン成功！　対面の sin で sin×3 の刻子を公開し、1枚捨てたよ。' : null),
    hint: '対面が捨てた sin と、手の sin 2枚で刻子になるよ。ポンの後も、ツモをせずに1枚捨てるよ。',
  },
  {
    id: '4D', stage: 3, label: '4-D', title: '鳴いた後のルール',
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
    id: '5A', stage: 4, label: '5-A', title: 'リーチ',
    lead: '門前（鳴いていない手）で、あと1枚で和了の形（聴牌）になる牌を捨てるとき「リーチ」を宣言できるよ。',
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '60', '=1/2', 'tan', '45'],
    draws: ['=-1', '180', '=√3', '=-√3', '90'],
    check: (p, act) => {
      if (act.type !== 'discard') return null;
      if (!p.game.riichi[HUMAN] && !act.riichi) return 'ここではリーチの練習だよ。聴牌になる牌を選んで「リーチして捨てる」を押そう。';
      return null;
    },
    goal: (p) => (p.game.riichi[HUMAN] && humanDiscards(p) >= 2 ? 'リーチの練習完了！　リーチの後は、ツモした牌をそのまま捨てる（ツモ切り）だけになるよ。' : null),
    hint: 'tan 45° の結果は =1。=−1 を捨てると =1 待ちの聴牌になるよ。リーチの後は、ツモした牌だけ捨てられるよ。',
  },
  {
    id: '5B', stage: 4, label: '5-B', title: 'ロン',
    lead: 'あと1枚（=1）で和了だよ。ほかの人が和了の牌を捨てたら「ロン」で和了できるよ。',
    dealer: 1,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '45'],
    draws: ['=1'],
    check: (p, act) => (p.pending.type === 'claim' && act.type !== 'ron' ? '下家が捨てた =1 で和了できるよ。ロンを押そう。' : null),
    goal: (p) => (wonBy(p, 'ron') ? 'ロン和了！　ほかの人の捨て牌で和了したので、捨てた人が点数を払うよ。' : null),
    hint: 'tan 45° = 1 だから、=1 が出たら和了だよ。',
  },
  {
    id: '5C', stage: 4, label: '5-C', title: 'ツモ',
    lead: '同じ手で、今度は自分で和了の牌（=1）を引いたら「ツモ」で和了できるよ。',
    dealer: 3,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '45'],
    draws: ['180', '=1'],
    check: (p, act) => (p.pending.type === 'turn' && p.pending.canTsumo && act.type !== 'tsumo' ? '引いた =1 で和了の形だよ。捨てずに「ツモ」を押そう。' : null),
    goal: (p) => (wonBy(p, 'tsumo') ? 'ツモ和了！　自分で引いて和了したので、ほかの3人が点数を分けて払うよ（ロンは捨てた1人が払う）。' : null),
    hint: '和了の牌を自分で引いたときは「ツモ」。ほかの人の捨て牌のときは「ロン」だよ。',
  },
  {
    id: '6', stage: 5, label: '卒業試験', title: '1局を打ち切ろう', exam: true,
    lead: 'あなたは親（最初の手番）。練習用CPU 3人との1局だよ。聴牌になる牌を捨てて、リーチ。和了の牌が来たらロンかツモで和了しよう。',
    dealer: 0,
    hand: ['sin', '30', '=1/2', 'cos', '0', '=1', 'tan', '135'],
    // あなたの9枚目は 90°。和了の牌（=−1）は、対面の打牌・あなたのツモ・下家の打牌・あなたのツモの順に4回来る。
    draws: ['90', '180', '=-1', '=√3', '=-1', '=-1', '120', '=-√3', '=-1'],
    check: () => null,
    goal: (p) => (wonBy(p) ? '卒業試験 合格！' : null),
  },
]);

export const STAGE_PARTS = Object.freeze([0, 0, 0, 4, 3, 1]); // 段階ごとの課題数（第1〜3段階は課題なし）
export const lessonsOf = (stage) => LESSONS.filter((l) => l.stage === stage);
export const lessonAt = (stage, part) => lessonsOf(stage)[part] || null;

function calledAndDiscarded(p, call) {
  const ev = p.game.events;
  const i = ev.findIndex((e) => e.type === call && e.seat === HUMAN);
  return i >= 0 && ev.slice(i + 1).some((e) => e.type === 'discard' && e.seat === HUMAN);
}
const wonBy = (p, how) => !!(p.game.result && p.game.result.type === 'win' && p.game.result.winner === HUMAN && (!how || p.game.result.how === how));
const humanDiscards = (p) => p.game.events.filter((e) => e.type === 'discard' && e.seat === HUMAN).length;
const tileKeyOf = (p, id) => p.game.rules.types[p.game.typeOf(id)].key;

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
  const game = new Game({ rules, seed: 1, dealer: lesson.dealer, players, presetWall: lessonWall(lesson) });
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
  return ids.map((id) => {
    const on = p.selected === id;
    const isDrawn = id === drawn;
    const off = !canPick || (locked && !isDrawn);
    return `<button class="br-pick bp-tile${on ? ' on' : ''}${isDrawn ? ' drawn' : ''}${canPick && locked && !isDrawn ? ' locked' : ''}" type="button" data-action="bp-tile" data-id="${id}" aria-pressed="${on}" aria-label="${esc(tileLabel(typeOfId(g, id)))}${isDrawn ? '（ツモ）' : ''}"${off ? ' disabled' : ''}>${tileHTML(typeOfId(g, id), { size: 'm' })}</button>`;
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
    (ropts.length ? `<button class="primary" data-action="bp-riichi"${canRiichi ? '' : ' disabled'}>リーチして捨てる</button>` : '') +
    `<button class="${ropts.length || pd.canTsumo ? '' : 'primary'}" data-action="bp-discard"${sel === null ? ' disabled' : ''}>この牌を捨てる</button>`;
}

function statusText(p) {
  const g = p.game;
  const pd = pendingOf(p);
  if (p.pause || p.done || !pd) return '';
  if (pd.type === 'claim') return `${SEAT_NAMES[pd.from]}の ${esc(tileLabel(typeOfId(g, pd.tile)))} に対して、宣言できるよ。`;
  if (lessonOf(p).id === '5C' && pd.canTsumo) return 'ツモで和了しよう。';
  if (g.riichi[HUMAN]) return 'リーチ中：ツモした牌（右端）だけ捨てられるよ。';
  if (g.drawn === null || g.drawn === undefined) return '鳴いた後はツモをしないで、1枚捨てよう。';
  return 'あなたの番：捨てる牌を選ぼう。';
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
