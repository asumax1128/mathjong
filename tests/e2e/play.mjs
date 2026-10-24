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
// --channel chromium：Chromium の新しいヘッドレスモードで実行（既定はヘッドレスシェル）。
// 新しいヘッドレスモードは横スワイプで「戻る」ナビゲーションが起きるなど、実ブラウザに近い挙動をする。
const CHANNEL = opt('--channel', null);
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
  // ゲーム以外のページへの遷移（ブラウザの「戻る」スワイプなど）を検出
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && !/^https?:\/\//.test(f.url())) errors.push(`unexpected navigation: ${f.url()}`); });
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
function presetWall(myHand, draws, othersOverride = null) {
  const k = (x) => (x.startsWith('=') ? `v:${x.slice(1)}` : /^\d+$/.test(x) ? `a:${x}` : `f:${x}`);
  const others = othersOverride || [
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

// ---- Ver.0.2-A：役ガイド・役候補ヒント・牌表示 ----
async function v02aFeatures(browser) {
  const ctx = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?seed=9&speed=slow`);
  await page.waitForSelector('.hand .tile.tap');

  // (1) 役候補ヒント：最大3件、エンジンの yakuCandidates（公開情報）と一致、必要牌は表示しない
  await page.locator('button[data-action="hint"]').tap();
  await page.waitForSelector('.hint-yaku');
  const shown = await page.locator('.yaku-cands li b').allInnerTexts();
  const expected = await page.evaluate(async (base) => {
    const { yakuCandidates } = await import(`${base}src/engine/yakuhint.js`);
    const { S, rules } = window.__mathjong;
    return yakuCandidates(rules, S.game.viewFor(0)).map((c) => ({ name: c.name, missing: c.missing }));
  }, BASE);
  assert.ok(shown.length >= 1 && shown.length <= 3, `役候補 ${shown.length}件`);
  assert.deepEqual(shown, expected.map((c) => c.name));
  const misses = await page.locator('.yaku-cands .yc-miss').allInnerTexts();
  assert.deepEqual(misses, expected.map((c) => (c.missing === 0 ? '完成！' : `あと${c.missing}枚`)));
  const yakuArea = await page.locator('.hint-yaku').innerText();
  assert.equal(await page.locator('.hint-yaku .tile').count(), 0, 'ヒントに牌を表示しない');
  assert.ok(!/[°√]|sin|cos|tan/.test(yakuArea), `ヒントに必要牌の情報がある: ${yakuArea}`);
  // 既存のヒント（完成面子・あと1枚）は維持
  assert.match(await page.locator('.hint-basic').innerText(), /完成している面子：\d組.*あと1枚で完成する組み合わせ：\d+通り/s);

  // (2) 役ガイド：有効な役・特殊和了すべて、得点・鳴き可否は設定データと一致、数式例あり
  await page.locator('.hint-tools [data-action="guide"]').tap();
  const cards = await page.evaluate(() => [...document.querySelectorAll('.gy')].map((el) => ({
    id: el.dataset.yaku, pts: el.querySelector('.gy-pts').textContent, closed: !!el.querySelector('.tag.closed'),
    open: !!el.querySelector('.tag.open'), formulas: el.querySelectorAll('.gy-ex .formula').length, tiles: el.querySelectorAll('.gy-tiles .tile').length,
  })));
  const cfg = await page.evaluate(() => {
    const c = window.__mathjong.rules.config;
    return [...c.yaku.filter((y) => y.enabled), ...c.specialHands.filter((s) => s.enabled)].map((y) => ({ id: y.id, points: y.points, yakuman: !!y.yakuman, closedOnly: !!y.closedOnly, special: !!y.angles }));
  });
  assert.deepEqual(cards.map((c) => c.id), cfg.map((c) => c.id));
  for (const [i, y] of cfg.entries()) {
    const c = cards[i];
    assert.equal(c.pts, y.yakuman ? `役満 ${y.points}` : `+${y.points}`, y.id);
    assert.equal(c.closed, y.closedOnly, `${y.id} 門前限定`);
    assert.equal(c.open, !y.closedOnly, `${y.id} 鳴いても可`);
    if (y.special) assert.equal(c.tiles, 9, `${y.id} 例の牌`);
    else assert.equal(c.formulas, 3, `${y.id} 数式例`);
  }

  // (3) 牌一覧：全33種×4サイズで中身が枠からはみ出さない、角度の数字が中央
  await page.locator('[data-action="guide-tab"][data-tab="tiles"]').tap();
  const m = await page.evaluate(() => [...document.querySelectorAll('.gallery .tile')].map((t) => {
    const r = t.getBoundingClientRect();
    let over = 0;
    for (const el of t.querySelectorAll('*')) {
      const q = el.getBoundingClientRect();
      if (!q.width) continue;
      over = Math.max(over, r.left - q.left, q.right - r.right, r.top - q.top, q.bottom - r.bottom);
    }
    const ang = t.querySelector('.ang');
    const off = ang ? Math.abs((ang.getBoundingClientRect().left + ang.getBoundingClientRect().right) / 2 - (r.left + r.right) / 2) : 0;
    return { label: t.getAttribute('aria-label'), size: [...t.classList].find((c) => c.startsWith('sz-')), over, off };
  }));
  assert.equal(m.length, 33 * 4);
  const overflow = m.filter((x) => x.over > 0.5);
  assert.deepEqual(overflow, [], 'はみ出している牌');
  const offCentre = m.filter((x) => x.off > 1);
  assert.deepEqual(offCentre, [], '角度の数字が中央からずれている');
  // 分数線は分子・分母の広い方の幅以上
  const bars = await page.evaluate(() => [...document.querySelectorAll('.gallery .frac')].map((f) => {
    const w = f.getBoundingClientRect().width;
    const den = f.querySelector('.den').getBoundingClientRect().width;
    const num = f.querySelector('.num .rad, .num .int').getBoundingClientRect().width;
    return den + 0.5 >= num && Math.abs(den - w) < 0.5;
  }));
  assert.ok(bars.length > 0 && bars.every(Boolean), '分数線の幅');
  assert.deepEqual(errors, []);
  await ctx.close();

  // (4) 公開サイト相当でも役候補ヒントとガイドが動く（テスト用フックなし）
  const ctx2 = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  const e2 = watchErrors(p2);
  await p2.goto(`${PUBLIC}?seed=9`);
  await p2.waitForSelector('.hand .tile.tap');
  await p2.locator('button[data-action="hint"]').tap();
  await p2.waitForSelector('.yaku-cands, .yc-none');
  await p2.locator('button[data-action="guide"]').first().tap();
  await p2.waitForSelector('.gy');
  assert.deepEqual(e2, []);
  await ctx2.close();
  console.log('✓ Ver.0.2-A：役候補ヒント・役ガイド・牌表示（132枚 はみ出しなし）');
}

// ---- Ver.0.2-A 監査対応：ヒントの自動更新・宣言対象牌・連続操作 ----
// 画面の役候補と、同じ局面でエンジンの yakuCandidates（公開情報＋自分の宣言状態）を比べる
async function hintMatchesEngine(page) {
  return page.evaluate(async (base) => {
    const { yakuCandidates, claimForSeat } = await import(`${base}src/engine/yakuhint.js`);
    const { S, rules } = window.__mathjong;
    const g = S.game;
    const claim = claimForSeat(g.pending(), 0, (id) => g.typeOf(id));
    const exp = yakuCandidates(rules, g.viewFor(0), { claim }).map((c) => `${c.name}|${c.missing === 0 ? '完成！' : `あと${c.missing}枚`}`);
    const shown = [...document.querySelectorAll('.yaku-cands li')].map((li) => `${li.querySelector('b').textContent}|${li.querySelector('.yc-miss').textContent}`);
    return { exp, shown, open: !!document.querySelector('.hint-box .hint-yaku'), used: S.hintsUsed, comps: S.hintComputations || 0 };
  }, BASE);
}

async function v02aAuditFixes(browser) {
  // (1) 自分の手牌が変わらず他家の河だけが変わる間も、ヒントを開いたまま最新の局面で再計算。回数は増えない。
  {
    const ctx = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=9&speed=fast`);
    await page.waitForSelector('.hand .tile.tap');
    await page.locator('button[data-action="hint"]').tap();
    let st = await hintMatchesEngine(page);
    assert.ok(st.open && st.used === 1);
    assert.deepEqual(st.shown, st.exp);
    const drawn = page.locator('.hand .tile.tap').last();
    await drawn.tap();
    await drawn.tap();
    const hand0 = await page.evaluate(() => window.__mathjong.S.game.hands[0].slice().sort().join());
    const rivers0 = await page.evaluate(() => JSON.stringify(window.__mathjong.S.game.rivers.map((r) => r.length)));
    // 他家が打牌するたびに確認（自分の次の手番まで）
    let checks = 0;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150);
      const s2 = await page.evaluate(() => ({ seat: window.__mathjong.S.game.pending() && window.__mathjong.S.game.pending().seat, hand: window.__mathjong.S.game.hands[0].slice().sort().join(), rivers: JSON.stringify(window.__mathjong.S.game.rivers.map((r) => r.length)) }));
      st = await hintMatchesEngine(page);
      assert.ok(st.open, 'ヒントの表示状態が維持される');
      assert.equal(st.used, 1, '自動更新でヒント回数が増えない');
      assert.deepEqual(st.shown, st.exp, '役候補が最新の局面と一致');
      if (s2.hand === hand0 && s2.rivers !== rivers0) checks++;
      if (s2.seat === 0) break;
    }
    assert.ok(checks >= 1, '手牌が同じで河だけが変わった局面を確認');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (2) 九角無双：最後の180°をロンできる局面 → 「ロンしない」→ 候補から消える（画面で確認）
  {
    const ctx = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=1&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const wall = presetWall(['0', '30', '45', '60', '90', '120', '135', '150'], ['=-√3', '180', '180', '180', '=1/√3', '180'],
      [['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'], ['tan', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2'], ['cos', 'tan', '270', '270', '=-√3/2', '=-√3/2', '=1/√3', '=1/√3']]);
    await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); }, wall);
    await page.waitForSelector('.hand .tile.tap');
    // AI の打牌はテストから実行する（AI の判断に依存しないため）
    const forceDiscard = (seat) => page.evaluate((s) => {
      const { S, render } = window.__mathjong;
      clearTimeout(S.timer);
      S.game.discard(s, S.game.drawn);
      render();
    }, seat);
    const kyu = () => page.evaluate(() => [...document.querySelectorAll('.yaku-cands li')].map((li) => li.textContent).find((t) => t.includes('九角無双')) || null);
    await page.locator('button[data-action="hint"]').tap();
    assert.match(await kyu(), /あと1枚/);
    const drawn = page.locator('.hand .tile.tap').last();
    await drawn.tap();
    await drawn.tap();
    for (const seat of [1, 2, 3]) {
      await forceDiscard(seat);
      await page.waitForSelector('button[data-action="ron"]');
      assert.match(await kyu(), /完成！/, `${seat}の180°でロン可能`);
      await page.locator('button[data-action="pass"]').tap();
      assert.match(await kyu(), /あと1枚/, '見送り後はあと1枚');
    }
    await page.waitForSelector('.hand .tile.tap');
    await page.locator('.hand .tile.tap').last().tap();
    await page.locator('.hand .tile.tap').last().tap();
    await forceDiscard(1); // 最後の180°
    await page.waitForSelector('button[data-action="ron"]');
    assert.match(await kyu(), /完成！/, '最後の180°をロンできる局面で九角無双が候補に残る');
    let st = await hintMatchesEngine(page);
    assert.deepEqual(st.shown, st.exp);
    await page.locator('button[data-action="pass"]').tap();
    assert.equal(await kyu(), null, '見送り後、九角無双は候補から消える');
    st = await hintMatchesEngine(page);
    assert.deepEqual(st.shown, st.exp);
    assert.ok(st.open && st.used === 1, 'ヒントは開いたまま・回数は1');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) ヒントの連続操作・連続局切替（事前計算の途中）でも安定
  {
    const ctx = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=12&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    const btn = await page.locator('button[data-action="hint"]').boundingBox();
    for (let i = 0; i < 7; i++) await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
    const st = await hintMatchesEngine(page);
    assert.ok(st.open, '7回押すと開いた状態');
    assert.equal(st.used, 4, '開いた回数だけ数える');
    assert.deepEqual(st.shown, st.exp);
    // 事前計算の途中で局切替を20回
    const state = await page.evaluate(async (base) => {
      const { warmUpState } = await import(`${base}src/engine/yakuhint.js`);
      const { S, startRound, rules } = window.__mathjong;
      const before = warmUpState(rules);
      for (let i = 0; i < 20; i++) { S.round++; S.dealer = (S.dealer + 1) % 4; startRound(); }
      return { before, after: warmUpState(rules), round: S.round, open: S.hintOpen };
    }, BASE);
    assert.ok(['running', 'done'].includes(state.after));
    assert.equal(state.open, false, '新しい局ではヒントは閉じた状態');
    await page.waitForFunction(async (base) => {
      const { warmUpState } = await import(`${base}src/engine/yakuhint.js`);
      return warmUpState(window.__mathjong.rules) === 'done';
    }, BASE, { timeout: 10000 });
    await page.locator('button[data-action="hint"]').tap();
    const st2 = await hintMatchesEngine(page);
    assert.ok(st2.open && st2.used === 1);
    assert.deepEqual(st2.shown, st2.exp);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.2-A 監査対応：ヒント自動更新・九角無双のロン/見送り・連続操作・連続局切替');
}

// ---- 牌一覧が iPhone の画面幅に収まる（Ver.0.2-A 実機テストの不具合の再発防止） ----
// WebKit では、入れ子の折り返し flex の最小幅が「1行に並べた幅」になり、牌が横にはみ出すことがある。
// Chromium で同じ状態を再現するため、牌の並びが縮まない指定（flex-shrink: 0）を加えた「WebKit 想定」でも検査する。
const WEBKIT_EMULATION = '.gallery .gtiles { flex-shrink: 0 !important; }';
async function guideFitsScreen(browser) {
  const sizes = [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [932, 430]];
  for (const [w, h] of sizes) {
    for (const emulateWebKit of [false, true]) {
      const ctx = await newContext(browser, { viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(`${PUBLIC}?seed=9`);
      await page.waitForSelector('.hand .tile');
      if (emulateWebKit) await page.addStyleTag({ content: WEBKIT_EMULATION });
      await page.locator('button[data-action="guide"]').first().tap();
      // 全タブを切り替え、どのタブも横にはみ出さない
      for (const tab of ['yaku', 'rules', 'tiles']) {
        await page.locator(`[data-action="guide-tab"][data-tab="${tab}"]`).tap();
        const o = await page.evaluate(() => {
          const m = document.querySelector('.modal');
          return { sw: m.scrollWidth, cw: m.clientWidth, doc: document.documentElement.scrollWidth - innerWidth, mr: m.getBoundingClientRect().right };
        });
        const where = `${w}x${h} ${emulateWebKit ? 'WebKit想定' : '通常'} ${tab}`;
        assert.ok(o.sw <= o.cw, `${where}: モーダルが横スクロールする（${o.sw} > ${o.cw}）`);
        assert.ok(o.doc <= 0, `${where}: ページが横スクロールする`);
        assert.ok(o.mr <= w + 0.5, `${where}: モーダルが画面外`);
      }
      // 牌一覧：33種×4サイズ＝132枚が、縦スクロールで1枚ずつ全体を表示でき、左右に切れない
      const n = await page.locator('.gallery .tile').count();
      assert.equal(n, 132);
      const bad = await page.evaluate(() => {
        const m = document.querySelector('.modal');
        const cs = getComputedStyle(m);
        const out = [];
        for (const t of document.querySelectorAll('.gallery .tile')) {
          t.scrollIntoView({ block: 'center' });
          const mr = m.getBoundingClientRect();
          const left = mr.left + parseFloat(cs.paddingLeft);
          const right = mr.right - parseFloat(cs.paddingRight);
          const q = t.getBoundingClientRect();
          const visible = q.left >= left - 0.5 && q.right <= right + 0.5 && q.top >= mr.top - 0.5 && q.bottom <= mr.bottom + 0.5 && q.right <= innerWidth;
          if (!visible) out.push(`${t.getAttribute('aria-label')}/${[...t.classList].find((c) => c.startsWith('sz-'))}`);
        }
        return out;
      });
      assert.deepEqual(bad, [], `${w}x${h} ${emulateWebKit ? 'WebKit想定' : '通常'}: 全体を表示できない牌`);
      // 役一覧に戻しても正常
      await page.locator('[data-action="guide-tab"][data-tab="yaku"]').tap();
      assert.ok(await page.locator('.gy').count() >= 13);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ 牌一覧：320〜430px（縦・横）・WebKit想定でも132枚すべて画面内に表示');
}

// ---- Ver.0.2-D：手牌の並び替え（長押しドラッグ） ----
// タッチの長押しドラッグは Chromium の CDP（Input.dispatchTouchEvent）で実際のタッチとして送る。
const shownOrder = (page) => page.evaluate(() => [...document.querySelectorAll('.hand .tile[data-id]')].map((e) => Number(e.dataset.id)));
const tileBox = (page, id) => page.locator(`.hand .tile[data-id="${id}"]`).boundingBox();
const engineState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  S.game.checkInvariants();
  return {
    hand: S.game.hands[0].slice(), events: S.game.events.length, accepted: S.input.accepted, failed: S.input.failed,
    selected: S.selected, myDiscards: S.game.events.filter((e) => e.type === 'discard' && e.seat === 0).length,
    ghosts: document.querySelectorAll('.drag-ghost').length, phase: window.__mathjong.drag.phase(),
  };
});
const moveExpected = (order, id, index) => { const r = order.filter((x) => x !== id); return [...r.slice(0, index), id, ...r.slice(index)]; };
async function xForIndex(page, order, id, index) {
  const others = order.filter((x) => x !== id);
  if (index >= others.length) { const b = await tileBox(page, others[others.length - 1]); return b.x + b.width + 6; }
  const b = await tileBox(page, others[index]);
  return b.x + b.width * 0.25;
}
async function touchDrag(page, cdp, id, toX, toY = null, { hold = 450, steps = 6, release = true, before = null } = {}) {
  const b = await tileBox(page, id);
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height / 2;
  const ty = toY === null ? sy : toY;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  await page.waitForTimeout(hold);
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + ((toX - sx) * i) / steps, y: sy + ((ty - sy) * i) / steps }] });
    await page.waitForTimeout(16);
  }
  if (before) await before();
  if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(30);
}
async function dragToIndex(page, cdp, id, index) {
  const order = await shownOrder(page);
  const b = await tileBox(page, id);
  await touchDrag(page, cdp, id, await xForIndex(page, order, id, index), b.y + b.height / 2);
  return moveExpected(order, id, index);
}
async function reorderPage(browser, query, viewport = { width: 390, height: 844 }) {
  const ctx = await newContext(browser, { viewport, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}${query}`);
  await page.waitForSelector('.hand .tile[data-id]');
  const cdp = await ctx.newCDPSession(page);
  await page.evaluate(() => { window.__clicks = 0; window.addEventListener('click', () => { window.__clicks++; }, true); });
  return { ctx, page, cdp, errors };
}

async function handReorder(browser) {
  // (1) 先頭・中央・末尾、ツモ牌の移動。エンジンの手牌は変わらず、打牌・選択も起きない
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const e0 = await engineState(page);
    let order = await shownOrder(page);
    assert.equal(order.length, 9);
    const drawn = order[8];
    assert.equal(await page.locator('.hand .drawn-gap').count(), 1, 'ツモ牌は右端に隙間');
    let exp = await dragToIndex(page, cdp, drawn, 0); // ツモ牌を先頭へ
    assert.deepEqual(await shownOrder(page), exp, 'ツモ牌を先頭へ');
    assert.equal(await page.locator(`.hand .tile[data-id="${drawn}"].drawn-mark`).count(), 1, '移動したツモ牌は金色の点');
    assert.equal(await page.locator('.hand .drawn-gap').count(), 0);
    exp = await dragToIndex(page, cdp, exp[1], 4); // 中央へ
    assert.deepEqual(await shownOrder(page), exp, '中央へ');
    exp = await dragToIndex(page, cdp, exp[0], 8); // 末尾へ（ツモ牌を右端に戻す）
    assert.deepEqual(await shownOrder(page), exp, '末尾へ');
    assert.equal(await page.locator('.hand .drawn-gap').count(), 1, '右端に戻ると隙間で区別');
    const e1 = await engineState(page);
    assert.deepEqual(e1.hand, e0.hand, 'エンジンの手牌配列は変わらない');
    assert.equal(e1.events, e0.events, 'ゲームは進まない（自分の手番）');
    assert.equal(e1.accepted, e0.accepted, '打牌なし');
    assert.equal(e1.selected, null, '選択なし');
    assert.equal(e1.ghosts, 0);
    // (2) 自動整列：表示順だけを種類順（ツモ牌は右端）に戻す
    await page.locator('button[data-action="autosort"]').tap();
    const sorted = await page.evaluate(() => {
      const { S } = window.__mathjong; const g = S.game;
      const rest = g.hands[0].filter((id) => id !== g.drawn).sort((a, b) => g.typeOf(a) - g.typeOf(b) || a - b);
      return [...rest, g.drawn];
    });
    assert.deepEqual(await shownOrder(page), sorted, '自動整列');
    assert.deepEqual((await engineState(page)).hand, e0.hand);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) 同じ表示の牌（sin が3枚）を別々に動かす
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=1&speed=slow');
    await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); },
      presetWall(['sin', 'sin', 'sin', '30', '150', '=1/2', '=1/2', 'cos'], ['tan']));
    await page.waitForSelector('.hand .tile.tap');
    const order = await shownOrder(page);
    const sins = await page.evaluate(() => { const g = window.__mathjong.S.game; return g.hands[0].filter((id) => g.typeOf(id) === 0).sort((a, b) => a - b); });
    assert.equal(sins.length, 3);
    let exp = await dragToIndex(page, cdp, sins[1], 8);
    assert.deepEqual(await shownOrder(page), exp, '2枚目の sin を末尾へ');
    exp = await dragToIndex(page, cdp, sins[2], 0);
    assert.deepEqual(await shownOrder(page), exp, '3枚目の sin を先頭へ');
    assert.notDeepEqual(exp, order);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (4) 誤打牌ゼロ：長押しして離すだけ／選択済みの牌の長押し／帯の外で離す／ドラッグ直後の通常タップ／2回タップの打牌
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const A = order[2];
    const B = order[5];
    // 長押しして離すだけ
    let b = await tileBox(page, A);
    await touchDrag(page, cdp, A, b.x + b.width / 2, null, { steps: 0 });
    let st = await engineState(page);
    assert.equal(st.selected, null, '長押しで選択されない');
    assert.equal(st.accepted, 0, '長押しで打牌されない');
    assert.deepEqual(await shownOrder(page), order);
    // 先に A を選択 → A を長押しして離す → 打牌されない、選択も解除
    await page.locator(`.hand .tile[data-id="${A}"]`).tap();
    assert.equal((await engineState(page)).selected, A);
    b = await tileBox(page, A);
    await touchDrag(page, cdp, A, b.x + b.width / 2, null, { steps: 0 });
    st = await engineState(page);
    assert.equal(st.accepted, 0, '選択済みの牌を長押ししても打牌されない');
    assert.equal(st.selected, null, 'ドラッグで選択は解除');
    // A を選択 → B をドラッグして並び替え → 打牌されない
    await page.locator(`.hand .tile[data-id="${A}"]`).tap();
    await dragToIndex(page, cdp, B, 0);
    st = await engineState(page);
    assert.equal(st.accepted, 0);
    assert.equal(st.selected, null);
    // 手牌の帯の外（上へ200px）で離す → 取り消し
    const before = await shownOrder(page);
    b = await tileBox(page, A);
    await touchDrag(page, cdp, A, b.x + b.width / 2, b.y - 200);
    assert.deepEqual(await shownOrder(page), before, '帯の外で離すと取り消し');
    // ドラッグ直後の通常タップは有効（1回目で選択、2回目で打牌）
    await dragToIndex(page, cdp, A, 0);
    const clicks0 = await page.evaluate(() => window.__clicks);
    await page.locator(`.hand .tile[data-id="${B}"]`).tap();
    st = await engineState(page);
    assert.equal(st.selected, B, 'ドラッグ直後の通常タップで選択できる');
    assert.ok((await page.evaluate(() => window.__clicks)) > clicks0, 'タップの click が届いている');
    await page.locator(`.hand .tile[data-id="${B}"]`).tap();
    st = await engineState(page);
    assert.equal(st.accepted, 1, '2回タップで通常どおり打牌');
    assert.equal(st.myDiscards, 1);
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (5a) iOS Safari 想定：ドロップ直後、指の位置にある（再描画後の）牌へ合成 click（pointerId なし）が届いても抑止。
  //      その次の新しいタップは抑止されない（時間ではなく、ドラッグしたポインターの操作に対応付けて抑止）。
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const A = order[3];
    const b = await tileBox(page, A);
    // (i) 長押しして離す：Chromium は同じポインターの click を実際に送る → 抑止されて選択にならない
    const c0 = await page.evaluate(() => window.__clicks);
    await touchDrag(page, cdp, A, b.x + b.width / 2 + 2, b.y + b.height / 2, { steps: 0 });
    let st = await engineState(page);
    assert.ok((await page.evaluate(() => window.__clicks)) > c0, '長押しの後に実際の click が発生');
    assert.equal(st.selected, null, 'ドラッグしたポインターの click は抑止');
    assert.equal(st.accepted, 0);
    // (ii) 並び替えのドロップ：Chromium は click を送らないが、iOS は再描画後の指の位置の牌に合成 click
    //      （pointerId なし）を送ることがある。それを再現して、抑止されることを確認。
    const c1 = await page.evaluate(() => window.__clicks);
    const exp = await dragToIndex(page, cdp, order[0], 5);
    assert.equal(await page.evaluate(() => window.__clicks), c1, 'Chromium はドロップ後に click を送らない（前提の確認）');
    const box5 = await tileBox(page, exp[5]);
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y).closest('.tile');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y }));
      return Number(el.dataset.id);
    }, [box5.x + box5.width / 2, box5.y + box5.height / 2]);
    st = await engineState(page);
    assert.ok(hit >= 0);
    assert.equal(st.selected, null, 'ドロップ直後の合成 click は抑止');
    // 次の新しいタップは通常どおり
    await page.locator(`.hand .tile[data-id="${A}"]`).tap();
    assert.equal((await engineState(page)).selected, A, '次の通常タップで選択');
    await page.locator(`.hand .tile[data-id="${A}"]`).tap();
    assert.equal((await engineState(page)).accepted, 1, '2回タップで打牌');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (5b) マウス（PC）：ドラッグで選択・打牌は起きず、次の通常クリックは有効
  {
    const ctx = await newContext(browser, { viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=9&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    const order = await shownOrder(page);
    const A = order[3];
    const b = await tileBox(page, A);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // 右端へドラッグ
    const last = await tileBox(page, order[8]);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 8, cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    assert.deepEqual(await shownOrder(page), moveExpected(order, A, 8), 'マウスで並び替え');
    // その場で動かさずに離す（取り消し）
    const b2 = await tileBox(page, order[0]);
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 + 10, b2.y + b2.height / 2, { steps: 2 });
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 2 });
    await page.mouse.up();
    let st = await engineState(page);
    assert.equal(st.selected, null);
    assert.equal(st.accepted, 0);
    const c = await tileBox(page, A);
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    assert.equal((await engineState(page)).selected, A, '次の通常クリックで選択');
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    assert.equal((await engineState(page)).accepted, 1, 'もう一度クリックで打牌');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (6) 連続ドラッグ5回：誤打牌なし・順番は期待どおり
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=12&speed=slow');
    let exp = await shownOrder(page);
    for (let k = 0; k < 5; k++) {
      const id = exp[(k * 3) % exp.length];
      exp = await dragToIndex(page, cdp, id, (k * 5 + 2) % exp.length);
      assert.deepEqual(await shownOrder(page), exp, `${k + 1}回目`);
    }
    const st = await engineState(page);
    assert.equal(st.accepted, 0);
    assert.equal(st.selected, null);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (7) 打牌・ツモ・チーの後も順番を保つ（AI の打牌はテストから実行）
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=1&speed=slow');
    await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); },
      presetWall(['sin', '30', 'cos', 'cos', '180', '180', '=√3', '=√3'], ['=-1/√3', '=-1/√3', '=-1/√3', '=1/√3', '=1/√2'],
        [['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'], ['tan', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2'], ['=1/2', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2']]));
    await page.waitForSelector('.hand .tile.tap');
    // 並び替え
    let order = await dragToIndex(page, cdp, (await shownOrder(page))[8], 2);
    order = await dragToIndex(page, cdp, order[0], 8);
    // 打牌（右から2番目の牌をタップ2回）
    const discard = order[7];
    await page.locator(`.hand .tile[data-id="${discard}"]`).tap();
    await page.locator(`.hand .tile[data-id="${discard}"]`).tap();
    order = order.filter((id) => id !== discard);
    assert.deepEqual(await shownOrder(page), order, '打牌後も順番を保つ');
    // 他家の打牌（seat1, seat2 はツモ切り、seat3 は =1/2）→ 自分にチーの判断
    const force = (seat, key) => page.evaluate(([s, k]) => {
      const { S, render, rules } = window.__mathjong;
      clearTimeout(S.timer);
      const g = S.game;
      const id = k ? g.hands[s].find((x) => rules.types[g.typeOf(x)].key === k) : g.drawn;
      g.discard(s, id);
      render();
    }, [seat, key]);
    await force(1, null);
    await force(2, null);
    assert.deepEqual(await shownOrder(page), order, '他家の手番中も順番を保つ');
    await force(3, 'v:1/2');
    await page.waitForSelector('button[data-action="chi"]');
    // 宣言待ちの間は並び替えできない。長押しして牌1.5枚分動かす（並び替えが有効なら必ず順番が変わる操作）。
    // 大きな横スワイプ（約240px 以上）は、並び替えが無効な状態ではブラウザの「戻る」ナビゲーションを起こすことがある
    // （Chromium の新しいヘッドレスモードで確認）ため、テストの操作はその手前にとどめる。
    const urlBefore = page.url();
    const b = await tileBox(page, order[0]);
    await touchDrag(page, cdp, order[0], b.x + b.width * 2, b.y + b.height / 2);
    assert.equal(page.url(), urlBefore, 'ページは遷移していない');
    assert.deepEqual(await shownOrder(page), order, '宣言待ちは並び替え不可');
    assert.equal((await engineState(page)).ghosts, 0);
    const used = await page.evaluate(() => { const { S } = window.__mathjong; const p = S.game.pending(); return p.chi[0].use; });
    await page.locator('button[data-action="chi"]').first().tap();
    order = order.filter((id) => !used.includes(id));
    assert.deepEqual(await shownOrder(page), order, 'チー後も残りの順番を保つ');
    // 打牌して、次のツモは右端
    await page.locator(`.hand .tile[data-id="${order[0]}"]`).tap();
    await page.locator(`.hand .tile[data-id="${order[0]}"]`).tap();
    order = order.slice(1);
    await force(0 + 1, null);
    await force(2, null);
    await force(3, null);
    await page.evaluate(() => window.__mathjong.step());
    await page.waitForSelector('.hand .tile.tap');
    const now = await shownOrder(page);
    assert.deepEqual(now.slice(0, order.length), order, '次のツモまで順番を保つ');
    assert.equal(now.length, order.length + 1);
    assert.equal(await page.locator('.hand .drawn-gap').count(), 1, '新しいツモ牌は右端');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (8) ドラッグ中の中止：Esc・回転（画面サイズ変更）・再描画・モーダル・局切替。宣言待ち中は開始不可
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const cases = [
      ['Esc', () => page.keyboard.press('Escape')],
      ['回転', async () => { await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(50); await page.setViewportSize({ width: 390, height: 844 }); }],
      ['再描画', () => page.evaluate(() => window.__mathjong.render())],
      ['モーダル', () => page.evaluate(() => { const m = window.__mathjong; m.S.modal = 'settings'; m.render(); })],
    ];
    for (const [name, act] of cases) {
      const id = order[1];
      const b = await tileBox(page, id);
      let midPhase = null;
      await touchDrag(page, cdp, id, b.x + b.width * 5, b.y + b.height / 2, {
        before: async () => { midPhase = await page.evaluate(() => window.__mathjong.drag.phase()); await act(); },
      });
      assert.equal(midPhase, 'dragging', `${name}: ドラッグ中だった`);
      const st = await engineState(page);
      assert.deepEqual(await shownOrder(page), order, `${name}: 元の並びに戻る`);
      assert.equal(st.ghosts, 0, `${name}: 浮いた牌が残らない`);
      assert.equal(st.phase, 'idle', `${name}: 操作状態が残らない`);
      assert.equal(st.accepted, 0, `${name}: 打牌なし`);
      if (name === 'モーダル') {
        // モーダル表示中は開始できない（重なった画面の下の牌は押せない）
        assert.equal(await page.evaluate(() => window.__mathjong.S.modal), 'settings');
        await page.locator('button[data-action="close"]').tap();
      }
    }
    // 局切替：ドラッグ中に新しい局 → 中止され、表示順は初期化
    {
      const id = order[2];
      const b = await tileBox(page, id);
      await touchDrag(page, cdp, id, b.x + b.width * 4, b.y + b.height / 2, {
        before: () => page.evaluate(() => { const m = window.__mathjong; m.S.round++; m.S.dealer = (m.S.dealer + 1) % 4; m.startRound(); }),
      });
      const st = await engineState(page);
      assert.equal(st.ghosts, 0);
      assert.equal(st.phase, 'idle');
      assert.equal(await page.evaluate(() => window.__mathjong.S.handOrder === null || window.__mathjong.S.handOrder.length > 0), true);
      const def = await page.evaluate(() => {
        const g = window.__mathjong.S.game; const p = g.pending();
        const d = p && p.seat === 0 && p.type === 'turn' ? g.drawn : null;
        const rest = g.hands[0].filter((x) => x !== d).sort((a, b2) => g.typeOf(a) - g.typeOf(b2) || a - b2);
        return d === null ? rest : [...rest, d];
      });
      assert.deepEqual(await shownOrder(page), def, '新しい局では表示順を初期化');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (9) AI の進行中のドラッグ：dragging の間だけ AI を保留し、離したら1回だけ再開（手番が飛ばない）
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=fast');
    // 自分の打牌 → AI の手番へ
    const d = (await shownOrder(page))[8];
    await page.locator(`.hand .tile[data-id="${d}"]`).tap();
    await page.locator(`.hand .tile[data-id="${d}"]`).tap();
    const order = await shownOrder(page);
    const id = order[0];
    const b = await tileBox(page, id);
    let during = null;
    await touchDrag(page, cdp, id, b.x + b.width * 4, b.y + b.height / 2, {
      hold: 450, // 押している間（pressing）は AI は進む（fast = 250ms）。長押しの途中で AI が打っても開始できる
      before: async () => {
        const a = await page.evaluate(() => window.__mathjong.S.game.events.length);
        await page.waitForTimeout(1500); // dragging 中は AI を保留
        const z = await page.evaluate(() => ({ n: window.__mathjong.S.game.events.length, deferred: window.__mathjong.S.stepDeferred, timer: window.__mathjong.S.timer, phase: window.__mathjong.drag.phase() }));
        during = { a, ...z };
      },
    });
    assert.equal(during.phase, 'dragging');
    assert.equal(during.n, during.a, 'dragging 中はゲームが進まない');
    assert.equal(during.timer, null, '保留中に AI のタイマーは予約されていない');
    // 離した後に AI が再開し、手番どおりに進む
    await page.waitForFunction((n) => window.__mathjong.S.game.events.length > n, during.n, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const seq = await page.evaluate(() => {
      const ev = window.__mathjong.S.game.events;
      window.__mathjong.S.game.checkInvariants();
      // 打牌の次の「ツモ」は、チーがなければ打牌者の下家
      const bad = [];
      for (let i = 0; i < ev.length; i++) {
        if (ev[i].type !== 'discard') continue;
        const nxt = ev.slice(i + 1).find((e) => e.type === 'draw' || e.type === 'chi' || e.type === 'win');
        if (nxt && nxt.type === 'draw' && nxt.seat !== (ev[i].seat + 1) % 4) bad.push(i);
      }
      return bad;
    });
    assert.deepEqual(seq, [], '手番が飛ばない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (10) ドラッグで AI を待たせても、局の結果（打牌・和了・得点）は同じ（seed 固定）
  {
    async function playRound(withDrags) {
      const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=31&speed=fast');
      let drags = 0;
      for (let i = 0; i < 400; i++) {
        if (await page.locator('.overlay .result').count()) break;
        const p = await page.evaluate(() => { const q = window.__mathjong.S.game.pending(); return q && { seat: q.seat, type: q.type }; });
        if (!p) { await page.waitForTimeout(50); continue; }
        if (p.seat === 0 && p.type === 'claim') { await page.locator('button[data-action="pass"]').tap(); continue; }
        if (p.seat === 0 && p.type === 'turn') {
          if (await page.locator('button[data-action="tsumo"]').count()) { await page.locator('button[data-action="tsumo"]').tap(); continue; }
          const o = await shownOrder(page);
          const drawn = await page.evaluate(() => window.__mathjong.S.game.drawn);
          await page.locator(`.hand .tile[data-id="${drawn}"]`).tap();
          await page.locator(`.hand .tile[data-id="${drawn}"]`).tap();
          if (withDrags && drags < 4 && o.length > 1) {
            // 直後の AI の手番中に、長くドラッグして AI を待たせる
            const cur = await shownOrder(page);
            const b = await tileBox(page, cur[0]);
            await touchDrag(page, cdp, cur[0], b.x + b.width * 3, b.y + b.height / 2, { before: () => page.waitForTimeout(900) });
            drags++;
          }
          continue;
        }
        await page.waitForTimeout(40);
      }
      await page.waitForSelector('.overlay .result', { timeout: 30000 });
      const out = await page.evaluate(() => {
        const { S } = window.__mathjong;
        return { events: S.game.events.map((e) => [e.type, e.seat, e.tile ?? null, e.meld ?? null].join(':')), result: { ...S.game.result, analysis: undefined }, scores: S.scores };
      });
      assert.deepEqual(errors, []);
      await ctx.close();
      return { ...out, drags };
    }
    const a = await playRound(false);
    const bRun = await playRound(true);
    assert.ok(bRun.drags >= 1, 'AI の手番中にドラッグした');
    assert.deepEqual(bRun.events, a.events, '同じ seed なら打牌・ツモの列が同じ');
    assert.deepEqual(bRun.result, a.result);
    assert.deepEqual(bRun.scores, a.scores);
  }

  // (11) 320・375・390・430px の縦・横で並び替えでき、画面からはみ出さない
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [932, 430]]) {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow', { width: w, height: h });
    // 横画面では下端の操作バーが手牌に重なるので、利用者と同じくページの一番下までスクロールしてから操作する
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(50);
    const hitOk = await page.evaluate(() => {
      const t = document.querySelector('.hand .tile').getBoundingClientRect();
      return !!document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2).closest('.hand .tile');
    });
    assert.ok(hitOk, `${w}x${h}: スクロール後は手牌を押せる`);
    const o = await shownOrder(page);
    const exp = await dragToIndex(page, cdp, o[0], 8);
    assert.deepEqual(await shownOrder(page), exp, `${w}x${h}: 並び替え`);
    const fit = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - innerWidth,
      hand: Math.max(...[...document.querySelectorAll('.hand .tile')].map((t) => t.getBoundingClientRect().right)) - innerWidth,
      help: !!document.querySelector('.hand-help button[data-action="autosort"]'),
    }));
    assert.ok(fit.doc <= 0 && fit.hand <= 0, `${w}x${h}: はみ出し`);
    assert.ok(fit.help, '操作説明と自動整列');
    assert.equal((await engineState(page)).accepted, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.2-D：手牌の並び替え（移動・同じ牌・ツモ牌・誤打牌ゼロ・中止・AI保留・結果不変・320〜430px）');
}

// ---- Ver.0.2-D 監査対応（PR #4）：P1 短い移動の誤打牌、P2 マウス1回の移動でのドロップ ----
async function touchShortMove(page, cdp, id, dx, { cancel = false } = {}) {
  const b = await tileBox(page, id);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx / 2, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
  await page.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(60);
}
const clickCount = (page) => page.evaluate(() => window.__clicks);

async function handReorderAuditFixes(browser) {
  // P1：タッチで 8・9・12・16px 動かして離す（長押し前）→ 選択も打牌もされない
  const realClicks = [];
  for (const dx of [8, 9, 12, 16]) {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const A = order[2];
    const B = order[6];
    // 未選択の牌
    let c0 = await clickCount(page);
    await touchShortMove(page, cdp, A, dx);
    let st = await engineState(page);
    realClicks.push([dx, 'unselected', (await clickCount(page)) - c0]);
    assert.equal(st.selected, null, `${dx}px（未選択）：選択されない`);
    assert.equal(st.accepted, 0, `${dx}px（未選択）：打牌されない`);
    assert.deepEqual(await shownOrder(page), order, `${dx}px：並びは変わらない`);
    // 選択済みの牌
    await page.locator(`.hand .tile[data-id="${A}"]`).tap();
    assert.equal((await engineState(page)).selected, A);
    c0 = await clickCount(page);
    await touchShortMove(page, cdp, A, dx);
    st = await engineState(page);
    realClicks.push([dx, 'selected', (await clickCount(page)) - c0]);
    assert.equal(st.selected, A, `${dx}px（選択済み）：選択状態は変わらない`);
    assert.equal(st.accepted, 0, `${dx}px（選択済み）：打牌されない`);
    assert.equal(st.myDiscards, 0);
    // 無効になった操作の直後の新しい通常タップは機能する（別の牌を選択 → 2回目で打牌）
    await page.locator(`.hand .tile[data-id="${B}"]`).tap();
    assert.equal((await engineState(page)).selected, B, `${dx}px の後の通常タップで選択`);
    await page.locator(`.hand .tile[data-id="${B}"]`).tap();
    st = await engineState(page);
    assert.equal(st.accepted, 1, `${dx}px の後の2回タップで打牌`);
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 前提の確認：Chromium は 8px 以上動いても実際に click を送ることがある（＝アプリとブラウザの閾値の差を再現できている）
  assert.ok(realClicks.some(([, , n]) => n > 0), `ブラウザが click を送った移動量がない: ${JSON.stringify(realClicks)}`);

  // P1：pointercancel の後も正常操作に復帰。pointerId 不明の合成 click・別ポインター・キーボードの扱い
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const A = order[1];
    const B = order[4];
    await touchShortMove(page, cdp, A, 12, { cancel: true }); // touchcancel → pointercancel
    await page.locator(`.hand .tile[data-id="${B}"]`).tap();
    assert.equal((await engineState(page)).selected, B, 'pointercancel の後の通常タップで選択');
    await page.locator(`.hand .tile[data-id="${B}"]`).tap(); // 2回目は打牌
    let st = await engineState(page);
    assert.equal(st.accepted, 1, 'pointercancel の後の2回タップで打牌');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const C = (await shownOrder(page))[0];
    let st;
    const dispatch = (id, init) => page.evaluate(([i, it]) => {
      const el = document.querySelector(`.hand .tile[data-id="${i}"]`);
      const ev = it.pointerId !== undefined ? new PointerEvent('click', { bubbles: true, cancelable: true, ...it }) : new MouseEvent('click', { bubbles: true, cancelable: true, ...it });
      el.dispatchEvent(ev);
    }, [id, init]);
    // (a) 16px 動かした操作の後、pointerId 不明の合成 click（iOS 想定）→ 抑止
    await touchShortMove(page, cdp, C, 16);
    await dispatch(C, { detail: 1 });
    assert.equal((await engineState(page)).selected, null, 'pointerId 不明の合成 click は抑止');
    // (b) 無効になった操作の後でも、別のポインターの click は抑止しない
    await touchShortMove(page, cdp, C, 16);
    await dispatch(C, { detail: 1, pointerId: 99 });
    assert.equal((await engineState(page)).selected, C, '別のポインターの click は有効');
    await page.evaluate(() => { window.__mathjong.S.selected = null; window.__mathjong.render(); });
    // (c) キーボード由来（detail 0）の click も抑止しない
    await touchShortMove(page, cdp, C, 16);
    await dispatch(C, { detail: 0 });
    assert.equal((await engineState(page)).selected, C, 'キーボード由来の click は有効');
    st = await engineState(page);
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // P2：マウス。1回の mouse.move と6回の mouse.move で同じ結果。6px 未満は通常クリック。帯の外はキャンセル
  async function mouseDragOnce(steps) {
    const ctx = await newContext(browser, { viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=9&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    const order = await shownOrder(page);
    const first = await tileBox(page, order[0]);
    const last = await tileBox(page, order[8]);
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 8, first.y + first.height / 2, { steps });
    await page.mouse.up();
    await page.waitForTimeout(30);
    const result = await shownOrder(page);
    const st = await engineState(page);
    assert.equal(st.accepted, 0);
    assert.equal(st.selected, null);
    return { ctx, page, errors, order, result };
  }
  const one = await mouseDragOnce(1);
  assert.deepEqual(one.result, moveExpected(one.order, one.order[0], 8), '1回の mouse.move で先頭から末尾へ');
  const six = await mouseDragOnce(6);
  assert.deepEqual(six.result, one.result, '6回の mouse.move でも同じ結果');
  await six.ctx.close();
  {
    const { ctx, page, errors } = one;
    // ドラッグ直後の通常クリック
    const t = await tileBox(page, one.result[3]);
    await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    assert.equal((await engineState(page)).selected, one.result[3], 'ドラッグ直後の通常クリックで選択');
    // 6px 未満の移動は通常クリック（2回目で打牌）
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width / 2 + 4, t.y + t.height / 2, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    assert.equal((await engineState(page)).accepted, 1, '6px 未満の移動は通常クリック（2回目で打牌）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    // 帯の外で離す → キャンセル（1回の移動）
    const ctx = await newContext(browser, { viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=9&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    const order = await shownOrder(page);
    const b = await tileBox(page, order[2]);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 40, b.y - 220, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    assert.deepEqual(await shownOrder(page), order, '帯の外で離すとキャンセル');
    const st = await engineState(page);
    assert.equal(st.accepted, 0);
    assert.equal(st.selected, null);
    assert.equal(st.ghosts, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`✓ Ver.0.2-D 監査対応：短い移動（8/9/12/16px）で誤打牌なし・pointercancel 復帰・click の区別・マウス1回移動のドロップ（ブラウザの click: ${JSON.stringify(realClicks)}）`);
}

// ---- Ver.0.2-D 第2回監査対応：遅れて届く古い click（新P2）・pointercancel と後始末（新P3） ----
async function touchStartAt(cdp, x, y) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); }
async function touchEndAll(cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
async function trackPointerIds(page) {
  await page.evaluate(() => { window.__pids = []; window.addEventListener('pointerdown', (e) => window.__pids.push(e.pointerId), true); });
}
async function injectClick(page, id, init) {
  return page.evaluate(([i, it]) => {
    const el = document.querySelector(`.hand .tile[data-id="${i}"]`);
    const ev = it.pointerId !== undefined ? new PointerEvent('click', { bubbles: true, cancelable: true, ...it }) : new MouseEvent('click', { bubbles: true, cancelable: true, ...it });
    el.dispatchEvent(ev);
  }, [id, init]);
}

async function handReorderAudit2(browser) {
  // 新P2：無効操作 A（16px 移動）→ 新しい主ポインター B で同じ牌を押す → B を離す前に A 由来の古い click を注入
  for (const kind of ['pointerId', 'unknown']) {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    await trackPointerIds(page);
    const X = (await shownOrder(page))[3];
    await page.locator(`.hand .tile[data-id="${X}"]`).tap(); // X を選択（古い click が通ると打牌される状態）
    assert.equal((await engineState(page)).selected, X);
    await touchShortMove(page, cdp, X, 16); // 操作 A：タップとして無効
    const pidA = await page.evaluate(() => window.__pids[window.__pids.length - 1]);
    const bx = await tileBox(page, X);
    await touchStartAt(cdp, bx.x + bx.width / 2, bx.y + bx.height / 2); // 操作 B：押している最中
    await page.waitForTimeout(40);
    const pidB = await page.evaluate(() => window.__pids[window.__pids.length - 1]);
    assert.notEqual(pidA, pidB);
    await injectClick(page, X, kind === 'pointerId' ? { detail: 1, pointerId: pidA } : { detail: 1 });
    let st = await engineState(page);
    assert.equal(st.selected, X, `${kind}：古い click で選択が変わらない`);
    assert.equal(st.accepted, 0, `${kind}：古い click で打牌されない`);
    await touchEndAll(cdp); // B を正常に終了 → B 由来の click（実際の Chromium の click）は受理される＝選択済みの X を打牌
    await page.waitForTimeout(80);
    st = await engineState(page);
    assert.equal(st.accepted, 1, `${kind}：B 由来の click は受理（打牌）`);
    assert.equal(st.myDiscards, 1);
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // 新P3：移動前の touchCancel・ドラッグ開始後の touchCancel・期限・2本指の cancel・pointerup が届かない場合
  {
    const { ctx, page, cdp, errors } = await reorderPage(browser, '?seed=9&speed=slow');
    const order = await shownOrder(page);
    const guardArmed = () => page.evaluate(() => window.__mathjong.drag.guard.isArmed());
    // (a) 移動前に touchCancel → 押下中の取り消しとして無効化され、期限が始まり 1 秒後に解除
    const a = await tileBox(page, order[1]);
    await touchStartAt(cdp, a.x + a.width / 2, a.y + a.height / 2);
    await page.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(30);
    let st = await engineState(page);
    assert.equal(st.phase, 'idle');
    assert.equal(await guardArmed(), true, '移動前の cancel：抑止は有効（期限内）');
    await page.waitForTimeout(1100);
    assert.equal(await guardArmed(), false, '移動前の cancel：離した時点から1秒で解除（期限が始まっている）');
    await page.locator(`.hand .tile[data-id="${order[1]}"]`).tap();
    assert.equal((await engineState(page)).selected, order[1], 'cancel の後の通常タップ');
    await page.evaluate(() => { window.__mathjong.S.selected = null; window.__mathjong.render(); });
    // (b) ドラッグ開始後に touchCancel → 取り消し、AI の保留も解除
    const b = await tileBox(page, order[2]);
    await touchStartAt(cdp, b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(450);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + b.width * 2, y: b.y + b.height / 2 }] });
    await page.waitForTimeout(30);
    assert.equal((await engineState(page)).phase, 'dragging');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(50);
    st = await engineState(page);
    assert.equal(st.phase, 'idle');
    assert.equal(st.ghosts, 0);
    assert.deepEqual(await shownOrder(page), order, 'ドラッグ後の cancel は元の並び');
    assert.equal(await guardArmed(), true);
    await page.waitForTimeout(1100);
    assert.equal(await guardArmed(), false, 'ドラッグ後の cancel も期限で解除');
    // (c) 2本指で押して cancel → 選択・打牌なし、状態が残らない
    const t1 = await tileBox(page, order[0]);
    const t2 = await tileBox(page, order[5]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: t1.x + t1.width / 2, y: t1.y + t1.height / 2, id: 1 }, { x: t2.x + t2.width / 2, y: t2.y + t2.height / 2, id: 2 }] });
    await page.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(50);
    st = await engineState(page);
    assert.equal(st.phase, 'idle');
    assert.equal(st.selected, null);
    assert.equal(st.accepted, 0);
    // (d) pointerup が届かない操作（押下だけ）：次の正常なタップで後始末され、タップは有効
    await page.evaluate((id) => {
      const el = document.querySelector(`.hand .tile[data-id="${id}"]`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 901, isPrimary: true, pointerType: 'touch', clientX: r.left + 5, clientY: r.top + 5 }));
    }, order[3]);
    assert.equal((await engineState(page)).phase, 'pressing');
    await page.waitForTimeout(450); // 長押しが成立 → dragging（pointerup は来ない）
    assert.equal((await engineState(page)).phase, 'dragging');
    await page.locator(`.hand .tile[data-id="${order[6]}"]`).tap(); // 新しい主ポインター
    st = await engineState(page);
    assert.equal(st.phase, 'idle', 'pointerup が届かないドラッグは、次の押下で後始末');
    assert.equal(st.ghosts, 0);
    assert.equal(st.selected, order[6], '次のタップは有効');
    assert.equal(st.accepted, 0);
    assert.equal(await page.evaluate(() => window.__mathjong.S.stepDeferred), false);
    // (e) DOM 再生成の後も不整合がない
    await page.evaluate(() => window.__mathjong.render());
    await page.locator(`.hand .tile[data-id="${order[6]}"]`).tap();
    st = await engineState(page);
    assert.equal(st.accepted, 1, '再描画の後の2回目のタップで打牌');
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.2-D 第2回監査対応：遅れた古い click（pointerId あり・なし）を抑止し新しいタップは受理・cancel の期限・2本指・pointerup 欠落・再描画');
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
  browser = await chromium.launch({ args: ['--no-proxy-server'], ...(CHANNEL ? { channel: CHANNEL } : {}) });
  console.log(`ブラウザ：${CHANNEL ? `channel=${CHANNEL}` : 'headless shell（既定）'} ${browser.version()}`);
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
  await v02aFeatures(browser);
  await v02aAuditFixes(browser);
  await guideFitsScreen(browser);
  await handReorder(browser);
  await handReorderAuditFixes(browser);
  await handReorderAudit2(browser);
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
