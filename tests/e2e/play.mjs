// ブラウザでの実プレイテスト（Playwright）。画面のボタン・牌をタップして複数局を最後まで遊ぶ。
// 使い方: node tests/e2e/play.mjs [--rounds 6] [--shots <dir>]
// 必要: playwright（Chromium）。リポジトリ自体には依存を追加しない。
// 環境に依存しないよう、次のようにしている：
// - サーバーは 127.0.0.1 の空きポート（OS が割当て）で起動し、終了時に必ず停止する。
// - Chromium は --no-proxy-server で起動（HTTP(S)_PROXY 等の環境変数のプロキシを使わない）。
// - 公開サイト相当のホスト（mathjong.test）は DNS を使わず、ブラウザ内のリクエスト横取り（route）で
//   ローカルサーバーへ転送する。
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROUNDS = Number(opt('--rounds', 6));
const SHOTS = opt('--shots', null);
// GitHub Pages と同じサブパスで配信して相対パスを検証する
const BASE = '/mathjong/';
let PORT;
let LOCAL;
// 公開サイト相当（localhost 以外のホスト名）。テスト用フックが無効になることを確認する。
const PUBLIC_HOST = 'mathjong.test';
const PUBLIC = `http://${PUBLIC_HOST}${BASE}`;

// mathjong.test へのリクエストをローカルサーバーへ転送（ステータス・ヘッダーはそのまま）
function forwardToLocal(route) {
  const url = new URL(route.request().url());
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path: url.pathname + url.search, method: route.request().method(), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => route.fulfill({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }).then(resolve, reject));
    });
    req.on('error', (e) => route.abort().finally(() => reject(e)));
    req.end();
  });
}

async function newContext(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route((u) => u.hostname === PUBLIC_HOST, forwardToLocal);
  return ctx;
}

// ページのエラー・HTTP 4xx/5xx・サブパス外への要求（/favicon.ico など）を記録
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => errors.push(`failed ${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && !u.pathname.startsWith(BASE) && u.pathname !== BASE.slice(0, -1)) errors.push(`outside base: ${r.url()}`); });
  return errors;
}

const DEVICES = [
  { name: 'iPhone SE (375×667)', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
  { name: 'Android (412×915)', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
  { name: 'iPad 縦 (768×1024)', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true },
  { name: 'Chromebook (1366×768)', viewport: { width: 1366, height: 768 }, isMobile: false, hasTouch: false },
];

async function invariants(page) {
  return page.evaluate(() => {
    const g = window.__mathjong.S.game;
    g.checkInvariants();
    return { phase: g.phase, wall: g.wall.length };
  });
}

async function playDevice(browser, dev, seed, rounds, stats) {
  const ctx = await newContext(browser, { viewport: dev.viewport, isMobile: dev.isMobile, hasTouch: dev.hasTouch, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?seed=${seed}&speed=test`);
  const tap = (loc) => (dev.hasTouch ? loc.tap() : loc.click());

  // 操作バーが画面内（下端のホームインジケーター領域を除く）に収まっている
  const bar = await page.locator('.bar').boundingBox();
  assert.ok(bar && bar.y + bar.height <= dev.viewport.height + 0.5, `${dev.name}: 操作バーが画面外`);
  // 牌が iOS のダブルタップ拡大を起こさない設定
  assert.equal(await page.locator('.hand .tile').first().evaluate((el) => getComputedStyle(el).touchAction), 'manipulation');
  // 手牌のタップ領域（幅30px以上）
  const tw = (await page.locator('.hand .tile').first().boundingBox()).width;
  assert.ok(tw >= 30, `${dev.name}: 手牌の幅 ${tw}px`);

  // レイアウト：横スクロールが発生しない
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${dev.name}: horizontal overflow ${overflow}px`);

  for (let r = 0; r < rounds; r++) {
    let actions = 0;
    let shotTaken = false;
    for (;;) {
      await page.waitForSelector('.overlay .result, .actions:not(.waiting) button:not([disabled]), .hand .tile.tap', { timeout: 15000 });
      await invariants(page);
      if (await page.locator('.overlay .result').count()) break;
      if (++actions > 400) throw new Error('round did not finish');

      const tsumo = page.locator('button[data-action="tsumo"]');
      const ron = page.locator('button[data-action="ron"]');
      const chi = page.locator('button[data-action="chi"]');
      const pass = page.locator('button[data-action="pass"]');
      if (await tsumo.count()) { stats.tsumo++; await tap(tsumo); continue; }
      if (await ron.count()) {
        // 一部の局ではロンを見送って進行が止まらないことを確認する
        if (r % 3 === 2 && !stats.ronDeclined) { stats.ronDeclined++; await tap(pass); continue; }
        stats.ron++; await tap(ron); continue;
      }
      if (await chi.count()) {
        // 奇数局ではチーを実行（公開面子と手牌枚数を確認）、偶数局では見送る
        if (r % 2 === 1) {
          const before = await page.evaluate(() => window.__mathjong.S.game.hands[0].length);
          await tap(chi.first());
          await page.waitForTimeout(30);
          const st = await page.evaluate(() => {
            const g = window.__mathjong.S.game;
            return { hand: g.hands[0].length, melds: g.melds[0].length, phase: g.phase, cur: g.current, winner: g.result && g.result.winner };
          });
          if (st.phase !== 'ended' || st.winner === 0) {
            if (st.phase === 'turn' && st.cur === 0) {
              assert.equal(st.hand, before - 2, 'チー後の手牌枚数');
              stats.chi++;
              if (SHOTS && !stats.chiShot) { stats.chiShot = 1; await page.screenshot({ path: `${SHOTS}/chi-${dev.viewport.width}.png` }); }
            }
          } else {
            stats.chiOverriddenByRon++;
          }
          continue;
        }
        stats.chiPassed++;
        await tap(pass);
        continue;
      }
      if (await pass.count()) { await tap(pass); continue; }

      // 自分の手番：牌をタップして選択→もう一度タップ（または「捨てる」）で捨てる。
      // 偶数局は AI と同じ評価で打牌（和了を狙う）、奇数局は端の牌を捨てる。
      const tiles = page.locator('.hand .tile.tap');
      const n = await tiles.count();
      if (n) {
        let t = tiles.nth(actions % 3 === 0 ? 0 : n - 1);
        if (r % 2 === 0) {
          const id = await page.evaluate(() => {
            const { S, decide } = window.__mathjong;
            const a = decide(S.game, 0, 'speed');
            return a.type === 'discard' ? a.tile : null;
          });
          if (id !== null) t = page.locator(`.hand .tile[data-id="${id}"]`);
        }
        await tap(t);
        if (SHOTS && !shotTaken && r === 0) { shotTaken = true; await page.screenshot({ path: `${SHOTS}/turn-${dev.viewport.width}.png` }); }
        if (actions % 2) await tap(t); else await tap(page.locator('button[data-action="discard"]'));
        stats.discards++;
      }
    }
    // 結果画面の検証
    const res = await page.evaluate(() => {
      const { S } = window.__mathjong;
      return { result: S.game.result, scores: S.scores.slice() };
    });
    const text = await page.locator('.overlay .result').innerText();
    if (res.result.type === 'win') {
      stats.wins[res.result.winner]++;
      assert.match(text, /和了/);
      assert.match(text, /合計/);
      if (res.result.analysis.kind === 'normal') {
        assert.equal(await page.locator('.overlay .formulas li').count(), 3, '3面子の数式を表示');
      }
      for (const y of res.result.analysis.yaku) { stats.yaku[y.name] = (stats.yaku[y.name] || 0) + 1; assert.ok(text.includes(y.name)); }
    } else {
      stats.draws++;
      assert.match(text, /流局/);
    }
    if (SHOTS && r < 2) await page.screenshot({ path: `${SHOTS}/result-${dev.viewport.width}-${r}.png` });
    stats.rounds++;
    await tap(page.locator('button[data-action="next"]'));
    await page.waitForFunction((rr) => window.__mathjong.S.round === rr + 2, r);
  }
  assert.deepEqual(errors, [], `${dev.name}: console errors`);
  await ctx.close();
}

// 山を指定した局面テスト（ツモ和了・九角無双）。dealer=自分。
function presetWall(myHand, draws) {
  const k = (x) => (x.startsWith('=') ? `v:${x.slice(1)}` : /^\d+$/.test(x) ? `a:${x}` : `f:${x}`);
  const others = [
    ['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'],
    ['cos', 'cos', 'cos', '180', '270', '270', '=√3', '=√3'],
    ['tan', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2'],
  ];
  const hands = [myHand, ...others];
  const keys = [];
  for (let r = 0; r < 8; r++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][r]));
  return [...keys, ...draws.map(k)];
}

async function scenario(browser, name, wall, check) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?seed=1&speed=test`);
  await page.waitForSelector('.hand .tile');
  await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); }, wall);
  const tsumo = page.locator('button[data-action="tsumo"]');
  await tsumo.waitFor({ timeout: 5000 });
  await tsumo.tap();
  await page.waitForSelector('.overlay .result');
  const text = await page.locator('.overlay .result').innerText();
  check(text);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/scenario-${name}.png` });
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log(`✓ 局面テスト: ${name}`);
}

// ---- 連打の検証（再発防止） ----
// 同じ座標を短時間に複数回タップし（DOM の再描画に左右されない座標指定）、
// 1) タップが実際にページに届いた回数、2) UI が処理した人間の操作の回数（S.input）、
// 3) エンジンに記録された自分の打牌の回数、を数えて「1手番に打牌1回」を確認する。
// AI は「ゆっくり」（1手1.2秒）なので、連打中に自分の次の手番は来ない（次の手番の操作と混同しない）。
async function burstTap(page, box, n) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) await page.touchscreen.tap(x, y);
  return Date.now() - t0;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const { S } = window.__mathjong;
    const g = S.game;
    return {
      events: g.events.length, input: { ...S.input }, river: g.rivers[0].length, hand: g.hands[0].length,
      clicks: window.__clicks || 0, selected: S.selected,
    };
  });
}

async function afterBurst(page, before) {
  return page.evaluate((b) => {
    const { S } = window.__mathjong;
    const g = S.game;
    g.checkInvariants();
    const mine = g.events.slice(b.events).filter((e) => e.type === 'discard' && e.seat === 0);
    const myDraws = g.events.slice(b.events).filter((e) => e.type === 'draw' && e.seat === 0).length;
    return {
      discards: mine.map((e) => e.tile), myDraws,
      accepted: S.input.accepted - b.input.accepted, failed: S.input.failed - b.input.failed,
      river: g.rivers[0].length, hand: g.hands[0].length, clicks: window.__clicks - b.clicks,
    };
  }, before);
}

async function rapidTapGuard(browser) {
  const N = 4;
  // (A) 同じ牌の連続タップ：1回目で選択、2回目で打牌、3回目以降は無効であること
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=77&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    await page.evaluate(() => { window.__clicks = 0; document.addEventListener('click', () => { window.__clicks++; }, true); });
    const target = page.locator('.hand .tile.tap').last();
    const id = Number(await target.getAttribute('data-id'));
    const box = await target.boundingBox();
    const before = await snapshot(page);
    assert.equal(before.hand, 9);
    const ms = await burstTap(page, box, N);
    const r = await afterBurst(page, before);
    assert.ok(ms < 1000, `連打が短時間に送られていない（${ms}ms）`);
    assert.equal(r.clicks, N, `タップが${N}回届いていない（${r.clicks}回）`);
    assert.equal(r.myDraws, 0, '自分の次の手番が混ざっている');
    assert.deepEqual(r.discards, [id], 'タップした牌が1回だけ捨てられる');
    assert.equal(r.accepted, 1, 'UI が処理した操作は1回');
    assert.equal(r.failed, 0, 'エンジンに拒否された二重操作がない');
    assert.equal(r.river, before.river + 1);
    assert.equal(r.hand, before.hand - 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (B) 「捨てる」ボタンの連続タップ：選択済みの牌が1回だけ捨てられること
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=78&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    await page.evaluate(() => { window.__clicks = 0; document.addEventListener('click', () => { window.__clicks++; }, true); });
    const tile = page.locator('.hand .tile.tap').first();
    const id = Number(await tile.getAttribute('data-id'));
    await tile.tap();
    assert.equal(await page.evaluate(() => window.__mathjong.S.selected), id);
    const btn = page.locator('button[data-action="discard"]:not([disabled])');
    const box = await btn.boundingBox();
    assert.ok(box, '捨てるボタンが有効');
    const before = await snapshot(page);
    const ms = await burstTap(page, box, N);
    const r = await afterBurst(page, before);
    assert.ok(ms < 1000, `連打が短時間に送られていない（${ms}ms）`);
    assert.equal(r.clicks, N, `タップが${N}回届いていない（${r.clicks}回）`);
    assert.equal(r.myDraws, 0, '自分の次の手番が混ざっている');
    assert.deepEqual(r.discards, [id], '選択した牌が1回だけ捨てられる');
    assert.equal(r.accepted, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.hand, before.hand - 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`✓ 連打（牌${N}回・捨てる${N}回）で打牌は1回だけ`);
}

// 公開サイト相当の挙動（localhost 以外のホスト名）
async function publicMode(browser) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const firstHand = async (q) => {
    await page.goto(`${PUBLIC}${q}`);
    await page.waitForSelector('.hand .tile');
    return page.locator('.hand .tile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).join(' '));
  };
  // テスト用フック・山の指定は公開サイトでは使えない
  await page.goto(`${PUBLIC}?seed=5&speed=test`);
  await page.waitForSelector('.hand .tile');
  assert.equal(await page.evaluate(() => typeof window.__mathjong), 'undefined', '公開サイトでテスト用フックが露出している');
  // ?speed=test は無視され、設定画面に「テスト」速度は出ない
  await page.locator('button[data-action="settings"]').tap();
  const speeds = await page.locator('select[data-action="speed"] option').evaluateAll((o) => o.map((x) => x.value));
  assert.deepEqual(speeds, ['fast', 'normal', 'slow']);
  assert.match(await page.locator('.report-info').innerText(), /seed 5/);
  // seed 再現：同じ seed は同じ配牌、違う seed は違う配牌
  const a1 = await firstHand('?seed=123');
  const a2 = await firstHand('?seed=123');
  const b = await firstHand('?seed=124');
  assert.equal(a1, a2, '同じ seed で同じ配牌');
  assert.notEqual(a1, b, '別の seed で別の配牌');
  // ?round=3 で第3局（親は対面）から始まる。round 1 から3局進めたときと同じ山。
  await page.goto(`${PUBLIC}?seed=123&round=3`);
  await page.waitForSelector('.panel.seat-2 .oya');
  assert.match(await page.locator('.top .info').innerText(), /第3局/);
  // 不正な値は無視される（エラーにならない）
  await firstHand('?seed=abc&round=-1&speed=%3Cscript%3E');
  assert.match(await page.locator('.top .info').innerText(), /第1局/);
  // /mathjong（末尾スラッシュなし）でも開ける（301 → /mathjong/）。
  // route で返したリダイレクト先はブラウザが再度横取りしないため、ホスト名に依存しない localhost で確認する。
  // （リダイレクト応答そのものは tests/serve.test.js で検査）
  await page.goto(`http://localhost:${PORT}${BASE.slice(0, -1)}`);
  assert.equal(new URL(page.url()).pathname, BASE);
  await page.waitForSelector('.hand .tile');
  assert.deepEqual(errors, [], 'console/HTTP errors');
  await ctx.close();
  console.log('✓ 公開サイト相当：テスト用フック無効・seed/round 再現・不正値・サブパス');
}

// 公開サイトで不正な speed（URL・localStorage）でも既定値で進行する
async function badSpeeds(browser) {
  // AI が1手以上打つまで（山の枚数が減るまで）進行することを確認
  async function progresses(page) {
    await page.waitForSelector('.hand .tile.tap');
    const wall0 = Number(await page.locator('.wall b').innerText());
    const drawn = page.locator('.hand .tile.tap').last();
    await drawn.tap();
    await drawn.tap();
    await page.waitForFunction((w) => Number(document.querySelector('.wall b').textContent) < w, wall0, { timeout: 5000 });
  }
  for (const v of ['toString', 'constructor', '__proto__', 'unknown', '', 'hasOwnProperty']) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${PUBLIC}?seed=5&speed=${encodeURIComponent(v)}`);
    await progresses(page);
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="speed"]').inputValue(), 'normal', `speed=${v}`);
    assert.deepEqual(errors, [], `speed=${v}`);
    await ctx.close();
  }
  for (const saved of ['constructor', '__proto__', 'toString', 'test', 'unknown', '']) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript((v) => { try { localStorage.setItem('mj-speed', v); } catch { /* ignore */ } }, saved);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${PUBLIC}?seed=5`);
    await progresses(page);
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="speed"]').inputValue(), 'normal', `saved=${saved}`);
    assert.deepEqual(errors, [], `saved=${saved}`);
    await ctx.close();
  }
  console.log('✓ 不正な speed（URL 6種・保存値 6種）でも既定値で進行');
}

// 第n局の山が「seed と n だけで決まる」ことの確認（?round=n の再現性）
async function roundReproduction(browser) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${LOCAL}?seed=321&speed=slow`);
  await page.waitForSelector('.hand .tile');
  const viaNext = await page.evaluate(() => {
    const m = window.__mathjong;
    m.S.round = 3; m.S.dealer = 2; m.startRound();
    return { wall: m.S.game.wall.slice(), hands: m.S.game.hands.map((h) => h.slice()), dealer: m.S.game.dealer };
  });
  await page.goto(`${LOCAL}?seed=321&round=3&speed=slow`);
  await page.waitForSelector('.hand .tile');
  const direct = await page.evaluate(() => {
    const g = window.__mathjong.S.game;
    return { wall: g.wall.slice(), hands: g.hands.map((h) => h.slice()), dealer: g.dealer };
  });
  assert.deepEqual(direct, viaNext);
  await ctx.close();
  console.log('✓ ?seed=&round= で同じ局を再現');
}

// 実機テスト用の固定 seed（docs/12）。「毎回右端のツモ牌を捨て、チー・ロンは見送る」と
// 指定の手番で宣言ボタンが出ることを、公開サイト相当の画面で確認する。
export const DEVICE_SEEDS = [
  { seed: 1, action: 'chi', turn: 1 },
  { seed: 111, action: 'ron', turn: 1 },
  { seed: 34, action: 'tsumo', turn: 2 },
];
async function fixedSeeds(browser) {
  for (const fx of DEVICE_SEEDS) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${PUBLIC}?seed=${fx.seed}&speed=fast`);
    let myTurns = 0;
    let seenAt = null;
    for (let i = 0; i < 200 && seenAt === null; i++) {
      await page.waitForSelector('.overlay .result, .actions:not(.waiting) button:not([disabled]), .hand .tile.tap', { timeout: 15000 });
      if (await page.locator('.overlay .result').count()) break;
      // ツモは自分の手番の開始時に出るので、その手番を数に含める
      if (await page.locator(`button[data-action="${fx.action}"]`).count()) { seenAt = fx.action === 'tsumo' ? myTurns + 1 : myTurns; break; }
      if (await page.locator('button[data-action="pass"]').count()) { await page.locator('button[data-action="pass"]').tap(); continue; }
      if (await page.locator('button[data-action="tsumo"]').count()) throw new Error(`seed ${fx.seed}: 想定外のツモ`);
      const drawn = page.locator('.hand .tile.tap').last();
      myTurns++;
      await drawn.tap();
      await drawn.tap();
    }
    assert.equal(seenAt, fx.turn, `seed ${fx.seed}: ${fx.action} が自分の${fx.turn}巡目に出る`);
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`✓ 固定seed ${fx.seed}: ${fx.action} ボタン（${fx.turn}巡目）`);
  }
}

const server = await startServer(0, { base: BASE, host: '127.0.0.1' });
PORT = server.address().port;
LOCAL = `http://localhost:${PORT}${BASE}`;
let browser;
const stats = { rounds: 0, wins: [0, 0, 0, 0], draws: 0, tsumo: 0, ron: 0, ronDeclined: 0, chi: 0, chiPassed: 0, chiOverriddenByRon: 0, discards: 0, yaku: {} };
const t0 = Date.now();
try {
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  await scenario(browser, 'tsumo', presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['=1']), (text) => {
    assert.match(text, /あなた の和了 ツモ/);
    assert.match(text, /三関制覇/);
    assert.match(text, /合計\s*2点/);
  });
  await scenario(browser, 'kyukaku', presetWall(['0', '30', '45', '60', '90', '120', '135', '150'], ['180']), (text) => {
    assert.match(text, /九角無双/);
    assert.match(text, /16点/);
  });
  await publicMode(browser);
  await badSpeeds(browser);
  await fixedSeeds(browser);
  await roundReproduction(browser);
  await rapidTapGuard(browser);
  for (const [i, dev] of DEVICES.entries()) {
    const rounds = i === 0 ? ROUNDS : Math.max(2, Math.ceil(ROUNDS / 2));
    await playDevice(browser, dev, 4242 + i * 101, rounds, stats);
    console.log(`✓ ${dev.name}: ${rounds}局 完走`);
  }
  console.log(JSON.stringify({ ...stats, seconds: (Date.now() - t0) / 1000 }));
  console.log('E2E OK');
} catch (e) {
  console.error('E2E FAILED');
  console.error(e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
