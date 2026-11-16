// オンライン対戦（段階1：ロビーまで・docs/79）の定数と小さな純関数。ネットワークにも DOM にも触れない。
// FB_CONFIG はブラウザに公開される値（秘密ではない）。FACTOR×FACTOR・いろヨミと同じ asumath-games プロジェクト。
// 段階1では本番に接続しない：ONLINE_PUBLIC が false の間は、オンライン入口はローカル開発環境の
// ?online=emu（Auth・Database エミュレータ）でだけ現れる。本番の公開は段階4（ルール適用の後）で切り替える。
export const ONLINE_PUBLIC = false;
export const FIREBASE_SDK_VERSION = '12.12.0';
export const FIREBASE_SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/`;
export const FB_CONFIG = Object.freeze({
  apiKey: 'AIzaSyC3__kwx4TH-ezcCCUWcb_J7PWZ7pDUjDc',
  authDomain: 'asumath-games.firebaseapp.com',
  databaseURL: 'https://asumath-games-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'asumath-games',
  storageBucket: 'asumath-games.firebasestorage.app',
  messagingSenderId: '254715782397',
  appId: '1:254715782397:web:bda2fd2283b292db050a94',
});
// エミュレータ（demo- プロジェクト。本番に接続しない）。ローカルの試験と E2E だけで使う
export const EMU = Object.freeze({
  projectId: 'demo-mathjong', authHost: '127.0.0.1', authPort: 9099, dbHost: '127.0.0.1', dbPort: 9000,
});
export const ROOT_PATH = 'games/mathjong';
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 部屋の期限（12時間）
export const SEATS = 4;
export const NAME_MAX = 10;
export const NAME_KEY = 'mj-online-name';
// 部屋コード：6文字。読み違えやすい I・O・0・1 を除いた32文字
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;
export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const MODES = Object.freeze(['math1', 'math2']);
export const LENGTHS = Object.freeze([1, 4, 8]);
export const RULESET = 2; // 段階1〜：ルールセットは2に固定（選択肢に出さない）

// 32文字なので1バイトの下位5ビットで偏りなく選べる
export function generateCode(randomBytes = defaultRandomBytes) {
  const b = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] & 31];
  return s;
}
function defaultRandomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}
// 入力されたコードを整える（空白・ハイフンを除き、大文字に）。形が正しくなければ null
export function normalizeCode(input) {
  const s = String(input ?? '').replace(/[\s\-ー－]/g, '').toUpperCase();
  return CODE_RE.test(s) ? s : null;
}
// ニックネーム：前後の空白を除いて1〜10文字（ルールの length と同じ数え方）。制御文字は不可。正しくなければ null
export function normalizeName(input) {
  const s = String(input ?? '').trim();
  if (s.length < 1 || s.length > NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}
export const modeLabel = (m) => (m === 'math2' ? '数学Ⅱ' : '数学Ⅰ');
