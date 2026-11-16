// オンライン対戦 段階1（ロビーまで）の単体試験。メモリ上の偽バスで、ホスト1＋ゲスト3を同じプロセスで動かす（docs/79「9.0①」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBus } from '../src/ui/online-transport.js';
import { createRoom, joinRoom, changeSettings, startMatch, leaveRoom, enterPresence, watchRoom, isEnabled, LobbyError, viewOf } from '../src/ui/online-lobby.js';
import { generateCode, normalizeCode, normalizeName, CODE_RE, CODE_ALPHABET, ROOM_TTL_MS, RULESET } from '../src/ui/online-config.js';

const V = '0.7.0';
const tick = () => new Promise((r) => setTimeout(r, 0));
function setup(n = 4) {
  let clock = 1_700_000_000_000;
  const bus = createMemoryBus({ now: () => clock });
  const ts = Array.from({ length: n }, (_, i) => bus.transport(`u${i}`));
  return { bus, ts, advance: (ms) => { clock += ms; } };
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof LobbyError && e.code === code);

test('部屋コード：6文字・32文字種（I・O・0・1なし）・入力の整形', () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.ok(!/[IO01]/.test(CODE_ALPHABET));
  for (let i = 0; i < 500; i++) assert.match(generateCode(), CODE_RE);
  // 決定論的な乱数で全文字が出る
  assert.equal(generateCode(() => [0, 1, 2, 29, 30, 31]), 'ABC789');
  assert.equal(normalizeCode(' abc-789 '), 'ABC789');
  assert.equal(normalizeCode('ABCI89'), null);
  assert.equal(normalizeCode('ABC78'), null);
  assert.equal(normalizeCode(null), null);
});

test('ニックネーム：前後の空白を除いて1〜10文字', () => {
  assert.equal(normalizeName('  すうじゃく '), 'すうじゃく');
  assert.equal(normalizeName('あいうえおかきくけこ'), 'あいうえおかきくけこ');
  assert.equal(normalizeName('あいうえおかきくけこさ'), null);
  assert.equal(normalizeName('   '), null);
  assert.equal(normalizeName('a\nb'), null);
});

test('停止スイッチ：config.enabled === true のときだけ入れる', async () => {
  const { bus, ts } = setup(1);
  assert.equal(await isEnabled(ts[0]), false);
  bus.write('config', { enabled: false });
  assert.equal(await isEnabled(ts[0]), false);
  bus.write('config', { enabled: true });
  assert.equal(await isEnabled(ts[0]), true);
  const broken = { get: async () => { throw Error('permission_denied'); } };
  assert.equal(await isEnabled(broken), false);
});

test('作成：ホストが席0・ルールセット2固定・期限12時間', async () => {
  const { bus, ts } = setup(1);
  const r = await createRoom(ts[0], { name: 'ホスト', mode: 'math2', length: 8, appVersion: V });
  assert.match(r.code, CODE_RE);
  const m = bus.read(`rooms/${r.code}/meta`);
  assert.equal(m.hostUid, 'u0');
  assert.equal(m.status, 'lobby');
  assert.equal(m.ruleset, RULESET);
  assert.equal(m.mode, 'math2');
  assert.equal(m.length, 8);
  assert.equal(m.expiresAt - m.createdAt, ROOM_TTL_MS);
  assert.deepEqual(bus.read(`rooms/${r.code}/seats/0`), { uid: 'u0', name: 'ホスト', kind: 'human', joinedAt: m.createdAt });
  await rejects(createRoom(ts[0], { name: '', appVersion: V }), 'bad-name');
  await rejects(createRoom(ts[0], { name: 'a', length: 3, appVersion: V }), 'bad-settings');
});

test('作成：既にあるコードとは衝突しない（次のコードを試す）', async () => {
  const { bus, ts } = setup(2);
  const seq = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1]];
  let i = 0;
  const rb = () => seq[Math.min(i++, seq.length - 1)];
  const a = await createRoom(ts[0], { name: 'A', appVersion: V, randomBytes: rb });
  assert.equal(a.code, 'AAAAAA');
  const b = await createRoom(ts[1], { name: 'B', appVersion: V, randomBytes: rb });
  assert.equal(b.code, 'BBBBBB');
  assert.equal(bus.read('rooms/AAAAAA/meta').hostUid, 'u0'); // 上書きされていない
  await rejects(createRoom(ts[1], { name: 'B', appVersion: V, randomBytes: () => [0, 0, 0, 0, 0, 0], maxTries: 3 }), 'code-exhausted');
});

test('参加：空席を順に取る・名前・誤ったコード・無い部屋・満席', async () => {
  const { ts, bus } = setup(4);
  const extra = bus.transport('u4');
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  await rejects(joinRoom(ts[1], { code: 'IIIIII', name: 'B', appVersion: V }), 'bad-code');
  await rejects(joinRoom(ts[1], { code: 'ZZZZZZ', name: 'B', appVersion: V }), 'not-found');
  await rejects(joinRoom(ts[1], { code, name: '', appVersion: V }), 'bad-name');
  assert.equal((await joinRoom(ts[1], { code: code.toLowerCase(), name: 'ビー', appVersion: V })).seat, 1);
  assert.equal((await joinRoom(ts[2], { code, name: 'シー', appVersion: V })).seat, 2);
  assert.equal((await joinRoom(ts[3], { code, name: 'ディー', appVersion: V })).seat, 3);
  await rejects(joinRoom(extra, { code, name: 'イー', appVersion: V }), 'full');
});

test('参加：版の違い・期限切れ（期限切れは丸ごと消える）・開始後', async () => {
  const { ts, bus, advance } = setup(3);
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  await assert.rejects(joinRoom(ts[1], { code, name: 'B', appVersion: '0.6.9' }), (e) => e.code === 'version' && e.detail === V);
  await joinRoom(ts[1], { code, name: 'B', appVersion: V });
  await startMatch(ts[0], code);
  await rejects(joinRoom(ts[2], { code, name: 'C', appVersion: V }), 'started');
  // 開始後でも、同じ uid（同じ端末）は自分の席に戻れる
  const back = await joinRoom(ts[1], { code, name: 'B2', appVersion: V });
  assert.deepEqual([back.seat, back.rejoined], [1, true]);
  assert.equal(bus.read(`rooms/${code}/seats/1/name`), 'B2');
  advance(ROOM_TTL_MS + 1);
  await rejects(joinRoom(ts[2], { code, name: 'C', appVersion: V }), 'expired');
  await tick();
  assert.equal(bus.read(`rooms/${code}`), null);
});

test('設定と開始はホストだけ・開始は人間2人以上', async () => {
  const { ts, bus } = setup(2);
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  await rejects(startMatch(ts[0], code), 'need-two');
  await joinRoom(ts[1], { code, name: 'B', appVersion: V });
  await rejects(changeSettings(ts[1], code, { length: 1 }), 'not-host');
  await rejects(startMatch(ts[1], code), 'not-host');
  await rejects(changeSettings(ts[0], code, { length: 2 }), 'bad-settings');
  await changeSettings(ts[0], code, { mode: 'math2', length: 1 });
  assert.deepEqual([bus.read(`rooms/${code}/meta/mode`), bus.read(`rooms/${code}/meta/length`), bus.read(`rooms/${code}/meta/ruleset`)], ['math2', 1, 2]);
  await startMatch(ts[0], code);
  assert.equal(bus.read(`rooms/${code}/meta/status`), 'playing');
  assert.equal(typeof bus.read(`rooms/${code}/meta/startedAt`), 'number');
  await rejects(changeSettings(ts[0], code, { length: 4 }), 'started');
});

test('監視：両者に同じ席・設定が見え、開始ボタンはホストで人間2人以上のときだけ', async () => {
  const { ts } = setup(3);
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  const views = [null, null, null];
  const stop = ts.map((t, i) => watchRoom(t, code, (v) => { views[i] = v; }));
  await tick();
  assert.equal(views[0].humans, 1);
  assert.equal(views[0].canStart, false);
  assert.deepEqual(views[0].seats.map((s) => s.kind), ['human', 'cpu', 'cpu', 'cpu']);
  await joinRoom(ts[1], { code, name: 'ビー', appVersion: V });
  await tick();
  assert.equal(views[0].canStart, true);
  assert.equal(views[1].canStart, false); // ゲストには押せない
  assert.equal(views[1].seats[1].me, true);
  assert.equal(views[1].seats[0].host, true);
  assert.equal(views[2].removed, true); // 見ているだけの人には席がない
  await changeSettings(ts[0], code, { length: 8 });
  await tick();
  assert.equal(views[1].meta.length, 8);
  await startMatch(ts[0], code);
  await tick();
  assert.equal(views[1].meta.status, 'playing');
  stop.forEach((s) => s());
});

test('presence：入室で online、切断（onDisconnect）で offline', async () => {
  const { ts, bus } = setup(2);
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  await joinRoom(ts[1], { code, name: 'B', appVersion: V });
  await enterPresence(ts[0], code);
  await enterPresence(ts[1], code);
  let v;
  watchRoom(ts[0], code, (x) => { v = x; });
  await tick();
  assert.deepEqual(v.seats.slice(0, 2).map((s) => s.online), [true, true]);
  bus.drop('u1');
  await tick();
  assert.equal(v.seats[1].online, false);
  assert.equal(v.seats[1].kind, 'human'); // 席はそのまま（離席扱いは段階3）
});

test('退出：ゲストは席を外す・ホストは部屋を丸ごと消し、ゲストには closed', async () => {
  const { ts, bus } = setup(3);
  const { code } = await createRoom(ts[0], { name: 'ホスト', appVersion: V });
  await joinRoom(ts[1], { code, name: 'B', appVersion: V });
  await joinRoom(ts[2], { code, name: 'C', appVersion: V });
  await enterPresence(ts[1], code);
  let gv;
  watchRoom(ts[2], code, (x) => { gv = x; });
  await leaveRoom(ts[1], code);
  await tick();
  assert.equal(bus.read(`rooms/${code}/seats/1`), null);
  assert.equal(gv.seats[1].kind, 'cpu');
  assert.equal(bus.read(`rooms/${code}/presence/u1/online`), false);
  // 空いた席には別の人が座れる
  const d = bus.transport('u9');
  assert.equal((await joinRoom(d, { code, name: 'D', appVersion: V })).seat, 1);
  await leaveRoom(ts[0], code);
  await tick();
  assert.equal(bus.read(`rooms/${code}`), null);
  assert.equal(gv.closed, true);
});

test('viewOf：meta が無ければ closed・期限切れの印', () => {
  assert.deepEqual(viewOf('u', 'ABCDEF', null, {}, {}, 0), { code: 'ABCDEF', closed: true });
  const v = viewOf('u', 'ABCDEF', { hostUid: 'u', status: 'lobby', expiresAt: 10 }, { 0: { uid: 'u', name: 'a', kind: 'human' } }, {}, 11);
  assert.equal(v.expired, true);
  assert.equal(v.mySeat, 0);
});
