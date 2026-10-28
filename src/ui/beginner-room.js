// 初心者の部屋（第1〜6段階）。通常対局と独立した数学Ⅰの練習。
// 第1〜3段階：数式面子・和了の判定は既存rules.meldOf / rules.analyzeWinを再利用する。
// 第4〜6段階：実際の対局エンジンで固定の局面を進める（beginner-practice.js）。
import { tileHTML, formulaHTML } from './render.js';
import { createPractice, lessonAt, practiceAct, practiceSelect, practiceContinue, practiceHint, practiceHTML, STAGE_PARTS } from './beginner-practice.js';
import { freshProgress, isUnlocked } from './beginner-progress.js';

export const ROOM_STAGES = Object.freeze([
  { name: '3枚の数式', lead: '関数・角度・結果の3枚を選んで、正しい数式を作ろう。' },
  { name: '3つの面子', lead: '9枚を3枚ずつの面子に分け、和了形を完成させよう。' },
  { name: 'ツモと打牌', lead: '8枚の手牌にツモした1枚が加わったよ。次の和了を狙うため1枚捨てよう。' },
  { name: 'チー・ポン', lead: 'ほかの人の捨て牌をもらって面子を作る「鳴き」を練習しよう。' },
  { name: 'リーチ・ロン・ツモ', lead: 'リーチの宣言と、2通りの和了（ロン・ツモ）を練習しよう。' },
  { name: '卒業試験', lead: '練習用CPU 3人と1局を打って、自分で和了しよう。' },
]);
export const ROOM_STAGE_COUNT = ROOM_STAGES.length;
export const partsOf = (stage) => STAGE_PARTS[stage] || 0;

// 実際の数学Ⅰで使用できる牌。第2段階の9枚はそのまま和了可能。
// 第3段階の9枚は=-1を切って=1をツモれば、3つの数式面子になる。
const BANKS = Object.freeze([
  ['a:60', 'v:1/2', 'f:cos', 'f:sin', 'a:30', 'v:1'],
  ['f:cos', 'a:45', 'v:1/2', 'f:sin', 'v:1', 'a:30', 'f:tan', 'v:1/2', 'a:60'],
  ['a:60', 'f:sin', 'v:1/2', 'a:45', 'f:tan', 'v:-1', 'f:cos', 'a:30', 'v:1/2'],
]);
export const ROOM_STEP_COUNT = BANKS.length;
export function roomTiles(rules, stage) {
  if (!Number.isInteger(stage) || stage < 0 || stage >= BANKS.length) throw new RangeError('bad stage');
  return BANKS[stage].map((key) => {
    const t = rules.typeByKey.get(key);
    if (!t) throw new Error('bad tutorial tile: ' + key);
    return t.idx;
  });
}
export function createRoomState(progress = freshProgress()) {
  return { stage: 0, part: 0, selected: [], groups: [], done: false, hint: false, message: '', view: 'stage', practice: null, progress, saveOk: true };
}

// 段階（と課題）を始める。第4〜6段階は固定の局面を新しく作る（やり直しも同じ）。
export function enterStage(s, rules, stage, part = 0) {
  if (!Number.isInteger(stage) || stage < 0 || stage >= ROOM_STAGE_COUNT) throw new RangeError('bad stage');
  s.stage = stage;
  s.part = stage >= ROOM_STEP_COUNT ? Math.min(Math.max(0, part), partsOf(stage) - 1) : 0;
  s.selected = [];
  s.groups = [];
  s.done = false;
  s.hint = false;
  s.message = '';
  s.view = 'stage';
  s.practice = stage >= ROOM_STEP_COUNT ? createPractice(rules, lessonAt(stage, s.part)) : null;
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
export function retryRoom(s, rules) { enterStage(s, rules, s.stage, s.part); }
export function openRoomList(s) { s.view = 'list'; }

// 段階の最後の課題を終えたらクリアにする
function markCleared(s) {
  if (s.done && (s.stage < ROOM_STEP_COUNT || s.part === partsOf(s.stage) - 1)) s.progress.cleared[s.stage] = true;
}

// 第4〜6段階の操作（実際の対局エンジンへ渡す）
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
  if (s.done) return;
  const tiles = roomTiles(rules, s.stage);
  if (!Number.isInteger(index) || index < 0 || index >= tiles.length) return;
  if (s.groups.flat().includes(index)) return;
  if (s.stage === 2) s.selected = [index];
  else if (s.selected.includes(index)) s.selected = s.selected.filter((i) => i !== index);
  else if (s.selected.length < 3) s.selected.push(index);
  else { s.message = '3枚選んだよ。「確認する」を押すか、1枚外そう。'; return; }
  s.message = '';
  s.hint = false;
}
export function checkRoom(s, rules) {
  if (s.done) return false;
  const tiles = roomTiles(rules, s.stage);
  if (s.selected.length !== (s.stage === 2 ? 1 : 3)) {
    s.message = '牌を選んでから確認してね。';
    return false;
  }
  if (s.stage <= 1) {
    const meld = rules.meldOf(...s.selected.map((i) => tiles[i]));
    if (!meld) {
      s.message = 'この3枚は面子にならないよ。別の組合せを試そう。';
      s.selected = []; return false;
    }
    if (s.stage === 0) {
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
// 次の段階（第4・5段階は次の課題）へ。卒業試験の後は false。
export function nextRoom(s, rules) {
  if (!s.done) return false;
  markCleared(s);
  if (s.stage >= ROOM_STEP_COUNT && s.part + 1 < partsOf(s.stage)) {
    enterStage(s, rules, s.stage, s.part + 1);
    return true;
  }
  if (s.stage >= ROOM_STAGE_COUNT - 1) return false;
  enterStage(s, rules, s.stage + 1, 0);
  return true;
}
export function roomHint(s) {
  s.hint = true;
  if (s.practice) return practiceHint(s.practice);
  return [
    'sin・30°・=1/2 の3枚を探そう。',
    'sin 30° = 1/2、cos 60° = 1/2、tan 45° = 1。=1/2牌は2枚あるよ。',
    'sin30°=1/2とcos60°=1/2は完成。残りのtanと45°の結果は何かな？',
  ][s.stage];
}
const COMMON_BUTTONS = '<button data-action="br-reset">やり直し</button><button data-action="br-list">一覧へ</button><button data-action="br-title">タイトルへ</button>';
const FOOTER = '<p class="br-footer">通常の対局・選んだ3人・対局の成績には影響しません。進み具合はこの端末だけに保存されます。</p>';

function headHTML(s) {
  return '<h1>初心者の部屋</h1>' +
    '<p class="br-sub">数学Ⅰ（度数法）・第' + (s.stage + 1) + '段階 / ' + ROOM_STAGE_COUNT + '</p>' +
    '<nav class="br-progress" aria-label="進み具合">' + ROOM_STAGES.map((x, i) =>
      '<span class="' + (i === s.stage ? 'current' : s.progress.cleared[i] ? 'past' : '') + '">' + (i + 1) + '</span>').join('') + '</nav>';
}

function nextLabel(s) {
  if (s.stage >= ROOM_STEP_COUNT && s.part + 1 < partsOf(s.stage)) return '次の課題へ';
  return '第' + (s.stage + 2) + '段階へ進む';
}

// 段階の一覧（クリアした段階はもう一度遊べる。まだ開いていない段階は選べない）
function listHTML(s) {
  const r = s.progress.resume;
  const items = ROOM_STAGES.map((st, i) => {
    const open = isUnlocked(s.progress, i), clear = s.progress.cleared[i];
    const state = clear ? 'クリア' : open ? (r.stage === i && r.part > 0 ? '途中（課題' + (r.part + 1) + '/' + partsOf(i) + '）' : '挑戦できる') : 'まだ開いていない';
    return '<li><button class="br-stage' + (clear ? ' clear' : '') + '" data-action="br-goto" data-stage="' + i + '"' + (open ? '' : ' disabled') + '>' +
      '<span class="br-stage-no">' + (i + 1) + '</span><span class="br-stage-name">' + st.name + '</span><span class="br-stage-state">' + state + '</span></button></li>';
  }).join('');
  return '<main class="beginner-room br-list-view"><h1>初心者の部屋</h1><p class="br-sub">数学Ⅰ（度数法）・段階の一覧</p>' +
    '<section class="br-panel"><h2>段階を選ぶ</h2><ol class="br-stages">' + items + '</ol>' +
    (s.saveOk ? '' : '<p class="br-note">この端末では進み具合を保存できません。画面を閉じると最初からになります。</p>') +
    '<div class="br-actions"><button class="primary" data-action="br-resume">続きから（第' + (r.stage + 1) + '段階）</button>' +
    '<button data-action="br-title">タイトルへ</button></div></section>' + FOOTER + '</main>';
}

function practiceViewHTML(s) {
  const st = ROOM_STAGES[s.stage];
  const exam = s.stage === ROOM_STAGE_COUNT - 1;
  const hintText = s.hint ? practiceHint(s.practice) : '';
  const grad = exam && s.done
    ? '<div class="br-graduate" role="status"><p class="br-grad-title">初心者の部屋 修了</p><p>おめでとう！　これで数雀の基本はばっちり。次は9人のキャラクターから3人を選んで、本当の対局に挑戦しよう。</p></div>'
    : '';
  const main = s.done
    ? (exam ? '<button class="primary" data-action="br-challenge">実際の対局に挑戦する</button>' : '<button class="primary" data-action="br-next">' + nextLabel(s) + '</button>')
    : '<button data-action="br-hint">ヒント</button>';
  return '<main class="beginner-room br-practice">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '</h2>' +
    practiceHTML(s.practice, { hintText }) + grad +
    '<div class="br-actions">' + main + COMMON_BUTTONS + '</div>' +
    '</section>' + FOOTER + '</main>';
}

export function roomHTML(s, rules) {
  if (s.view === 'list') return listHTML(s);
  if (s.stage >= ROOM_STEP_COUNT) return practiceViewHTML(s);
  const st = ROOM_STAGES[s.stage], bank = roomTiles(rules, s.stage);
  const used = new Set(s.groups.flat());
  const groups = s.stage === 1 && s.groups.length
    ? '<div class="br-groups"><b>完成した面子</b>' + s.groups.map((xs, i) => {
      const m = rules.meldOf(...xs.map((j) => bank[j]));
      return '<div class="br-group">' + (i + 1) + '組目： ' + formulaHTML(rules, m.idx) + '</div>';
    }).join('') + '</div>'
    : '';
  const tiles = bank.map((idx, i) => {
    const isUsed = used.has(i), on = s.selected.includes(i);
    return '<button class="br-pick' + (on ? ' on' : '') + (isUsed ? ' used' : '') +
      '" type="button" data-action="br-pick" data-idx="' + i + '" aria-pressed="' + on +
      '" aria-label="牌を選ぶ ' + (i + 1) + '"' + (isUsed || s.done ? ' disabled' : '') +
      '>' + tileHTML(rules.types[idx], { size: 'm' }) + '</button>';
  }).join('');
  const needed = s.stage === 2 ? 1 : 3;
  const answerLabel = s.stage === 2 ? 'この牌を捨てる' : 'この3枚を確認';
  return '<main class="beginner-room">' + headHTML(s) +
    '<section class="br-panel"><h2>' + st.name + '</h2><p>' + st.lead + '</p>' +
    (s.stage === 2 ? '<p class="br-note">9枚の中から1枚を捨てると、手牌は8枚に戻るよ。</p>' : '') +
    groups + '<div class="br-bank" role="group" aria-label="練習牌">' + tiles + '</div>' +
    '<p class="br-count">選択 ' + s.selected.length + ' / ' + needed + ' 枚</p>' +
    (s.message ? '<p class="br-feedback" role="status">' + s.message + '</p>' : '') +
    (s.hint && !s.done ? '<p class="br-hint">' + [
      'sin・30°・=1/2 を探してみよう。',
      'sin30°=1/2、cos60°=1/2、tan45°=1 の3組を探そう。',
      'sin30°=1/2とcos60°=1/2は完成。tanと45°に合う結果を考えよう。',
    ][s.stage] + '</p>' : '') +
    '<div class="br-actions">' +
    (s.done
      ? '<button class="primary" data-action="br-next">' + (s.stage === 2 ? '第4段階へ進む' : '次へ進む') + '</button>'
      : '<button class="primary" data-action="br-check"' + (s.selected.length === needed ? '' : ' disabled') + '>' + answerLabel + '</button>' +
        '<button data-action="br-hint">ヒント</button>') +
    COMMON_BUTTONS + '</div>' +
    '</section>' + FOOTER + '</main>';
}
