// オンライン対戦のロビーの論理（段階1・docs/79「6」「7.1」「9.1」）。通信は Transport（online-transport.js）だけを使う。
// 画面（online-ui.js）とは分けて、メモリ上の偽バスで単体試験できるようにしている。
// ・部屋の作成：衝突しない6文字コード（無いコードにだけ meta を作る transaction）。作成者が席0に座る。
// ・参加：形の確認 → 部屋の有無 → 期限 → 版 → 自分の席があれば戻る → ロビー中か → 空席を transaction で取る（満席なら不可）
// ・設定の変更と開始はホストだけ（ルールでも守る）。開始は人間2人以上。段階1では status を playing にするまで。
// ・退出：ホストは部屋を丸ごと消す（ホストの移譲はしない・U3）。ゲストは自分の席を外す。
import { ROOM_TTL_MS, SEATS, MODES, LENGTHS, RULESET, generateCode, normalizeCode, normalizeName } from './online-config.js';
import { OPPONENTS, drawOpponents, assignSeats } from './opponents.js';

// 段階2：空席の CPU（U7）。meta.cpus は CPU の枠（空席を席の順に並べたもの）ごとの選択を「,」でつないだ文字列。
// 'auto'＝自動（開始時に、選ばれていない人から無作為に選ぶ。ローカルの「おまかせ」と同じ drawOpponents）。
export const CPU_AUTO = 'auto';
export const CPU_IDS = OPPONENTS.map((o) => o.id);
export const parseCpus = (s) => {
  const a = String(s || '').split(',').map((x) => x.trim());
  return [0, 1, 2].map((i) => (CPU_IDS.includes(a[i]) ? a[i] : CPU_AUTO));
};

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

// CPU の枠の選択（ホストだけ）。同じ人を2つの枠に選べない（後から選んだ枠を優先し、ほかの枠の同じ人は自動に戻す）
export async function setCpu(t, code, slot, id) {
  if (!(slot >= 0 && slot < 3) || !(id === CPU_AUTO || CPU_IDS.includes(id))) fail('bad-settings');
  const meta = await t.get(room(code, 'meta'));
  if (!meta) fail('not-found');
  if (meta.hostUid !== t.uid) fail('not-host');
  if (meta.status !== 'lobby') fail('started');
  const cpus = parseCpus(meta.cpus).map((x, i) => (i === slot ? id : x === id ? CPU_AUTO : x));
  await t.update(room(code, 'meta'), { cpus: cpus.join(',') });
}

// 開始の席決め（ホストの端末で無作為に・U9）：人間と CPU を4席に並べ、最初の親も無作為。純関数（rand を渡す）
export function planSeats(lobbySeats, cpus, rand) {
  const humans = [];
  for (let i = 0; i < SEATS; i++) { const s = lobbySeats && lobbySeats[i]; if (s && s.kind === 'human') humans.push({ kind: 'human', uid: s.uid, name: s.name, joinedAt: s.joinedAt }); }
  const n = SEATS - humans.length;
  const picks = parseCpus(cpus).slice(0, n);
  const fixed = picks.filter((x) => x !== CPU_AUTO);
  const autos = drawOpponents(rand, picks.length - fixed.length, CPU_IDS.filter((id) => !fixed.includes(id)));
  const autoQueue = assignSeats(autos, rand);
  const cpuIds = picks.map((x) => (x === CPU_AUTO ? autoQueue.shift() : x));
  const cpuSeats = cpuIds.map((id) => { const o = OPPONENTS.find((x) => x.id === id); return { kind: 'cpu', cpuId: id, name: o ? o.name : id }; });
  const order = assignSeats([...humans, ...cpuSeats], rand);
  return { seats: order, startDealer: Math.floor(rand() * SEATS) };
}

// 開始：人間2人以上。席を決め直して seats に書き、seedBase と最初の親は host（ホストだけが読める）へ。status を playing に
export async function startMatch(t, code, { rand = Math.random, seedBase = Math.floor(rand() * 1e9) } = {}) {
  const [meta, seats] = await Promise.all([t.get(room(code, 'meta')), t.get(room(code, 'seats'))]);
  if (!meta) fail('not-found');
  if (meta.hostUid !== t.uid) fail('not-host');
  if (!canStart(meta, seats)) fail('need-two');
  const plan = planSeats(seats, meta.cpus, rand);
  const now = Math.floor(t.now());
  const upd = { host: { seedBase, startDealer: plan.startDealer }, 'meta/status': 'playing', 'meta/startedAt': now };
  plan.seats.forEach((s, i) => { upd[`seats/${i}`] = s.kind === 'human' ? { uid: s.uid, name: s.name, kind: 'human', joinedAt: s.joinedAt || now } : { name: s.name, kind: 'cpu', cpuId: s.cpuId, joinedAt: now }; });
  await t.update(room(code), upd);
  return { seats: plan.seats, startDealer: plan.startDealer, seedBase, mode: meta.mode, length: meta.length };
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
      list.push({ seat: i, kind: 'human', name: s.name, uid: s.uid, me: s.uid === uid, host: s.uid === meta.hostUid, online: !!(p && p.online) });
    } else if (s && s.kind === 'cpu') list.push({ seat: i, kind: 'cpu', name: s.name, cpuId: s.cpuId });
    else list.push({ seat: i, kind: 'cpu', slot: null });
  }
  // ロビーの空席：CPU の枠を席の順に割り当てる（枠ごとの選択は meta.cpus）
  const cpus = parseCpus(meta.cpus);
  let slot = 0;
  for (const s of list) if (s.kind === 'cpu' && !s.cpuId) { s.slot = slot; s.pick = cpus[slot]; slot++; }
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
