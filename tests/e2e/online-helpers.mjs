// オンライン対戦の E2E の共通部品（エミュレータ・Firebase SDK の横取り・画面の操作）。online-reconnect.mjs・online-long.mjs で使う。
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
const FB_DIR = dirname(require.resolve('firebase/package.json'));
export const NS = 'demo-mathjong-default-rtdb';
export const DB = 'http://127.0.0.1:9000';
export const BASE = '/mathjong/';
export const rulesFragment = () => require('../../firebase/mathjong-rules.cjs');

export async function owner(method, path, body) {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, { method, headers: { authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `owner ${method} ${path}: ${r.status}`);
  return r.json();
}

export async function setup({ extra = '' } = {}) {
  const server = await startServer(0, { base: BASE, host: '127.0.0.1' });
  const port = server.address().port;
  const url = (q = '') => `http://localhost:${port}${BASE}?online=emu${extra}${q}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  await owner('PUT', '.settings/rules', { rules: { games: { mathjong: rulesFragment() } } });
  await owner('DELETE', 'games/mathjong');
  await owner('PUT', 'games/mathjong/config', { enabled: true });
  const contexts = [];
  return {
    server, browser, url, contexts,
    async newCtx(viewport = { width: 390, height: 844 }) {
      const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
      contexts.push(ctx);
      await ctx.route((u) => u.hostname === 'www.gstatic.com', (route) => {
        const m = new URL(route.request().url()).pathname.match(/^\/firebasejs\/12\.12\.0\/(firebase-(?:app|auth|database)\.js)$/);
        if (!m) return route.abort('failed');
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(pjoin(FB_DIR, m[1])) });
      });
      const x = { ctx, errors: [], page: null };
      x.open = async () => {
        const page = await ctx.newPage();
        page.on('pageerror', (e) => x.errors.push(`pageerror: ${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' ')}`));
        page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|net::ERR|Failed to load resource/.test(m.text())) x.errors.push(`console: ${m.text()}`); });
        x.page = page;
        return page;
      };
      await x.open();
      return x;
    },
    async close() {
      for (const c of contexts) await c.close().catch(() => {});
      await browser.close();
      server.close();
      await owner('DELETE', 'games/mathjong').catch(() => {});
    },
  };
}

export const waitScreen = (page, name, timeout = 20000) => page.waitForSelector(`[data-online-screen="${name}"]`, { timeout });
export async function enter(page, url, name) {
  await page.goto(url);
  await page.click('[data-action="online-open"]');
  await waitScreen(page, 'name');
  await page.fill('#ol-name', name);
  await page.click('[data-action="ol-name-save"]');
  await waitScreen(page, 'menu');
}
export async function createRoomUI(page, { length = 4, mode = 'math1' } = {}) {
  await page.check(`input[name="ol-length"][value="${length}"]`);
  await page.check(`input[name="ol-mode"][value="${mode}"]`);
  await page.click('[data-action="ol-create"]');
  await waitScreen(page, 'lobby');
  return page.getAttribute('.ol-code', 'data-code');
}
export async function joinUI(page, code) {
  await page.fill('#ol-code', code);
  await page.click('[data-action="ol-join"]');
  await waitScreen(page, 'lobby');
}
export const onlineState = (page) => page.evaluate(() => {
  const o = window.__mathjong && window.__mathjong.S.online;
  return o && o.pub ? { pub: o.pub, priv: o.priv, mySeat: o.mySeat, hostWait: o.hostWait } : null;
}).catch(() => null);

// 配信で画面が描き直された瞬間の取りこぼしは、次の回にやり直す
async function tryClick(h) { try { await h.click({ timeout: 1500 }); return true; } catch { return false; } }
// 1手だけ進める（自分の番・宣言・結果の「次へ」）。何もできなければ false
export async function stepOnce(page) {
  try {
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
  } catch { return false; }
  return false;
}
// 全員で打ち進める。until(states) が true になるか、全員が最終結果になるまで
export async function playUntil(pages, until = null, { timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    assert.ok(Date.now() - t0 < timeoutMs, `${timeoutMs / 1000}秒以内に進む`);
    const r = await Promise.all(pages.map((p) => stepOnce(p)));
    if (until && await until()) return 'until';
    if (r.every((x) => x === 'final')) return 'final';
    if (!r.some(Boolean)) await pages[0].waitForTimeout(100);
  }
}
export const shotter = (dir) => async (page, name) => { if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: pjoin(dir, `${name}.png`) }); } };
export const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
// 画面 0.7.4：リーチ宣言の席の発光（docs/87）。ゲストの画面で、配信の記録（pub.game.events）にあるリーチの宣言の席が、
// 名札（.seat-tag.seat-N）の riichi-flash で光ったかを記録する（ページの中の MutationObserver。追加の通信はない）。
// 席の番号はその端末から見た席（RemoteTable の events と同じ向き）。局ごとに（gameSerial）分けて数える。
export async function watchRiichiFlash(page) {
  await page.evaluate(() => {
    if (window.__rfWatch) return;
    const w = (window.__rfWatch = { flashed: new Set(), declared: new Set() });
    const look = () => {
      const m = window.__mathjong;
      const S = m && m.S;
      if (!S || !S.game) return;
      for (const e of S.game.events || []) if (e.type === 'riichi') w.declared.add(`${S.gameSerial}:${e.seat}`);
      for (const el of document.querySelectorAll('.seat-tag.riichi-flash')) { const k = el.className.match(/\bseat-(\d)\b/); if (k) w.flashed.add(`${S.gameSerial}:${k[1]}`); }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    look();
  });
}
export const riichiFlashReport = (page) => page.evaluate(() => { const w = window.__rfWatch; return w ? { declared: [...w.declared], flashed: [...w.flashed] } : null; });
// 宣言のあった席は、すべて光っている
export async function assertRiichiFlashed(page, label) {
  const r = await riichiFlashReport(page);
  assert.ok(r, `${label}：記録の準備`);
  for (const k of r.declared) assert.ok(r.flashed.includes(k), `${label}：リーチを宣言した席（${k}）が光る`);
  return r.declared.length;
}
