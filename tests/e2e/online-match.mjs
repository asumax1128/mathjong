// オンライン対戦 段階2（2人で1局通し）のブラウザ試験。別々のブラウザコンテキスト2つ（ホスト・ゲスト）＋空席の CPU 2人で、
// 1局戦を実際の画面のタップだけで最後まで打ち、両端末の結果（持ち点・順位）が一致することを確かめる（docs/79「9.2」）。
// エミュレータ（demo- プロジェクト）だけに接続する。Firebase SDK は npm の firebase@12.12.0 を route で返す（online-lobby.mjs と同じ）。
// 確かめること：
//  ・ホストが CPU を1人選び（もう1人は自動）、開始すると両端末が卓の画面になる（席・最初の親は無作為）
//  ・各端末の受信データ（pub・自分の priv）に他家の手牌がない（局の途中）。ゲストは他家の priv を読めない（ルール）
//  ・自分の番で牌を2回タップして捨てる／宣言はロンがあればロン・なければ見送り／結果の「次の局へ」→ 最終結果
//  ・両端末の最終結果の持ち点・順位が一致。残り時間の帯が表示される
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/e2e/online-match.mjs"
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const FB_DIR = dirname(require.resolve('firebase/package.json'));
const NS = 'demo-mathjong-default-rtdb';
const DB = 'http://127.0.0.1:9000';
const AUTH = 'http://127.0.0.1:9099';
const owner = async (method, path, body) => {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, { method, headers: { authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `owner ${method} ${path}: ${r.status}`);
  return r.json();
};
const BASE = '/mathjong/';
const server = await startServer(0, { base: BASE, host: '127.0.0.1' });
const PORT = server.address().port;
const ONLINE = `http://localhost:${PORT}${BASE}?online=emu&onlineCpuDelay=150`;
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? process.argv[i + 1] : null; })();
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: pjoin(SHOTS, `${name}.png`) }); } };
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const contexts = [];
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

async function newCtx(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  contexts.push(ctx);
  await ctx.route((u) => u.hostname === 'www.gstatic.com', (route) => {
    const m = new URL(route.request().url()).pathname.match(/^\/firebasejs\/12\.12\.0\/(firebase-(?:app|auth|database)\.js)$/);
    if (!m) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(pjoin(FB_DIR, m[1])) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' ')}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // 受信した配信を記録（他家の手牌が含まれないことを確かめる）
  return { ctx, page, errors };
}
const waitScreen = (page, name) => page.waitForSelector(`[data-online-screen="${name}"]`, { timeout: 20000 });
async function enter(page, name) {
  await page.goto(ONLINE);
  await page.click('[data-action="online-open"]');
  await waitScreen(page, 'name');
  await page.fill('#ol-name', name);
  await page.click('[data-action="ol-name-save"]');
  await waitScreen(page, 'menu');
}
const onlineState = (page) => page.evaluate(() => { const o = window.__mathjong.S.online; return o && o.pub ? { pub: o.pub, priv: o.priv, mySeat: o.mySeat } : null; });

// 1手だけ進める（自分の番・宣言・結果の「次へ」）。何もできなければ false
async function stepOnce(page) {
  if (await page.$('.final')) return 'final';
  const next = await page.$('[data-action="online-next"]:not([disabled])');
  if (next) return (await tryClick(next)) && 'next';
  for (const sel of ['button[data-action="ron"]', 'button[data-action="tsumo"]', 'button[data-action="pass"]']) {
    const b = await page.$(sel);
    if (b && await b.isVisible().catch(() => false)) return (await tryClick(b)) && sel;
  }
  const tiles = await page.$$('.self.active .hand [data-action="tile"]');
  if (tiles.length) {
    if (!(await tryClick(tiles[tiles.length - 1]))) return false;
    const again = await page.$$('.self.active .hand [data-action="tile"]');
    if (again.length) await tryClick(again[again.length - 1]);
    return 'discard';
  }
  return false;
}
// 配信で画面が描き直された瞬間の取りこぼしは、次の回にやり直す
async function tryClick(h) { try { await h.click({ timeout: 1500 }); return true; } catch { return false; } }

try {
  await owner('PUT', '.settings/rules', { rules: { games: { mathjong: require('../../firebase/mathjong-rules.cjs') } } });
  await owner('DELETE', 'games/mathjong');
  await owner('PUT', 'games/mathjong/config', { enabled: true });

  const H = await newCtx();
  const G = await newCtx();
  await enter(H.page, 'ホスト');
  await H.page.check('input[name="ol-length"][value="1"]');
  await H.page.click('[data-action="ol-create"]');
  await waitScreen(H.page, 'lobby');
  const code = await H.page.getAttribute('.ol-code', 'data-code');
  await enter(G.page, 'ゲスト');
  await G.page.fill('#ol-code', code);
  await G.page.click('[data-action="ol-join"]');
  await waitScreen(G.page, 'lobby');
  await H.page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  // 空席の CPU：ホストは選べる（1枠目をかなたに）。ゲストには表示だけ
  const selects = await H.page.$$('select[data-action="ol-cpu"]');
  assert.equal(selects.length, 2, 'CPU の枠は2つ');
  await H.page.selectOption('select[data-action="ol-cpu"][data-slot="0"]', 'kanata');
  await G.page.waitForFunction(() => document.body.textContent.includes('CPU（予定）：かなた'));
  assert.equal(await G.page.locator('select[data-action="ol-cpu"]').count(), 0);
  ok('空席の CPU：ホストが12人から選び（既定は自動）、ゲストにも表示');

  await H.page.click('[data-action="ol-start"]');
  await H.page.waitForSelector('.self', { timeout: 20000 });
  await G.page.waitForSelector('.self', { timeout: 20000 });
  const hs = await onlineState(H.page);
  const gs = await onlineState(G.page);
  assert.equal(hs.pub.players.filter((p) => p.kind === 'cpu').length, 2);
  assert.ok(hs.pub.players.some((p) => p.cpuId === 'kanata'), '選んだ CPU が入る');
  assert.notEqual(hs.mySeat, gs.mySeat);
  const seats = await owner('GET', `games/mathjong/rooms/${code}/seats`);
  assert.equal(Object.values(seats).filter((s) => s.kind === 'cpu' && !s.uid).length, 2, 'CPU の席は uid なし');
  ok(`開始：両端末が卓の画面に（ホスト席${hs.mySeat}・ゲスト席${gs.mySeat}・最初の親は席${hs.pub.game.dealer}）`);

  // ゲストは他家の priv を読めない（エミュレータのルール）。ゲストのトークンを画面から取って REST で試す
  const gToken = await G.page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return new Promise((res) => {
      const req = indexedDB.open('firebaseLocalStorageDb');
      req.onsuccess = () => {
        const tx = req.result.transaction('firebaseLocalStorage', 'readonly');
        const all = tx.objectStore('firebaseLocalStorage').getAll();
        all.onsuccess = () => { const u = all.result.find((x) => x.value && x.value.stsTokenManager); res(u ? u.value.stsTokenManager.accessToken : null); };
      };
      req.onerror = () => res(null);
      void dbs;
    });
  });
  assert.ok(gToken, 'ゲストのトークン');
  const rd = (p) => fetch(`${DB}/games/mathjong/rooms/${code}/${p}.json?ns=${NS}&auth=${gToken}`);
  assert.equal((await rd(`priv/${hs.mySeat}`)).status, 401, 'ホストの priv は読めない');
  assert.equal((await rd(`priv/${gs.mySeat}`)).status, 200, '自分の priv は読める');
  for (let s = 0; s < 4; s++) if (s !== gs.mySeat) assert.equal((await rd(`priv/${s}`)).status, 401, `席${s}の priv は読めない`);
  assert.equal((await rd('host')).status, 401, 'host（seedBase）は読めない');
  ok('ゲストは他家・CPU の priv と host を読めない（自分の priv だけ）');

  // 残り時間の帯（全員に同じ締切）
  await H.page.waitForSelector('.ol-timer .ol-left', { timeout: 20000 });
  ok('残り時間の帯が表示される');
  await shot(H.page, 'match-host');
  await shot(G.page, 'match-guest');

  // 打ち切るまで両端末で操作。受信データに他家の手牌がないことを毎回確かめる
  const t0 = Date.now();
  let steps = 0;
  let checked = 0;
  for (;;) {
    assert.ok(Date.now() - t0 < 240000, '4分以内に1局戦が終わる');
    const [a, b] = await Promise.all([stepOnce(H.page), stepOnce(G.page)]);
    if (a === 'final' && b === 'final') break;
    if (a || b) steps++;
    for (const [P] of [[H.page], [G.page]]) {
      const st = await onlineState(P);
      if (!st) continue;
      checked++;
      if (st.pub.game.phase !== 'ended') {
        assert.equal(st.pub.game.revealed, null, '局の途中は全員の手牌を出さない');
        assert.ok(!('hands' in st.pub.game), 'pub に手牌はない');
      }
      if (st.priv) assert.equal(st.priv.seat, st.mySeat, 'priv は自分の席だけ');
      const handsOthers = await P.evaluate(() => { const g = window.__mathjong.S.game; return g && g.phase !== 'ended' ? [1, 2, 3].every((s) => g.hands[s].every((x) => x === -1)) : true; });
      assert.ok(handsOthers, '画面のモデルにも他家の手牌の中身はない');
    }
    if (!a && !b) await H.page.waitForTimeout(120);
  }
  ok(`1局戦を画面の操作だけで最後まで（操作 ${steps} 回・検査 ${checked} 回）`);
  await shot(H.page, 'final-host');
  await shot(G.page, 'final-guest');

  const hf = await onlineState(H.page);
  const gf = await onlineState(G.page);
  assert.equal(hf.pub.phase, 'final');
  assert.equal(gf.pub.phase, 'final');
  assert.deepEqual(gf.pub.match.scores, hf.pub.match.scores, '両端末の持ち点が一致');
  assert.equal(hf.pub.match.scores.reduce((x, y) => x + y, 0), 400);
  // 画面の最終結果：自分の順位と得点が、配信の持ち点と一致
  for (const [P, st] of [[H.page, hf], [G.page, gf]]) {
    assert.equal(await P.locator('.report-info').count(), 0, 'オンラインの結果画面にも再現情報（注記を含む）は出さない');
    const me = await P.textContent('.final-me');
    const pts = st.pub.match.scores[st.mySeat];
    const rank = 1 + st.pub.match.scores.filter((x) => x > pts).length;
    assert.ok(me.includes(`${rank}位`) && me.includes(`${pts}点`), `画面の順位・得点：${me}`);
    const rows = await P.$$eval('.final-table tr td.pts', (els) => els.map((e) => Number(e.textContent)));
    assert.deepEqual(rows.slice().sort((x, y) => y - x), st.pub.match.scores.slice().sort((x, y) => y - x));
  }
  ok(`両端末で結果（持ち点 ${hf.pub.match.scores.join('・')}・順位）が一致`);

  // 部屋を出る：ホストが出ると部屋が消え、ゲストに「閉じられました」
  await H.page.click('[data-action="online-leave"]');
  await waitScreen(H.page, 'menu');
  await waitScreen(G.page, 'closed');
  ok('最終結果から部屋を出る（ホスト）→ ゲストに「閉じられました」');

  for (const x of [H, G]) assert.deepEqual(x.errors, [], 'ページのエラーなし');
  ok('両端末でページのエラーなし');
  console.log(`✓ オンライン 2人で1局通し E2E：${passed}件すべて合格`);
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  server.close();
  await owner('DELETE', 'games/mathjong').catch(() => {});
}
