// 初心者の部屋の進み具合（第1〜6段階）。この端末の localStorage に、版つきの専用キーで保存する。
// 通常対局の設定・選んだ3人・対局の記録とは別（ほかのキーを読み書きしない）。保存できない環境でも、画面の記憶だけで動く。
export const PROGRESS_KEY = 'mj-beginner-room-v1';
export const STAGE_COUNT = 6;

export function freshProgress() {
  return { v: 1, cleared: new Array(STAGE_COUNT).fill(false), resume: { stage: 0, part: 0 } };
}

// partsOf(stage)：その段階の課題数（第1〜3段階は 0）
export function parseProgress(raw, partsOf) {
  const p = freshProgress();
  if (typeof raw !== 'string' || !raw) return p;
  let o;
  try { o = JSON.parse(raw); } catch { return p; }
  if (!o || o.v !== 1 || !Array.isArray(o.cleared) || o.cleared.length !== STAGE_COUNT) return p;
  p.cleared = o.cleared.map((x) => x === true);
  const st = o.resume && o.resume.stage;
  const pt = o.resume && o.resume.part;
  if (Number.isInteger(st) && st >= 0 && st < STAGE_COUNT && isUnlocked(p, st)) {
    p.resume.stage = st;
    p.resume.part = Number.isInteger(pt) && pt >= 0 && pt < Math.max(1, partsOf(st)) ? pt : 0;
  }
  return p;
}

export function loadProgress(storage, partsOf) {
  let raw = null;
  try { raw = storage ? storage.getItem(PROGRESS_KEY) : null; } catch { raw = null; }
  return parseProgress(raw, partsOf);
}

// 戻り値：保存できたか
export function saveProgress(storage, p) {
  try {
    if (!storage) return false;
    storage.setItem(PROGRESS_KEY, JSON.stringify({ v: 1, cleared: p.cleared, resume: p.resume }));
    return true;
  } catch {
    return false;
  }
}

// 第1段階と、クリアした段階の次の段階まで選べる
export function isUnlocked(p, stage) {
  return stage === 0 || p.cleared.slice(0, stage).every(Boolean) || p.cleared[stage];
}

export const hasProgress = (p) => p.cleared.some(Boolean) || p.resume.stage > 0 || p.resume.part > 0;
