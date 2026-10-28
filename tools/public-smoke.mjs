// 公開サイトの動作確認（Ver.0.6）：既存の GitHub Pages の URL を実際に開き、新しい版が配信されていることと、
// タイトル → 対戦相手の選択（3人）→ 対局開始 まで操作できることを確かめる。サイトの内容は変更しない（読むだけ）。
//   node tools/public-smoke.mjs --url https://asumax1128.github.io/mathjong/ --version 0.6.2 [--wait 600] [--shots dir]
// 公開サイトではテスト用の機能（window.__mathjong・speed=test）は無効なので、画面の表示（DOM）だけで確認する。
// 反映待ち：指定の版が配信されるまで、最大 --wait 秒まで繰り返し読み込む（キャッシュを避けるため毎回クエリを変える）。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL0 = opt('--url', 'https://asumax1128.github.io/mathjong/');
const VERSION = opt('--version', '0.6.2');
const WAIT = Number(opt('--wait', 600));
const SHOTS = opt('--shots', null);

const browser = await chromium.launch(args.includes('--no-proxy') ? { args: ['--no-proxy-server'] } : {});
const log = (...a) => console.log(...a);
let ok = false;
try {
  // (1) 新しい版が配信されるまで待つ
  const t0 = Date.now();
  let title = '';
  for (;;) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const r = await page.goto(`${URL0}?v=${Date.now()}`, { waitUntil: 'load' }).catch((e) => ({ status: () => `error ${e.message}` }));
    title = await page.title().catch(() => '');
    const hasChoose = await page.locator('button[data-action="choose-opponents"]').count().catch(() => 0);
    log(`読み込み ${Math.round((Date.now() - t0) / 1000)}秒：HTTP ${r && r.status ? r.status() : '?'}・タイトル「${title}」・対戦相手を選ぶ ${hasChoose}`);
    await ctx.close();
    if (title.includes(VERSION) && hasChoose) break;
    if ((Date.now() - t0) / 1000 > WAIT) throw new Error(`版 ${VERSION} が ${WAIT} 秒以内に配信されなかった（タイトル「${title}」）`);
    await new Promise((res) => setTimeout(res, 20000));
  }

  // (2) スマートフォン相当（iPhone の画面の大きさ・タッチ）で、資源の読み込みと一連の操作
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  const responses = [];
  const failed = [];
  const errors = [];
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status() }));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${URL0}?v=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.title-screen');
  assert.equal(await page.evaluate(() => typeof window.__mathjong), 'undefined', '公開サイトでテストフックを出さない');
  assert.ok((await page.title()).includes(VERSION), `ページの版 ${await page.title()}`);
  assert.match(await page.locator('.title-ver').innerText(), new RegExp(`v${VERSION.replace(/\./g, '\\.')}`));
  await page.waitForFunction(() => { const i = document.querySelector('.title-logo img'); return i && i.complete && i.naturalWidth > 0; });
  assert.equal(await page.locator('input[data-action="title-ai"]').count(), 0, 'AI 難易度の3択はない');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/public-title.png` });
  await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
  await page.locator('button[data-action="choose-opponents"]').tap();
  await page.waitForSelector('.select-screen');
  const names = await page.locator('.opp-card .opp-name').allInnerTexts();
  assert.deepEqual(names, ['かなた', 'みつき', 'あおと', 'ゆうじん', 'おうすけ', 'なつき', 'ゆき', 'たら', 'シャカ', 'かおる', 'アスマ', 'のっち']);
  assert.equal(await page.locator('.opp-placeholder').count(), 3, '追加3人は仮表示');
  assert.deepEqual(await page.locator('.opp-card .opp-level').allInnerTexts(), [...Array(4).fill('初級'), ...Array(4).fill('中級'), ...Array(4).fill('上級')], '難易度ごとに4人');
  for (const [id, age, level] of [['yujin',26,'初級'],['tara',25,'中級'],['nocchi',28,'上級']]) {
    await page.locator(`.opp-card[data-id="${id}"] .opp-name`).tap();
    const info = await page.locator('.opp-sheet').innerText();
    assert.match(info, new RegExp(`${age}歳[\\s\\S]*${level}`), `${id} の年齢・難易度`);
    await page.locator('.opp-close').tap();
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.opp-grid')).gridTemplateColumns.split(' ').length), 2, '2列');
  assert.equal(await page.locator('.select-screen button[data-action="start-match"]').isDisabled(), true, '0人では開始できない');
  for (const id of ['yujin', 'tara', 'nocchi']) await page.locator(`.opp-check[data-id="${id}"]`).tap();
  await page.locator('.opp-card[data-id="kaoru"] .opp-name').tap();
  await page.waitForSelector('.opp-sheet');
  assert.match(await page.locator('.opp-sheet').innerText(), /27歳/);
  await page.locator('.opp-close').tap();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/public-select.png`, fullPage: true });
  assert.equal(await page.locator('.select-screen button[data-action="start-match"]').isDisabled(), false, '3人で開始できる');
  await page.locator('.select-screen button[data-action="start-match"]').tap();
  await page.waitForSelector('.hand .tile');
  const panel = (await page.locator('.panel .name').allInnerTexts()).sort();
  assert.deepEqual(panel, ['ゆうじん', 'たら', 'のっち'].sort(), `対局の名前 ${panel}`);
  assert.ok((await page.locator('.hand .tile').count()) >= 8, '手牌が表示される');
  // 実タップで1枚捨て、AI3人の打牌または正当な終局まで待つ。手牌が出ただけを進行成功にしない。
  const drawn = page.locator('.hand .tile.tap.drawn');
  await drawn.waitFor();
  const tile = drawn.first();
  if (!(await tile.evaluate(e => e.classList.contains('selected')))) await tile.tap();
  await drawn.first().tap();
  const deadline = Date.now() + 30000;
  let advanced = false;
  while (Date.now() < deadline) {
    advanced = await page.evaluate(() => !!document.querySelector('.overlay .result') || [...document.querySelectorAll('.panel')].every(p => p.querySelector('.river .tile')));
    if (advanced) break;
    const ron = page.locator('button[data-action="ron"]'), pass = page.locator('button[data-action="pass"]');
    if (await ron.count()) await ron.tap();
    else if (await pass.count()) await pass.tap();
    else await page.waitForTimeout(100);
  }
  assert.ok(advanced, '新3人のAIが進行する（打牌または和了）');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/public-game.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, '横スクロールなし');
  // 読み込んだ資源（JavaScript・CSS・画像）がすべて成功
  const site = responses.filter((r) => r.url.startsWith(new URL(URL0).origin));
  const bad = site.filter((r) => r.status >= 400);
  const kinds = { js: site.filter((r) => /\.m?js(\?|$)/.test(r.url)).length, css: site.filter((r) => /\.css(\?|$)/.test(r.url)).length, png: site.filter((r) => /\.png(\?|$)/.test(r.url)).length };
  log('資源', JSON.stringify(kinds), '失敗', JSON.stringify(bad), JSON.stringify(failed));
  assert.deepEqual(bad, [], '404 などの失敗がない');
  assert.deepEqual(failed, []);
  assert.ok(kinds.js >= 5 && kinds.css >= 1 && kinds.png >= 1, `JavaScript・CSS・画像を読み込んだ ${JSON.stringify(kinds)}`);
  assert.deepEqual(errors, [], 'ページのエラーがない');
  log(`サイト smoke OK：${URL0}（版 ${VERSION}）タイトル → 12人から新3人を選択 → 対局開始・AI進行、名前 ${panel.join('・')}`);
  ok = true;
  await ctx.close();
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
