// オンライン対戦 段階1（ロビーまで）のブラウザ試験。別々のブラウザコンテキスト（保存領域が別＝匿名 uid も別）を2〜5つ開き、
// Auth・Database エミュレータ（demo- プロジェクト。本番に接続しない）へつないで、実際に画面をタップして確かめる（docs/79「9.0③」）。
// ・Firebase SDK（gstatic の firebasejs/12.12.0）は、ブラウザ内の横取り（route）で npm の firebase@12.12.0 の同じファイルを返す
//  （CI・手元のどちらでも外部へ取りに行かない）。読込の失敗も route で再現する。
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/e2e/online-lobby.mjs"
// 必要：playwright（Chromium）と firebase@12.12.0（npm install --no-save）。
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const FB_DIR = dirname(require.resolve('firebase/package.json'));
const FB_VERSION = JSON.parse(readFileSync(pjoin(FB_DIR, 'package.json'), 'utf8')).version;
assert.equal(FB_VERSION, '12.12.0', 'firebase@12.12.0 を使う');
const NS = 'demo-mathjong-default-rtdb';
const DB = 'http://127.0.0.1:9000';
const owner = async (method, path, body) => {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, { method, headers: { authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `owner ${method} ${path}: ${r.status}`);
  return r.json();
};
const BASE = '/mathjong/';
const server = await startServer(0, { base: BASE, host: '127.0.0.1' });
const PORT = server.address().port;
const URL0 = `http://localhost:${PORT}${BASE}`;
const ONLINE = `${URL0}?online=emu`;
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? process.argv[i + 1] : null; })();
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: pjoin(SHOTS, `${name}.png`), fullPage: true }); } };
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const contexts = [];
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

// gstatic の SDK を npm の同じ版で返す（sdkFail なら読込失敗を再現）。エミュレータ（127.0.0.1:9000/9099）と配信元以外への要求はエラー扱い
async function newCtx({ sdkFail = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contexts.push(ctx);
  const sdkRequests = [];
  await ctx.route((u) => u.hostname === 'www.gstatic.com', (route) => {
    const u = new URL(route.request().url());
    sdkRequests.push(u.pathname);
    const m = u.pathname.match(/^\/firebasejs\/12\.12\.0\/(firebase-(?:app|auth|database)\.js)$/);
    if (sdkFail || !m) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(pjoin(FB_DIR, m[1])) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !sdkFail) errors.push(`console: ${m.text()}`); });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.protocol.startsWith('http')) return;
    const allowed = (u.host === `localhost:${PORT}` && u.pathname.startsWith(BASE)) || u.host === '127.0.0.1:9000' || u.host === '127.0.0.1:9099' || u.hostname === 'www.gstatic.com';
    if (!allowed) errors.push(`unexpected request: ${r.url()}`);
  });
  return { ctx, page, errors, sdkRequests };
}
const screenOf = (page) => page.locator('[data-online-screen]').getAttribute('data-online-screen');
async function waitScreen(page, name) { await page.waitForSelector(`[data-online-screen="${name}"]`, { timeout: 15000 }); }
async function openOnline(page, url = ONLINE) {
  await page.goto(url);
  await page.click('[data-action="online-open"]');
}
async function setName(page, name) {
  await waitScreen(page, 'name');
  await page.fill('#ol-name', name);
  await page.click('[data-action="ol-name-save"]');
  await waitScreen(page, 'menu');
}
async function join(page, code) {
  await page.fill('#ol-code', code);
  await page.click('[data-action="ol-join"]');
}
const seatTexts = (page) => page.$$eval('.ol-seat', (els) => els.map((e) => e.querySelector('.ol-name').textContent));
async function waitSeats(page, expected) {
  await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('.ol-seat .ol-name')].map((e) => e.textContent)) === JSON.stringify(exp), expected, { timeout: 15000 });
}
async function errorKind(page) { await page.waitForSelector('.ol-error[data-kind]', { timeout: 15000 }); return page.getAttribute('.ol-error[data-kind]', 'data-kind'); }

try {
  await owner('PUT', '.settings/rules', { rules: { games: { mathjong: require('../../firebase/mathjong-rules.cjs') } } });
  await owner('DELETE', 'games/mathjong');

  // ---- 0. 入口：?online=emu が無ければ出ない・SDK も読まない ----
  {
    const { page, errors, sdkRequests } = await newCtx();
    await page.goto(URL0);
    await page.waitForSelector('.title-screen');
    assert.equal(await page.locator('[data-action="online-open"]').count(), 0);
    await page.waitForTimeout(300);
    assert.deepEqual(sdkRequests, []);
    assert.deepEqual(errors, []);
    ok('通常のタイトルにはオンライン入口が無く、Firebase SDK を読まない');
  }

  // ---- 0b. 公開サイト相当のホストでは ?online=emu を無視する（入口を出さない） ----
  {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    await ctx.route((u) => u.hostname === 'mathjong.test', async (route) => {
      const u = new URL(route.request().url());
      const r = await fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`);
      await route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/plain' }, body: Buffer.from(await r.arrayBuffer()) });
    });
    let sdk = 0;
    await ctx.route((u) => u.hostname === 'www.gstatic.com', (route) => { sdk++; return route.abort('failed'); });
    const page = await ctx.newPage();
    await page.goto(`http://mathjong.test${BASE}?online=emu`);
    await page.waitForSelector('.title-screen');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-action="online-open"]').count(), 0);
    assert.equal(sdk, 0);
    ok('公開サイト相当のホストでは ?online=emu でも入口が出ない（段階1は本番に接続しない）');
  }

  // ---- 1. 停止スイッチ：config.enabled が true でなければ入れない ----
  {
    await owner('PUT', 'games/mathjong/config', { enabled: false });
    const { page, errors, sdkRequests } = await newCtx();
    await page.goto(ONLINE);
    await page.waitForSelector('.title-screen');
    assert.deepEqual(sdkRequests, [], 'タイトルを開いただけでは SDK を読まない');
    await page.click('[data-action="online-open"]');
    await waitScreen(page, 'disabled');
    assert.match(await page.textContent('.ol-disabled'), /お休み中/);
    assert.ok(sdkRequests.length >= 3, '入口に入ったときだけ SDK を読む');
    await page.click('[data-action="ol-back"]');
    await page.waitForSelector('.title-screen');
    assert.deepEqual(errors, []);
    ok('停止スイッチ OFF ではその旨を表示して入れない');
    await owner('PUT', 'games/mathjong/config', { enabled: true });
  }

  // ---- 2. SDK の読込に失敗しても、オフラインの機能は無傷 ----
  {
    const { page, errors } = await newCtx({ sdkFail: true });
    await openOnline(page);
    await waitScreen(page, 'load-failed');
    await page.click('[data-action="ol-back"]');
    await page.waitForSelector('.title-screen');
    await page.click('[data-action="br-open"]'); // 初心者の部屋
    await page.waitForSelector('.br-sub', { timeout: 10000 });
    await page.goto(ONLINE);
    await page.click('[data-action="choose-opponents"]'); // 通常対局：相手を選んで開始
    await page.click('[data-action="opp-random"]');
    await page.click('[data-action="start-match"]');
    await page.waitForSelector('.hand .tile', { timeout: 20000 });
    assert.deepEqual(errors.filter((e) => !/gstatic/.test(e)), []);
    ok('SDK の読込に失敗しても、初心者の部屋・通常対局は動く');
  }

  // ---- 3. 作成・参加・名前・設定の共有・開始ボタン ----
  const A = await newCtx();
  const B = await newCtx();
  await openOnline(A.page);
  await waitScreen(A.page, 'name');
  await A.page.fill('#ol-name', 'あいうえおかきくけこさ'); // 11文字は入力欄で10文字に切られる
  assert.equal((await A.page.inputValue('#ol-name')).length, 10);
  await A.page.fill('#ol-name', '   ');
  await A.page.click('[data-action="ol-name-save"]');
  assert.equal(await errorKind(A.page), 'bad-name');
  await A.page.fill('#ol-name', 'ホスト<b>');
  await A.page.click('[data-action="ol-name-save"]');
  await waitScreen(A.page, 'menu');
  assert.equal(await A.page.textContent('.ol-myname'), 'ホスト<b>'); // 名前は文字として表示（HTML として解釈しない）
  ok('ニックネーム：空は不可・10文字まで・文字として表示');
  await A.page.click('[data-action="ol-create"]');
  await waitScreen(A.page, 'lobby');
  await A.page.waitForSelector('.ol-code[data-code]');
  const code = await A.page.getAttribute('.ol-code', 'data-code');
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  await waitSeats(A.page, ['ホスト<b>', 'CPU（予定）', 'CPU（予定）', 'CPU（予定）']);
  assert.equal(await A.page.isDisabled('[data-action="ol-start"]'), true, '1人では開始できない');
  ok(`部屋の作成（コード ${code}）・空席は CPU 予定・1人では開始ボタンが押せない`);

  await openOnline(B.page);
  await setName(B.page, 'ビー');
  await join(B.page, 'ABCDI1');
  assert.equal(await errorKind(B.page), 'bad-code');
  await join(B.page, 'ZZZZZZ');
  await B.page.waitForSelector('.ol-error[data-kind="not-found"]');
  ok('誤ったコード（形が違う・無い部屋）');
  await join(B.page, code.toLowerCase());
  await waitScreen(B.page, 'lobby');
  await waitSeats(B.page, ['ホスト<b>', 'ビー', 'CPU（予定）：自動', 'CPU（予定）：自動']); // ゲストには CPU の選択（既定は自動）を表示だけ
  await waitSeats(A.page, ['ホスト<b>', 'ビー', 'CPU（予定）', 'CPU（予定）']);
  await A.page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  assert.equal(await B.page.locator('[data-action="ol-start"]').count(), 0, 'ゲストには開始ボタンが無い');
  assert.equal(await B.page.isDisabled('input[name="ol-length"][value="8"]'), true, 'ゲストは設定を変えられない');
  await B.page.waitForSelector('.ol-seat[data-seat="0"] .ol-dot.on');
  ok('参加：両者に名前が見え、2人で開始ボタンが有効（ホストだけ）');

  await A.page.check('input[name="ol-length"][value="8"]');
  await B.page.waitForSelector('input[name="ol-length"][value="8"]:checked');
  await A.page.check('input[name="ol-mode"][value="math2"]');
  await B.page.waitForSelector('input[name="ol-mode"][value="math2"]:checked');
  ok('設定の共有（ホストが8局戦・数学Ⅱにすると、ゲストにも反映）');
  await shot(A.page, 'lobby-host');
  await shot(B.page, 'lobby-guest');

  // ---- 4. 版の違い・満席・退出 ----
  const V = await newCtx();
  await openOnline(V.page, `${ONLINE}&onlineAppVersion=0.6.9`);
  await setName(V.page, 'ふるい');
  await join(V.page, code);
  assert.equal(await errorKind(V.page), 'version');
  assert.match(await V.page.textContent('.ol-error'), /再読み込み/);
  assert.equal(await V.page.locator('[data-action="ol-reload"]').count(), 1);
  await shot(V.page, 'version-mismatch');
  ok('版の違いは入室不可＋再読み込みの案内');

  const C = await newCtx();
  const D = await newCtx();
  for (const [x, n] of [[C, 'シー'], [D, 'ディー']]) { await openOnline(x.page); await setName(x.page, n); await join(x.page, code); await waitScreen(x.page, 'lobby'); }
  await waitSeats(A.page, ['ホスト<b>', 'ビー', 'シー', 'ディー']);
  const E = await newCtx();
  await openOnline(E.page);
  await setName(E.page, 'イー');
  await join(E.page, code);
  assert.equal(await errorKind(E.page), 'full');
  ok('満席（4人）は入れない');
  await shot(A.page, 'lobby-full');
  await D.page.click('[data-action="ol-leave"]');
  await waitScreen(D.page, 'menu');
  await waitSeats(A.page, ['ホスト<b>', 'ビー', 'シー', 'CPU（予定）']);
  ok('ゲストの退出で席が CPU 予定に戻る');

  // 切断（タブを閉じる）で presence が offline に
  await C.ctx.close();
  await A.page.waitForSelector('.ol-seat[data-seat="2"] .ol-dot.off', { timeout: 20000 });
  ok('切断（onDisconnect）で接続中の印が消える');

  // ニックネームは端末に保存：再読込後は名前の入力を飛ばす
  await B.page.reload();
  await B.page.click('[data-action="online-open"]');
  await waitScreen(B.page, 'menu');
  assert.equal(await B.page.textContent('.ol-myname'), 'ビー');
  await join(B.page, code); // 同じ端末（同じ uid）は自分の席に戻る
  await waitScreen(B.page, 'lobby');
  assert.equal(await B.page.getAttribute('.ol-seat.me', 'data-seat'), '1');
  ok('ニックネームは端末に保存・同じ端末は自分の席に戻る');

  // ---- 5. 開始 → ロビーが閉じて全員が対局の卓へ（段階2。対局そのものは online-match.mjs）----
  await A.page.click('[data-action="ol-start"]');
  await A.page.waitForSelector('.self', { timeout: 20000 });
  await B.page.waitForSelector('.self', { timeout: 20000 });
  assert.equal(await B.page.evaluate(() => window.__mathjong.S.online.pub.mode + '/' + window.__mathjong.S.online.pub.length), 'math2/8');
  await shot(B.page, 'started-guest');
  await join(E.page, code);
  await E.page.waitForSelector('.ol-error[data-kind="started"]');
  ok('開始：ロビーが閉じて全員が対局の卓へ（数学Ⅱ・8局戦）・開始後は入れない');

  // ---- 6. ホストの退出で部屋が閉じる（対局中の設定から「部屋を出る」）----
  await A.page.click('[data-action="settings"]');
  await A.page.click('[data-action="ask-title"]');
  await A.page.click('[data-action="online-leave"]');
  await waitScreen(A.page, 'menu');
  await waitScreen(B.page, 'closed');
  assert.equal(await owner('GET', `games/mathjong/rooms/${code}`), null);
  ok('ホストの退出で部屋が消え、ゲストに「閉じられました」');

  for (const x of [A, B, D, E, V]) assert.deepEqual(x.errors, [], 'ページのエラー・想定外の通信なし');
  ok('全コンテキストでページのエラー・想定外の通信なし');
  console.log(`✓ オンライン ロビー E2E：${passed}件すべて合格`);
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  server.close();
  await owner('DELETE', 'games/mathjong').catch(() => {});
}
