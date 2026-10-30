// 初心者の部屋の進み具合。この端末の localStorage に、版つきの専用キーで保存する。
// 通常対局の設定・選んだ3人・対局の記録とは別（ほかのキーを読み書きしない）。保存できない環境でも、画面の記憶だけで動く。
//
// 版2（docs/67・初心者体験の刷新）：8段階（数式→捨て牌→聴牌と待ち→リーチ→ロン・ツモ→フリテン→鳴き→卒業試験（1局戦））。
// 版1（旧6段階、キー mj-beginner-room-v1）は読むだけで消さない・書き換えない。版2の保存がまだなければ版1から引き継ぐ：
//   旧1・2（数式・3つの面子）→ 新1、旧3（ツモと打牌）→ 新2、旧5（リーチ・ロン・ツモ）→ 新3・4・5、旧4（チー・ポン）→ 新7、
//   旧6（卒業試験）→ 新8（修了済み）。新しい段階（フリテン）は未クリアのまま（受講できる）。
export const PROGRESS_KEY = 'mj-beginner-room-v2';
export const LEGACY_PROGRESS_KEY = 'mj-beginner-room-v1';
export const STAGE_COUNT = 8;
const LEGACY_STAGE_COUNT = 6;

// exam：卒業試験（1局戦）の記録。plays：受けた回数、firsts：1位の回数、best：最高の順位（null＝まだ）、lastRank、lastMode
export function freshProgress() {
  return { v: 2, cleared: new Array(STAGE_COUNT).fill(false), resume: { stage: 0, part: 0 }, graduated: false, exam: { plays: 0, firsts: 0, best: null, lastRank: null, lastMode: null }, migratedFrom: null };
}

const validPart = (pt, stage, partsOf) => (Number.isInteger(pt) && pt >= 0 && pt < Math.max(1, partsOf(stage)) ? pt : 0);

// partsOf(stage)：その段階の課題数
export function parseProgress(raw, partsOf) {
  const p = freshProgress();
  if (typeof raw !== 'string' || !raw) return p;
  let o;
  try { o = JSON.parse(raw); } catch { return p; }
  if (!o || o.v !== 2 || !Array.isArray(o.cleared) || o.cleared.length !== STAGE_COUNT) return p;
  p.cleared = o.cleared.map((x) => x === true);
  p.graduated = o.graduated === true;
  if (o.exam && typeof o.exam === 'object') {
    const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
    p.exam.plays = n(o.exam.plays);
    p.exam.firsts = Math.min(n(o.exam.firsts), p.exam.plays);
    p.exam.best = [1, 2, 3, 4].includes(o.exam.best) ? o.exam.best : null;
    p.exam.lastRank = [1, 2, 3, 4].includes(o.exam.lastRank) ? o.exam.lastRank : null;
    p.exam.lastMode = ['math1', 'math2'].includes(o.exam.lastMode) ? o.exam.lastMode : null;
  }
  p.migratedFrom = o.migratedFrom === 1 ? 1 : null;
  const st = o.resume && o.resume.stage;
  if (Number.isInteger(st) && st >= 0 && st < STAGE_COUNT && isUnlocked(p, st)) p.resume = { stage: st, part: validPart(o.resume.part, st, partsOf) };
  return p;
}

// 版1（旧6段階）の値から版2を作る。壊れた値・版の違う値は null（引き継がない）
export function migrateLegacy(raw, partsOf) {
  if (typeof raw !== 'string' || !raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || o.v !== 1 || !Array.isArray(o.cleared) || o.cleared.length !== LEGACY_STAGE_COUNT) return null;
  const c = o.cleared.map((x) => x === true);
  const p = freshProgress();
  p.migratedFrom = 1;
  p.cleared = [c[0] && c[1], c[2], c[4], c[4], c[4], false, c[3], c[5]];
  p.graduated = c[5];
  // 続きの位置：旧の段階・課題を新しい段階・課題へ
  const st = o.resume && o.resume.stage, pt = o.resume && Number.isInteger(o.resume.part) ? o.resume.part : 0;
  const map = { 0: [0, 0], 1: [0, 1], 2: [1, 0], 3: [6, pt], 4: [[3, 0], [4, 0], [4, 1]][pt] || [3, 0], 5: [7, 0] };
  const to = map[st];
  if (to && isUnlocked(p, to[0])) p.resume = { stage: to[0], part: validPart(to[1], to[0], partsOf) };
  return p;
}

export function loadProgress(storage, partsOf) {
  const get = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const raw = get(PROGRESS_KEY);
  if (raw) return parseProgress(raw, partsOf);
  return migrateLegacy(get(LEGACY_PROGRESS_KEY), partsOf) || freshProgress();
}

// 戻り値：保存できたか（版2のキーだけに書く。版1のキーは残す）
export function saveProgress(storage, p) {
  try {
    if (!storage) return false;
    storage.setItem(PROGRESS_KEY, JSON.stringify({ v: 2, cleared: p.cleared, resume: p.resume, graduated: !!p.graduated, exam: p.exam, migratedFrom: p.migratedFrom }));
    return true;
  } catch {
    return false;
  }
}

// 第1段階と、それまでの段階をすべてクリアした段階・クリア済みの段階を選べる（修了後は全段階を受け直せる）
export function isUnlocked(p, stage) {
  return stage === 0 || p.graduated || p.cleared.slice(0, stage).every(Boolean) || p.cleared[stage];
}

export const hasProgress = (p) => p.cleared.some(Boolean) || p.resume.stage > 0 || p.resume.part > 0 || p.graduated;

// 卒業試験（1局戦）の結果を記録する：最後まで打てば合格（修了）。rank：1〜4、mode：'math1' | 'math2'
export function recordExam(p, rank, mode) {
  p.exam.plays++;
  if (rank === 1) p.exam.firsts++;
  p.exam.best = p.exam.best === null ? rank : Math.min(p.exam.best, rank);
  p.exam.lastRank = rank;
  p.exam.lastMode = mode;
  p.cleared[STAGE_COUNT - 1] = true;
  p.graduated = true;
}
