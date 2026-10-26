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

async function playDevice(browser, dev, seed, rounds, stats, { autopass = false, mode = 'legacy' } = {}) {
  const ctx = await newContext(browser, { viewport: dev.viewport, isMobile: dev.isMobile, hasTouch: dev.hasTouch, deviceScaleFactor: 2 });
  // Ver.0.2-B：チーのオートパス ON で通しプレイ（チーのみの宣言は画面に出ない）
  if (autopass) await ctx.addInitScript(() => { try { localStorage.setItem('mj-chi-autopass', '1'); } catch { /* */ } });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?${mode === 'legacy' ? 'rules=legacy' : `mode=${mode}`}&seed=${seed}&speed=test&len=8`); // 8局戦（最大6局を続けて遊ぶため）
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
      // Ver.0.3：ポン（偶数局はポンする、奇数局は見送る）。ポン後は公開刻子と手牌枚数を確認
      const pon = page.locator('button[data-action="pon"]');
      if (await pon.count()) {
        if (r % 2 === 0) {
          const before = await page.evaluate(() => window.__mathjong.S.game.hands[0].length);
          await tap(pon);
          await page.waitForTimeout(30);
          const st = await page.evaluate(() => {
            const g = window.__mathjong.S.game;
            const m = g.melds[0][g.melds[0].length - 1];
            return { hand: g.hands[0].length, phase: g.phase, cur: g.current, call: m && m.call, kind: m && m.kind };
          });
          if (st.phase === 'turn' && st.cur === 0 && st.call === 'pon') {
            assert.equal(st.hand, before - 2, 'ポン後の手牌枚数');
            assert.equal(st.kind, 'koutsu');
            stats.pon = (stats.pon || 0) + 1;
          }
        } else {
          stats.ponPassed = (stats.ponPassed || 0) + 1;
          await tap(pass);
        }
        continue;
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
  if (autopass) {
    const ap = await page.evaluate(() => ({ ...window.__mathjong.S.autoPass, on: window.__mathjong.S.chiAutoPass }));
    assert.ok(ap.on && ap.failed === 0, `${dev.name}: オートパス ${JSON.stringify(ap)}`);
    stats.autoPassed = (stats.autoPassed || 0) + ap.count;
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
  await page.goto(`${LOCAL}?rules=legacy&seed=1&speed=test`);
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
    await page.goto(`${LOCAL}?rules=legacy&seed=77&speed=slow`);
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
    await page.goto(`${LOCAL}?rules=legacy&seed=78&speed=slow`);
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
  assert.match(await page.locator('.top .info').innerText(), /東3局/);
  // 不正な値は無視される（エラーにならない）。seed が不正なら再現 URL ではないのでタイトル画面から（Ver.0.4-A）
  await page.goto(`${PUBLIC}?seed=abc&round=-1&speed=%3Cscript%3E&len=9&hand=-2&dealer=7`);
  await page.waitForSelector('.title-screen');
  await page.locator('button[data-action="start-match"]').tap();
  await page.waitForSelector('.hand .tile');
  assert.match(await page.locator('.top .info').innerText(), /東1局/);
  // seed が正しくても、ほかの値が不正なら別の局面として黙って始めない（エラー画面）。Ver.0.4-A の最終修正
  await page.goto(`${PUBLIC}?seed=77&round=-1&len=9&hand=-2&dealer=7&renchan=abc`);
  await page.waitForSelector('.replay-error');
  assert.match(await page.locator('.re-title').innerText(), /再現URLの局状態が不正です/);
  assert.equal(await page.locator('.hand .tile').count(), 0, '対局は始めない');
  // /mathjong（末尾スラッシュなし）でも開ける（301 → /mathjong/）。
  // route で返したリダイレクト先はブラウザが再度横取りしないため、ホスト名に依存しない localhost で確認する。
  // （リダイレクト応答そのものは tests/serve.test.js で検査）
  await page.goto(`http://localhost:${PORT}${BASE.slice(0, -1)}`);
  assert.equal(new URL(page.url()).pathname, BASE);
  await page.waitForSelector('.title-screen'); // ?seed= のない URL はタイトル画面（Ver.0.4-A）
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
  await page.goto(`${LOCAL}?rules=legacy&seed=321&speed=slow`);
  await page.waitForSelector('.hand .tile');
  const viaNext = await page.evaluate(() => {
    const m = window.__mathjong;
    m.goRound(3, 2); // 通し第3局・親は対面（Ver.0.4-A：試合の状態も合わせる）
    return { wall: m.S.game.wall.slice(), hands: m.S.game.hands.map((h) => h.slice()), dealer: m.S.game.dealer };
  });
  await page.goto(`${LOCAL}?rules=legacy&seed=321&round=3&speed=slow`);
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
  await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=slow`);
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
  assert.match(await page.locator('.hint-basic').innerText(), /完成している数式：\d+通り.*あと1枚で完成する組み合わせ：\d+通り/s); // Ver.0.3-B の表記

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
    await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=fast`);
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
    await page.goto(`${LOCAL}?rules=legacy&seed=1&speed=slow`);
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
    await page.goto(`${LOCAL}?rules=legacy&seed=12&speed=slow`);
    await page.waitForSelector('.hand .tile.tap');
    const btn = await page.locator('button[data-action="hint"]').boundingBox();
    for (let i = 0; i < 7; i++) await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
    const st = await hintMatchesEngine(page);
    assert.ok(st.open, '7回押すと開いた状態');
    assert.equal(st.used, 1, '同じ手牌の状態では開閉を繰り返しても1回（Ver.0.3-B）');
    assert.deepEqual(st.shown, st.exp);
    // 事前計算の途中で局切替を20回
    const state = await page.evaluate(async (base) => {
      const { warmUpState } = await import(`${base}src/engine/yakuhint.js`);
      const { S, startRound, rules } = window.__mathjong;
      const before = warmUpState(rules);
      for (let i = 0; i < 20; i++) window.__mathjong.goRound(S.round + 1, (S.dealer + 1) % 4);
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
  // Ver.0.3：数学Ⅱ（既定・弧度法・33種）と数学Ⅰ（度数法・25種）の両方
  for (const [w, h] of sizes) {
    for (const [emulateWebKit, mode] of [[false, 'math2'], [true, 'math2'], [false, 'math1'], [true, 'math1']]) {
      const ctx = await newContext(browser, { viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(`${PUBLIC}?seed=9${mode === 'math1' ? '&mode=math1' : ''}`);
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
        const where = `${w}x${h} ${mode} ${emulateWebKit ? 'WebKit想定' : '通常'} ${tab}`;
        assert.ok(o.sw <= o.cw, `${where}: モーダルが横スクロールする（${o.sw} > ${o.cw}）`);
        assert.ok(o.doc <= 0, `${where}: ページが横スクロールする`);
        assert.ok(o.mr <= w + 0.5, `${where}: モーダルが画面外`);
      }
      // 牌一覧：数学Ⅱ 33種／数学Ⅰ 25種 ×4サイズが、縦スクロールで1枚ずつ全体を表示でき、左右に切れない
      const n = await page.locator('.gallery .tile').count();
      assert.equal(n, (mode === 'math1' ? 25 : 33) * 4);
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
  console.log('✓ 牌一覧：320〜430px（縦・横）・WebKit想定でも数学Ⅱ132枚・数学Ⅰ100枚すべて画面内に表示');
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
  await page.goto(`${LOCAL}?rules=legacy&${query.slice(1)}`); // 旧規則の局面（互換）
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
    await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=slow`);
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
      // アプリ切替：Chromium では実際に非表示にできないため、visibilityState を hidden にして実際のイベントを送る
      ['アプリ切替', () => page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      })],
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
        before: () => page.evaluate(() => { const m = window.__mathjong; m.goRound(m.S.round + 1, (m.S.dealer + 1) % 4); }),
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
    await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=slow`);
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
    await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=slow`);
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

// ---- Ver.0.2-D P2-2：pointerup がドラッグ処理に届かなかった後の新しいマウス操作（同じ／異なる pointerId） ----
// pointerup を「ドラッグ処理に届かない」状態にする：window の捕捉段階で1回だけ伝播を止める
// （click 抑止の記録はそれより先に登録された捕捉リスナーで行われるので、release は記録される）。
async function blockNextPointerUp(page) {
  await page.evaluate(() => {
    window.__blockUp = true;
    window.addEventListener('pointerup', (e) => { if (window.__blockUp) { window.__blockUp = false; window.__blockedUp = (window.__blockedUp || 0) + 1; e.stopImmediatePropagation(); } }, true);
  });
}
const dragState = (page) => page.evaluate(() => {
  const { S, drag } = window.__mathjong;
  S.game.checkInvariants();
  return {
    phase: drag.phase(), ghosts: document.querySelectorAll('.drag-ghost').length, markers: document.querySelectorAll('.drop-marker').length,
    deferred: !!S.stepDeferred, timer: S.timer !== null && S.timer !== undefined, events: S.game.events.length,
    appClicks: window.__appClicks || 0, selected: S.selected, accepted: S.input.accepted, failed: S.input.failed,
  };
});

async function handReorderP22(browser) {
  for (const variant of ['same-pointerId (mouse→mouse)', 'different-pointerId (touch→mouse)']) {
    const ctx = await newContext(browser, { viewport: { width: 1366, height: 768 }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?rules=legacy&seed=9&speed=fast`);
    await page.waitForSelector('.hand .tile.tap');
    // アプリが受理した click（捕捉段階の抑止を通過したもの）を数える
    await page.evaluate(() => { window.__appClicks = 0; document.getElementById('app').addEventListener('click', () => { window.__appClicks++; }); });
    // 自分の打牌 → AI の手番
    const drawn = await page.evaluate(() => window.__mathjong.S.game.drawn);
    const db = await tileBox(page, drawn);
    await page.mouse.click(db.x + db.width / 2, db.y + db.height / 2);
    await page.mouse.click(db.x + db.width / 2, db.y + db.height / 2);
    assert.equal((await dragState(page)).accepted, 1);
    // 1. AI の手番中にドラッグを開始し、2. AI の保留を成立させる
    const order = await shownOrder(page);
    const b = await tileBox(page, order[2]);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    let cdp = null;
    if (variant.startsWith('same')) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 40, cy, { steps: 1 });
    } else {
      cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
      await page.waitForTimeout(450);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 40, y: cy }] });
    }
    await page.waitForTimeout(700); // fast = 250ms：保留中に AI のタイマーが来て stepDeferred になる
    let st = await dragState(page);
    assert.equal(st.phase, 'dragging', `${variant}：ドラッグ中`);
    assert.equal(st.deferred, true, `${variant}：AI の保留が成立`);
    const eventsHeld = st.events;
    // 3. pointerup がドラッグ処理に届かない
    await blockNextPointerUp(page);
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
    await page.waitForTimeout(100);
    st = await dragState(page);
    assert.equal(await page.evaluate(() => window.__blockedUp), 1, `${variant}：pointerup がドラッグ処理に届かない状態を再現`);
    assert.equal(st.phase, 'dragging', `${variant}：（再現）ドラッグ状態が残る`);
    assert.equal(st.ghosts, 1);
    assert.equal(st.events, eventsHeld, `${variant}：（再現）AI は止まったまま`);
    // 4. 新しいマウス操作（マウスの pointerId は常に同じ）
    const c0 = st.appClicks;
    const t = await tileBox(page, order[5]);
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    st = await dragState(page);
    assert.equal(st.ghosts, 0, `${variant}：浮いた牌が消える`);
    assert.equal(st.markers, 0, `${variant}：挿入位置の線が消える`);
    assert.notEqual(st.phase, 'dragging', `${variant}：古いドラッグは終了`);
    await page.mouse.up();
    await page.waitForTimeout(30);
    // 5. 状態の確認
    st = await dragState(page);
    assert.equal(st.phase, 'idle', `${variant}：idle に復帰`);
    assert.equal(st.deferred, false, `${variant}：AI の保留が解除`);
    assert.equal(st.appClicks, c0 + 1, `${variant}：新しいクリックは受理（抑止されない）`);
    await page.waitForFunction((n) => window.__mathjong.S.game.events.length > n, eventsHeld, { timeout: 5000 });
    // AI が正常に進み、自分の手番が来る（手番が飛ばず、タイマーが二重にならない）。途中の宣言（チー・ロン）は見送る
    for (let i = 0; i < 60; i++) {
      await page.waitForSelector('.hand .tile.tap, button[data-action="pass"], .overlay .result', { timeout: 15000 });
      if (await page.locator('.hand .tile.tap').count()) break;
      if (await page.locator('.overlay .result').count()) throw new Error(`${variant}：自分の手番の前に終局（seed を変更して再検討）`);
      await page.locator('button[data-action="pass"]').click();
    }
    await page.waitForSelector('.hand .tile.tap');
    const seq = await page.evaluate(() => {
      const ev = window.__mathjong.S.game.events;
      const bad = [];
      for (let i = 0; i < ev.length; i++) {
        if (ev[i].type !== 'discard') continue;
        const nxt = ev.slice(i + 1).find((e) => e.type === 'draw' || e.type === 'chi' || e.type === 'win');
        if (nxt && nxt.type === 'draw' && nxt.seat !== (ev[i].seat + 1) % 4) bad.push(i);
      }
      return bad;
    });
    assert.deepEqual(seq, [], `${variant}：手番が飛ばない`);
    // 自分の手番で、通常のクリック（選択 → 打牌）とドラッグが成立
    const o2 = await shownOrder(page);
    const u = await tileBox(page, o2[1]);
    await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
    assert.equal((await dragState(page)).selected, o2[1], `${variant}：自分の手番の通常クリックで選択`);
    const last = await tileBox(page, o2[o2.length - 1]);
    const f = await tileBox(page, o2[0]);
    await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 8, f.y + f.height / 2, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    assert.deepEqual(await shownOrder(page), moveExpected(o2, o2[0], o2.length - 1), `${variant}：次のドラッグも成立`);
    st = await dragState(page);
    assert.equal(st.phase, 'idle');
    assert.equal(st.ghosts, 0);
    assert.equal(st.failed, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.2-D P2-2：pointerup が届かなかったドラッグを、同じ／異なる pointerId の新しいマウス操作で後始末（浮いた牌・線・AI 保留を解除、クリック受理）');
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
    await page.goto(`${LOCAL}?rules=legacy&seed=${fx.seed}&speed=fast`); // 旧規則での固定 seed（互換）
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

// ---- Ver.0.2-B：チーのオートパス ----
// 自分（親）の上家 = seat 3 は値の牌だけを持ち（面子を作れない）、何を捨てても自分がチーできる。
// 他家の打牌はテストから実行し（AI の判断に依存しない）、AI と同じく打牌の直後に step() を呼ぶ。
const AP_CHI_ONLY = ['sin', '30', 'tan', '45', 'cos', '180', '0', '270']; // 値の牌がないのでロンはできない
const AP_RON_CHI = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '30']; // 1/2 でロン（sin 30° のチーも可能）
const AP_SEAT3 = ['=1/2', '=1/2', '=1', '=1', '=-1', '=-1', '=0', '=0'];
const AP_JUNK1 = ['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'];
const AP_JUNK2 = ['cos', 'cos', 'cos', '180', '270', '270', '=√3', '=√3'];
function apWall(myHand, { seat1Draws = null, seat1Hand = null, seat3Draws = null } = {}) {
  const mine = ['120', '135', '150', '210'];
  const s1 = seat1Draws || ['=-1/√3', '=-1/√3', '=-1/√3', '=-1/√3'];
  const s3 = seat3Draws || ['=1/2', '=0', '=1/2', '=0'];
  const draws = [];
  for (let i = 0; i < 4; i++) draws.push(mine[i], s1[i], '=-√3/2', s3[i]);
  return presetWall(myHand, draws, [seat1Hand || AP_JUNK1, AP_JUNK2, AP_SEAT3]);
}
async function apPage(browser, { viewport = { width: 390, height: 844 }, init = null, query = '?seed=1&speed=slow' } = {}) {
  const ctx = await newContext(browser, { viewport, isMobile: true, hasTouch: true });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?rules=legacy&${query.slice(1)}`); // 旧規則の局面（互換）
  await page.waitForSelector('.hand .tile');
  return { ctx, page, errors };
}
async function apScene(page, wall) {
  await page.evaluate((w) => {
    const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound();
    // 宣言ボタンの描画を記録（同じ処理の中で消えたものも数える）
    window.__chiSeen = 0;
    if (!window.__chiObs) {
      window.__chiObs = new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.matches('button[data-action="chi"]') || n.querySelector('button[data-action="chi"]'))) window.__chiSeen++;
        }
      });
      window.__chiObs.observe(document.getElementById('app'), { childList: true, subtree: true });
    }
  }, wall);
  await page.waitForSelector('.hand .tile.tap');
}
const apState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const g = S.game;
  g.checkInvariants();
  const p = g.pending();
  const pass = document.querySelector('button[data-action="pass"]');
  return {
    count: S.autoPass.count, failed: S.autoPass.failed, accepted: S.input.accepted, on: S.chiAutoPass,
    p: p && { seat: p.seat, type: p.type, ron: p.ron ?? null, chi: p.chi ? p.chi.length : null },
    melds0: g.melds[0].length, events: g.events.length, modal: S.modal, timer: S.timer !== null, ended: !p,
    status: (document.querySelector('.bar .actions .status') || {}).textContent?.trim() || '',
    chiBtn: document.querySelectorAll('.bar button[data-action="chi"]').length,
    ronBtn: document.querySelectorAll('.bar button[data-action="ron"]').length,
    passText: pass ? pass.textContent.trim() : null, note: document.querySelectorAll('.bar .pass-note').length,
    chiSeen: window.__chiSeen || 0, seat3Discards: g.events.filter((e) => e.type === 'discard' && e.seat === 3).length,
    stored: (() => { try { return localStorage.getItem('mj-chi-autopass'); } catch { return 'ERR'; } })(),
  };
});
async function apForce(page, seat, key = null) {
  await page.waitForFunction((s) => { const p = window.__mathjong.S.game.pending(); return p && p.seat === s && p.type === 'turn'; }, seat, { timeout: 5000 });
  await page.evaluate(([s, k]) => {
    const { S, rules, step } = window.__mathjong;
    const g = S.game;
    clearTimeout(S.timer); S.timer = null;
    const id = k === null ? g.drawn : g.hands[s].find((x) => rules.types[g.typeOf(x)].key === k);
    if (id === undefined || id === null) throw new Error(`seat ${s} has no ${k}`);
    g.discard(s, id);
    step(true); // AI のタイマーと同じ（打牌 → step）
  }, [seat, key]);
}
async function apDiscardDrawn(page) {
  await page.waitForSelector('.hand .tile.tap.drawn');
  const t = page.locator('.hand .tile.tap.drawn');
  if (!(await t.evaluate((e) => e.classList.contains('selected')))) await t.tap(); // 1回目で選択、2回目で打牌
  await t.tap();
  await page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return !p || p.seat !== 0; });
}
// 自分の打牌 → 下家・対面の打牌（ツモ牌）まで進め、上家の手番にする
async function apToSeat3(page) {
  await apDiscardDrawn(page);
  await apForce(page, 1);
  await apForce(page, 2);
}
// Ver.0.5-A：チー・ポンの自動パスは対戦画面（手牌の下）の切替ボタン。設定画面から移動した。
const apToggle = (page, kind = 'chi') => page.locator(`.hand-help button[data-action="toggle-${kind}-autopass"]`);
const apToggleOn = async (page, kind = 'chi') => (await apToggle(page, kind).getAttribute('aria-pressed')) === 'true';
async function apSetting(page, on) {
  // 設定画面などが開いていれば閉じてから、対戦画面のボタンを押す
  if (await page.locator('.overlay .modal-actions button[data-action="close"]').count()) await page.locator('.overlay .modal-actions button[data-action="close"]').tap();
  if ((await apToggleOn(page)) !== on) await apToggle(page).tap();
  assert.equal(await apToggleOn(page), on);
  assert.equal(await page.evaluate(() => window.__mathjong.S.chiAutoPass), on);
}
async function apHint(page) {
  return page.evaluate(async (base) => {
    const { yakuCandidates, claimForSeat } = await import(`${base}src/engine/yakuhint.js`);
    const { claimPendingForHint } = await import(`${base}src/ui/autopass.js`);
    const { S, rules } = window.__mathjong;
    const g = S.game;
    const p = g.pending();
    const typeOf = (id) => g.typeOf(id);
    const fmt = (c) => `${c.name}|${c.missing === 0 ? '完成！' : `あと${c.missing}枚`}`;
    const filtered = yakuCandidates(rules, g.viewFor(0), { claim: claimForSeat(claimPendingForHint(p, true), 0, typeOf) });
    const all = yakuCandidates(rules, g.viewFor(0), { claim: claimForSeat(p, 0, typeOf) });
    const shown = [...document.querySelectorAll('.yaku-cands li')].map((li) => `${li.querySelector('b').textContent}|${li.querySelector('.yc-miss').textContent}`);
    return { shown, filtered: filtered.map(fmt), all: all.map(fmt), filteredVia: filtered.map((c) => c.via), allVia: all.map((c) => c.via), used: S.hintsUsed };
  }, BASE);
}
const NOTICE = 'チーを自動で見送りました';
const evList = (page) => page.evaluate(() => window.__mathjong.S.game.events.map((e) => `${e.type}:${e.seat}:${e.tile ?? ''}`));

async function chiAutoPass(browser) {
  // (1) 初期 OFF：保存値なし → スイッチ OFF、チーのみの宣言は従来どおり表示され、チーできる
  {
    const { ctx, page, errors } = await apPage(browser);
    let st = await apState(page);
    assert.equal(st.on, false, '初期値 OFF');
    assert.equal(st.stored, null);
    assert.equal(await apToggleOn(page), false, '対戦画面のボタンも OFF');
    assert.match(await apToggle(page).innerText(), /チー自動\s*OFF/);
    await page.locator('button[data-action="settings"]').tap();
    // Ver.0.5-A：設定画面には切替の場所と安全仕様の説明だけ（二重管理しない）
    assert.equal(await page.locator('.modal input[type="checkbox"]').count(), 0, '設定画面にスイッチはない');
    assert.match(await page.locator('.setting-note').innerText(), /対戦画面の手牌の下のボタンで切り替えます/);
    assert.match(await page.locator('.setting-note').innerText(), /チー・ポンをそれぞれ自動で見送ります。ロン・ツモは自動で見送りません。/);
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await apScene(page, apWall(AP_CHI_ONLY));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    st = await apState(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 1 });
    assert.equal(st.chiBtn, 1, 'OFF：チーを表示');
    assert.ok(st.chiSeen >= 1, '（検査の前提）チーのボタンの描画を記録できている');
    assert.equal(st.passText, '見送る');
    assert.equal(st.count, 0);
    await page.locator('button[data-action="chi"]').tap();
    st = await apState(page);
    assert.equal(st.melds0, 1, 'チーが成立');
    assert.deepEqual(st.p, { seat: 0, type: 'turn', ron: null, chi: null });
    assert.match(st.status, /チー後/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (2) ON・チーのみ：宣言ボタンを一度も描画せず自動パス。手動操作の数は増えない。通知は次の自分の手番だけ。
  //     連続するチー機会（3回）は各1回ずつ。OFF＋手動の見送りと同じ局の記録になる。
  let manualEvents;
  {
    const { ctx, page, errors } = await apPage(browser);
    await apScene(page, apWall(AP_CHI_ONLY));
    const normalStatus = (await apState(page)).status;
    assert.ok(!normalStatus.includes(NOTICE), '自動パス前の手番に通知はない');
    for (const key of ['v:1/2', 'v:1', 'v:-1']) {
      await apToSeat3(page);
      await apForce(page, 3, key);
      await page.locator('button[data-action="pass"]').tap();
    }
    manualEvents = await evList(page);
    assert.equal((await apState(page)).count, 0);
    await ctx.close();
    assert.deepEqual(errors, []);
  }
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY));
    const before = await apState(page);
    const barNormal = (await page.locator('.bar').boundingBox()).height;
    for (const [i, key] of ['v:1/2', 'v:1', 'v:-1'].entries()) {
      await apToSeat3(page);
      const acc = (await apState(page)).accepted;
      await apForce(page, 3, key);
      const st = await apState(page);
      assert.equal(st.count, i + 1, `${i + 1}回目の自動パス`);
      assert.equal(st.chiSeen, 0, 'チーのボタンは一度も描画されない');
      assert.equal(st.accepted, acc, '手動操作の数（S.input.accepted）は増えない');
      assert.deepEqual(st.p, { seat: 0, type: 'turn', ron: null, chi: null }, '自分のツモ番まで進む');
      assert.equal(st.melds0, 0);
      assert.equal(st.status, NOTICE, '次の自分の手番に通知');
      assert.equal(st.timer, false, 'AI のタイマーは残らない');
      assert.ok(Math.abs((await page.locator('.bar').boundingBox()).height - barNormal) < 1, '通知で操作バーの高さは変わらない');
      // 同じ手番の再描画（牌の選択）では通知は1件のまま
      await page.locator('.hand .tile.tap.drawn').tap();
      assert.equal(await page.locator('.bar .actions .status', { hasText: NOTICE }).count(), 1);
    }
    const st = await apState(page);
    assert.equal(st.failed, 0);
    assert.equal(before.count, 0);
    // OFF＋手動の見送りと同じ局の記録（3回分）
    assert.deepEqual(await evList(page), manualEvents, 'ON の自動パスと OFF の手動見送りで局の記録が一致');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) ON・ロン＋チー：ロンと「ロンしない（チーも見送ります）」のみ。自動パスしない。ロンできる。
  //     役候補ヒントは、表示している選択肢（チーなし）と一致する。
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_RON_CHI));
    await page.locator('button[data-action="hint"]').tap();
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    const st = await apState(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: true, chi: 1 });
    assert.equal(st.count, 0, 'ロン可能なら自動パスしない');
    assert.equal(st.ronBtn, 1);
    assert.equal(st.chiBtn, 0, 'チーは表示しない');
    assert.equal(st.passText, 'ロンしないチーも見送ります');
    assert.equal(st.note, 1);
    const h = await apHint(page);
    assert.deepEqual(h.shown, h.filtered, 'ヒントは表示中の選択肢（ロン・見送り）と一致');
    assert.ok(!h.filteredVia.includes('chi'), 'チー後の役候補を出さない');
    assert.ok(h.allVia.includes('chi'), '（比較）チーを含めると、チー後の役候補が出る局面である');
    assert.equal(h.used, 1);
    await page.locator('button[data-action="ron"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.match(await page.locator('.overlay .result').innerText(), /あなた の和了 ロン/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (3b) 同じ局面で「ロンしない」：チーも見送られ、自分のツモ番。自動パスではないので通知は出ない。
  //      OFF なら従来どおりロン・チー・ロンしないを表示し、ヒントはチーの経路も含む。
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_RON_CHI));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    await page.locator('button[data-action="pass"]').tap();
    let st = await apState(page);
    assert.equal(st.melds0, 0, 'チーも見送った');
    assert.deepEqual(st.p, { seat: 0, type: 'turn', ron: null, chi: null });
    assert.equal(st.count, 0);
    assert.ok(!st.status.includes(NOTICE));
    await apSetting(page, false);
    await page.locator('button[data-action="hint"]').tap();
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    st = await apState(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: true, chi: 1 });
    assert.equal(st.chiBtn, 1, 'OFF：チーを表示');
    assert.equal(st.passText, 'ロンしない');
    const h = await apHint(page);
    assert.deepEqual(h.shown, h.all, 'OFF：ヒントはチーの経路も含む（従来どおり）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (4) ON・ロンのみ（下家の打牌）：ロン・ロンしないを表示し、自動パスしない
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_RON_CHI, { seat1Draws: ['=1/2', '=-1/√3', '=-1/√3', '=-1/√3'], seat3Draws: ['=0', '=0', '=-1/2', '=-1/2'] }));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1/2');
    const st = await apState(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: true, chi: 0 });
    assert.equal(st.count, 0);
    assert.equal(st.ronBtn, 1);
    assert.equal(st.chiBtn, 0);
    assert.equal(st.passText, 'ロンしない');
    assert.equal(st.note, 0, 'チーの候補がないので注記なし');
    await page.locator('button[data-action="ron"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (5) ON・ツモ可能：ツモは自動で見送らない
  {
    const { ctx, page, errors } = await apPage(browser, { init: { fn: () => { try { localStorage.setItem('mj-chi-autopass', '1'); } catch { /* */ } } } });
    await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); },
      presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['=1']));
    await page.locator('button[data-action="tsumo"]').waitFor({ timeout: 5000 });
    const st = await apState(page);
    assert.equal(st.on, true);
    assert.equal(st.count, 0);
    assert.deepEqual(st.p, { seat: 0, type: 'turn', ron: null, chi: null });
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.match(await page.locator('.overlay .result').innerText(), /あなた の和了 ツモ/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (6) 宣言の表示中に設定を変えても、表示中の選択肢・ヒントは変わらない（次の宣言から反映）
  {
    const { ctx, page, errors } = await apPage(browser);
    await apScene(page, apWall(AP_CHI_ONLY));
    await page.locator('button[data-action="hint"]').tap();
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    const hintBefore = await apHint(page);
    await apSetting(page, true); // OFF → ON（チーのみの宣言を表示中）
    let st = await apState(page);
    assert.equal(st.count, 0, '表示中の宣言は自動パスしない');
    assert.equal(st.chiBtn, 1, '表示中のチーは消えない');
    assert.equal(st.stored, '1');
    assert.deepEqual((await apHint(page)).shown, hintBefore.shown, 'ヒントも変わらない');
    await page.locator('button[data-action="pass"]').tap();
    st = await apState(page);
    assert.equal(st.chiBtn, 0);
    assert.ok(!st.status.includes(NOTICE), '手動の見送りでは通知を出さない');
    const seen = st.chiSeen;
    await apToSeat3(page);
    await apForce(page, 3, 'v:1');
    st = await apState(page);
    assert.equal(st.count, 1, '次の宣言から自動パス');
    assert.equal(st.chiSeen, seen, '次の宣言ではチーのボタンを描画しない');
    // ON → OFF：次の宣言は通常の表示
    await apSetting(page, false);
    assert.equal((await apState(page)).stored, '0');
    await apToSeat3(page);
    await apForce(page, 3, 'v:-1');
    st = await apState(page);
    assert.equal(st.count, 1);
    assert.ok(st.chiBtn >= 1 && st.chiBtn === st.p.chi, 'OFF に戻した後の宣言は通常の表示（チーの候補すべて）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (6b) ON でロン＋チーを表示中に OFF：表示中の選択肢は変えない（チーは出さないまま）
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_RON_CHI));
    await page.locator('button[data-action="hint"]').tap();
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    await apSetting(page, false);
    const st = await apState(page);
    assert.equal(st.chiBtn, 0, '表示中の宣言の選択肢は変えない');
    assert.equal(st.note, 1);
    const h = await apHint(page);
    assert.deepEqual(h.shown, h.filtered, 'ヒントは固定された選択肢と一致');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (7) モーダル表示中に裏で宣言待ちが発生：ON なら自動パス（モーダルは閉じない）、OFF なら宣言ボタンを裏に表示
  for (const on of [true, false]) {
    const { ctx, page, errors } = await apPage(browser);
    if (on) await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY));
    await apToSeat3(page);
    await page.locator('button[data-action="settings"]').tap();
    await apForce(page, 3, 'v:1/2');
    const st = await apState(page);
    assert.equal(st.modal, 'settings', 'モーダルは開いたまま');
    assert.equal(await page.evaluate(() => window.__mathjong.S.chiAutoPass), on);
    if (on) {
      assert.equal(st.count, 1);
      assert.deepEqual(st.p, { seat: 0, type: 'turn', ron: null, chi: null });
      await page.locator('.modal-actions button[data-action="close"]').tap();
      assert.equal((await apState(page)).status, NOTICE);
    } else {
      assert.equal(st.count, 0);
      assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 1 });
      assert.equal(st.chiBtn, 1);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (8) 自動パスの直後に他家がロンして終局：通知を持ち越さない（次の局の最初の手番に出ない）
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY, { seat1Hand: AP_RON_CHI }));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    await page.waitForSelector('.overlay .result', { timeout: 8000 }); // 下家（AI）のロン
    let st = await apState(page);
    assert.equal(st.count, 1);
    assert.equal(st.ended, true);
    const res = await page.evaluate(() => window.__mathjong.S.game.result);
    assert.deepEqual([res.winner, res.how], [1, 'ron'], '自動パス後も後続のロンが優先される');
    assert.equal(await page.evaluate(() => window.__mathjong.S.autoPass.noticePending), false);
    await page.locator('button[data-action="next"]').tap();
    await page.waitForFunction(() => window.__mathjong.S.round === 2);
    for (let i = 0; i < 40; i++) {
      st = await apState(page);
      if (st.p && st.p.seat === 0 && st.p.type === 'turn') break;
      await page.waitForTimeout(200);
    }
    assert.ok(!st.status.includes(NOTICE), '次の局に通知を持ち越さない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (9) 保存・復元：ON → 再読み込みで ON（局の切替でも維持）、OFF → 再読み込みで OFF
  {
    const { ctx, page, errors } = await apPage(browser);
    await apSetting(page, true);
    assert.equal((await apState(page)).stored, '1');
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal((await apState(page)).on, true, '再読み込み後も ON');
    assert.equal(await apToggleOn(page), true, '対戦画面のボタンも ON');
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="reset"]').tap();
    assert.equal((await apState(page)).on, true, '新しい対局でも ON');
    // 再読み込み後に実際に自動パスする
    await apScene(page, apWall(AP_CHI_ONLY));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    assert.equal((await apState(page)).count, 1);
    await apSetting(page, false);
    await page.reload();
    await page.waitForSelector('.hand .tile');
    const st = await apState(page);
    assert.equal(st.on, false, '再読み込み後も OFF');
    assert.equal(st.stored, '0');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (10) 保存値の異常・保存不可：OFF で起動。保存できない環境でも、その場の ON は有効でエラーにならない
  for (const saved of ['true', '1 ', 'on', '', '0', '2', 'null']) {
    const { ctx, page, errors } = await apPage(browser, { init: { fn: (v) => { try { localStorage.setItem('mj-chi-autopass', v); } catch { /* */ } }, arg: saved } });
    assert.equal((await apState(page)).on, false, `保存値 ${JSON.stringify(saved)} は OFF`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const block = () => {
      const deny = () => { throw new DOMException('denied', 'SecurityError'); };
      Storage.prototype.getItem = deny; Storage.prototype.setItem = deny;
    };
    const { ctx, page, errors } = await apPage(browser, { init: { fn: block } });
    let st = await apState(page);
    assert.equal(st.on, false, '保存不可なら OFF');
    assert.equal(st.stored, 'ERR');
    await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    st = await apState(page);
    assert.equal(st.count, 1, '保存できなくてもその場の ON は有効');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (11) ドラッグとの競合：dragging 中は上家の AI が打牌しない（宣言待ちも自動パスも起きない）。
  //      離した後、AI が1回だけ打牌し、自動パスも1回だけ。並び替えは確定し、自動整列も使える。
  {
    const { ctx, page, errors } = await apPage(browser);
    const cdp = await ctx.newCDPSession(page);
    await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY));
    await apToSeat3(page); // 上家の AI のタイマー（ゆっくり：1.2秒）が予約された状態
    const before = await apState(page);
    assert.deepEqual(before.p, { seat: 3, type: 'turn', ron: null, chi: null });
    const order = await shownOrder(page);
    const id = order[0];
    await touchDrag(page, cdp, id, await xForIndex(page, order, id, 4), null, { release: false });
    assert.equal(await page.evaluate(() => window.__mathjong.drag.phase()), 'dragging');
    await page.waitForTimeout(1600); // AI のタイマーが発火しても保留される
    let st = await apState(page);
    assert.equal(st.events, before.events, 'ドラッグ中は進行しない');
    assert.equal(st.count, 0);
    assert.equal(await page.evaluate(() => window.__mathjong.S.stepDeferred), true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return p && p.seat === 0 && p.type === 'turn'; }, null, { timeout: 5000 });
    st = await apState(page);
    assert.equal(st.seat3Discards, before.seat3Discards + 1, '上家の打牌は1回だけ');
    assert.equal(st.count, 1, '自動パスは1回だけ');
    assert.equal(st.chiSeen, 0);
    assert.equal(st.accepted, before.accepted, 'ドラッグで打牌しない');
    assert.equal(st.status, NOTICE);
    const shown = await shownOrder(page);
    assert.deepEqual(shown.slice(0, order.length), moveExpected(order, id, 4), '並び替えは確定（新しいツモ牌は右端）');
    await page.locator('button[data-action="autosort"]').tap();
    const sorted = await page.evaluate(async (base) => {
      const { defaultOrder } = await import(`${base}src/ui/handorder.js`);
      const g = window.__mathjong.S.game;
      return defaultOrder(g.hands[0], (x) => g.typeOf(x), g.drawn);
    }, BASE);
    assert.deepEqual(await shownOrder(page), sorted, '自動整列');
    await page.waitForTimeout(300);
    assert.equal((await apState(page)).events, st.events, '自分の手番で AI が勝手に進まない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (12) バージョン表示：ヘッダー・ページタイトル・再現情報
  {
    const { ctx, page, errors } = await apPage(browser, { viewport: { width: 1366, height: 768 } });
    assert.equal(await page.title(), '数雀（MATHJONG）Ver.0.5.0-b');
    assert.equal(await page.locator('.logo').innerText(), '数雀 Ver.0.5.0-b');
    await page.locator('button[data-action="settings"]').tap();
    assert.match(await page.locator('.report-info').innerText(), /画面 v0\.5\.0-b ・ エンジン v0\.5\.0-a/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.2-B：チーのオートパス（初期OFF・自動パス・連続3回・ロン＋チー・ロンのみ・ツモ・表示中の設定変更・モーダル裏・後続ロン・保存/復元/異常値/保存不可・ドラッグ・版表示）');
}

// Ver.0.2-B：設定スイッチ・通知・宣言ボタンが、横画面を含む各サイズで画面に収まる
async function chiAutoPassLayouts(browser) {
  const sizes = [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [932, 430], [768, 1024], [1366, 768]];
  for (const [w, h] of sizes) {
    const { ctx, page, errors } = await apPage(browser, { viewport: { width: w, height: h } });
    const where = `${w}×${h}`;
    // Ver.0.5-A：対戦画面のチー・ポンの切替ボタン。どちらも 44px 以上・画面内
    for (const kind of ['chi', 'pon']) {
      const b = apToggle(page, kind);
      await b.scrollIntoViewIfNeeded();
      const lb = await b.boundingBox();
      assert.ok(lb.height >= 44 && lb.width >= 44 && lb.x >= 0 && lb.x + lb.width <= w + 0.5, `${where}: ${kind} のタップ領域 ${JSON.stringify(lb)}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${where}: 横スクロール`);
    await apSetting(page, true);
    await apScene(page, apWall(AP_CHI_ONLY));
    const barNormal = (await page.locator('.bar').boundingBox()).height;
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    assert.equal((await apState(page)).status, NOTICE, where);
    const bar = await page.locator('.bar').boundingBox();
    assert.ok(Math.abs(bar.height - barNormal) < 1, `${where}: 通知で操作バーの高さが変わらない ${barNormal}→${bar.height}`);
    const fit = await page.evaluate(() => {
      const s = document.querySelector('.bar .actions .status');
      return { over: document.documentElement.scrollWidth - window.innerWidth, clipped: s.scrollWidth - s.clientWidth };
    });
    assert.ok(fit.over <= 0, `${where}: 横スクロール ${fit.over}px`);
    assert.ok(fit.clipped <= 0, `${where}: 通知が切れている`);
    // ロン＋チー：ロン・ロンしない（注記）が画面内
    await apScene(page, apWall(AP_RON_CHI));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    for (const sel of ['button[data-action="ron"]', 'button[data-action="pass"]']) {
      const loc = page.locator(sel);
      await loc.scrollIntoViewIfNeeded();
      const b = await loc.boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= w + 0.5 && b.height >= 44, `${where}: ${sel} ${JSON.stringify(b)}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${where}: 横スクロール`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/autopass-ronchi-${w}x${h}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`✓ Ver.0.2-B：設定スイッチ（44px以上）・通知・ロン＋チーの表示（縦横 ${sizes.length}サイズ）`);
}

// ---- Ver.0.3-A：数学Ⅰ・Ⅱ／刻子・ポン・新役（固定局面のテストプレイ） ----
// 数学Ⅰに無い角度（210°〜360°）を使わない他家の手
const V3_O1 = ['sin', 'sin', 'sin', '0', '90', '90', '=-√3', '=√3'];
const V3_O2 = ['=1/2', 'cos', '135', '180', '150', '150', '=√3', '=√3'];
const V3_O3 = ['=-1', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2'];
async function v3Page(browser, mode, { viewport = { width: 390, height: 844 }, query = '', init = null } = {}) {
  const ctx = await newContext(browser, { viewport, isMobile: true, hasTouch: true });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?mode=${mode}&seed=1&speed=slow${query}`);
  await page.waitForSelector('.hand .tile');
  return { ctx, page, errors };
}
async function v3Scene(page, wall) {
  await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); }, wall);
  await page.waitForSelector('.hand .tile.tap');
}
const v3State = (page) => page.evaluate(() => {
  const { S, rules } = window.__mathjong;
  const g = S.game;
  g.checkInvariants();
  const p = g.pending();
  return {
    p: p && { seat: p.seat, type: p.type, ron: p.ron ?? null, chi: p.chi ? p.chi.length : null, pon: p ? !!p.pon : null },
    melds0: g.melds[0].map((m) => `${m.call}:${m.kind}`), hand0: g.hands[0].length, ended: !p,
    result: g.result && { winner: g.result.winner, how: g.result.how, points: g.result.points, yaku: g.result.analysis ? g.result.analysis.yaku.map((y) => y.id) : [] },
    buttons: [...document.querySelectorAll('.bar button[data-action]')].map((b) => b.dataset.action),
    passText: (document.querySelector('.bar button[data-action="pass"]') || {}).textContent?.trim() || null,
    status: (document.querySelector('.bar .actions .status') || {}).textContent?.trim() || '',
    mode: rules.config.mode, deck: rules.deckSize, autoPass: S.autoPass.count,
  };
});
// 自分の宣言待ちで止まるまで、他家の行動（AI のタイマー）を待つ
const v3WaitHuman = (page) => page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return !p || p.seat === 0; }, null, { timeout: 8000 });

// 和了形ごとのツモ和了（自分が親、配牌8枚＋最初のツモ）
async function v3Tsumo(browser, mode, name, hand, draw, check) {
  const { ctx, page, errors } = await v3Page(browser, mode);
  await v3Scene(page, presetWall(hand, [draw], [V3_O1, V3_O2, V3_O3]));
  await page.locator('button[data-action="tsumo"]').tap();
  await page.waitForSelector('.overlay .result');
  const text = await page.locator('.overlay .result').innerText();
  const kinds = await page.locator('.overlay .formulas li').evaluateAll((els) => els.map((e) => e.className));
  check(text, kinds);
  assert.deepEqual(errors, [], name);
  await ctx.close();
}

async function v03Rules(browser) {
  // (1) 和了形・新役（ツモ和了の結果画面）
  await v3Tsumo(browser, 'math1', '数式3組', ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], '=1', (t, k) => {
    assert.deepEqual(k, ['formula', 'formula', 'formula']);
    assert.match(t, /三関制覇/);
  });
  await v3Tsumo(browser, 'math1', '刻子3組（対々和・三暗刻）', ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos'], 'cos', (t, k) => {
    assert.deepEqual(k, ['koutsu', 'koutsu', 'koutsu']);
    assert.match(t, /対々和/);
    assert.match(t, /三暗刻/);
    assert.match(t, /合計\s*9点/);
    assert.match(t, /刻子/);
  });
  await v3Tsumo(browser, 'math2', '数式2＋刻子1（門前・役なし）', ['sin', '30', '=1/2', 'cos', '180', '=-1', '45', '45'], '45', (t, k) => {
    assert.deepEqual(k.sort(), ['formula', 'formula', 'koutsu']);
    assert.match(t, /役なし（門前のため和了可）/);
    assert.match(t, /合計\s*1点/);
    assert.match(t, /混合形/);
    assert.match(t, /sin\s*π\s*6/, '数学Ⅱの数式は弧度法');
  });
  await v3Tsumo(browser, 'math1', '数式1＋刻子2', ['sin', '30', '=1/2', '45', '45', '45', '=0', '=0'], '=0', (t, k) => {
    assert.deepEqual(k.sort(), ['formula', 'koutsu', 'koutsu']);
    assert.match(t, /合計\s*1点/);
  });
  for (const [fn, name] of [['sin', '正弦一色'], ['cos', '余弦一色'], ['tan', '正接一色']]) {
    // 数学Ⅰ（関数牌各12枚）：自分の9枚＋他家の3枚＝12枚
    await v3Tsumo(browser, 'math1', name, Array(8).fill(fn), fn, (t) => {
      assert.match(t, new RegExp(name));
      assert.match(t, /役満/);
      assert.match(t, /合計\s*16点/);
      assert.ok(!/対々和/.test(t), '役満のとき通常役は加算しない');
    });
  }
  await v3Tsumo(browser, 'math1', '九角無双', ['0', '30', '45', '60', '90', '120', '135', '150'], '180', (t) => {
    assert.match(t, /九角無双/);
    assert.match(t, /16点/);
  });
  await v3Tsumo(browser, 'math2', '九角無双（弧度法）', ['0', '30', '45', '60', '90', '120', '135', '150'], '180', (t) => {
    assert.match(t, /九角無双/);
    assert.match(t, /0・π\/6・π\/4・π\/3・π\/2・2π\/3・3π\/4・5π\/6・π/);
  });
  console.log('✓ Ver.0.3：和了形（数式3・刻子3・数式2＋刻子1・数式1＋刻子2）・対々和・三暗刻・正弦/余弦/正接一色・九角無双（数学Ⅰ・Ⅱ）');

  // (2) ポン → 打牌 → チー（連続して鳴く）→ 鳴きは合計2回まで（数学Ⅰ）
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['=1/2', '=1/2', '0', '0', '135', '=-√3', 'tan', 'cos'],
      // 4枚目（下家の2回目のツモ）は対面がチーできない牌にする（対面 AI は cos 135° = −1/√2 をチーし得る）
      ['45', '=-1/√3', '=-√3/2', '=-1/√3', '=1/√3', '=1/√2', '60', '30', '=√3/2'], [V3_O1, V3_O2, V3_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1);
    await apForce(page, 2, 'v:1/2');
    let st = await v3State(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 0, pon: true }, '対面の 1/2 をポンできる');
    assert.deepEqual(st.buttons, ['pon', 'pass']);
    assert.match(await page.locator('button[data-action="pon"]').innerText(), /ポン/);
    await page.locator('button[data-action="pon"]').tap();
    st = await v3State(page);
    assert.deepEqual(st.melds0, ['pon:koutsu']);
    assert.equal(st.hand0, 6);
    assert.equal(st.status, 'ポン後：捨てる牌を選択');
    assert.equal(await page.locator('.melds.mine .meld.pon .tile').count(), 3, '公開刻子を表示');
    assert.match(await page.locator('.msg').innerText(), /あなた がポン/);
    // 打牌（=-√3）→ 上家（seat3）は飛ばされ、下家の手番
    const t1 = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:-√3'); });
    await page.locator(`.hand .tile[data-id="${t1}"]`).tap();
    await page.locator(`.hand .tile[data-id="${t1}"]`).tap();
    st = await v3State(page);
    assert.deepEqual([st.p.seat, st.p.type], [1, 'turn'], 'ポンした人の次（下家）の手番');
    await apForce(page, 1);
    await apForce(page, 2);
    await apForce(page, 3, 'v:-1');
    st = await v3State(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 1, pon: false }, 'tan 135° = −1 のチー');
    await page.locator('button[data-action="chi"]').tap();
    st = await v3State(page);
    assert.deepEqual(st.melds0, ['pon:koutsu', 'chi:formula']);
    assert.equal(st.status, 'チー後：捨てる牌を選択');
    const t2 = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'f:cos'); });
    await page.locator(`.hand .tile[data-id="${t2}"]`).tap();
    await page.locator(`.hand .tile[data-id="${t2}"]`).tap();
    st = await v3State(page);
    assert.equal(st.hand0, 2);
    // 2回鳴いた後：0° の対子があっても、下家の 0° ではポンできない（宣言待ちにならない）
    await apForce(page, 1, 'a:0');
    st = await v3State(page);
    assert.deepEqual([st.p.seat, st.p.type], [2, 'turn'], '鳴きは合計2回まで（3回目のポンはない）');
    assert.ok(!st.buttons.includes('pon'));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：ポン（公開刻子・手番の飛び越し）→ チーと連続して鳴いた後の進行・鳴きは合計2回まで');

  // (3) ポン＋チーの同時（上家の打牌）：OFF はポン・チー・見送る、ON はポン・見送る（チーも見送ります）。ポンは自動パスしない
  for (const on of [false, true]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    if (on) await apSetting(page, true);
    await v3Scene(page, presetWall(['=1/2', '=1/2', 'sin', '30', '0', '0', '135', '=-√3'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'],
      [V3_O1, ['=1/√3', 'cos', 'cos', '180', '150', '150', '=√3', '=√3'], ['=1/2', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']]));
    await page.locator('button[data-action="hint"]').tap();
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    const st = await v3State(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 1, pon: true });
    assert.equal(st.autoPass, 0, 'ポンが可能なら自動パスしない');
    if (on) {
      assert.deepEqual(st.buttons, ['pon', 'pass']);
      assert.match(st.passText, /チーも見送ります/);
    } else {
      assert.deepEqual(st.buttons, ['pon', 'chi', 'pass']);
    }
    // 役候補ヒントは、表示している選択肢と同じ経路
    const h = await page.evaluate(async ([base, on]) => {
      const { yakuCandidates, claimForSeat } = await import(`${base}src/engine/yakuhint.js`);
      const { claimPendingForHint } = await import(`${base}src/ui/autopass.js`);
      const { S, rules } = window.__mathjong;
      const g = S.game;
      const c = claimForSeat(claimPendingForHint(g.pending(), on), 0, (id) => g.typeOf(id));
      const exp = yakuCandidates(rules, g.viewFor(0), { claim: c }).map((x) => `${x.name}|${x.missing === 0 ? '完成！' : `あと${x.missing}枚`}`);
      const shown = [...document.querySelectorAll('.yaku-cands li')].map((li) => `${li.querySelector('b').textContent}|${li.querySelector('.yc-miss').textContent}`);
      return { exp, shown, chiRoute: c.chiMelds.length, ponRoute: c.ponMeld !== null };
    }, [BASE, on]);
    assert.deepEqual(h.shown, h.exp, 'ヒントが表示中の宣言経路と一致');
    assert.equal(h.chiRoute, on ? 0 : 1);
    assert.equal(h.ponRoute, true);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // ON・チーだけ（数学Ⅰ）：自動パス
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await apSetting(page, true);
    await v3Scene(page, presetWall(['=1/2', '45', 'sin', '30', '0', '0', '135', '=-√3'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'],
      [V3_O1, ['=1/√3', 'cos', 'cos', '180', '150', '150', '=√3', '=√3'], ['=1/2', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']]));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    const st = await v3State(page);
    assert.equal(st.autoPass, 1, 'チーだけなら自動パス');
    assert.deepEqual([st.p.seat, st.p.type], [0, 'turn']);
    assert.equal(st.status, 'チーを自動で見送りました');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：ポン＋チー同時（OFF：ポン・チー／ON：ポンを残しチーを見送り対象）・ポンは自動パスしない・ヒントの経路一致');

  // (4) ロン＞ポン：自分がポンを選んでも、後続の他家のロンが優先（ポンは取り消し）
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['=1/2', '=1/2', '0', '0', '135', '=-√3', 'tan', 'cos'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'],
      [['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '30'], ['=1/√3', 'cos', 'cos', '180', '150', '150', '=√3', '=√3'], ['=1/2', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']]));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    let st = await v3State(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 0, pon: true });
    await page.locator('button[data-action="pon"]').tap();
    st = await v3State(page);
    assert.deepEqual(st.melds0, [], 'ロン判断が終わるまでポンは確定しない');
    await page.waitForSelector('.overlay .result', { timeout: 8000 });
    st = await v3State(page);
    assert.deepEqual([st.result.winner, st.result.how], [1, 'ron'], '下家のロンが優先');
    assert.deepEqual(st.melds0, [], 'ポンは取り消し');
    assert.equal(st.hand0, 8);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (5) 自分のロンの機会は、先に判断した他家のポンで失われない
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '30'], ['=1/2', '=-1/√3', '=-√3/2', '=-1/√2'],
      [['=1/2', 'cos', 'sin', '0', '90', '90', '=-√3', '=√3'], ['=1/2', '=1/2', 'cos', '135', '150', '150', '=√3', '=-1/√3'], ['=1/√3', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']]));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1/2'); // 対面（1/2 の対子）がポン判断 → 上家 → 自分のロン
    await v3WaitHuman(page);
    const st = await v3State(page);
    assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: true, chi: 0, pon: false }, '自分にはロンだけ（他家のポンより優先）');
    assert.deepEqual(st.buttons, ['ron', 'pass']);
    await page.locator('button[data-action="ron"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.match(await page.locator('.overlay .result').innerText(), /あなた の和了 ロン/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：ロン＞ポン（自分のポンは後続ロンで取り消し／他家のポンで自分のロンは失われない）');

  // (6) 数学Ⅰ：180°を超える牌が出ない・度数法。数学Ⅱ：弧度法の表示
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    const st = await page.evaluate(() => {
      const { S, rules } = window.__mathjong;
      const degs = S.game.tileType.map((t) => rules.types[t]).filter((t) => t.kind === 'angle').map((t) => t.deg);
      return { max: Math.max(...degs), n: S.game.tileType.length, labels: [...document.querySelectorAll('.tile.t-angle')].map((e) => e.getAttribute('aria-label')) };
    });
    assert.equal(st.max, 180);
    assert.equal(st.n, 124);
    assert.ok(st.labels.every((l) => /^\d+°$/.test(l)), st.labels.join());
    assert.equal(await page.locator('.top .mode').innerText(), '数Ⅰ');
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('.hint-tools [data-action="table"]').tap();
    assert.equal(await page.locator('.values tr').count(), 10, '値表は0°〜180°の9行');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await v3Page(browser, 'math2');
    await page.locator('button[data-action="guide"]').first().tap();
    await page.locator('[data-action="guide-tab"][data-tab="tiles"]').tap();
    const labels = await page.locator('.gallery.sz-row-l .tile.t-angle').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert.deepEqual(labels, ['0', 'π/6', 'π/4', 'π/3', 'π/2', '2π/3', '3π/4', '5π/6', 'π', '7π/6', '5π/4', '4π/3', '3π/2', '5π/3', '7π/4', '11π/6', '2π']);
    // 縦組みの分数（分子 π・分母 6）、0 と 2π は別の牌
    const frac = await page.locator('.gallery.sz-row-l .tile[aria-label="π/6"] .afrac').evaluate((e) => ({ num: e.querySelector('.num').textContent, den: e.querySelector('.den').textContent, dir: getComputedStyle(e).flexDirection }));
    assert.deepEqual(frac, { num: 'π', den: '6', dir: 'column' });
    assert.equal(await page.locator('.top .mode').innerText(), '数Ⅱ');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：数学Ⅰは0°〜180°（度数法・124枚）、数学Ⅱは弧度法（縦組みの分数・0 と 2π は別の牌）');

  // (7) モードの選択：進行中の局は変わらず、「新しい対局」で切り替わる。保存して再読み込み後も維持、次の局でも維持
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=3&speed=test`);
    await page.waitForSelector('.hand .tile');
    const info = () => page.evaluate(() => ({ mode: window.__mathjong.rules.config.mode, deck: window.__mathjong.S.game.tileType.length, stored: localStorage.getItem('mj-mode') }));
    assert.deepEqual(await info(), { mode: 'math2', deck: 168, stored: null }, '既定は数学Ⅱ');
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    assert.match(await page.locator('.mode-note').innerText(), /新しい対局」で切り替わります/);
    let st = await info();
    assert.deepEqual([st.mode, st.deck, st.stored], ['math2', 168, 'math1'], '進行中の局は変えない');
    await page.locator('button[data-action="reset"]').tap();
    st = await info();
    assert.deepEqual([st.mode, st.deck], ['math1', 124], '新しい対局で数学Ⅰ');
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal((await info()).mode, 'math1', '再読み込み後も数学Ⅰ');
    await page.evaluate(() => { const { S, goRound } = window.__mathjong; goRound(S.round + 1, (S.dealer + 1) % 4); });
    assert.equal((await info()).mode, 'math1', '次の局でも維持');
    // 切替後のガイドの条件文は度数法（P3-1）
    await page.locator('button[data-action="guide"]').first().tap();
    const conds = await page.locator('.gy-cond').allInnerTexts();
    assert.ok(conds.length > 5 && conds.every((c) => !c.includes('π')), '数学Ⅰへ切り替えた後は度数法');
    assert.match(conds.join(' '), /30°・45°・60°/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：モード選択（進行中の局は不変・新しい対局で反映・保存/再読み込み・次の局で維持）');

  // (8) ガイド：新役（刻子の数式例）・数学Ⅰで成立しない役は出さない・ルールにポンと優先順位
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await v3Page(browser, mode);
    await page.locator('button[data-action="guide"]').first().tap();
    const ids = await page.locator('.gy').evaluateAll((els) => els.map((e) => e.dataset.yaku));
    for (const id of ['toitoi', 'sanankou', 'sinIsshoku', 'cosIsshoku', 'tanIsshoku', 'kyukaku']) assert.ok(ids.includes(id), `${mode} ${id}`);
    assert.equal(ids.includes('shougen3'), mode === 'math2');
    assert.equal(await page.locator('.gy[data-yaku="toitoi"] .formula.koutsu').count(), 3);
    assert.match(await page.locator('.gy[data-yaku="sanankou"]').innerText(), /ロンで最後の刻子を完成させた場合も成立/);
    // 監査 P3-1：条件文の角度表記はモードに合わせる（数学Ⅰ＝度数法、数学Ⅱ＝弧度法）
    const conds = await page.locator('.gy-cond').allInnerTexts();
    if (mode === 'math2') {
      assert.ok(conds.every((c) => !c.includes('°')), `数学Ⅱに度数法が残る: ${conds.filter((c) => c.includes('°')).join(' / ')}`);
      assert.match(await page.locator('.gy[data-yaku="yokaku"] .gy-cond').innerText(), /cos\(π\/2−θ\).*0≦θ≦π\/2/);
    } else {
      assert.ok(conds.every((c) => !c.includes('π')), '数学Ⅰに弧度法が混ざる');
      assert.match(await page.locator('.gy[data-yaku="yokaku"] .gy-cond').innerText(), /cos\(90°−θ\).*0°≦θ≦90°/);
    }
    await page.locator('[data-action="guide-tab"][data-tab="rules"]').tap();
    const rulesText = await page.locator('.rules-list').innerText();
    assert.match(rulesText, /ロン ＞ ポン ＞ チー/);
    assert.match(rulesText, /雀頭は不要/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：ガイド（新役・刻子の数式例・数学Ⅰで成立しない役は非表示・ルールの優先順位）');

  // (9) 数学Ⅰ・Ⅱで長押しの並び替え・自動整列・通常の打牌
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await v3Page(browser, mode, { query: '' });
    const cdp = await ctx.newCDPSession(page);
    await page.waitForSelector('.hand .tile.tap');
    const order = await shownOrder(page);
    const moved = await dragToIndex(page, cdp, order[0], 5);
    assert.deepEqual(await shownOrder(page), moved, `${mode} 並び替え`);
    await page.locator('button[data-action="autosort"]').tap();
    const t = (await shownOrder(page))[2];
    await page.locator(`.hand .tile[data-id="${t}"]`).tap();
    await page.locator(`.hand .tile[data-id="${t}"]`).tap();
    const mine = await page.evaluate(() => window.__mathjong.S.game.rivers[0].map((r) => r.id));
    assert.deepEqual(mine, [t], `${mode} 打牌`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3：数学Ⅰ・Ⅱで長押し並び替え・自動整列・通常の打牌');
}


// ---- Ver.0.3-B：2段階ヒント（発見・確認）と数式の色枠 ----
const hintState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const frames = {};
  document.querySelectorAll('.hand .tile.fhf').forEach((t) => { frames[t.dataset.id] = [...t.classList].find((c) => /^fhf-/.test(c)); });
  const clean = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  return {
    open: S.hintOpen, stage: S.hintStage, frames, panel: !!document.querySelector('.hint-box .fh'),
    confirm: !!document.querySelector('.hint-box [data-action="fh-confirm"]'),
    list: [...document.querySelectorAll('.fh-item')].map(clean), basic: clean(document.querySelector('.hint-basic')),
    fh: clean(document.querySelector('.hint-box .fh')), stats: { ...S.hintStats }, used: S.hintsUsed, comps: S.hintComputations || 0,
  };
});
const idOf = (page, key, nth = 0) => page.evaluate(([k, n]) => {
  const { S, rules } = window.__mathjong;
  return S.game.hands[0].filter((x) => rules.types[S.game.typeOf(x)].key === k).sort((a, b) => a - b)[n];
}, [key, nth]);

async function v03bHints(browser) {
  // (1) 2通り（30°が2枚）：第1段階 → 確認 → 赤・青を別々の牌に。並び替え・閉じて開く・打牌・他家の打牌・ツモ
  {
    const { ctx, page, errors } = await v3Page(browser, 'math2');
    const cdp = await ctx.newCDPSession(page);
    await v3Scene(page, presetWall(['sin', 'cos', '30', '30', '=1/2', '=√3/2', '0', '0'],
      ['=-√3/2', '=-1/√3', '=1/√3', '45', '=-1/2'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    let st = await hintState(page);
    assert.equal(st.stage, 1, 'ヒント初回は第1段階');
    assert.deepEqual(st.frames, {}, '第1段階では枠を出さない');
    assert.equal(st.panel, false);
    assert.equal(st.confirm, true);
    assert.match(st.basic, /完成している数式：2通り/);
    assert.ok(!/sin|cos|=/.test(st.basic.replace('数式を確認する', '')), '第1段階で具体的な式を出さない');
    assert.deepEqual(st.stats, { discover: 1, confirm: 0, table: 0 });
    await page.locator('button[data-action="fh-confirm"]').tap();
    st = await hintState(page);
    assert.equal(st.stage, 2);
    assert.equal(st.confirm, false);
    assert.deepEqual(st.stats, { discover: 1, confirm: 1, table: 0 });
    assert.match(st.fh, /同時に使える数式面子：最大2組/);
    assert.equal(st.list.length, 2);
    assert.match(st.list[0], /^1\s*sin/);
    assert.match(st.list[1], /^2\s*cos/);
    const ids = {
      sin: await idOf(page, 'f:sin'), cos: await idOf(page, 'f:cos'), a30: await idOf(page, 'a:30', 0), b30: await idOf(page, 'a:30', 1),
      half: await idOf(page, 'v:1/2'), r32: await idOf(page, 'v:√3/2'),
    };
    const expectFrames = { [ids.sin]: 'fhf-red', [ids.a30]: 'fhf-red', [ids.half]: 'fhf-red', [ids.cos]: 'fhf-blue', [ids.b30]: 'fhf-blue', [ids.r32]: 'fhf-blue' };
    assert.deepEqual(st.frames, expectFrames, '30°は赤と青に1枚ずつ（共有しない）');
    // 枠の装飾は操作を妨げない（pointer-events: none）、牌の大きさは変わらない
    const deco = await page.locator(`.hand .tile[data-id="${ids.sin}"]`).evaluate((el) => ({ pe: getComputedStyle(el, '::before').pointerEvents, w: el.getBoundingClientRect().width }));
    assert.equal(deco.pe, 'none');
    // 表示の切替：赤だけ → 2式
    await page.locator('button[data-action="fh-mode"][data-mode="a"]').tap();
    st = await hintState(page);
    assert.deepEqual(Object.values(st.frames).sort(), ['fhf-red', 'fhf-red', 'fhf-red']);
    assert.deepEqual(st.stats, { discover: 1, confirm: 1, table: 0 }, '表示の切替では数えない');
    await page.locator('button[data-action="fh-mode"][data-mode="both"]').tap();
    // 並び替え・自動整列：段階・表示対象・色（物理牌 id）を維持
    const order = await shownOrder(page);
    await dragToIndex(page, cdp, order[0], 5);
    st = await hintState(page);
    assert.equal(st.stage, 2, '並び替えでは第2段階を維持');
    assert.deepEqual(st.frames, expectFrames, '色は物理牌 id に対応');
    await page.locator('button[data-action="autosort"]').tap();
    assert.deepEqual((await hintState(page)).frames, expectFrames);
    // 閉じる → 枠を解除。開き直すと第1段階、同じ手牌なので回数は増えない
    await page.locator('button[data-action="hint"]').tap();
    st = await hintState(page);
    assert.equal(st.open, false);
    assert.deepEqual(st.frames, {});
    assert.equal(await page.locator('.hand .tile.fhf').count(), 0);
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="fh-confirm"]').tap();
    st = await hintState(page);
    assert.equal(st.stage, 2);
    assert.deepEqual(st.stats, { discover: 1, confirm: 1, table: 0 }, '同じ手牌では重複して数えない');
    // 打牌 → 第1段階（ヒントは開いたまま）。2回タップの打牌は枠があっても使える
    await apDiscardDrawn(page);
    st = await hintState(page);
    assert.deepEqual([st.open, st.stage, Object.keys(st.frames).length], [true, 1, 0], '打牌で第1段階へ');
    // 他家の手番に確認（新しい手牌の状態なので確認回数 +1）→ 他家の打牌では第2段階を維持し、役候補だけ更新
    await page.locator('button[data-action="fh-confirm"]').tap();
    const before = await hintState(page);
    assert.equal(before.stats.confirm, 2);
    await apForce(page, 1);
    st = await hintState(page);
    assert.equal(st.stage, 2, '他家の打牌では第2段階を維持');
    assert.ok(st.comps > before.comps, '役候補は更新');
    assert.deepEqual(st.frames, before.frames);
    await apForce(page, 2);
    await apForce(page, 3);
    // 自分のツモ → 第1段階
    await page.waitForSelector('.hand .tile.tap');
    st = await hintState(page);
    assert.deepEqual([st.stage, Object.keys(st.frames).length], [1, 0], 'ツモで第1段階へ');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (2) 0通り：確認ボタンなし
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=√3'], ['=-1'], [['cos', 'cos', 'cos', '180', '150', '150', '=1/2', '=1/2'], V3_O2, V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    const st = await hintState(page);
    assert.match(st.basic, /完成している数式：0通り/);
    assert.equal(st.confirm, false, '0通りなら確認ボタンなし');
    assert.deepEqual(st.frames, {});
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) 牌を共有する2式（sin45°・cos45°、45°と 1/√2 が1枚）：2色の枠と説明。表示の切替
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['sin', 'cos', '45', '=1/√2', '0', '0', '135', '=-√3'], ['=-√3/2'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="fh-confirm"]').tap();
    let st = await hintState(page);
    assert.equal(st.list.length, 3, 'sin45・cos45・sin135');
    const a45 = await idOf(page, 'a:45');
    const v = await idOf(page, 'v:1/√2');
    assert.equal(st.frames[a45], 'fhf-rb');
    assert.equal(st.frames[v], 'fhf-rb');
    assert.equal(st.frames[await idOf(page, 'f:sin')], 'fhf-red');
    assert.equal(st.frames[await idOf(page, 'f:cos')], 'fhf-blue');
    assert.match(st.fh, /牌を共有するため、同時には使用できません/);
    assert.match(st.fh, /最大1組/);
    // 青を3番（sin135°）に切り替え：sin は1枚なので共有、1/√2 も共有
    await page.locator('.fh-item:nth-child(3) button[data-slot="b"]').tap();
    st = await hintState(page);
    assert.equal(st.frames[await idOf(page, 'a:135')], 'fhf-blue');
    assert.equal(st.frames[await idOf(page, 'f:sin')], 'fhf-rb');
    assert.equal(st.frames[a45], 'fhf-red');
    assert.match(st.list[2], /青/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (4) 1通りを3組（sin30°=1/2 ×3）：黄色の枠で9枚すべて、×3組。和了でヒントを閉じ、結果に回数。次局で初期化
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2'], ['=1/2'], [V3_O1, ['=-1/2', 'cos', '135', '180', '150', '150', '=√3', '=√3'], V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="fh-confirm"]').tap();
    const st = await hintState(page);
    assert.equal(Object.keys(st.frames).length, 9);
    assert.ok(Object.values(st.frames).every((c) => c === 'fhf-yellow'));
    assert.match(st.list[0], /×3組/);
    assert.match(st.fh, /最大3組/);
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.equal((await hintState(page)).open, false, '和了でヒントを閉じる');
    assert.match(await page.locator('.hint-stats').innerText(), /発見 1回・確認 1回・値表 0回/);
    await page.locator('button[data-action="next"]').tap();
    const n = await hintState(page);
    assert.deepEqual([n.open, n.used, n.stats.discover], [false, 0, 0], '次局は閉じた状態・回数も初期化');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (5) ポンで第1段階へ戻る（宣言待ちの間に確認していた場合）
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['=1/2', '=1/2', 'sin', '30', '0', '0', '135', '=-√3'], ['45', '=-1/√3', '=-√3/2'], [V3_O1, V3_O2, V3_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1);
    await apForce(page, 2, 'v:1/2');
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="fh-confirm"]').tap();
    assert.equal((await hintState(page)).stage, 2);
    await page.locator('button[data-action="pon"]').tap();
    const st = await hintState(page);
    assert.deepEqual([st.open, st.stage, Object.keys(st.frames).length], [true, 1, 0], 'ポンで第1段階へ');
    assert.match(st.basic, /手牌内の完成している数式：0通り/, '1/2 は2枚ともポンで公開（公開面子は手牌内に数えない）');
    assert.match(st.basic, /公開済み：数式面子 0組・刻子 1組/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (6) 数式が多い場合（数学Ⅱ・6通り）のレイアウト：320〜430px、横スクロールなし、一覧は高さ制限、手牌と重ならない
  for (const w of [320, 375, 390, 430]) {
    const { ctx, page, errors } = await v3Page(browser, 'math2', { viewport: { width: w, height: 760 } });
    await v3Scene(page, presetWall(['sin', 'cos', 'tan', '45', '225', '=1/√2', '=-1/√2', '=1'], ['=-√3/2'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="fh-confirm"]').tap();
    const m = await page.evaluate(() => {
      const list = document.querySelector('.fh-list');
      const hand = document.querySelector('.hand').getBoundingClientRect();
      const box = document.querySelector('.hint-box').getBoundingClientRect();
      return { over: document.documentElement.scrollWidth - innerWidth, items: list.children.length, lh: list.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(list).fontSize), handBottom: hand.bottom, boxTop: box.top, colors: new Set([...document.querySelectorAll('.hand .tile.fhf')].map((t) => [...t.classList].find((c) => /^fhf-/.test(c)))).size };
    });
    assert.equal(m.items, 6);
    assert.ok(m.over <= 0, `${w}px: 横スクロール ${m.over}`);
    assert.ok(m.lh <= 11.5 * 16 + 2, `${w}px: 一覧の高さ ${m.lh}`);
    assert.ok(m.boxTop >= m.handBottom - 1, `${w}px: ヒント欄が手牌に重ならない`);
    assert.ok(m.colors <= 3, '赤・青（共有があれば赤青）まで');
    // 枠がある状態で牌の2回タップによる打牌ができる
    const t = (await shownOrder(page))[0];
    await page.locator(`.hand .tile[data-id="${t}"]`).tap();
    await page.locator(`.hand .tile[data-id="${t}"]`).tap();
    assert.deepEqual(await page.evaluate(() => window.__mathjong.S.game.rivers[0].map((r) => r.id)), [t], `${w}px: 打牌`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hint-many-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.3-B：2段階ヒント（発見→確認・0通りでボタンなし）・赤青／共有の2色／黄色×3組・表示切替・並び替えで維持・打牌/ツモ/ポンで第1段階・他家の打牌で維持・回数の重複なし・和了で終了・次局で初期化・320〜430px');
}

// ---- Ver.0.4-A：タイトル画面・4局戦／8局戦・親の連荘・親子の精算・試合終了 ----
const matchState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const m = S.match;
  return {
    screen: S.screen, modal: S.modal, label: m && document.querySelector('.top .hand-label') ? document.querySelector('.top .hand-label').textContent : null,
    hand: m && m.hand, renchan: m && m.renchan, played: m && m.played, over: m && m.over, length: m && m.length, scores: m && m.scores.slice(),
    sum: m ? m.scores.reduce((a, b) => a + b, 0) : null, dealer: S.dealer, round: S.round, ai: S.ai, mode: window.__mathjong.rules.config.mode,
    info: (document.querySelector('.top .info') || {}).textContent || '',
  };
});
// 流局させる（テスト用：山を空にして、手番の人がツモ牌を捨てる。宣言はすべて見送る）
const forceDraw = (page) => page.evaluate(() => {
  const { S, step } = window.__mathjong;
  const g = S.game;
  clearTimeout(S.timer); S.timer = null;
  while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  g.wall.length = 0;
  const p = g.pending();
  g.discard(p.seat, g.drawn !== null && g.drawn !== undefined ? g.drawn : g.hands[p.seat][0]);
  while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  step(true);
});
const TSUMO_HAND = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];

async function v04Match(browser) {
  // (1) タイトル画面：数学モード・局数・AI難易度を選んで開始。選択は保存され、再読み込み後も残る
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    assert.match(await page.locator('.title-logo').innerText(), /数雀\s*MATHJONG/);
    assert.equal(await page.locator('input[data-action="title-mode"][value="math2"]').isChecked(), true, '既定は数学Ⅱ');
    assert.equal(await page.locator('input[data-action="title-length"][value="4"]').isChecked(), true, '既定は4局戦');
    assert.equal(await page.locator('input[data-action="title-ai"][value="intermediate"]').isChecked(), true, '既定は中級');
    // Ver.0.4-B：初級・上級を有効化（「準備中」の表示はなく、各難易度の説明を表示）
    assert.equal(await page.locator('.title-set .soon').count(), 0, '準備中の表示はない');
    assert.equal(await page.locator('text=準備中').count(), 0);
    for (const lv of ['beginner', 'intermediate', 'advanced']) assert.ok((await page.locator(`label.setting.radio:has(input[value="${lv}"]) small`).innerText()).length > 5, `${lv} の説明`);
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    await page.locator('label.setting.radio', { hasText: '8局戦' }).tap();
    await page.locator('label.setting.radio', { hasText: '上級' }).tap();
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    let st = await matchState(page);
    assert.deepEqual([st.screen, st.mode, st.length, st.ai, st.label, st.scores], ['game', 'math1', 8, 'advanced', '東1局', [100, 100, 100, 100]]);
    // 対局中に設定からタイトルへ（確認あり）
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="cancel-title"]').tap();
    assert.equal((await matchState(page)).screen, 'game', '「続ける」で対局に戻る');
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    st = await matchState(page);
    assert.equal(st.screen, 'title');
    assert.equal(await page.evaluate(() => window.__mathjong.S.timer), null, 'AI の進行を止める');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.title-screen').count(), 1, 'タイトルのまま（AI が勝手に進まない）');
    await page.reload();
    await page.waitForSelector('.title-screen');
    assert.equal(await page.locator('input[data-action="title-mode"][value="math1"]').isChecked(), true, '保存');
    assert.equal(await page.locator('input[data-action="title-length"][value="8"]').isChecked(), true);
    assert.equal(await page.locator('input[data-action="title-ai"][value="advanced"]').isChecked(), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (2) ヒントのボタンは手牌の下（自動整列の隣）。開閉・2段階・回数は従来どおり
  {
    const { ctx, page, errors } = await v3Page(browser, 'math2');
    assert.equal(await page.locator('.top button[data-action="hint"]').count(), 0, 'ヘッダーにはない');
    assert.equal(await page.locator('.hand-help .hh-tools button[data-action="autosort"] + button[data-action="hint"]').count(), 1, '自動整列の隣');
    const hb = await page.locator('.hand-help button[data-action="hint"]').boundingBox();
    assert.ok(hb.height >= 36, `タップ領域 ${hb.height}`);
    await page.locator('button[data-action="hint"]').tap();
    assert.equal(await page.locator('.hint-box .hint-basic').count(), 1);
    assert.equal(await page.locator('button[data-action="hint"]').getAttribute('aria-pressed'), 'true');
    await page.locator('button[data-action="hint"]').tap();
    assert.equal(await page.locator('.hint-box').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) 親の連荘（親のツモ：+6B・子 −2B）→ 流局で親交代 → 精算・合計400・表示
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { query: '&len=4' });
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    let st = await matchState(page);
    assert.deepEqual(st.scores, [112, 96, 96, 96], '親ツモ：和了点2 → +12、子 各 −4');
    assert.equal(st.sum, 400);
    const text = await page.locator('.overlay .result').innerText();
    assert.match(text, /東1局の精算/);
    assert.match(text, /\+12/);
    assert.match(text, /−4/);
    assert.match(text, /連荘/);
    assert.equal(st.label, '東1局', '終局後のヘッダーはその局のまま');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.label, st.renchan, st.dealer, st.round], ['東1局', 1, 0, 2], '同じ親で連荘、通し第2局');
    assert.match(st.info, /連荘1/);
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    assert.match(await page.locator('.overlay .result').innerText(), /流局[\s\S]*親交代/);
    st = await matchState(page);
    assert.deepEqual(st.scores, [112, 96, 96, 96], '流局は得点移動なし');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.label, st.renchan, st.dealer], ['東2局', 0, 1], '親交代：下家が親');
    assert.equal(await page.locator('.panel.seat-1 .oya').count(), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (4) 最終の親（東4局）が連荘して延長 → 流局で試合終了 → 最終結果（同点は同順位）→ もう一度遊ぶ／タイトルへ
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { query: '&round=4&len=4&hand=3&dealer=0' }); // 東4局の親は自分（起家は逆算）
    let st = await matchState(page);
    assert.deepEqual([st.label, st.dealer], ['東4局', 0]);
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    st = await matchState(page);
    assert.equal(st.over, false, '最終の親の連荘で延長');
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '次の局へ');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.deepEqual([(await matchState(page)).label, (await matchState(page)).renchan], ['東4局', 1]);
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    st = await matchState(page);
    assert.equal(st.over, true);
    assert.match(await page.locator('.overlay .result').innerText(), /試合終了/);
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '最終結果へ');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.overlay .final');
    const fin = await page.locator('.overlay .final').innerText();
    assert.match(fin, /あなたは 1位（112点）/);
    assert.match(fin, /実施した局数：2局/);
    assert.match(fin, /連荘回数：1回/);
    assert.match(fin, /数学Ⅰ/);
    assert.match(fin, /AI難易度：中級/);
    const ranksShown = await page.locator('.final-table td.rank').allInnerTexts();
    assert.deepEqual(ranksShown, ['1位', '2位', '2位', '2位'], '同点は同順位');
    assert.match(fin, /\+12/);
    assert.match(fin, /−4/);
    assert.equal(await page.locator('.overlay .final .modal-actions button[data-action="close"]').count(), 0, '閉じるボタンなし');
    await page.locator('button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.label, st.scores, st.played, st.over], ['東1局', [100, 100, 100, 100], 0, false], 'もう一度遊ぶ：新しい試合');
    // 試合終了画面から「タイトルへ戻る」
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    await page.locator('.final button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (5) 再現情報：連荘中の局を URL（seed・round・dealer・hand・renchan・len・mode）で再現できる
  {
    // 正規の状態（通し第8局 = 南2局・連荘2。round ≥ hand + renchan + 1 を満たす）から始め、出力される URL を往復する
    const { ctx, page, errors } = await v3Page(browser, 'math2', { query: '' });
    await page.goto(`${LOCAL}?seed=555&round=8&dealer=1&hand=5&renchan=2&len=8&mode=math2&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const st = await matchState(page);
    await page.locator('button[data-action="settings"]').tap();
    const info = await page.locator('.report-info').innerText();
    const q = info.match(/(\?seed=\S+)/)[1];
    assert.match(q, /seed=555&round=8&dealer=1&hand=5&renchan=2&len=8&mode=math2/);
    const deal = await page.evaluate(() => ({ wall: window.__mathjong.S.game.wall.slice(), hands: window.__mathjong.S.game.hands.map((h) => h.slice()) }));
    await page.goto(`${LOCAL}${q}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const st2 = await matchState(page);
    assert.deepEqual([st2.label, st2.renchan, st2.dealer, st2.round, st2.length], ['南2局', 2, 1, 8, 8]);
    assert.deepEqual(await page.evaluate(() => ({ wall: window.__mathjong.S.game.wall.slice(), hands: window.__mathjong.S.game.hands.map((h) => h.slice()) })), deal, '同じ山・配牌');
    assert.equal(st.dealer, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (6) 320〜430px：タイトル・対局・精算・最終結果で横スクロールなし、主要ボタンが画面内
  for (const w of [320, 375, 430]) {
    const ctx = await newContext(browser, { viewport: { width: w, height: 700 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=slow`);
    await page.waitForSelector('.title-screen');
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(await over() <= 0, `${w}px タイトル`);
    const sb = await page.locator('button[data-action="start-match"]').boundingBox();
    assert.ok(sb.x >= 0 && sb.x + sb.width <= w && sb.height >= 44);
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.ok(await over() <= 0, `${w}px 対局`);
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    assert.ok(await over() <= 0, `${w}px 精算`);
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    assert.ok(await over() <= 0, `${w}px 最終結果`);
    const t = await page.evaluate(() => { const m = document.querySelector('.modal'); return m.scrollWidth - m.clientWidth; });
    assert.ok(t <= 0, `${w}px 最終結果の表が横にはみ出す`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/final-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-A：タイトル（モード・局数・AI難易度の保存）・ヒントボタンの移動・親の連荘／親交代・精算（合計400）・最終の親の延長・試合終了（同点同順位）・もう一度／タイトルへ・再現URL・320〜430px');
}

// ---- Ver.0.4-A 監査対応（PR #9）：もう一度遊ぶ・長い連荘の再現 URL・再現情報の注意書き ----
const dealOf = (page) => page.evaluate(() => ({ wall: window.__mathjong.S.game.wall.slice(), hands: window.__mathjong.S.game.hands.map((h) => h.slice()), dealer: window.__mathjong.S.game.dealer }));
const reproQuery = async (page) => {
  await page.locator('button[data-action="settings"]').tap();
  const info = await page.locator('.report-info').innerText();
  await page.locator('.modal-actions button[data-action="close"]').tap();
  return { info, q: info.match(/(\?seed=\S+)/)[1] };
};

async function v04Fixes(browser) {
  // (1) P2-1：もう一度遊ぶは、終了した試合と同じ設定（数学モード・局数・AI難易度）。予約中の次回用モードは使わない。逆方向も。
  for (const [startMode, pending, length, ai, otherLength] of [['math1', 'math2', 4, 'advanced', 8], ['math2', 'math1', 8, 'beginner', 4]]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    const lab = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
    await page.locator('label.setting.radio', { hasText: lab[startMode] }).tap();
    await page.locator('label.setting.radio', { hasText: `${length}局戦` }).tap();
    await page.locator(`input[data-action="title-ai"][value="${ai}"]`).evaluate((e) => e.click());
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    const seed1 = await page.evaluate(() => window.__mathjong.S.seedBase);
    // 試合中に、次回用の別の数学モードを予約する（設定画面）。S.length もタイトルの別の値にしておく（採用元を取り違えないこと）
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('label.setting.radio', { hasText: lab[pending] }).tap();
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await page.evaluate((l) => { window.__mathjong.S.length = l; }, otherLength);
    // 試合を進めて（得点・和了・履歴・ヒントを作り）終了させる
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="hint"]').tap();
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    const before = await page.evaluate(() => { const { S, rules } = window.__mathjong; return { mode: rules.config.mode, len: S.match.length, scores: S.match.scores.slice(), hist: S.history.length, seed: S.seedBase, next: S.nextMode }; });
    assert.equal(before.mode, startMode);
    assert.equal(before.next, pending, '予約中の次回用モード');
    assert.ok(before.scores.some((x) => x !== 100) && before.hist > 0);
    assert.match(await page.locator('.final-info').innerText(), new RegExp(`AI難易度：${{ beginner: '初級', advanced: '上級' }[ai]}`));
    await page.locator('button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    const after = await page.evaluate(() => {
      const { S, rules } = window.__mathjong;
      return { mode: rules.config.mode, deck: S.game.tileType.length, len: S.match.length, ai: S.matchSettings.ai, scores: S.match.scores.slice(), hist: S.history.length, played: S.match.played, renchan: S.match.renchan, wins: S.match.wins.slice(), seed: S.seedBase, next: S.nextMode, round: S.round, hintOpen: S.hintOpen, hints: S.hintsUsed, label: document.querySelector('.hand-label').textContent };
    });
    assert.equal(after.mode, startMode, `もう一度遊ぶは ${startMode} のまま（予約中の ${pending} にならない）`);
    assert.equal(after.deck, startMode === 'math1' ? 124 : 168);
    assert.equal(after.len, length, '局数も同じ');
    assert.equal(after.ai, ai, 'AI 難易度も同じ');
    assert.deepEqual([after.scores, after.hist, after.played, after.renchan, after.wins, after.round, after.label, after.hintOpen, after.hints], [[100, 100, 100, 100], 0, 0, 0, [0, 0, 0, 0], 1, '東1局', false, 0], '得点・履歴・局数・連荘・和了回数・ヒントは初期化');
    assert.notEqual(after.seed, before.seed, '新しい山（seed）');
    assert.equal(after.next, pending, '予約中の次回用モードは保持（再試合には影響しない）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-A 監査 P2-1：もう一度遊ぶは同じ設定（数学Ⅰ→Ⅱ予約・Ⅱ→Ⅰ予約の両方向）で、seed・得点・履歴・ヒントを初期化');

  // (2) P2-2：連荘99→100・通し局数999→1000・大きな値の再現 URL の往復（山・配牌・親席・親番・連荘回数が一致）
  for (const [name, start, expect] of [
    ['連荘99→100', 'seed=4242&round=150&dealer=0&hand=0&renchan=99&len=4&mode=math1', { renchan: 100, round: 151, label: '東1局' }],
    ['局数999→1000', 'seed=4242&round=999&dealer=0&hand=0&renchan=0&len=8&mode=math2', { renchan: 1, round: 1000, label: '東1局' }],
    ['大きな値', 'seed=999999999&round=499999&dealer=0&hand=0&renchan=499998&len=8&mode=math1', { renchan: 499999, round: 500000, label: '東1局' }],
  ]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { query: '' });
    await page.goto(`${LOCAL}?${start}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    let st = await matchState(page);
    assert.equal(st.renchan, Number(start.match(/renchan=(\d+)/)[1]), `${name}: 開始時の連荘回数が読めている`);
    assert.equal(st.round, Number(start.match(/round=(\d+)/)[1]));
    // 親（自分）がツモ和了 → 連荘で次の局へ（正規の進行で出力される値）
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.renchan, st.round, st.label], [expect.renchan, expect.round, expect.label], `${name}: 正規の進行`);
    const deal = await dealOf(page);
    const { q } = await reproQuery(page);
    const parsed = Object.fromEntries(new URLSearchParams(q.slice(1)));
    assert.equal(Number(parsed.renchan), expect.renchan, `${name}: URL に連荘回数 ${expect.renchan} を出力`);
    assert.equal(Number(parsed.round), expect.round);
    await page.goto(`${LOCAL}${q}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const st2 = await matchState(page);
    assert.deepEqual([st2.renchan, st2.round, st2.label, st2.dealer, st2.length, st2.mode], [expect.renchan, expect.round, expect.label, 0, Number(parsed.len), parsed.mode], `${name}: 往復で同じ局面設定（黙って別の局面にならない）`);
    assert.deepEqual(await dealOf(page), deal, `${name}: 同じ山・配牌・親席`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 通常の連荘局（東2局・連荘1）と、従来の seed と round だけの URL
  {
    const { ctx, page, errors } = await v3Page(browser, 'math2', { query: '&len=8' });
    await page.evaluate(() => window.__mathjong.goRound(5, 0));
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.hand = 1; S.match.renchan = 1; S.match.startDealer = 3; S.dealer = 0; render(); });
    const { q } = await reproQuery(page);
    assert.match(q, /round=5&dealer=0&hand=1&renchan=1&len=8&mode=math2/);
    const st1 = await matchState(page);
    await page.goto(`${LOCAL}?seed=321&round=3&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const old = await matchState(page);
    assert.deepEqual([old.label, old.renchan, old.dealer, old.round], ['東3局', 0, 2, 3], '従来の seed と round だけの URL');
    assert.equal(st1.renchan, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 範囲外・不正な値・不可能な組み合わせは拒否（別の局面として黙って始めず、エラー画面からタイトルへ戻れる）
  for (const bad of ['renchan=1000000', 'renchan=-1', 'renchan=1.5', 'renchan=1e3', 'renchan=abc', 'round=1000001', 'round=-3', 'round=0', 'round=2.5', 'round=99999999999999999999',
    'hand=8', 'dealer=4', 'len=5', 'mode=math3',
    'round=1&hand=0&renchan=999999&dealer=0&len=4', 'round=100&hand=0&renchan=100&dealer=0&len=4', 'round=100&hand=2&renchan=98&dealer=2&len=4', 'round=10&hand=4&renchan=0&dealer=0&len=4']) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=77&${bad}&speed=slow`);
    await page.waitForSelector('.replay-error', { timeout: 5000 });
    assert.match(await page.locator('.re-title').innerText(), /再現URLの局状態が不正です/, bad);
    assert.ok((await page.locator('.re-list li').count()) >= 1, `${bad}: 理由を表示`);
    assert.equal(await page.locator('.hand .tile').count(), 0, `${bad}: 対局を始めない`);
    assert.equal(await page.evaluate(() => window.__mathjong.S.game), null);
    await page.locator('button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    assert.ok(!new URL(page.url()).search, `${bad}: 戻ると URL の検索部分を外す（再読み込みで同じエラーに戻らない）`);
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 受理される組み合わせ（境界）
  for (const [q, label, renchan] of [['round=1&hand=0&renchan=0&dealer=0&len=4', '東1局', 0], ['round=100&hand=0&renchan=99&dealer=0&len=4', '東1局', 99], ['round=100&hand=2&renchan=97&dealer=2&len=4', '東3局', 97], ['round=1000000&hand=0&renchan=999999&dealer=0&len=4', '東1局', 999999], ['round=10&hand=7&renchan=0&dealer=3&len=8', '南4局', 0]]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${LOCAL}?seed=77&${q}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const st = await matchState(page);
    assert.deepEqual([st.label, st.renchan], [label, renchan], q);
    await ctx.close();
  }
  // 上限（通し局数 1,000,000）に達したら試合を終える（出力する値を読み取りの範囲内に保つ）
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { query: '' });
    await page.goto(`${LOCAL}?seed=9&round=1000000&dealer=0&hand=0&renchan=999999&len=8&mode=math1&speed=slow`);
    await page.waitForSelector('.hand .tile');
    assert.deepEqual([(await matchState(page)).round, (await matchState(page)).renchan], [1000000, 999999], '上限の値も読める');
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '最終結果へ', '連荘でも上限で試合終了');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // (3) P3-1：再現情報の注意書き（設定・局結果）。URL から復元すると全員100点から
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { query: '&len=4' });
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    const caveat = /このURLでは山・配牌・親・局状態を再現します。持ち点や過去の対局履歴は復元されず、全員100点から開始します。/;
    assert.match(await page.locator('.overlay .result .report-info').innerText(), caveat, '局結果の再現情報');
    assert.deepEqual((await matchState(page)).scores, [112, 96, 96, 96]);
    await page.locator('button[data-action="close-result"]').tap();
    const { info, q } = await reproQuery(page);
    assert.match(info, caveat, '設定の再現情報');
    // 注意書きは再現情報の中（別の画面を開かない）。長すぎず、横にはみ出さない
    // （終局後は設定を閉じると局結果へ戻るので、局結果を閉じてから設定を開き直す）
    await page.locator('button[data-action="close-result"]').tap();
    await page.locator('button[data-action="settings"]').tap();
    const m = await page.evaluate(() => { const c = document.querySelector('.report-caveat'); const mo = document.querySelector('.modal'); return { inside: !!c.closest('.report-info'), fs: parseFloat(getComputedStyle(c).fontSize), over: mo.scrollWidth - mo.clientWidth, len: c.textContent.length }; });
    assert.ok(m.inside && m.fs >= 11 && m.over <= 0 && m.len <= 70, JSON.stringify(m));
    await page.goto(`${LOCAL}${q}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const st = await matchState(page);
    assert.deepEqual(st.scores, [100, 100, 100, 100], 'URL から復元すると全員100点');
    assert.deepEqual([st.label, st.dealer, st.round], ['東1局', 0, 1], '山・親・局状態は再現');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-A 監査 P2-2・P3-1：連荘99→100／通し局数999→1000／大きな値の再現 URL の往復・従来 URL・不正な整数の拒否・上限での試合終了・再現情報の注意書き（全員100点から）');
}

// ---- Ver.0.4-A 最終修正（PR #9）：終了理由（通常終了／通し局数の上限）と不可能な局状態の再現 URL ----
const LIMIT_NOTE = '通し局数の上限（1,000,000局）に達したため、試合を終了しました。親の連荘もここで終了します。';
// ---- Ver.0.4-B：AI 難易度・ポンのオートパス ----
const PA_OTHERS = [V3_O1, ['=1/√3', 'cos', 'cos', '180', '150', '150', '=√3', '=√3'], ['=1/2', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']];
const PA_DRAWS = ['45', '=-1/√3', '=-√3/2', '=-1/√2'];
// 上家（席3）が 1/2 を捨てたときに自分（席0）ができること（数学Ⅰ）
const PA_HANDS = {
  chiPon: ['=1/2', '=1/2', 'sin', '30', '0', '0', '135', '=-√3'], // チー＋ポン
  pon: ['=1/2', '=1/2', '45', '0', '0', '135', '=-√3', 'tan'], // ポンのみ
  chi: ['=1/2', '45', 'sin', '30', '0', '0', '135', '=-√3'], // チーのみ
  ronPon: ['=1/2', '=1/2', 'tan', '45', '=1', 'cos', '180', '=-1'], // ロン＋ポン
  ronPonChi: ['=1/2', '=1/2', 'sin', '30', 'cos', '60', 'sin', '150'], // ロン＋ポン＋チー
};
async function paSettings(page, chi, pon) {
  // Ver.0.5-A：対戦画面の切替ボタンで設定する
  for (const [kind, on] of [['chi', chi], ['pon', pon]]) {
    if ((await apToggleOn(page, kind)) !== on) await apToggle(page, kind).tap();
    assert.equal(await apToggleOn(page, kind), on);
  }
}
async function paClaim(page, hand, { hint = false } = {}) {
  await v3Scene(page, presetWall(hand, PA_DRAWS, PA_OTHERS));
  if (hint) await page.locator('button[data-action="hint"]').tap(); // ヒントは局の開始で閉じるので、局面を作った後に開く
  await apToSeat3(page);
  await apForce(page, 3, 'v:1/2');
  await v3WaitHuman(page);
  return v3State(page);
}
const paStored = (page) => page.evaluate(() => { try { return [localStorage.getItem('mj-chi-autopass'), localStorage.getItem('mj-pon-autopass')]; } catch { return 'ERR'; } });

async function v04bLevels(browser) {
  // (1) タイトルで選んだ難易度が試合の AI 全員に使われる。もう一度遊ぶでも同じ。最終結果に実際の難易度を表示
  for (const [lv, label] of [['beginner', '初級'], ['advanced', '上級']]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    await page.locator(`label.setting.radio:has(input[value="${lv}"])`).tap();
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    // AI の手番を何回か進める（自分はツモ牌を捨てる）
    for (let i = 0; i < 3; i++) {
      await v3WaitHuman(page);
      const p = await page.evaluate(() => { const q = window.__mathjong.S.game.pending(); return q && { type: q.type, seat: q.seat }; });
      if (!p) break;
      if (p.type === 'turn') await apDiscardDrawn(page);
      else await page.locator('button[data-action="pass"]').tap();
    }
    const d = await page.evaluate(() => ({ ...window.__mathjong.S.aiDecisions, ms: window.__mathjong.S.matchSettings.ai }));
    assert.equal(d.ms, lv);
    assert.ok(d[lv] > 0, `${lv} の AI が判断 ${JSON.stringify(d)}`);
    for (const other of ['beginner', 'intermediate', 'advanced']) if (other !== lv) assert.equal(d[other] || 0, 0, `${other} は使わない`);
    // 試合を終わらせて最終結果（東4局で親が流局 → 終了）
    await page.evaluate(() => { const { S } = window.__mathjong; S.match.hand = 3; S.match.startDealer = 1; });
    await forceDraw(page);
    await page.waitForSelector('button[data-action="next"]', { timeout: 5000 });
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.final');
    const info = await page.locator('.final-info').innerText();
    assert.match(info, new RegExp(`AI難易度：${label}`));
    assert.doesNotMatch(info, /準備中/);
    // もう一度遊ぶ：同じ難易度（タイトルの選択を変えても試合の設定を使う）
    await page.evaluate(() => { window.__mathjong.S.ai = 'intermediate'; window.__mathjong.S.aiDecisions = {}; });
    await page.locator('button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    for (let i = 0; i < 2; i++) {
      await v3WaitHuman(page);
      const p = await page.evaluate(() => { const q = window.__mathjong.S.game.pending(); return q && q.type; });
      if (!p) break;
      if (p === 'turn') await apDiscardDrawn(page); else await page.locator('button[data-action="pass"]').tap();
    }
    const d2 = await page.evaluate(() => ({ ...window.__mathjong.S.aiDecisions, ms: window.__mathjong.S.matchSettings.ai }));
    assert.equal(d2.ms, lv, 'もう一度遊ぶは同じ難易度');
    assert.ok(d2[lv] > 0 && !d2.intermediate, JSON.stringify(d2));
    // 再現 URL に難易度が入る
    await page.locator('button[data-action="settings"]').tap();
    assert.match(await page.locator('.report-info code').innerText(), new RegExp(`&ai=${lv}$`));
    assert.match(await page.locator('.report-info').innerText(), new RegExp(`AI ${label}`));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (2) 再現 URL の ai：指定どおりの難易度で始まる。不正な値はエラー画面
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=12&round=1&dealer=1&hand=0&renchan=0&len=4&mode=math1&ai=beginner&speed=test`);
    await page.waitForSelector('.hand .tile');
    await page.waitForFunction(() => (window.__mathjong.S.aiDecisions.beginner || 0) > 0);
    assert.equal(await page.evaluate(() => window.__mathjong.S.matchSettings.ai), 'beginner');
    await page.goto(`${LOCAL}?seed=12&round=1&ai=expert`);
    await page.waitForSelector('.replay-error');
    assert.match(await page.locator('.re-list').innerText(), /ai/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：AI難易度（タイトル → 試合の AI 全員・もう一度遊ぶで維持・最終結果・再現 URL）');
}

async function v04bPonAutoPass(browser) {
  // (1) 保存値：'1' だけが ON。切り替えると '1'／'0' を保存。チーの保存キー・値は従来どおり
  for (const [saved, on] of [[null, false], ['1', true], ['0', false], ['true', false], [' 1', false]]) {
    const init = saved === null ? null : { fn: (v) => { try { localStorage.setItem('mj-pon-autopass', v); } catch { /* */ } }, arg: saved };
    const { ctx, page, errors } = await v3Page(browser, 'math1', { init });
    assert.equal(await page.evaluate(() => window.__mathjong.S.ponAutoPass), on, `保存値 ${saved}`);
    assert.equal(await apToggleOn(page, 'pon'), on);
    assert.match(await apToggle(page, 'pon').innerText(), new RegExp(`ポン自動\\s*${on ? 'ON' : 'OFF'}`));
    if (saved === null) {
      await apToggle(page, 'pon').tap();
      assert.deepEqual(await paStored(page), [null, '1']);
      assert.equal(await apToggleOn(page, 'pon'), true);
      await apToggle(page, 'pon').tap();
      assert.deepEqual(await paStored(page), [null, '0']);
      await apToggle(page, 'chi').tap();
      assert.deepEqual(await paStored(page), ['1', '0'], 'チーとポンは独立');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：ポンのオートパスの保存（mj-pon-autopass、"1" だけ ON）・チーと独立');

  // (2) チー＋ポンが可能（ロン不可）：4つの組合せ。ヒントは表示中の選択肢と同じ経路。通知は見送った候補に応じる
  const combos = [[false, false, ['pon', 'chi', 'pass']], [true, false, ['pon', 'pass']], [false, true, ['chi', 'pass']], [true, true, null]];
  for (const [chi, pon, buttons] of combos) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await paSettings(page, chi, pon);
    const st = await paClaim(page, PA_HANDS.chiPon, { hint: true });
    const where = `チー${chi ? 'ON' : 'OFF'}・ポン${pon ? 'ON' : 'OFF'}`;
    if (buttons) {
      assert.deepEqual(st.p, { seat: 0, type: 'claim', ron: false, chi: 1, pon: true }, where);
      assert.deepEqual(st.buttons.filter((b) => b !== 'hint' && b !== 'autosort' && b !== 'guide' && b !== 'settings'), buttons, where);
      assert.equal(st.autoPass, 0);
      const h = await page.evaluate(async ([base, set]) => {
        const { yakuCandidates, claimForSeat } = await import(`${base}src/engine/yakuhint.js`);
        const { claimPendingForHint } = await import(`${base}src/ui/autopass.js`);
        const { S, rules } = window.__mathjong;
        const g = S.game;
        const c = claimForSeat(claimPendingForHint(g.pending(), set), 0, (id) => g.typeOf(id));
        const exp = yakuCandidates(rules, g.viewFor(0), { claim: c }).map((x) => `${x.name}|${x.missing === 0 ? '完成！' : `あと${x.missing}枚`}`);
        const shown = [...document.querySelectorAll('.yaku-cands li')].map((li) => `${li.querySelector('b').textContent}|${li.querySelector('.yc-miss').textContent}`);
        return { exp, shown, chiRoute: c.chiMelds.length, ponRoute: c.ponMeld !== null };
      }, [BASE, { chi, pon }]);
      assert.deepEqual(h.shown, h.exp, `${where}：ヒントは表示中の宣言経路`);
      assert.equal(h.chiRoute, buttons.includes('chi') ? 1 : 0, where);
      assert.equal(h.ponRoute, buttons.includes('pon'), where);
    } else {
      // 両方 ON：宣言全体を自動パス → 自分のツモ番に「チー・ポンを自動で見送りました」
      assert.equal(st.autoPass, 1, where);
      assert.deepEqual([st.p.seat, st.p.type], [0, 'turn']);
      assert.equal(st.status, 'チー・ポンを自動で見送りました');
      assert.equal(await page.evaluate(() => window.__mathjong.S.game.melds[0].length), 0);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：チー＋ポン可能（4組合せ：全部／ポン／チー／自動パス）・ヒントの経路一致・通知');

  // (3) ポンのみ・チーのみ：それぞれの設定だけで自動パス。通知の文言
  for (const [hand, chi, pon, auto, notice] of [
    [PA_HANDS.pon, false, true, true, 'ポンを自動で見送りました'],
    [PA_HANDS.pon, true, false, false, null],
    [PA_HANDS.chi, true, false, true, 'チーを自動で見送りました'],
    [PA_HANDS.chi, false, true, false, null],
  ]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await paSettings(page, chi, pon);
    const st = await paClaim(page, hand);
    if (auto) {
      assert.equal(st.autoPass, 1);
      assert.equal(st.status, notice);
    } else {
      assert.equal(st.autoPass, 0);
      assert.equal(st.p.type, 'claim');
      assert.ok(st.buttons.includes(hand === PA_HANDS.pon ? 'pon' : 'chi'));
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：ポンのみ・チーのみ（各設定で自動パス・通知の区別）');

  // (4) ロン＋ポン／ロン＋ポン＋チー：ロンは必ず表示し自動パスしない。チー・ポンは各設定に従う
  for (const [hand, chi, pon, buttons] of [
    [PA_HANDS.ronPon, true, true, ['ron', 'pass']],
    [PA_HANDS.ronPon, false, false, ['ron', 'pon', 'pass']],
    [PA_HANDS.ronPonChi, true, true, ['ron', 'pass']],
    [PA_HANDS.ronPonChi, false, true, ['ron', 'chi', 'pass']],
    [PA_HANDS.ronPonChi, true, false, ['ron', 'pon', 'pass']],
  ]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await paSettings(page, chi, pon);
    const st = await paClaim(page, hand);
    assert.equal(st.autoPass, 0, 'ロンがあれば自動パスしない');
    assert.equal(st.p.ron, true);
    // チーの候補が複数（sin30・cos60・sin150）なら、チーのボタンは候補の数だけ並ぶ
    assert.deepEqual([...new Set(st.buttons.filter((b) => ['ron', 'pon', 'chi', 'pass'].includes(b)))], buttons);
    assert.match(st.passText, /^ロンしない/);
    await page.locator('button[data-action="ron"]').tap();
    assert.equal((await v3State(page)).result.winner, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：ロン＋ポン・ロン＋ポン＋チー（ロンは表示・自動パスなし、チー・ポンは各設定）');

  // (5) 宣言中に設定を変えても選択肢は変わらず、次の宣言から反映
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    let st = await paClaim(page, PA_HANDS.chiPon);
    assert.deepEqual(st.buttons.filter((b) => ['ron', 'pon', 'chi', 'pass'].includes(b)), ['pon', 'chi', 'pass']);
    await paSettings(page, true, true);
    st = await v3State(page);
    assert.deepEqual(st.buttons.filter((b) => ['ron', 'pon', 'chi', 'pass'].includes(b)), ['pon', 'chi', 'pass'], '表示中の宣言は変わらない');
    assert.equal(st.autoPass, 0);
    await page.locator('button[data-action="pass"]').tap();
    st = await paClaim(page, PA_HANDS.chiPon);
    assert.equal(st.autoPass, 1, '次の宣言から ON');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (6) 自動パス後、後続の他家のロンで局が終わったら通知は次局に持ち越さない
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await paSettings(page, true, true);
    await v3Scene(page, presetWall(PA_HANDS.chiPon, PA_DRAWS, [['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '30'], PA_OTHERS[1], PA_OTHERS[2]]));
    await apToSeat3(page);
    await apForce(page, 3, 'v:1/2');
    await page.waitForFunction(() => !window.__mathjong.S.game.pending(), null, { timeout: 8000 });
    const r = await page.evaluate(() => ({ ...window.__mathjong.S.autoPass, result: window.__mathjong.S.game.result }));
    assert.equal(r.count, 1, '自動パスした');
    assert.equal(r.result.winner, 1, '下家のロン（後続のロンを妨げない）');
    assert.equal(r.noticePending, false);
    assert.equal(r.noticeKind, null);
    await page.evaluate(() => window.__mathjong.startRound());
    await v3WaitHuman(page);
    const st = await v3State(page);
    assert.doesNotMatch(st.status, /自動で見送りました/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：宣言中の設定変更は次の宣言から・後続のロンを妨げない・通知を次局へ持ち越さない');

  // (7) 320〜430px：2つのスイッチと宣言ボタン（ロン＋ポン＋チー）が画面に収まる
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { viewport: { width: w, height: 700 } });
    for (const kind of ['chi', 'pon']) {
      const b = await apToggle(page, kind).boundingBox();
      assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= w + 0.5, `${w}px ${kind} ${JSON.stringify(b)}`);
    }
    await paClaim(page, PA_HANDS.ronPonChi);
    for (const sel of ['ron', 'pon', 'chi', 'pass']) {
      const b = await page.locator(`.bar button[data-action="${sel}"]`).first().boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= w + 0.5 && b.height >= 40, `${w}px ${sel} ${JSON.stringify(b)}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${w}px 横スクロール`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v04b-ronponchi-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B：320／375／430px（スイッチ2つ・ロン＋ポン＋チーのボタン）');
}

// ---- Ver.0.5-A：リーチ ----
const RI_HAND = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45']; // 0 を捨てて =1 待ち、45 を捨てて =0 待ち
const RI_O1 = ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'];
const RI_O2 = ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'];
const RI_O3 = ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', '=-√3'];
const riState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const g = S.game;
  g.checkInvariants();
  const p = g.pending();
  return {
    p: p && { seat: p.seat, type: p.type, canTsumo: p.canTsumo ?? null }, riichi: g.riichi.map((r) => !!r), input: { ...S.input },
    buttons: [...document.querySelectorAll('.bar button[data-action]')].map((b) => b.dataset.action),
    status: (document.querySelector('.bar .actions .status') || {}).textContent?.trim() || '',
    taps: document.querySelectorAll('.hand .tile.tap').length, locked: document.querySelectorAll('.hand .tile.locked').length,
    hand0: g.hands[0].length, river0: g.rivers[0].length, drawn: g.drawn,
  };
});
// 自分の打牌番で止まるまで待つ
const riWaitTurn = (page) => page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return p && p.seat === 0 && p.type === 'turn'; }, null, { timeout: 8000 });

async function v05Riichi(browser) {
  // (1) 自分のリーチ：宣言 → 聴牌になる牌だけ選べる → 宣言牌 → 以後ツモ切りだけ → ツモで基本点＋1
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await v3Page(browser, mode);
    await v3Scene(page, presetWall(RI_HAND, ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'], [RI_O1, RI_O2, RI_O3]));
    let st = await riState(page);
    assert.ok(st.buttons.includes('riichi'), `${mode}：聴牌ならリーチのボタン`);
    await page.locator('button[data-action="riichi"]').tap();
    st = await riState(page);
    assert.deepEqual(st.buttons.filter((b) => b.startsWith('riichi')), ['riichi-cancel', 'riichi-discard']);
    assert.equal(st.taps, 2, '聴牌になる牌（0・45）だけ選べる');
    assert.equal(st.locked, 7);
    // やめる → 通常の打牌に戻る
    await page.locator('button[data-action="riichi-cancel"]').tap();
    st = await riState(page);
    assert.equal(st.taps, 9);
    await page.locator('button[data-action="riichi"]').tap();
    // 選べない牌（sin）はタップしても選択されない
    const sinId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'f:sin'); });
    await page.locator(`.hand .tile[data-id="${sinId}"]`).tap({ force: true });
    assert.equal(await page.evaluate(() => window.__mathjong.S.selected), null);
    assert.equal(await page.locator('button[data-action="riichi-discard"]').isDisabled(), true);
    const zeroId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'a:0'); });
    await page.locator(`.hand .tile[data-id="${zeroId}"]`).tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    st = await riState(page);
    assert.deepEqual(st.riichi, [true, false, false, false]);
    assert.equal(await page.locator('.self .riichi-badge').count(), 1, '自分の表示にリーチ');
    assert.equal(await page.locator('.river.mine .tile.riichi-decl').count(), 1, '宣言牌に印');
    assert.match(await page.locator('.msg').innerText(), /リーチ/);
    // 他家は（強制的に）ツモ切り → 自分の番：ツモ切りだけ
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    await riWaitTurn(page);
    st = await riState(page);
    assert.equal(st.p.canTsumo, false);
    assert.ok(st.buttons.includes('tsumogiri') && !st.buttons.includes('discard') && !st.buttons.includes('riichi'));
    assert.match(st.status, /リーチ中：ツモ切り/);
    assert.equal(st.taps, 1, 'ツモ牌だけ選べる');
    // ツモ牌以外をエンジンに直接渡しても拒否される（画面の制限だけに頼らない）
    const bypass = await page.evaluate(() => { const { S } = window.__mathjong; const g = S.game; const other = g.hands[0].find((x) => x !== g.drawn); try { g.discard(0, other); return 'accepted'; } catch (e) { return e.message; } });
    assert.match(bypass, /tsumogiri only/);
    await page.locator('button[data-action="tsumogiri"]').tap();
    st = await riState(page);
    assert.equal(st.river0, 2);
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    await riWaitTurn(page);
    st = await riState(page);
    assert.equal(st.p.canTsumo, true, '=1 を引いてツモ和了できる');
    assert.ok(st.buttons.includes('tsumo') && st.buttons.includes('tsumogiri'));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.result');
    const res = await page.evaluate(() => { const { S } = window.__mathjong; const r = S.game.result; return { points: r.points, riichi: r.analysis.riichi, bonus: r.analysis.riichiBonus, delta: S.match.scores.map((x, i) => x - S.prevScores[i]) }; });
    assert.equal(res.riichi, true);
    assert.equal(res.bonus, 1);
    const yakuText = await page.locator('.result .yaku').innerText();
    assert.match(yakuText, /リーチ\s*\+1/);
    assert.match(yakuText, new RegExp(`合計\\s*${res.points}点`));
    // 親（自分）のツモ：子3人が 2×和了点ずつ（和了点はリーチ込み）
    assert.deepEqual(res.delta, [6 * res.points, -2 * res.points, -2 * res.points, -2 * res.points]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-A：リーチ（宣言・聴牌の牌だけ選択・やめる・ツモ切りだけ・エンジンも拒否・ツモで＋1・親の精算）数学Ⅰ・Ⅱ');

  // (2) リーチ後は自分にチー・ポンの選択肢が出ない（上家の sin：リーチ前ならチー・ポンできる形）。ロンは出る
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    const hand = ['sin', 'sin', '30', '=1/2', 'cos', '180', '=-1', '45'];
    await v3Scene(page, presetWall(hand, ['0', '=-1/√3', '=-√3/2', 'sin'], [RI_O1.map((x) => (x === 'sin' ? '135' : x)), RI_O2, RI_O3]));
    await page.locator('button[data-action="riichi"]').tap();
    const zeroId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'a:0'); });
    await page.locator(`.hand .tile[data-id="${zeroId}"]`).tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    await apForce(page, 1); await apForce(page, 2);
    await apForce(page, 3, 'f:sin');
    const claim = await page.evaluate(() => { const g = window.__mathjong.S.game; const p = g.pending(); return p && p.seat === 0 && p.type === 'claim' ? { chi: p.chi.length, pon: !!p.pon } : null; });
    assert.equal(claim, null, 'リーチ後は宣言待ちにならない（チー・ポンなし、ロンもない形）');
    await riWaitTurn(page);
    const st = await riState(page);
    assert.ok(!st.buttons.includes('chi') && !st.buttons.includes('pon'));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-A：リーチ後はチー・ポンの選択肢が出ない');

  // (3) AI のリーチ：聴牌した AI はリーチを宣言し、対戦画面に表示する（初級・中級・上級）
  for (const ai of ['beginner', 'intermediate', 'advanced']) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await page.evaluate((a) => { window.__mathjong.S.matchSettings.ai = a; }, ai);
    // 下家（席1）に聴牌の手（不要牌 0 をツモ）。自分はツモ切り
    await v3Scene(page, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=-1/√2', '=-1/√2', '=√3', '=√3'], ['=-1', '0'], [RI_HAND, RI_O2, RI_O3]));
    await apDiscardDrawn(page);
    await page.waitForFunction(() => window.__mathjong.S.game.riichi[1] !== null || window.__mathjong.S.game.rivers[1].length > 0, null, { timeout: 8000 });
    const st = await riState(page);
    assert.equal(st.riichi[1], true, `${ai}：下家がリーチ`);
    assert.equal(await page.locator('.panel.seat-1 .riichi-badge').count(), 1, `${ai}：下家の表示にリーチ`);
    assert.equal(await page.locator('.panel.seat-1 .river .tile.riichi-decl').count(), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-A：AI のリーチ（初級・中級・上級）と対戦画面の表示');

  // (4) 320／375／430px：リーチのボタン・宣言牌の選択・ツモ切りが画面に収まる
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { viewport: { width: w, height: 700 } });
    await v3Scene(page, presetWall(RI_HAND, ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=-1/√3'], [RI_O1, RI_O2, RI_O3]));
    for (const sel of ['button[data-action="riichi"]', 'button[data-action="discard"]']) {
      const b = await page.locator(sel).boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= w + 0.5 && b.height >= 44, `${w}px ${sel} ${JSON.stringify(b)}`);
    }
    await page.locator('button[data-action="riichi"]').tap();
    for (const sel of ['button[data-action="riichi-cancel"]', 'button[data-action="riichi-discard"]']) {
      const b = await page.locator(sel).boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= w + 0.5 && b.height >= 44, `${w}px ${sel} ${JSON.stringify(b)}`);
    }
    await page.locator('.hand .tile.tap').first().tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    await riWaitTurn(page);
    const b = await page.locator('button[data-action="tsumogiri"]').boundingBox();
    assert.ok(b && b.x + b.width <= w + 0.5 && b.height >= 44, `${w}px ツモ切り ${JSON.stringify(b)}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${w}px 横スクロール`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05-riichi-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-A：320／375／430px（リーチ・宣言牌の選択・ツモ切り）');
}

// ---- Ver.0.5-B：ロン・ポン・チーの演出 ----
const FX_O1 = ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'];
const FX_O2 = ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'];
const FX_O3 = ['=1/2', 'tan', 'tan', '120', '120', '90', '=-1/√2', '=-1/√2']; // 席3：=1/2 を持つ（上家の打牌）
const fxState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const l = document.getElementById('fx-layer');
  const g = S.game;
  const p = g && g.pending();
  return {
    cls: l.className, word: (l.querySelector('.fx-word') || {}).textContent || '', who: (l.querySelector('.fx-who') || {}).textContent || '',
    tiles: l.querySelectorAll('.fx-tiles .fx-t').length, win: l.querySelectorAll('.fx-wintile .tile').length, flash: l.querySelectorAll('.fx-flash').length,
    history: [...S.fx.history], shake: document.querySelectorAll('.table.fx-shake').length, glow: document.querySelectorAll('.meld.fx-glow').length,
    events: g ? g.events.length : null, p: p && { seat: p.seat, type: p.type }, modal: S.modal, mode: S.fx.mode,
  };
});
const fxGone = (page) => page.waitForFunction(() => document.getElementById('fx-layer').className === '' && document.getElementById('fx-layer').innerHTML === '', null, { timeout: 5000 });
// 自分の打牌 → 下家・対面の打牌（ツモ牌）→ 上家が =1/2 を捨てる。自分の宣言待ちで止まる
async function fxToClaim(page, hand, others = [FX_O1, FX_O2, FX_O3], draws = ['45', '=-1/√3', '=-√3/2', '=-1/√2']) {
  await v3Scene(page, presetWall(hand, draws, others));
  await apDiscardDrawn(page);
  await apForce(page, 1); await apForce(page, 2);
  await apForce(page, 3, 'v:1/2');
  await v3WaitHuman(page);
}

async function v05bEffects(browser) {
  // (1) ポン・チー：自分の鳴き。演出が出て、終わると消える。ゲームの進行は演出と無関係に進む
  for (const [kind, hand, word, tiles] of [
    ['pon', ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150'], 'ポン！', 3],
    ['chi', ['=1/2', '45', 'sin', '30', '0', '0', '135', '=-√3'], 'チー！', 3],
  ]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await fxToClaim(page, hand);
    assert.deepEqual((await fxState(page)).history, [], '鳴く前は演出なし');
    const evBefore = (await fxState(page)).events;
    await page.locator(`button[data-action="${kind}"]`).first().tap();
    let st = await fxState(page);
    assert.equal(st.cls, `fx-${kind}`, `${kind}：演出のレイヤー`);
    assert.equal(st.word, word);
    assert.equal(st.tiles, tiles, '鳴いた面子の3枚');
    assert.equal(st.who, 'あなた');
    assert.deepEqual(st.history, [kind]);
    assert.ok(st.glow === 1, '鳴いた面子が光る');
    assert.deepEqual(st.p, { seat: 0, type: 'turn' }, '進行は演出を待たず、自分の打牌番');
    assert.equal(st.events, evBefore + 1, '記録は鳴きの1件だけ増える（演出は記録を増やさない）');
    // 演出中も操作できる：ヒント・自動パスの切替・手牌の選択（タップを通す）
    await page.locator('button[data-action="hint"]').tap();
    assert.equal(await page.evaluate(() => window.__mathjong.S.hintOpen), true, '演出中もヒントが開く');
    await apToggle(page, 'pon').tap();
    assert.equal(await apToggleOn(page, 'pon'), true, '演出中も自動パスを切り替えられる');
    // 再描画（ヒント・切替）でも演出は途切れず、同じ演出の二重発火もない
    assert.deepEqual((await fxState(page)).history, [kind]);
    await fxGone(page);
    st = await fxState(page);
    assert.deepEqual([st.cls, st.glow, st.shake], ['', 0, 0], '終わると消える');
    assert.deepEqual(st.history, [kind], '1回だけ');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：ポン・チーの演出（文字・3枚・面子の発光）・終わると消える・演出中もヒント／自動パスの切替が可能・記録を増やさない');

  // (2) ロン：自分のロン（赤〜金の演出・画面揺れ・和了牌）。結果画面・精算は従来どおり
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3', '=-√3/2', '=-1/√2'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await page.locator('.hand .tile.tap.drawn').tap(); await page.locator('.hand .tile.tap.drawn').tap(); // 0 を捨てる（=1 待ち）
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    assert.equal((await v3State(page)).p.ron, true);
    await page.locator('button[data-action="ron"]').tap();
    let st = await fxState(page);
    assert.equal(st.cls, 'fx-ron');
    assert.equal(st.word, 'ロン！');
    assert.equal(st.win, 1, '和了牌を大きく表示');
    assert.equal(st.flash, 1, 'フラッシュ');
    assert.equal(st.shake, 1, '画面揺れ（盤面だけ。操作バーは動かさない）');
    assert.equal(st.modal, 'result', '結果画面は演出を待たずに開く（進行・精算は従来どおり）');
    const res = await page.evaluate(() => { const { S } = window.__mathjong; const r = S.game.result; return { winner: r.winner, how: r.how, points: r.points, delta: S.match.scores.map((x, i) => x - S.prevScores[i]) }; });
    assert.deepEqual([res.winner, res.how], [0, 'ron']);
    assert.deepEqual(res.delta, [6 * res.points, -6 * res.points, 0, 0], '精算は演出と無関係（親ロン 6B）');
    // 揺れるのは盤面だけ：操作バー（固定配置）は動かない
    assert.equal(await page.evaluate(() => document.querySelector('.bar').closest('.fx-shake')), null, '操作バーは揺れる盤面（.table）の外');
    assert.equal(await page.evaluate(() => !!document.querySelector('.table').contains(document.querySelector('.bar'))), false);
    await fxGone(page);
    st = await fxState(page);
    assert.deepEqual([st.cls, st.shake], ['', 0]);
    assert.deepEqual(st.history, ['ron']);
    // 結果画面から次の局へ：演出の持ち越しなし・従来どおり進む
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await fxState(page);
    assert.deepEqual([st.cls, st.history.length, st.modal], ['', 1, null]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：ロンの演出（文字・和了牌・フラッシュ・盤面だけの揺れ）・結果画面と精算は従来どおり・次の局へ持ち越さない');

  // (3) AI のロン・ポン：他家の鳴き・和了でも演出が出る（AI の名前を表示）
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['=1', 'sin', 'sin', '0', '90', '=-√3', '=√3', '150'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'],
      [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], FX_O2, FX_O3])); // 下家（席1）は =1 待ちの聴牌
    await page.locator('.hand .tile.tap:not(.drawn)').first().evaluate((e) => e.click()); // 何もしない（選択のみ）
    const oneId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:1'); });
    await page.locator(`.hand .tile[data-id="${oneId}"]`).tap();
    await page.locator(`.hand .tile[data-id="${oneId}"]`).tap();
    await page.waitForFunction(() => window.__mathjong.S.fx.history.includes('ron'), null, { timeout: 8000 });
    const st = await fxState(page);
    assert.equal(st.word, 'ロン！');
    assert.equal(st.who, 'AI-A', '和了した AI の名前');
    assert.equal(st.modal, 'result');
    assert.equal((await page.evaluate(() => window.__mathjong.S.game.result.winner)), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    // AI のポン：自分（席0）が =1/2 を捨て、下家（席1・速攻型）が対々和に向かう手（=1/2 の対子と sin の刻子）でポンする
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['=1/2', 'sin', 'sin', '0', '90', '=-√3', '=√3', '150'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'],
      [['=1/2', '=1/2', 'sin', 'sin', 'sin', '0', '0', '=-√3'], FX_O2, FX_O3.map((x) => (x === '=1/2' ? '=-1' : x))]));
    const halfId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:1/2'); });
    await page.locator(`.hand .tile[data-id="${halfId}"]`).tap();
    await page.locator(`.hand .tile[data-id="${halfId}"]`).tap();
    await page.waitForFunction(() => window.__mathjong.S.fx.history.includes('pon'), null, { timeout: 8000 });
    const st = await fxState(page);
    assert.equal(st.word, 'ポン！');
    assert.equal(st.who, 'AI-A', 'ポンした AI の名前');
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.melds[1].length), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：AI のロン・ポンでも演出（AI の名前を表示）');

  // (4) 重なり：表示中のロンを後から来たポン・チーで潰さない。ポン → ロン は入れ替わる。進行・記録は変わらない
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    const before = await fxState(page);
    const seq = await page.evaluate(() => {
      const { S, fx } = window.__mathjong;
      const g = S.game;
      const ev = g.events.length;
      const out = [];
      const snap = () => out.push(document.getElementById('fx-layer').className);
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap();
      fx.fire('pon', { type: 'pon', seat: 2, tile: g.hands[2][0] }); snap(); // 高い優先度は入れ替える
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap(); // 低い優先度は無視
      fx.fire('ron', { type: 'win', seat: 3, how: 'ron', from: 0 }); snap();
      fx.fire('pon', { type: 'pon', seat: 2, tile: g.hands[2][0] }); snap(); // ロン表示中は潰さない
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap();
      return { out, history: [...S.fx.history], eventsSame: g.events.length === ev, pending: JSON.stringify(g.pending()) };
    });
    assert.deepEqual(seq.out, ['fx-chi', 'fx-pon', 'fx-pon', 'fx-ron', 'fx-ron', 'fx-ron']);
    assert.deepEqual(seq.history, ['chi', 'pon', 'ron'], '潰された演出は記録に残らない');
    assert.equal(seq.eventsSame, true, '演出はゲームの記録を変えない');
    assert.equal(JSON.stringify((await page.evaluate(() => window.__mathjong.S.game.pending()))), seq.pending, '進行は変わらない');
    await fxGone(page);
    // 局の切り替え・タイトルへ戻る：演出が残らない
    await page.evaluate(() => window.__mathjong.fx.fire('pon', { type: 'pon', seat: 1, tile: window.__mathjong.S.game.hands[1][0] }));
    await page.evaluate(() => window.__mathjong.startRound());
    assert.equal((await fxState(page)).cls, '', '新しい局で演出を消す');
    await page.evaluate(() => window.__mathjong.fx.fire('chi', { type: 'chi', seat: 1, tile: window.__mathjong.S.game.hands[1][0] }));
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    assert.equal((await fxState(page)).cls, '', 'タイトルへ戻ると演出を消す');
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.timer), null, '演出のタイマーも止まる');
    assert.deepEqual(errors, []);
    void before;
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：演出が重なっても進行・記録は不変（ロン優先）・新しい局／タイトルで演出を消す');

  // (5) リーチ・自動パス・ヒントとの競合なし：リーチ中のロン演出／自動パスでポンを見送れば演出は出ない
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    // 自分がリーチ → 下家が =1 を捨てて、リーチ中の自分がロン（演出あり、ロンは自動パスされない）
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0', '=-1/√3', '=-√3/2'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await page.locator('button[data-action="riichi"]').tap();
    const zeroId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'a:0'); });
    await page.locator(`.hand .tile[data-id="${zeroId}"]`).tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    assert.deepEqual((await fxState(page)).history, [], 'リーチ宣言では演出を出さない');
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    await apToggle(page, 'chi').tap(); await apToggle(page, 'pon').tap(); // 自動パス ON でも、ロンは出る
    assert.equal((await v3State(page)).p.ron, true);
    await page.locator('button[data-action="ron"]').tap();
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-ron');
    const res = await page.evaluate(() => window.__mathjong.S.game.result);
    assert.equal(res.analysis.riichi, true, 'リーチ＋1は従来どおり');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await paSettings(page, true, true); // チー・ポンの自動パス ON（この手は sin150°=1/2 でチーもできるので両方 ON）
    await fxToClaim(page, ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']);
    const st = await fxState(page);
    assert.equal(st.history.length, 0, '自動パスで見送ったポンは鳴いていないので演出なし');
    assert.deepEqual([st.p.seat, st.p.type], [0, 'turn']);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：リーチ・自動パス・ヒントと競合しない（ロンは自動パスされず演出、見送ったポンは演出なし）');

  // (6) 簡易表示：設定で切替。文字だけ（フラッシュ・揺れ・牌・発光なし）。保存は 'lite'
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="fx-mode"]').inputValue(), 'full');
    await page.locator('select[data-action="fx-mode"]').selectOption('lite');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-effects')), 'lite');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await page.locator('.hand .tile.tap.drawn').tap(); await page.locator('.hand .tile.tap.drawn').tap();
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    await page.locator('button[data-action="ron"]').tap();
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-ron lite');
    assert.deepEqual([st.word, st.flash, st.win, st.tiles, st.shake, st.glow], ['ロン！', 0, 0, 0, 0, 0], '簡易：文字だけ');
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.mode), 'lite', '再読み込みでも保持');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // reduced motion（OS の「視差効果を減らす」）も文字だけ
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?mode=math1&seed=1&speed=slow`);
    await page.waitForSelector('.hand .tile');
    await page.evaluate(() => { const { S, fx } = window.__mathjong; fx.fire('ron', { type: 'win', seat: 1, how: 'ron', from: 0 }); });
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-ron lite');
    assert.equal(st.shake, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：簡易表示（設定・保存・文字だけ）と reduced motion');

  // (7) 320／375／430px：演出の文字・牌・名前が画面内に収まり、横スクロールが出ない。ロンの揺れで操作バーがずれない
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { viewport: { width: w, height: 700 } });
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    for (const kind of ['ron', 'pon', 'chi']) {
      await page.evaluate((k) => {
        const { S, fx } = window.__mathjong; const g = S.game;
        S.game.result = k === 'ron' ? { ...(g.result || {}), tile: g.hands[0][0] } : g.result;
        if (k !== 'ron') g.melds[1].push({ meld: 0, kind: 'formula', call: k, tiles: g.hands[1].slice(0, 3), claimed: g.hands[1][0], from: 0 });
        fx.fire(k, { type: k === 'ron' ? 'win' : k, seat: 1, how: 'ron', from: 0, tile: g.hands[1][0] });
      }, kind);
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const l = document.getElementById('fx-layer');
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
        return { word: r(l.querySelector('.fx-word')), card: r(l.querySelector('.fx-card')), over: document.documentElement.scrollWidth - innerWidth, fs: parseFloat(getComputedStyle(l.querySelector('.fx-word')).fontSize), vh: innerHeight };
      });
      assert.ok(m.card.l >= -1 && m.card.r <= w + 1, `${w}px ${kind}：演出が画面の幅に収まる ${JSON.stringify(m.card)}`);
      assert.ok(m.word.t >= 0 && m.word.b <= m.vh, `${w}px ${kind}：文字が画面の高さに収まる`);
      assert.ok(m.fs >= 40, `${w}px ${kind}：文字の大きさ ${m.fs}px`);
      assert.ok(m.over <= 0, `${w}px ${kind}：横スクロールなし`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05b-${kind}-${w}.png` });
      await fxGone(page);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：320／375／430px で演出（ロン・ポン・チー）が画面内に収まる');
}

async function v04End(browser) {
  const open = async (q) => {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=31&${q}&speed=slow`);
    await page.waitForSelector('.hand .tile');
    return { ctx, page, errors };
  };
  const endInfo = (page) => page.evaluate(() => { const { S } = window.__mathjong; return { over: S.match.over, reason: S.match.endReason, hist: S.history.length, scores: S.match.scores.slice(), played: S.match.played, round: S.round, log: S.match.log.length }; });
  const resultText = (page) => page.locator('.overlay .result').innerText();
  const finalText = async (page) => { await page.locator('button[data-action="next"]').tap(); await page.waitForSelector('.overlay .final'); return page.locator('.overlay .final').innerText(); };
  const LIMIT_URL = 'round=1000000&dealer=0&hand=0&renchan=0&len=8&mode=math1';

  // (1) 上限の局で親が和了：上限による終了（連荘もここで終わる）。精算は1回だけ。局結果と最終結果で理由が一致
  {
    const { ctx, page, errors } = await open(LIMIT_URL);
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    const info = await endInfo(page);
    assert.deepEqual([info.over, info.reason, info.hist, info.scores, info.log], [true, 'round-limit', 1, [112, 96, 96, 96], 1], '精算は1回だけ');
    const rt = await resultText(page);
    assert.ok(rt.includes(LIMIT_NOTE), '局結果に上限の説明');
    assert.ok(!/親が和了したので連荘/.test(rt), '連荘はここで終了');
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '最終結果へ');
    const ft = await finalText(page);
    assert.ok(ft.includes(LIMIT_NOTE), '最終結果にも同じ説明');
    // 上限終了後は次局へ進めない（もう一度「次へ」を押す手段がなく、状態も変わらない）
    assert.equal(await page.locator('.final button[data-action="next"]').count(), 0);
    assert.deepEqual(await endInfo(page), info, '最終結果の表示で精算を重ねない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (2) 上限の局で流局
  {
    const { ctx, page, errors } = await open(LIMIT_URL);
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    const info = await endInfo(page);
    assert.deepEqual([info.over, info.reason, info.scores], [true, 'round-limit', [100, 100, 100, 100]]);
    assert.ok((await resultText(page)).includes(LIMIT_NOTE));
    assert.ok((await finalText(page)).includes(LIMIT_NOTE));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (3) 上限の局で子（下家）がツモ和了：親交代で続くはずの試合も上限で終了
  {
    const { ctx, page, errors } = await open(LIMIT_URL);
    await v3Scene(page, presetWall(['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'], ['=-√3/2', '=1'], [TSUMO_HAND, V3_O2, V3_O3]));
    await apDiscardDrawn(page);
    await page.waitForSelector('.overlay .result', { timeout: 10000 });
    const info = await endInfo(page);
    assert.deepEqual([info.over, info.reason, info.hist], [true, 'round-limit', 1]);
    assert.equal((await page.evaluate(() => window.__mathjong.S.game.result.winner)), 1, '下家のツモ和了');
    assert.deepEqual(info.scores, [96, 112 - 4, 96 + 2, 96 + 2].map((x, i) => [96, 108, 98, 98][i]), '子ツモ：和了者 +4B、親 −2B、ほかの子 −B');
    assert.ok((await resultText(page)).includes(LIMIT_NOTE));
    assert.ok((await finalText(page)).includes(LIMIT_NOTE));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (4) 同じ上限の局で通常の終了条件（最終の親番）も満たす：通常終了を優先し、上限の説明は出さない
  {
    const { ctx, page, errors } = await open('round=1000000&dealer=3&hand=3&renchan=0&len=4&mode=math1');
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    const info = await endInfo(page);
    assert.deepEqual([info.over, info.reason], [true, 'normal']);
    const rt = await resultText(page);
    assert.ok(!rt.includes('上限') && /試合終了/.test(rt), '通常終了に上限の説明は出さない');
    assert.ok(!(await finalText(page)).includes('上限'));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (5) 通常の東4局終了・南4局終了：上限の説明なし。通常の連荘規則は維持（上限の1局前でも連荘）
  for (const q of ['round=4&dealer=3&hand=3&renchan=0&len=4&mode=math1', 'round=8&dealer=3&hand=7&renchan=0&len=8&mode=math1']) {
    const { ctx, page, errors } = await open(q);
    await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    assert.deepEqual((await endInfo(page)).reason, 'normal', q);
    assert.ok(!(await resultText(page)).includes('上限'));
    assert.ok(!(await finalText(page)).includes('上限'));
    await ctx.close();
    assert.deepEqual(errors, []);
  }
  {
    const { ctx, page, errors } = await open('round=999999&dealer=0&hand=0&renchan=0&len=8&mode=math1');
    await v3Scene(page, presetWall(TSUMO_HAND, ['=1'], [V3_O1, V3_O2, V3_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    await page.waitForSelector('.overlay .result');
    const info = await endInfo(page);
    assert.deepEqual([info.over, info.reason], [false, null], '上限の1局前の連荘は通常どおり続く');
    assert.match(await resultText(page), /親が和了したので連荘/);
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '次の局へ');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.deepEqual([(await matchState(page)).round, (await matchState(page)).renchan], [1000000, 1]);
    // 次の URL（上限の局）も読み取れる
    await page.locator('button[data-action="settings"]').tap();
    const q2 = (await page.locator('.report-info').innerText()).match(/(\?seed=\S+)/)[1];
    assert.match(q2, /round=1000000&dealer=0&hand=0&renchan=1&len=8/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (6) 不可能な局状態の再現 URL はエラー画面（理由つき）。正常な URL とは区別され、旧形式は従来どおり
  {
    const { ctx, page } = await open('round=1&dealer=0&hand=0&renchan=0&len=4');
    await page.goto(`${LOCAL}?seed=9&round=1&dealer=0&hand=0&renchan=999999&len=4&mode=math2&speed=slow`);
    await page.waitForSelector('.replay-error');
    assert.match(await page.locator('.re-list').innerText(), /不可能な局状態/);
    assert.equal(await page.locator('.hand .tile').count(), 0);
    await page.goto(`${LOCAL}?seed=321&round=3&speed=slow`);
    await page.waitForSelector('.hand .tile');
    const old = await matchState(page);
    assert.deepEqual([old.label, old.renchan, old.dealer, old.round], ['東3局', 0, 2, 3], '旧形式の URL は従来どおり');
    await ctx.close();
  }
  console.log('✓ Ver.0.4-A 最終修正：終了理由（上限の局で親和了・子和了・流局→round-limit／通常終了を優先／東4局・南4局は通常）・精算1回・局結果と最終結果で一致・不可能な局状態の URL はエラー画面・旧形式は従来どおり');
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
  // 開発用：--only 関数名,… で一部の検査だけを実行する（全体の E2E OK とは区別して表示）
  const ONLY = opt('--only', null);
  if (ONLY) {
    const fns = { chiAutoPass, chiAutoPassLayouts, v03Rules, v03bHints, v04Match, v04Fixes, v04End, v04bLevels, v04bPonAutoPass, v05Riichi, v05bEffects };
    for (const n of ONLY.split(',')) await fns[n](browser);
    console.log(`E2E PARTIAL OK（--only ${ONLY}）`);
  } else {
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
  await handReorderP22(browser);
  await chiAutoPass(browser);
  await chiAutoPassLayouts(browser);
  await v03Rules(browser);
  await v03bHints(browser);
  await v04Match(browser);
  await v04Fixes(browser);
  await v04End(browser);
  await v04bLevels(browser);
  await v04bPonAutoPass(browser);
  await v05Riichi(browser);
  await v05bEffects(browser);
  // Ver.0.3：数学Ⅱ・数学Ⅰを交互に（ポン・刻子を含む新規則）。旧規則でも1回（互換）。
  for (const [i, dev] of DEVICES.entries()) {
    const rounds = i === 0 ? ROUNDS : Math.max(2, Math.ceil(ROUNDS / 2));
    const mode = i % 2 === 0 ? 'math2' : 'math1';
    await playDevice(browser, dev, 4242 + i * 101, rounds, stats, { mode });
    console.log(`✓ ${dev.name}: ${mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'} ${rounds}局 完走`);
  }
  await playDevice(browser, DEVICES[0], 4242, 2, stats, { mode: 'legacy' });
  console.log(`✓ ${DEVICES[0].name}: 旧規則（Ver.0.2.1 互換）2局 完走`);
  for (const [i, dev] of [DEVICES[0], { ...DEVICES[1], name: 'Android 横 (915×412)', viewport: { width: 915, height: 412 } }].entries()) {
    const mode = i === 0 ? 'math1' : 'math2';
    await playDevice(browser, dev, 5151 + i * 37, 3, stats, { autopass: true, mode });
    console.log(`✓ ${dev.name}: チーのオートパス ON・${mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'}で3局 完走`);
  }
  console.log(JSON.stringify({ ...stats, seconds: (Date.now() - t0) / 1000 }));
  console.log('E2E OK');
  }
} catch (e) {
  console.error('E2E FAILED');
  console.error(e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
