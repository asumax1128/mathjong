// 初心者の部屋（第1〜3段階）。通常対局と独立した数学Ⅰの練習。
// 数式面子・和了の判定は既存rules.meldOf / rules.analyzeWinを再利用する。
import { tileHTML, formulaHTML } from './render.js';

export const ROOM_STAGES = Object.freeze([
  { name: '3枚の数式', lead: '関数・角度・結果の3枚を選んで、正しい数式を作ろう。' },
  { name: '3つの面子', lead: '9枚を3枚ずつの面子に分け、和了形を完成させよう。' },
  { name: 'ツモと打牌', lead: '8枚の手牌にツモした1枚が加わったよ。次の和了を狙うため1枚捨てよう。' },
]);

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
export function createRoomState() {
  return { stage: 0, selected: [], groups: [], done: false, hint: false, message: '' };
}
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
      s.done = true;
      s.message = '正解！　3枚で正しい数式面子が完成したよ。';
      return true;
    }
    s.groups.push(s.selected.slice());
    s.selected = [];
    if (s.groups.length === 3) {
      if (!rules.analyzeWin(rules.countsOf(tiles), [])) throw new Error('invalid tutorial win fixture');
      s.done = true;
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
    s.done = true;
    s.message = '正解！　8枚に戻したよ。次に「=1」をツモれば和了できるね。';
    return true;
  }
  s.message = '惜しい！　完成している2組と、あと1枚でできる組を探そう。';
  s.selected = [];
  return false;
}
export function nextRoom(s) {
  if (!s.done || s.stage >= ROOM_STEP_COUNT - 1) return false;
  s.stage++;
  s.selected = [];
  s.groups = [];
  s.done = false;
  s.hint = false;
  s.message = '';
  return true;
}
export function roomHint(s) {
  s.hint = true;
  return [
    'sin・30°・=1/2 の3枚を探そう。',
    'sin 30° = 1/2、cos 60° = 1/2、tan 45° = 1。=1/2牌は2枚あるよ。',
    'sin30°=1/2とcos60°=1/2は完成。残りのtanと45°の結果は何かな？',
  ][s.stage];
}
export function roomHTML(s, rules) {
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
  return '<main class="beginner-room"><h1>初心者の部屋</h1>' +
    '<p class="br-sub">数学Ⅰ（度数法）・第' + (s.stage + 1) + '段階 / 3</p>' +
    '<nav class="br-progress" aria-label="進み具合">' + ROOM_STAGES.map((x, i) =>
      '<span class="' + (i === s.stage ? 'current' : i < s.stage ? 'past' : '') + '">' + (i + 1) + '</span>').join('') + '</nav>' +
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
      ? '<button class="primary" data-action="br-next">' + (s.stage === 2 ? '練習完了・タイトルへ' : '次へ進む') + '</button>'
      : '<button class="primary" data-action="br-check"' + (s.selected.length === needed ? '' : ' disabled') + '>' + answerLabel + '</button>' +
        '<button data-action="br-hint">ヒント</button>') +
    '<button data-action="br-reset">最初から</button><button data-action="br-title">タイトルへ戻る</button></div>' +
    '</section><p class="br-footer">通常の対局と選んだ3人には影響しません。第4〜6段階は今後追加予定です。</p></main>';
}
