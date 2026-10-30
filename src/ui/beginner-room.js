// 初心者の部屋（版2・docs/67）：操作中心の8段階。通常対局と独立した数学Ⅰの練習。
// 段階は課題（step）の並び。課題の種類：
//   bank：牌を選ぶ問題（数式・3つの面子・ツモと打牌。数式面子・和了の判定は既存の rules.meldOf / rules.analyzeWin）
//   practice：実際の対局エンジンで固定の局面を進める（beginner-practice.js）
//   quiz：待ち牌を当てる（正解はエンジンの和了判定）
//   exam：卒業試験。通常の対局画面で、初級AI 3人と1局戦（現行ルール）を最後まで打つ（app.js が開始し、結果を記録する）
import { tileHTML, formulaHTML } from './render.js';
import { createPractice, lessonById, practiceAct, practiceSelect, practiceContinue, practiceHint, practiceHTML } from './beginner-practice.js';
import { freshProgress, isUnlocked } from './beginner-progress.js';
import { RIICHI_DEPOSIT } from '../engine/match.js';

export const ROOM_STAGES = Object.freeze([
  { name: '数式の作り方', lead: '関数・角度・結果の3枚で正しい数式を作り、9枚を3つの面子に分けよう。', steps: [{ kind: 'bank', bank: 0, title: '3枚の数式' }, { kind: 'bank', bank: 1, title: '3つの面子' }] },
  { name: '捨て牌の判断', lead: 'ツモした後は1枚捨てて8枚に戻すよ。どの牌を残すかを考えよう。', steps: [{ kind: 'bank', bank: 2, title: 'ツモと打牌' }, { kind: 'practice', lesson: 'D1' }] },
  { name: '聴牌と待ち牌', lead: 'あと1枚で和了の形が「聴牌」。その1枚が「待ち牌」だよ。', steps: [{ kind: 'practice', lesson: 'T1' }, { kind: 'quiz', quiz: 0, title: '待ち牌を当てよう' }] },
  { name: 'リーチ', lead: `聴牌したらリーチ。待ちを確かめてから宣言しよう（宣言料${RIICHI_DEPOSIT}点）。`, steps: [{ kind: 'practice', lesson: '5A' }] },
  { name: 'ロン・ツモ', lead: 'ほかの人の捨て牌で和了するのがロン、自分で引いて和了するのがツモ。', steps: [{ kind: 'practice', lesson: '5B' }, { kind: 'practice', lesson: '5C' }] },
  { name: 'フリテン', lead: 'ロンできないとき（フリテン）を体験しよう。ツモ和了はできるよ。', steps: [{ kind: 'practice', lesson: 'F1' }, { kind: 'practice', lesson: 'F2' }] },
  { name: '鳴き（チー・ポン）', lead: 'ほかの人の捨て牌をもらって面子を作る「鳴き」を練習しよう。', steps: ['4A', '4B', '4C', '4D'].map((lesson) => ({ kind: 'practice', lesson })) },
  { name: '卒業試験（1局戦）', lead: '仕上げの練習の後、初級のキャラクター3人と本番と同じ1局戦を打とう。最後まで打てば修了。1位を目指そう！', steps: [{ kind: 'practice', lesson: '6' }, { kind: 'exam', title: '卒業試験：1局戦' }] },
]);
export const ROOM_STAGE_COUNT = ROOM_STAGES.length;
export const partsOf = (stage) => (ROOM_STAGES[stage] ? ROOM_STAGES[stage].steps.length : 0);
export const stepOf = (stage, part) => (ROOM_STAGES[stage] ? ROOM_STAGES[stage].steps[part] || null : null);
// 卒業試験の対戦相手：初級の既定3人（判断係数は変えない）
export const EXAM_OPPONENTS = Object.freeze(['kanata', 'mitsuki', 'aoto']);

// 待ち牌クイズ：8枚の聴牌の手と、答えの候補（角度牌）。正解はエンジンの和了判定で決める（ここに答えを書かない）
const QUIZZES = Object.freeze([
  { hand: ['sin', '=1/2', 'cos', '180', '=-1', 'tan', '45', '=1'], choices: ['0', '30', '45', '60', '90', '120', '135', '150', '180'],
    lead: 'sin・=1/2 が残っているよ。sin θ = 1/2 になる角度は？　待ち牌をすべて選んで「答える」。', hint: 'sin 30° = 1/2、sin 150° = 1/2。待ちは2種類あるよ。' },
]);
export const quizOf = (i) => QUIZZES[i];
export function quizHand(rules, i) { return QUIZZES[i].hand.map((x) => rules.typeByKey.get(keyOf(x)).idx); }
export function quizAnswer(rules, i) {
  const hand = quizHand(rules, i);
  return QUIZZES[i].choices.map((x) => rules.typeByKey.get(keyOf(x)).idx).filter((t) => !!rules.analyzeWin(rules.countsOf([...hand, t]), []));
}
const keyOf = (s) => (s.startsWith('=') ? `v:${s.slice(1)}` : /^\d+$/.test(s) ? `a:${s}` : `f:${s}`);

// 実際の数学Ⅰで使用できる牌。第2段階の9枚はそのまま和了可能。
// 第3段階の9枚は=-1を切って=1をツモれば、3つの数式面子になる。
const BANKS = Object.freeze([
  ['a:60', 'v:1/2', 'f:cos', 'f:sin', 'a:30', 'v:1'],
  ['f:cos', 'a:45', 'v:1/2', 'f:sin', 'v:1', 'a:30', 'f:tan', 'v:1/2', 'a:60'],
  ['a:60', 'f:sin', 'v:1/2', 'a:45', 'f:tan', 'v:-1', 'f:cos', 'a:30', 'v:1/2'],
]);
export const ROOM_BANK_COUNT = BANKS.length;
export function roomTiles(rules, bank) {
  if (!Number.isInteger(bank) || bank < 0 || bank >= BANKS.length) throw new RangeError('bad bank');
  return BANKS[bank].map((key) => {
    const t = rules.typeByKey.get(key);
    if (!t) throw new Error('bad tutorial tile: ' + key);
    return t.idx;
  });
}
export function createRoomState(progress = freshProgress()) {
  return { stage: 0, part: 0, step: null, selected: [], groups: [], done: false, hint: false, message: '', view: 'stage', practice: null, progress, saveOk: true };
}

// 段階（と課題）を始める。実戦形式の課題は固定の局面を新しく作る（やり直しも同じ）。
export function enterStage(s, rules, stage, part = 0) {
  if (!Number.isInteger(stage) || stage < 0 || stage >= ROOM_STAGE_COUNT) throw new RangeError('bad stage');
  s.stage = stage;
  s.part = Math.min(Math.max(0, Number.isInteger(part) ? part : 0), partsOf(stage) - 1);
  s.step = stepOf(stage, s.part);
  s.selected = [];
  s.groups = [];
  s.done = false;
  s.hint = false;
  s.message = '';
  s.view = 'stage';
  s.practice = s.step.kind === 'practice' ? createPractice(rules, lessonById(s.step.lesson)) : null;
  s.progress.resume = { stage, part: s.part };
}

// 一覧から選ぶ：まだ開いていない段階は選べない
export function gotoStage(s, rules, stage) {
  if (!Number.isInteger(stage) || stage < 0 || stage >= ROOM_STAGE_COUNT || !isUnlocked(s.progress, stage)) return false;
  const part = s.progress.resume.stage === stage && !s.progress.cleared[stage] ? s.progress.resume.part : 0;
  enterStage(s, rules, stage, part);
  return true;
}
export function resumeRoom(s, rules) {
  const r = s.progress.resume;
  enterStage(s, rules, isUnlocked(s.progress, r.stage) ? r.stage : 0, r.part);
}
// 最初から受け直す（クリア・修了の記録は消さない）
export function restartRoom(s, rules) { enterStage(s, rules, 0, 0); }
export function retryRoom(s, rules) { enterStage(s, rules, s.stage, s.part); }
export function openRoomList(s) { s.view = 'list'; }

// 段階の最後の課題を終えたらクリアにする（卒業試験は1局戦を最後まで打ったとき：recordExam）
function markCleared(s) {
  if (s.done && s.part === partsOf(s.stage) - 1 && s.step.kind !== 'exam') s.progress.cleared[s.stage] = true;
}

// 実戦形式の課題の操作（実際の対局エンジンへ渡す）
export function roomPracticeSelect(s, id) { return !!s.practice && practiceSelect(s.practice, id); }
export function roomPracticeAct(s, act) {
  if (!s.practice) return false;
  const ok = practiceAct(s.practice, act);
  s.done = s.practice.done;
  if (ok) s.hint = false;
  markCleared(s);
  return ok;
}
export function roomPracticeContinue(s) { return !!s.practice && practiceContinue(s.practice); }
export function pickRoomTile(s, rules, index) {
  if (s.done || !s.step) return;
  if (s.step.kind === 'quiz') {
    const n = quizOf(s.step.quiz).choices.length;
    if (!Number.isInteger(index) || index < 0 || index >= n) return;
    s.selected = s.selected.includes(index) ? s.selected.filter((i) => i !== index) : [...s.selected, index];
    s.message = ''; s.hint = false;
    return;
  }
  if (s.step.kind !== 'bank') return;
  const bank = s.step.bank;
  const tiles = roomTiles(rules, bank);
  if (!Number.isInteger(index) || index < 0 || index >= tiles.length) return;
  if (s.groups.flat().includes(index)) return;
  if (bank === 2) s.selected = [index];
  else if (s.selected.includes(index)) s.selected = s.selected.filter((i) => i !== index);
  else if (s.selected.length < 3) s.selected.push(index);
  else { s.message = '3枚選んだよ。「確認する」を押すか、1枚外そう。'; return; }
  s.message = '';
  s.hint = false;
}
export function checkRoom(s, rules) {
  if (s.done || !s.step) return false;
  if (s.step.kind === 'quiz') {
    const q = quizOf(s.step.quiz);
    const chosen = s.selected.map((i) => rules.typeByKey.get(keyOf(q.choices[i])).idx).sort((a, b) => a - b);
    const ans = quizAnswer(rules, s.step.quiz).sort((a, b) => a - b);
    if (!chosen.length) { s.message = '待ち牌を選んでから答えてね。'; return false; }
    if (chosen.length === ans.length && chosen.every((t, i) => t === ans[i])) {
      s.done = true; markCleared(s);
      s.message = '正解！　待ちが2種類ある聴牌だね。どちらを引いても（どちらが捨てられても）和了だよ。';
      return true;
    }
    const miss = ans.filter((t) => !chosen.includes(t)).length, extra = chosen.filter((t) => !ans.includes(t)).length;
    s.message = extra ? '選んだ中に、和了にならない牌があるよ。もう一度考えよう。' : `あと${miss}種類あるよ。ほかにも和了の形になる牌がないか探そう。`;
    return false;
  }
  if (s.step.kind !== 'bank') return false;
  const bank = s.step.bank;
  const tiles = roomTiles(rules, bank);
  if (s.selected.length !== (bank === 2 ? 1 : 3)) {
    s.message = '牌を選んでから確認してね。';
    return false;
  }
  if (bank <= 1) {
    const meld = rules.meldOf(...s.selected.map((i) => tiles[i]));
    if (!meld) {
      s.message = 'この3枚は面子にならないよ。別の組合せを試そう。';
      s.selected = []; return false;
    }
    if (bank === 0) {
      s.done = true; markCleared(s);
      s.message = '正解！　3枚で正しい数式面子が完成したよ。';
      return true;
    }
    s.groups.push(s.selected.slice());
    s.selected = [];
    if (s.groups.length === 3) {
      if (!rules.analyzeWin(rules.countsOf(tiles), [])) throw new Error('invalid tutorial win fixture');
      s.done = true; markCleared(s);
      s.message = '正解！　9枚で3つの面子を作れたね。これが和了形だよ。';
    } else {
      s.message = '正解！　' + s.groups.length + ' / 3組完成。残りで続けよう。';
    }
    return true;
  }
  const remaining = tiles.filter((_, i) => i !== s.selected[0]);
  const winTile = rules.typeByKey.get('v:1').idx;
  const valid = !!rules.analyzeWin(rules.countsOf([...remaining, winTile]), []);
  if (tiles[s.selected[0]] === rules.typeByKey.get('v:-1').idx && valid) {
    s.done = true; markCleared(s);
    s.message = '正解！　8枚に戻したよ。次に「=1」をツモれば和了できるね。';
    return true;
  }
  s.message = '惜しい！　完成している2組と、あと1枚でできる組を探そう。';
  s.selected = [];
  return false;
}
// 次の課題（段階の最後なら次の段階）へ。最後の段階の後は false。
export function nextRoom(s, rules) {
  if (!s.done) return false;
  markCleared(s);
  if (s.part + 1 < partsOf(s.stage)) {
    enterStage(s, rules, s.stage, s.part + 1);
    return true;
  }
  if (s.stage >= ROOM_STAGE_COUNT - 1) return false;
  enterStage(s, rules, s.stage + 1, 0);
  return true;
}
const BANK_HINTS = [
  'sin・30°・=1/2 の3枚を探そう。',
  'sin 30° = 1/2、cos 60° = 1/2、tan 45° = 1。=1/2牌は2枚あるよ。',
  'sin30°=1/2とcos60°=1/2は完成。残りのtanと45°の結果は何かな？',
];
export function roomHint(s) {
  s.hint = true;
  if (s.practice) return practiceHint(s.practice);
  if (s.step && s.step.kind === 'quiz') return quizOf(s.step.quiz).hint;
  if (s.step && s.step.kind === 'bank') return BANK_HINTS[s.step.bank];
  return '';
}
const COMMON_BUTTONS = '<button data-action="br-reset">やり直し</button><button data-action="br-list">一覧へ</button><button data-action="br-title">タイトルへ</button>';
const FOOTER = '<p class="br-footer">練習（第1〜7段階）は通常の対局・成績には影響しません。進み具合はこの端末だけに保存されます。</p>';

function headHTML(s) {
  return '<h1>初心者の部屋</h1>' +
    '<p class="br-sub">数学Ⅰ（度数法）・第' + (s.stage + 1) + '段階 / ' + ROOM_STAGE_COUNT + '・課題 ' + (s.part + 1) + ' / ' + partsOf(s.stage) + '</p>' +
    '<nav class="br-progress" aria-label="進み具合">' + ROOM_STAGES.map((x, i) =>
      '<span class="' + (i === s.stage ? 'current' : s.progress.cleared[i] ? 'past' : '') + '" title="' + x.name + '">' + (i + 1) + '</span>').join('') + '</nav>';
}

function nextLabel(s) {
  if (s.part + 1 < partsOf(s.stage)) return '次の課題へ';
  return '第' + (s.stage + 2) + '段階へ進む';
}

function examRecordHTML(p) {
  const e = p.exam;
  if (!e.plays) return '';
  return '<p class="br-exam-record">卒業試験：' + e.plays + '回（1位 ' + e.firsts + '回・最高 ' + e.best + '位）</p>';
}

// 段階の一覧（クリアした段階はもう一度遊べる。修了した人は全段階を受け直せる）
function listHTML(s) {
  const r = s.progress.resume;
  const items = ROOM_STAGES.map((st, i) => {
    const open = isUnlocked(s.progress, i), clear = s.progress.cleared[i];
    const state = clear ? 'クリア' : open ? (r.stage === i && r.part > 0 ? '途中（課題' + (r.part + 1) + '/' + partsOf(i) + '）' : '挑戦できる') : 'まだ開いていない';
    return '<li><button class="br-stage' + (clear ? ' clear' : '') + '" data-action="br-goto" data-stage="' + i + '"' + (open ? '' : ' disabled') + '>' +
      '<span class="br-stage-no">' + (i + 1) + '</span><span class="br-stage-name">' + st.name + '</span><span class="br-stage-state">' + state + '</span></button></li>';
  }).join('');
  const grad = s.progress.graduated
    ? '<p class="br-graduated">修了済み。どの段階からでも受け直せます（クリアの記録は消えません）。</p>' + examRecordHTML(s.progress)
    : '';
  const migrated = s.progress.migratedFrom === 1 ? '<p class="br-note">以前の初心者の部屋（6段階）の進み具合を引き継ぎました。新しい段階「フリテン」などが追加されています。</p>' : '';
  return '<main class="beginner-room br-list-view"><h1>初心者の部屋</h1><p class="br-sub">数学Ⅰ（度数法）・段階の一覧</p>' +
    '<section class="br-panel"><h2>段階を選ぶ</h2>' + grad + migrated + '<ol class="br-stages">' + items + '</ol>' +
    (s.saveOk ? '' : '<p class="br-note">この端末では進み具合を保存できません。画面を閉じると最初からになります。</p>') +
    '<div class="br-actions"><button class="primary" data-action="br-resume">続きから（第' + (r.stage + 1) + '段階）</button>' +
    (s.progress.cleared.some(Boolean) || s.progress.graduated ? '<button data-action="br-restart">最初から受け直す</button>' : '') +
    '<button data-action="br-title">タイトルへ</button></div></section>' + FOOTER + '</main>';
}

function practiceViewHTML(s) {
  const st = ROOM_STAGES[s.stage];
  const hintText = s.hint ? practiceHint(s.practice) : '';
  const main = s.done
    ? '<button class="primary" data-action="br-next">' + nextLabel(s) + '</button>'
    : '<button data-action="br-hint">ヒント</button>';
  return '<main class="beginner-room br-practice">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '</h2>' +
    practiceHTML(s.practice, { hintText }) +
    '<div class="br-actions">' + main + COMMON_BUTTONS + '</div>' +
    '</section>' + FOOTER + '</main>';
}

// 卒業試験：通常の対局画面で1局戦を打つ（数学Ⅰ・Ⅱを選べる）
function examViewHTML(s) {
  const st = ROOM_STAGES[s.stage];
  const p = s.progress;
  return '<main class="beginner-room br-exam">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '</h2>' +
    '<p>初級のキャラクター（かなた・みつき・あおと）と、本番と同じ<b>1局戦</b>（現行ルール：リーチ宣言料' + RIICHI_DEPOSIT + '点・フリテン・待ちの表示あり）を打つよ。</p>' +
    '<ul class="br-exam-points"><li>聴牌したら、手牌の上に待ち牌が出るよ。</li><li>リーチできるときは「リーチ」が金色に光るよ。押してから捨てる牌を選ぶと、その後の待ちを確認できる。</li><li>和了の牌が来たら「ロン」「ツモ」。フリテンのときは理由が表示されるよ。</li></ul>' +
    '<p class="br-note">最後まで打てば修了（順位に関係なく合格）。1位を目指そう！　結果はこの端末に記録され、何度でも受け直せるよ。</p>' +
    (p.graduated ? '<p class="br-graduated">修了済み。</p>' + examRecordHTML(p) : '') +
    '<div class="br-actions br-exam-start"><button class="primary" data-action="br-exam" data-mode="math1">数学Ⅰで受ける</button><button class="primary" data-action="br-exam" data-mode="math2">数学Ⅱで受ける</button></div>' +
    '<div class="br-actions">' + COMMON_BUTTONS.replace('<button data-action="br-reset">やり直し</button>', '') + '</div>' +
    '</section>' + FOOTER + '</main>';
}

function quizViewHTML(s, rules) {
  const st = ROOM_STAGES[s.stage];
  const q = quizOf(s.step.quiz);
  const hand = quizHand(rules, s.step.quiz).map((t) => tileHTML(rules.types[t], { size: 'm' })).join('');
  const choices = q.choices.map((x, i) => {
    const on = s.selected.includes(i);
    return '<button class="br-pick' + (on ? ' on' : '') + '" type="button" data-action="br-pick" data-idx="' + i + '" aria-pressed="' + on + '"' + (s.done ? ' disabled' : '') + '>' +
      tileHTML(rules.typeByKey.get(keyOf(x)), { size: 'm' }) + '</button>';
  }).join('');
  return '<main class="beginner-room br-quiz">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '：' + s.step.title + '</h2><p>' + q.lead + '</p>' +
    '<div class="br-quiz-hand" aria-label="聴牌の手牌（8枚）">' + hand + '</div>' +
    '<p class="br-note">待ち牌の候補（いくつでも選べる）</p><div class="br-bank" role="group" aria-label="待ち牌の候補">' + choices + '</div>' +
    '<p class="br-count">選択 ' + s.selected.length + ' 枚</p>' +
    (s.message ? '<p class="br-feedback" role="status">' + s.message + '</p>' : '') +
    (s.hint && !s.done ? '<p class="br-hint">' + q.hint + '</p>' : '') +
    '<div class="br-actions">' +
    (s.done ? '<button class="primary" data-action="br-next">' + nextLabel(s) + '</button>'
      : '<button class="primary" data-action="br-check"' + (s.selected.length ? '' : ' disabled') + '>答える</button><button data-action="br-hint">ヒント</button>') +
    COMMON_BUTTONS + '</div></section>' + FOOTER + '</main>';
}

export function roomHTML(s, rules) {
  if (s.view === 'list') return listHTML(s);
  if (!s.step) s.step = stepOf(s.stage, s.part);
  if (s.step.kind === 'practice') return practiceViewHTML(s);
  if (s.step.kind === 'exam') return examViewHTML(s);
  if (s.step.kind === 'quiz') return quizViewHTML(s, rules);
  const st = ROOM_STAGES[s.stage], bank = s.step.bank, tilesOf = roomTiles(rules, bank);
  const used = new Set(s.groups.flat());
  const groups = bank === 1 && s.groups.length
    ? '<div class="br-groups"><b>完成した面子</b>' + s.groups.map((xs, i) => {
      const m = rules.meldOf(...xs.map((j) => tilesOf[j]));
      return '<div class="br-group">' + (i + 1) + '組目： ' + formulaHTML(rules, m.idx) + '</div>';
    }).join('') + '</div>'
    : '';
  const tiles = tilesOf.map((idx, i) => {
    const isUsed = used.has(i), on = s.selected.includes(i);
    return '<button class="br-pick' + (on ? ' on' : '') + (isUsed ? ' used' : '') +
      '" type="button" data-action="br-pick" data-idx="' + i + '" aria-pressed="' + on +
      '" aria-label="牌を選ぶ ' + (i + 1) + '"' + (isUsed || s.done ? ' disabled' : '') +
      '>' + tileHTML(rules.types[idx], { size: 'm' }) + '</button>';
  }).join('');
  const needed = bank === 2 ? 1 : 3;
  const answerLabel = bank === 2 ? 'この牌を捨てる' : 'この3枚を確認';
  const lead = ['関数・角度・結果の3枚を選んで、正しい数式を作ろう。', '9枚を3枚ずつの面子に分け、和了形を完成させよう。', '8枚の手牌にツモした1枚が加わったよ。次の和了を狙うため1枚捨てよう。'][bank];
  return '<main class="beginner-room">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '：' + s.step.title + '</h2><p>' + lead + '</p>' +
    (bank === 2 ? '<p class="br-note">9枚の中から1枚を捨てると、手牌は8枚に戻るよ。</p>' : '') +
    groups + '<div class="br-bank" role="group" aria-label="練習牌">' + tiles + '</div>' +
    '<p class="br-count">選択 ' + s.selected.length + ' / ' + needed + ' 枚</p>' +
    (s.message ? '<p class="br-feedback" role="status">' + s.message + '</p>' : '') +
    (s.hint && !s.done ? '<p class="br-hint">' + BANK_HINTS[bank] + '</p>' : '') +
    '<div class="br-actions">' +
    (s.done
      ? '<button class="primary" data-action="br-next">' + nextLabel(s) + '</button>'
      : '<button class="primary" data-action="br-check"' + (s.selected.length === needed ? '' : ' disabled') + '>' + answerLabel + '</button>' +
        '<button data-action="br-hint">ヒント</button>') +
    COMMON_BUTTONS + '</div>' +
    '</section>' + FOOTER + '</main>';
}
