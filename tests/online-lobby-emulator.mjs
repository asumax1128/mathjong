// ロビーの論理を、実際の Firebase SDK（npm の firebase@12.12.0）＋ Auth・Database エミュレータ＋ルール断片で通す結合試験。
// 本番には接続しない（demo- プロジェクト）。ルール試験（online-rules-emulator.mjs）の後に実行する。
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/online-lobby-emulator.mjs"
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFirebaseTransport } from '../src/ui/online-transport.js';
import { createRoom, joinRoom, changeSettings, startMatch, leaveRoom, enterPresence, watchRoom, isEnabled } from '../src/ui/online-lobby.js';

const require = createRequire(import.meta.url);
const NS = 'demo-mathjong-default-rtdb';
const DB = 'http://127.0.0.1:9000';
const owner = (method, path, body) => fetch(`${DB}/${path}.json?ns=${NS}`, { method, headers: { authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const load = async () => ({ app: await import('firebase/app'), auth: await import('firebase/auth'), db: await import('firebase/database') });
const V = '0.7.0';
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

await owner('PUT', '.settings/rules', { rules: { games: { mathjong: require('../firebase/mathjong-rules.cjs') } } });
await owner('DELETE', 'games/mathjong');
const ts = [];
for (let i = 0; i < 5; i++) ts.push(await createFirebaseTransport({ emulator: true, load, appName: `t${i}` }));
const [A, B, C, D, E] = ts;
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

assert.equal(await isEnabled(A), false); ok('config が無ければ入れない');
await owner('PUT', 'games/mathjong/config', { enabled: true });
assert.equal(await isEnabled(A), true); ok('config.enabled=true で入れる');

// 衝突：同じコードが続く乱数でも、既存の部屋を上書きせず次のコードを使う
let k = 0;
const fixed = () => (k++ < 2 ? [0, 0, 0, 0, 0, 0] : [1, 1, 1, 1, 1, 1]);
const r1 = await createRoom(A, { name: 'ホスト', appVersion: V, randomBytes: () => [0, 0, 0, 0, 0, 0] });
assert.equal(r1.code, 'AAAAAA');
const r2 = await createRoom(E, { name: 'べつ', appVersion: V, randomBytes: fixed });
assert.equal(r2.code, 'BBBBBB');
const m1 = await owner('GET', 'games/mathjong/rooms/AAAAAA/meta');
assert.equal(m1.hostUid, A.uid); ok('コードの衝突で上書きしない（transaction＋ルール）');
await leaveRoom(E, r2.code);
assert.equal(await owner('GET', 'games/mathjong/rooms/BBBBBB'), null); ok('ホストの退出で部屋が消える');

const code = r1.code;
let hv; let gv;
const stopA = watchRoom(A, code, (v) => { hv = v; });
await enterPresence(A, code);
await assert.rejects(joinRoom(B, { code, name: 'ビー', appVersion: '0.6.0' }), (e) => e.code === 'version'); ok('版の違いは入れない');
await assert.rejects(joinRoom(B, { code: 'ZZZZZZ', name: 'ビー', appVersion: V }), (e) => e.code === 'not-found'); ok('無いコード');
assert.equal((await joinRoom(B, { code, name: 'ビー', appVersion: V })).seat, 1);
const stopB = watchRoom(B, code, (v) => { gv = v; });
await enterPresence(B, code);
await until(() => hv && hv.humans === 2 && hv.seats[1].online);
assert.equal(hv.canStart, true);
await until(() => gv && gv.seats[0].name === 'ホスト');
assert.equal(gv.canStart, false); ok('両者に名前が見え、開始はホストだけ');
await assert.rejects(changeSettings(B, code, { length: 1 }), (e) => e.code === 'not-host');
await assert.rejects(B.update(`rooms/${code}/meta`, { length: 1 }), /permission/i); ok('ゲストは設定を変えられない（ルールでも）');
await changeSettings(A, code, { mode: 'math2', length: 8 });
await until(() => gv.meta.mode === 'math2' && gv.meta.length === 8); ok('設定の共有');
assert.equal((await joinRoom(C, { code, name: 'シー', appVersion: V })).seat, 2);
assert.equal((await joinRoom(D, { code, name: 'ディー', appVersion: V })).seat, 3);
await assert.rejects(joinRoom(E, { code, name: 'イー', appVersion: V }), (e) => e.code === 'full'); ok('満席');
await leaveRoom(D, code);
await until(() => hv.seats[3].kind === 'cpu'); ok('ゲストの退出で CPU 予定に戻る');
await startMatch(A, code);
await until(() => gv.meta.status === 'playing'); ok('開始が全員に届く');
await until(() => hv.seats.filter((x) => x.kind === 'cpu' && x.cpuId).length === 1);
assert.equal(hv.seats.filter((x) => x.kind === 'human').length, 3);
assert.ok(gv.mySeat !== null && gv.seats[gv.mySeat].uid === B.uid); ok('開始で席を決め直し、空席は CPU（uid なし）');
await assert.rejects(joinRoom(E, { code, name: 'イー', appVersion: V }), (e) => e.code === 'started'); ok('開始後は入れない');

// 期限切れ：所有者権限で古い部屋を置き、参加の試みで丸ごと消える
const now = Date.now();
await owner('PUT', 'games/mathjong/rooms/XPRD77', { meta: { hostUid: A.uid, status: 'lobby', mode: 'math1', length: 4, ruleset: 2, appVersion: V, createdAt: now - 13 * 3600e3, expiresAt: now - 3600e3 }, seats: { 0: { uid: A.uid, name: 'x', kind: 'human', joinedAt: now } } });
await assert.rejects(joinRoom(E, { code: 'XPRD77', name: 'イー', appVersion: V }), (e) => e.code === 'expired');
for (let i = 0; i < 50 && (await owner('GET', 'games/mathjong/rooms/XPRD77/meta')); i++) await new Promise((r) => setTimeout(r, 50));
assert.equal(await owner('GET', 'games/mathjong/rooms/XPRD77/meta'), null); ok('期限切れは入れず、丸ごと消える');

// 切断：B の接続を閉じると onDisconnect で offline
B.close();
await until(() => hv.seats.find((x) => x.uid === B.uid).online === false); ok('切断で presence が offline');
stopA(); stopB();
await leaveRoom(A, code);
assert.equal(await owner('GET', `games/mathjong/rooms/${code}`), null);
for (const t of ts) t.close();
await owner('DELETE', 'games/mathjong');
console.log(`✓ ロビー結合試験（SDK＋エミュレータ＋ルール）：${n}件すべて合格`);
process.exit(0);
