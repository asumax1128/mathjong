// 数雀のオンライン対戦のルール試験（docs/79「5」「9.0②」・docs/80「5」）。Auth・Database エミュレータ（demo- プロジェクト）だけに接続する。
// 本番の Firebase には接続しない。REST で試すので Firebase SDK は使わない。
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/online-rules-emulator.mjs"
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-mathjong';
const NS = `${PROJECT}-default-rtdb`;
const DB = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000'}`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const ROOT = 'games/mathjong';
const HOUR = 3600 * 1000;

async function req(method, path, { token = null, owner = false, body } = {}) {
  const q = new URLSearchParams({ ns: NS });
  if (token) q.set('auth', token);
  const res = await fetch(`${DB}/${path}.json?${q}`, {
    method, headers: { 'content-type': 'application/json', ...(owner ? { authorization: 'Bearer owner' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, val: text ? JSON.parse(text) : null };
}
async function user() {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  return { uid: j.localId, token: j.idToken };
}

let pass = 0;
const fails = [];
async function expect(name, p, ok) {
  const r = await p;
  if (r.ok === ok) pass++;
  else fails.push(`${name}: expected ${ok ? 'allowed' : 'denied'} but got ${r.status} ${JSON.stringify(r.val)}`);
  return r;
}
const allow = (n, p) => expect(n, p, true);
const deny = (n, p) => expect(n, p, false);

// ルールを読み込む（最新の断片で上書き）
const rules = { rules: { games: { mathjong: require('../firebase/mathjong-rules.cjs') } } };
const put = await req('PUT', '.settings/rules', { owner: true, body: rules });
assert.ok(put.ok, `rules upload ${put.status} ${JSON.stringify(put.val)}`);
await req('DELETE', ROOT, { owner: true });

const A = await user(); // ホスト
const B = await user(); // ゲスト
const C = await user(); // 部外者
const D = await user(); // 後から来る人
const now = Date.now();
const meta = (uid, extra = {}) => ({ hostUid: uid, status: 'lobby', mode: 'math1', length: 4, ruleset: 2, appVersion: '0.7.0', createdAt: now, expiresAt: now + 12 * HOUR, matchNo: 0, ...extra });
const seat = (uid, name = 'なまえ', extra = {}) => ({ uid, name, kind: 'human', joinedAt: now, ...extra });
const R = (code, p = '') => `${ROOT}/rooms/${code}${p ? `/${p}` : ''}`;
const CODE = 'ABCD23';

// ---- config（停止スイッチ）：認証済みは読める・誰も書けない ----
await req('PUT', `${ROOT}/config`, { owner: true, body: { enabled: true } });
await allow('config を読める', req('GET', `${ROOT}/config`, { token: B.token }));
await deny('未認証は config を読めない', req('GET', `${ROOT}/config`));
await deny('config は書けない（ホストでも）', req('PUT', `${ROOT}/config`, { token: A.token, body: { enabled: false } }));

// ---- 部屋の作成（meta） ----
await deny('部屋の一覧は読めない', req('GET', `${ROOT}/rooms`, { token: A.token }));
await deny('未認証は作れない', req('PUT', R(CODE, 'meta'), { body: meta('x') }));
await deny('他人をホストにして作れない', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(B.uid) }));
await deny('コードの文字種（I・O・0・1 不可）', req('PUT', R('ABCDI0', 'meta'), { token: A.token, body: meta(A.uid) }));
await deny('コードの長さ', req('PUT', R('ABC23', 'meta'), { token: A.token, body: meta(A.uid) }));
await deny('ルールセット 1 は不可', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { ruleset: 1 }) }));
await deny('長さ 3 は不可', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { length: 3 }) }));
await deny('モード不正', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { mode: 'math3' }) }));
await deny('期限は12時間まで', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { expiresAt: now + 13 * HOUR }) }));
await deny('作成時はロビー', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { status: 'playing' }) }));
await deny('作成時刻を大きくずらせない', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { createdAt: now - 2 * HOUR, expiresAt: now + HOUR }) }));
await deny('未知の項目', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid, { evil: 1 }) }));
await allow('ホストが自分をホストにして作る', req('PUT', R(CODE, 'meta'), { token: A.token, body: meta(A.uid) }));
await deny('同じコードを別の人が作れない（上書き不可）', req('PUT', R(CODE, 'meta'), { token: B.token, body: meta(B.uid) }));
await allow('コードを知っていれば meta を読める', req('GET', R(CODE, 'meta'), { token: B.token }));
await deny('未認証は meta を読めない', req('GET', R(CODE, 'meta')));
await deny('部屋全体は読めない（参加者でも）', req('GET', R(CODE), { token: A.token }));

// ---- 席 ----
await allow('ホストが席0を取る', req('PUT', R(CODE, 'seats/0'), { token: A.token, body: seat(A.uid, 'ホスト') }));
await allow('ゲストが空席を自分の uid で取る', req('PUT', R(CODE, 'seats/1'), { token: B.token, body: seat(B.uid, 'ゲスト') }));
await deny('席を持つ人は2つ目の席を取れない', req('PUT', R(CODE, 'seats/2'), { token: B.token, body: seat(B.uid) }));
await deny('取られた席は取れない', req('PUT', R(CODE, 'seats/1'), { token: C.token, body: seat(C.uid) }));
await deny('他人の uid で席を取れない', req('PUT', R(CODE, 'seats/2'), { token: C.token, body: seat(D.uid) }));
await deny('席番号は0〜3', req('PUT', R(CODE, 'seats/4'), { token: C.token, body: seat(C.uid) }));
await deny('名前は10文字まで', req('PUT', R(CODE, 'seats/2'), { token: C.token, body: seat(C.uid, 'あいうえおかきくけこさ') }));
await deny('名前は1文字以上', req('PUT', R(CODE, 'seats/2'), { token: C.token, body: seat(C.uid, '') }));
await deny('kind は human だけ', req('PUT', R(CODE, 'seats/2'), { token: C.token, body: seat(C.uid, 'x', { kind: 'cpu' }) }));
await allow('自分の名前を更新', req('PUT', R(CODE, 'seats/1/name'), { token: B.token, body: 'あたらしい' }));
await deny('他人の席を書き換えられない', req('PUT', R(CODE, 'seats/0/name'), { token: B.token, body: 'のっとり' }));
await deny('他人の席を消せない', req('DELETE', R(CODE, 'seats/0'), { token: B.token }));
await allow('席の一覧は読める', req('GET', R(CODE, 'seats'), { token: C.token }));
await allow('C が席2を取る', req('PUT', R(CODE, 'seats/2'), { token: C.token, body: seat(C.uid, 'さん') }));
await allow('C はロビー中に離席できる', req('DELETE', R(CODE, 'seats/2'), { token: C.token }));

// ---- ホストだけが meta を変える ----
await deny('ゲストは設定を変えられない', req('PUT', R(CODE, 'meta/length'), { token: B.token, body: 8 }));
await allow('ホストは長さを変えられる', req('PUT', R(CODE, 'meta/length'), { token: A.token, body: 8 }));
await allow('ホストはモードを変えられる', req('PUT', R(CODE, 'meta/mode'), { token: A.token, body: 'math2' }));
await deny('ルールセットは変えられない', req('PUT', R(CODE, 'meta/ruleset'), { token: A.token, body: 1 }));
await deny('ホストを付け替えられない', req('PUT', R(CODE, 'meta/hostUid'), { token: A.token, body: B.uid }));
await deny('期限を延ばせない', req('PUT', R(CODE, 'meta/expiresAt'), { token: A.token, body: now + 12 * HOUR + 1000 }));
await deny('meta だけを消せない', req('DELETE', R(CODE, 'meta'), { token: A.token }));

// ---- presence ----
await allow('自分の presence を書く', req('PUT', R(CODE, `presence/${B.uid}`), { token: B.token, body: { online: true, at: now } }));
await deny('他人の presence は書けない', req('PUT', R(CODE, `presence/${A.uid}`), { token: B.token, body: { online: false, at: now } }));
await deny('presence の形', req('PUT', R(CODE, `presence/${B.uid}`), { token: B.token, body: { online: 'yes', at: now } }));

// ---- pub（公開状態）：参加者だけ読み、ホストだけ書く ----
await allow('ホストは pub に書ける', req('PUT', R(CODE, 'pub/state'), { token: A.token, body: { seq: 1 } }));
await deny('ゲストは pub に書けない', req('PUT', R(CODE, 'pub/state'), { token: B.token, body: { seq: 2 } }));
await deny('部外者は pub に書けない', req('PUT', R(CODE, 'pub/state'), { token: C.token, body: { seq: 2 } }));
await allow('参加者は pub を読める', req('GET', R(CODE, 'pub'), { token: B.token }));
await deny('部外者は pub を読めない', req('GET', R(CODE, 'pub'), { token: C.token }));

// ---- priv（席ごとの非公開）：その席の本人だけ ----
await allow('ホストは priv/1 を書ける', req('PUT', R(CODE, 'priv/1'), { token: A.token, body: { hand: [1, 2, 3] } }));
await allow('ホストは priv/0 を書ける', req('PUT', R(CODE, 'priv/0'), { token: A.token, body: { hand: [4, 5, 6] } }));
await allow('本人（席1）は priv/1 を読める', req('GET', R(CODE, 'priv/1'), { token: B.token }));
await deny('ゲストは他家（席0）の priv を読めない', req('GET', R(CODE, 'priv/0'), { token: B.token }));
await deny('部外者は priv を読めない', req('GET', R(CODE, 'priv/1'), { token: C.token }));
await deny('priv 全体は読めない', req('GET', R(CODE, 'priv'), { token: B.token }));
await deny('ゲストは priv を書けない', req('PUT', R(CODE, 'priv/1'), { token: B.token, body: { hand: [9] } }));

// ---- act（行動）：本人が追記するだけ ----
const act = (k = 'discard') => ({ k, sid: 1, at: now, tile: 3 });
await allow('本人は自分の席の act に追記できる', req('PUT', R(CODE, 'act/1/0'), { token: B.token, body: act() }));
await deny('同じ番号は上書きできない', req('PUT', R(CODE, 'act/1/0'), { token: B.token, body: act('pass') }));
await deny('act は消せない', req('DELETE', R(CODE, 'act/1/0'), { token: B.token }));
await deny('他席の act に書けない（ゲスト）', req('PUT', R(CODE, 'act/0/0'), { token: B.token, body: act() }));
await deny('他席の act に書けない（ホスト）', req('PUT', R(CODE, 'act/1/1'), { token: A.token, body: act() }));
await deny('部外者は act に書けない', req('PUT', R(CODE, 'act/2/0'), { token: C.token, body: act() }));
await deny('行動の種類が不正', req('PUT', R(CODE, 'act/1/1'), { token: B.token, body: act('cheat') }));
await allow('ホストは act を読める', req('GET', R(CODE, 'act/1'), { token: A.token }));
await allow('本人は自分の act を読める', req('GET', R(CODE, 'act/1'), { token: B.token }));
await deny('部外者は act を読めない', req('GET', R(CODE, 'act/1'), { token: C.token }));

// ---- host（ホストの秘密）----
await allow('ホストは host に書ける', req('PUT', R(CODE, 'host'), { token: A.token, body: { seedBase: 123 } }));
await allow('ホストは host を読める', req('GET', R(CODE, 'host'), { token: A.token }));
await deny('ゲストは host を読めない', req('GET', R(CODE, 'host'), { token: B.token }));
await deny('ゲストは host に書けない', req('PUT', R(CODE, 'host'), { token: B.token, body: { seedBase: 1 } }));

// ---- 開始の後：ロビー以外では席を取れない・離席できない ----
await allow('ホストが開始（status=playing）', req('PATCH', R(CODE, 'meta'), { token: A.token, body: { status: 'playing', startedAt: now } }));
await deny('開始後は席を取れない', req('PUT', R(CODE, 'seats/3'), { token: D.token, body: seat(D.uid) }));
await deny('開始後はゲストが離席（席の削除）できない', req('DELETE', R(CODE, 'seats/1'), { token: B.token }));
await allow('開始後も自分の名前は更新できる', req('PUT', R(CODE, 'seats/1/name'), { token: B.token, body: 'もどった' }));

// ---- 部屋の削除と期限切れ ----
await deny('期限内の部屋をゲストは消せない', req('DELETE', R(CODE), { token: B.token }));
await deny('期限内の部屋を部外者は消せない', req('DELETE', R(CODE), { token: C.token }));
const OLD = 'ZZZZ99';
await req('PUT', R(OLD), { owner: true, body: { meta: meta(A.uid, { createdAt: now - 13 * HOUR, expiresAt: now - HOUR }), seats: { 0: seat(A.uid) } } });
await deny('期限切れの部屋で席を取れない', req('PUT', R(OLD, 'seats/1'), { token: C.token, body: seat(C.uid) }));
await deny('期限切れの部屋の一部だけは消せない', req('DELETE', R(OLD, 'seats/0'), { token: C.token }));
await deny('期限切れの部屋に presence を書けない', req('PUT', R(OLD, `presence/${C.uid}`), { token: C.token, body: { online: true, at: now } }));
await deny('期限切れの部屋を書き換えられない（丸ごと置換）', req('PUT', R(OLD), { token: C.token, body: { meta: meta(C.uid) } }));
await allow('期限切れの部屋は誰でも丸ごと削除できる', req('DELETE', R(OLD), { token: C.token }));
await allow('ホストは自分の部屋を丸ごと削除できる', req('DELETE', R(CODE), { token: A.token }));
const gone = await req('GET', R(CODE, 'meta'), { token: A.token });
assert.equal(gone.val, null, '削除された');

await req('DELETE', ROOT, { owner: true });
if (fails.length) {
  console.error(`ルール試験：${fails.length}件失敗／${pass + fails.length}件\n${fails.join('\n')}`);
  process.exit(1);
}
console.log(`✓ ルール試験：${pass}件すべて合格（他家の priv を読めない・pub/host に書けない・他席の act に書けない・ロビー以外で席を取れない・期限切れは丸ごと削除だけ ほか）`);
