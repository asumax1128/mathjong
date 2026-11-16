// オンライン対戦のロビーの論理（段階1・docs/79「6」「7.1」「9.1」）。通信は Transport（online-transport.js）だけを使う。
// 画面（online-ui.js）とは分けて、メモリ上の偽バスで単体試験できるようにしている。
// ・部屋の作成：衝突しない6文字コード（無いコードにだけ meta を作る transaction）。作成者が席0に座る。
// ・参加：形の確認 → 部屋の有無 → 期限 → 版 → 自分の席があれば戻る → ロビー中か → 空席を transaction で取る（満席なら不可）
// ・設定の変更と開始はホストだけ（ルールでも守る）。開始は人間2人以上。段階1では status を playing にするまで。
// ・退出：ホストは部屋を丸ごと消す（ホストの移譲はしない・U3）。ゲストは自分の席を外す。
import { ROOM_TTL_MS, SEATS, MODES, LENGTHS, RULESET, generateCode, normalizeCode, normalizeName } from './online-config.js';

export class LobbyError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new LobbyError(code, detail); };
const room = (code, p = '') => `rooms/${code}${p ? `/${p}` : ''}`;

export const humansOf = (seats) => Object.values(seats || {}).filter((s) => s && s.kind === 'human').length;
export const canStart = (meta, seats) => !!meta && meta.status === 'lobby' && humansOf(seats) >= 2;

// 停止スイッチ：config.enabled === true のときだけ入れる（読めない・無いときも入れない）
export async function isEnabled(t) {
  try { const c = await t.get('config'); return !!(c && c.enabled === true); } catch { return false; }
}

export async function createRoom(t, { name, mode = 'math1', length = 4, appVersion, randomBytes, maxTries = 8 }) {
  const nm = normalizeName(name) || fail('bad-name');
  if (!MODES.includes(mode) || !LENGTHS.includes(length)) fail('bad-settings');
  for (let i = 0; i < maxTries; i++) {
    const code = generateCode(randomBytes);
    const now = Math.floor(t.now());
    const meta = { hostUid: t.uid, status: 'lobby', mode, length, ruleset: RULESET, appVersion, createdAt: now, expiresAt: now + ROOM_TTL_MS, matchNo: 0 };
    let res;
    try { res = await t.transaction(room(code, 'meta'), (cur) => (cur ? undefined : meta)); } catch { continue; } // 他人の部屋（読めても書けない）は次のコードへ
    if (!res.committed) continue;
    await t.set(room(code, 'seats/0'), { uid: t.uid, name: nm, kind: 'human', joinedAt: now });
    return { code, seat: 0, meta };
  }
  return fail('code-exhausted');
}

export async function joinRoom(t, { code: input, name, appVersion }) {
  const code = normalizeCode(input) || fail('bad-code');
  const nm = normalizeName(name) || fail('bad-name');
  const meta = await t.get(room(code, 'meta'));
  if (!meta) fail('not-found');
  if (!(meta.expiresAt > t.now())) {
    t.remove(room(code)).catch(() => {}); // 期限切れの部屋は誰でも丸ごと消せる（サーバーなしの掃除）
    fail('expired');
  }
  if (meta.appVersion !== appVersion) fail('version', meta.appVersion);
  const seats = (await t.get(room(code, 'seats'))) || {};
  for (const [k, s] of Object.entries(seats)) {
    if (s && s.uid === t.uid) { // 同じ端末から入り直し：自分の席に戻る
      if (s.name !== nm) await t.set(room(code, `seats/${k}/name`), nm);
      return { code, seat: Number(k), meta, rejoined: true };
    }
  }
  if (meta.status !== 'lobby') fail('started');
  for (let i = 0; i < SEATS; i++) {
    if (seats[i]) continue;
    const seat = { uid: t.uid, name: nm, kind: 'human', joinedAt: Math.floor(t.now()) };
    let res;
    try { res = await t.transaction(room(code, `seats/${i}`), (cur) => (cur ? undefined : seat)); } catch { res = { committed: false }; }
    if (res.committed) return { code, seat: i, meta };
  }
  // 取り合いに負けた・状態が変わった：最新の状態で理由を決める
  const m2 = await t.get(room(code, 'meta'));
  if (!m2) fail('not-found');
  if (m2.status !== 'lobby') fail('started');
  return fail('full');
}

export async function changeSettings(t, code, { mode, length }) {
  const patch = {};
  if (mode !== undefined) { if (!MODES.includes(mode)) fail('bad-settings'); patch.mode = mode; }
  if (length !== undefined) { if (!LENGTHS.includes(length)) fail('bad-settings'); patch.length = length; }
  const meta = await t.get(room(code, 'meta'));
  if (!meta) fail('not-found');
  if (meta.hostUid !== t.uid) fail('not-host');
  if (meta.status !== 'lobby') fail('started');
  await t.update(room(code, 'meta'), patch);
}

export async function startMatch(t, code) {
  const [meta, seats] = await Promise.all([t.get(room(code, 'meta')), t.get(room(code, 'seats'))]);
  if (!meta) fail('not-found');
  if (meta.hostUid !== t.uid) fail('not-host');
  if (!canStart(meta, seats)) fail('need-two');
  await t.update(room(code, 'meta'), { status: 'playing', startedAt: Math.floor(t.now()) });
}

// 接続の有無：入室中は online:true。切れたら onDisconnect で online:false
export async function enterPresence(t, code) {
  const p = room(code, `presence/${t.uid}`);
  await t.onDisconnectSet(p, { online: false, at: Math.floor(t.now()) });
  await t.set(p, { online: true, at: Math.floor(t.now()) });
}

export async function leaveRoom(t, code) {
  const p = room(code, `presence/${t.uid}`);
  try { await t.cancelOnDisconnect(p); } catch { /* 取り消せなくても退出は進める */ }
  const meta = await t.get(room(code, 'meta')).catch(() => null);
  if (!meta) return;
  if (meta.hostUid === t.uid) { await t.remove(room(code)); return; }
  const seats = (await t.get(room(code, 'seats'))) || {};
  const mine = Object.entries(seats).find(([, s]) => s && s.uid === t.uid);
  try { await t.set(p, { online: false, at: Math.floor(t.now()) }); } catch { /* 期限切れなど */ }
  if (mine && meta.status === 'lobby') await t.remove(room(code, `seats/${mine[0]}`));
}

// ロビーの監視：meta・seats・presence をまとめて cb(view) に渡す。meta が消えたら closed
export function watchRoom(t, code, cb) {
  const st = { meta: undefined, seats: undefined, presence: undefined };
  const emit = () => {
    if (st.meta === undefined || st.seats === undefined || st.presence === undefined) return;
    cb(viewOf(t.uid, code, st.meta, st.seats, st.presence, t.now()));
  };
  const uns = [
    t.onValue(room(code, 'meta'), (v) => { st.meta = v; emit(); }),
    t.onValue(room(code, 'seats'), (v) => { st.seats = v || {}; emit(); }),
    t.onValue(room(code, 'presence'), (v) => { st.presence = v || {}; emit(); }),
  ];
  return () => uns.forEach((u) => u());
}

export function viewOf(uid, code, meta, seats, presence, now) {
  if (!meta) return { code, closed: true };
  const list = [];
  for (let i = 0; i < SEATS; i++) {
    const s = seats && seats[i];
    if (s && s.kind === 'human') {
      const p = presence && presence[s.uid];
      list.push({ seat: i, kind: 'human', name: s.name, me: s.uid === uid, host: s.uid === meta.hostUid, online: !!(p && p.online) });
    } else list.push({ seat: i, kind: 'cpu' });
  }
  const mine = list.find((s) => s.me);
  return {
    code, closed: false, meta,
    seats: list,
    humans: list.filter((s) => s.kind === 'human').length,
    isHost: meta.hostUid === uid,
    mySeat: mine ? mine.seat : null,
    removed: !mine, // 自分の席が無くなった（ホストが部屋を作り直した等）
    canStart: meta.hostUid === uid && canStart(meta, seats),
    expired: !(meta.expiresAt > now),
  };
}
