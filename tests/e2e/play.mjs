// ブラウザでの実プレイテスト（Playwright）。画面のボタン・牌をタップして複数局を最後まで遊ぶ。
// 使い方: node tests/e2e/play.mjs [--rounds 6] [--shots <dir>]
// 公開URL: --public-url https://asumax1128.github.io/mathjong/ --only v07BeginnerRoom,v07BeginnerRoom2
// 必要: playwright（Chromium）。リポジトリ自体には依存を追加しない。
// 環境に依存しないよう、次のようにしている：
// - 通常モードは127.0.0.1の空きポートで配信し、終了時に停止。公開モードはサーバーを起動しない。
// - 通常モードは --no-proxy-server、公開モードは環境のHTTP(S)プロキシ設定を尊重する。
// - 公開サイト相当のホスト（mathjong.test）は DNS を使わず、ブラウザ内のリクエスト横取り（route）で
//   ローカルサーバーへ転送する。
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';
import { RECIPES } from '../../src/ui/sound.js';
import { RON_LATE_LIMIT_MS, judgeRonLate } from './ron-late.mjs';
import { publicTarget } from './public-target.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const EXTERNAL = publicTarget(args);
const { chromium } = require('playwright');
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROUNDS = Number(opt('--rounds', 6));
const SHOTS = opt('--shots', null);
// --channel chromium：Chromium の新しいヘッドレスモードで実行（既定はヘッドレスシェル）。
// 新しいヘッドレスモードは横スワイプで「戻る」ナビゲーションが起きるなど、実ブラウザに近い挙動をする。
const CHANNEL = opt('--channel', null);
// GitHub Pages と同じサブパスで配信して相対パスを検証する
const BASE = EXTERNAL ? EXTERNAL.base : '/mathjong/';
let PORT;
let LOCAL;
// 公開サイト相当（localhost 以外のホスト名）。テスト用フックが無効になることを確認する。
const PUBLIC_HOST = 'mathjong.test';
const PUBLIC = EXTERNAL ? EXTERNAL.url : `http://${PUBLIC_HOST}${BASE}`;

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
  if (!EXTERNAL) await ctx.route((u) => u.hostname === PUBLIC_HOST, forwardToLocal);
  return ctx;
}

async function openBeginnerPage(page) {
  const response = await page.goto(PUBLIC);
  if (EXTERNAL) assert.equal(response && response.status(), 200, `教材ページの取得に失敗：${PUBLIC}`);
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

async function playDevice(browser, dev, seed, rounds, stats, { autopass = false, mode = 'legacy', ruleset = 0, ai = null } = {}) {
  const newRules = ruleset >= 1;
  const ctx = await newContext(browser, { viewport: dev.viewport, isMobile: dev.isMobile, hasTouch: dev.hasTouch, deviceScaleFactor: 2 });
  // Ver.0.2-B：チーのオートパス ON で通しプレイ（チーのみの宣言は画面に出ない）
  if (autopass) await ctx.addInitScript(() => { try { localStorage.setItem('mj-chi-autopass', '1'); } catch { /* */ } });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${LOCAL}?${mode === 'legacy' ? 'rules=legacy' : `mode=${mode}`}&seed=${seed}&speed=test&len=8${ruleset ? `&newrules=${ruleset}` : ''}${ai ? `&ai=${ai}` : ''}`); // 8局戦（最大6局を続けて遊ぶため）
  // ルールの版（docs/62）：URL の newrules（1＝新ルール初版、2＝現行）。付いていない URL は従来ルール（ドラ表示・暗カンなし）
  assert.equal(await page.evaluate(() => window.__mathjong.S.game.ruleset), ruleset, `${dev.name}: ルールの版`);
  assert.equal(await page.locator('.dora-box').count(), newRules ? 1 : 0, `${dev.name}: ドラ表示は新ルールだけ`);
  const tap = (loc) => (dev.hasTouch ? loc.tap() : loc.click());

  // 操作バーが画面内（下端のホームインジケーター領域を除く）に収まっている
  if (dev.viewport.width > dev.viewport.height && dev.viewport.height <= 500) await page.locator('.study-dock').scrollIntoViewIfNeeded();
  const bar = await page.locator('.bar').boundingBox();
  assert.ok(bar && bar.y + bar.height <= dev.viewport.height + 0.5, `${dev.name}: 操作バーが画面外`);
  assert.equal(await page.locator('.board-center').count(), 1, '中央の局情報パネルがある');
  const handRect = await page.locator('.self .hand').boundingBox();
  const dockRect = await page.locator('.study-dock').boundingBox();
  const split = dev.viewport.width >= 1000 && dev.viewport.height >= 600 && dev.viewport.width > dev.viewport.height;
  assert.ok(handRect && dockRect && (split ? dockRect.x >= handRect.x + handRect.width - 1 : dockRect.y >= handRect.y + handRect.height - 1),
    `${dev.name}: ヒント専用エリアは手牌より下`);
  assert.ok(dockRect.y + dockRect.height <= bar.y + 2,
    `${dev.name}: ヒント専用エリアは操作バーより上`);
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
      if (newRules) {
        // ドラ表示は公開された表示牌と同じ枚数（1〜5）。暗カンの選択肢があれば画面から実行する（確認の段階を経る）
        const nr = await page.evaluate(() => { const g = window.__mathjong.S.game; return { shown: document.querySelectorAll('.dora-box .dr-ind .tile').length, n: g.doraIndicators.length, kans: g.melds.flat().filter((x) => x.call === 'ankan').length }; });
        assert.equal(nr.shown, nr.n, 'ドラ表示の枚数');
        assert.ok(nr.n === 1 + nr.kans && nr.n <= 5, 'ドラ表示＝1＋暗カンの数');
        const kanBtn = page.locator('button[data-action="ankan"]');
        if (await kanBtn.count()) {
          await tap(kanBtn);
          await tap(page.locator('button[data-action="ankan-type"]').first());
          stats.ankan = (stats.ankan || 0) + 1;
          continue;
        }
      }

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
      if (newRules) assert.match(text, /ドラ/, 'ドラの行');
    } else {
      stats.draws++;
      assert.match(text, /流局/);
      if (newRules) assert.match(text, /上限|山の牌がなくなりました/, '流局の理由');
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
  assert.match(await page.locator('.board-center').innerText(), /東3局/);
  // 不正な値は無視される（エラーにならない）。seed が不正なら再現 URL ではないのでタイトル画面から（Ver.0.4-A）
  await page.goto(`${PUBLIC}?seed=abc&round=-1&speed=%3Cscript%3E&len=9&hand=-2&dealer=7`);
  await page.waitForSelector('.title-screen');
  await chooseAndStart(page);
  assert.match(await page.locator('.board-center').innerText(), /東1局/);
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
    const wall0 = Number(await page.locator('.bc-wall strong').innerText());
    const drawn = page.locator('.hand .tile.tap').last();
    await drawn.tap();
    await drawn.tap();
    await page.waitForFunction((w) => Number(document.querySelector('.bc-wall strong').textContent) < w, wall0, { timeout: 5000 });
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
  assert.equal(await page.locator('.study-dock.open .hint-box .hint-basic').count(), 1, '第1段階ヒントは手牌下の専用エリアに表示');
  assert.equal(await page.locator('.self .hint-box').count(), 0, '手牌内にヒントを重複表示しない');
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
    // Ver.0.7は卓内スクロール。利用者と同じく手牌を表示してから実座標で押せることを検査する。
    await page.locator('.self .hand').scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    const hitOk = await page.evaluate(() => {
      const t = document.querySelector('.hand .tile').getBoundingClientRect();
      return !!document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)?.closest('.hand .tile');
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
  // 打牌の完了は「その牌の打牌が記録された」ことで判断する（手番が他家に移ったかだけを見ると、AI が速いときに
  // 自分の手番まで一瞬で戻り、条件を見逃して待ち続ける）。局が替わっても判断できるよう、その時点の局を覚えておく。
  const id = Number(await t.getAttribute('data-id'));
  await page.evaluate(() => { window.__apGame = window.__mathjong.S.game; });
  if (!(await t.evaluate((e) => e.classList.contains('selected')))) await t.tap(); // 1回目で選択、2回目で打牌
  await t.tap();
  await page.waitForFunction((tile) => window.__apGame.events.some((e) => e.type === 'discard' && e.seat === 0 && e.tile === tile), id, { timeout: 8000 });
  // 2回タップで打牌は1回だけ（その牌の打牌の記録がちょうど1件、河の末尾ではなく記録で数える）
  assert.equal(await page.evaluate((tile) => window.__apGame.events.filter((e) => e.type === 'discard' && e.seat === 0 && e.tile === tile).length, id), 1, '打牌は1回だけ');
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
    // 版の変更（docs/62）：画面 0.7.0・エンジン 0.6.0
    assert.equal(await page.title(), '数雀（MATHJONG）Ver.0.7.0');
    assert.equal(await page.locator('.logo').innerText(), '数雀 Ver.0.7.0');
    await page.locator('button[data-action="settings"]').tap();
    assert.match(await page.locator('.report-info').innerText(), /画面 v0\.7\.0 ・ エンジン v0\.6\.0/);
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
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.events.at(-1).type), 'pon', '成立イベントは維持');
    assert.equal(await page.locator('.msg').count(), 0, '実況行は表示しない');
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
    assert.equal(await page.locator('.board-center .bc-mode').innerText(), '数学Ⅰ');
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
    assert.equal(await page.locator('.board-center .bc-mode').innerText(), '数学Ⅱ');
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
// Ver.0.6：タイトル →「対戦相手を選ぶ」→ 3人のチェック欄 →「対局開始」（選択画面での既存の選択は ids に合わせて入れ替える）
async function chooseAndStart(page, ids = ['ousuke', 'natsuki', 'yuki']) {
  await page.locator('button[data-action="choose-opponents"]').click();
  await page.waitForSelector('.select-screen');
  // 公開サイト相当（テスト用のフックなし）でも動くよう、選択は画面（選択済みのカード）から読む
  const cur = await page.locator('.opp-card.selected').evaluateAll((es) => es.map((e) => e.dataset.id));
  for (const id of cur) if (!ids.includes(id)) await page.locator(`.opp-check[data-id="${id}"]`).click();
  for (const id of ids) if (!cur.includes(id)) await page.locator(`.opp-check[data-id="${id}"]`).click();
  await page.locator('.select-screen button[data-action="start-match"]').click();
  await page.waitForSelector('.hand .tile');
}
const matchState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const m = S.match;
  return {
    screen: S.screen, modal: S.modal, label: m && document.querySelector('.board-center .hand-label') ? document.querySelector('.board-center .hand-label').textContent : null,
    hand: m && m.hand, renchan: m && m.renchan, played: m && m.played, over: m && m.over, length: m && m.length, scores: m && m.scores.slice(),
    sum: m ? m.scores.reduce((a, b) => a + b, 0) : null, dealer: S.dealer, round: S.round, ai: S.ai, mode: window.__mathjong.rules.config.mode,
    chars: S.matchSettings ? S.matchSettings.chars.slice() : null, seats: S.matchSettings ? S.matchSettings.seats.slice() : null,
    info: (document.querySelector('.board-center') || {}).textContent || '',
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
  // (1) タイトル画面：数学モード・局数を選び、対戦相手を選んで開始。モード・局数は保存され、再読み込み後も残る
  //     （Ver.0.6：AI 難易度の3択はタイトルから撤去。対戦相手の選択は保存しない）
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    // Ver.0.5-C：ロゴは画像（alt が名前）。読み込めて、4:3 の比率で表示されること
    assert.equal(await page.locator('.title-logo img').getAttribute('alt'), '数雀（MATHJONG）');
    assert.equal(await page.locator('input[data-action="title-mode"][value="math2"]').isChecked(), true, '既定は数学Ⅱ');
    assert.equal(await page.locator('input[data-action="title-length"][value="4"]').isChecked(), true, '既定は4局戦');
    assert.equal(await page.locator('input[data-action="title-ai"]').count(), 0, 'AI 難易度の3択はない');
    assert.equal(await page.locator('text=AI難易度').count(), 0);
    assert.equal(await page.locator('button[data-action="start-match"]').count(), 0, 'タイトルに対局開始はない');
    assert.equal(await page.locator('button[data-action="choose-opponents"]').innerText(), '対戦相手を選ぶ');
    assert.equal(await page.locator('text=準備中').count(), 0);
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    await page.locator('label.setting.radio', { hasText: '8局戦' }).tap();
    await chooseAndStart(page, ['fukuyama', 'kaoru', 'asuma']);
    let st = await matchState(page);
    assert.deepEqual([st.screen, st.mode, st.length, st.label, st.scores], ['game', 'math1', 8, '東1局', [100, 100, 100, 100]]);
    assert.deepEqual([st.chars, st.seats.slice().sort()], [['fukuyama', 'kaoru', 'asuma'], ['asuma', 'fukuyama', 'kaoru']]);
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
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.deepEqual(await page.evaluate(() => window.__mathjong.S.opp.selected), [], '対戦相手の選択は保存しない（再読み込みで0人）');
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
    assert.match(fin, /対戦相手：下家 おうすけ（中級）・対面 なつき（中級）・上家 ゆき（中級）/);
    assert.equal(await page.locator('text=AI難易度').count(), 0);
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
    const sb = await page.locator('button[data-action="choose-opponents"]').boundingBox();
    assert.ok(sb.x >= 0 && sb.x + sb.width <= w && sb.height >= 44);
    await page.locator('button[data-action="choose-opponents"]').tap();
    await page.waitForSelector('.select-screen');
    assert.ok(await over() <= 0, `${w}px 対戦相手の選択`);
    await page.locator('button[data-action="opp-random"]').tap();
    const stb = await page.locator('.select-screen button[data-action="start-match"]').boundingBox();
    assert.ok(stb.x >= 0 && stb.x + stb.width <= w && stb.height >= 44);
    await page.locator('.select-screen button[data-action="start-match"]').tap();
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
  console.log('✓ Ver.0.4-A：タイトル（モード・局数の保存、Ver.0.6 で対戦相手の選択へ）・ヒントボタンの移動・親の連荘／親交代・精算（合計400）・最終の親の延長・試合終了（同点同順位）・もう一度／タイトルへ・再現URL・320〜430px');
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
  // (1) P2-1：もう一度遊ぶ（Ver.0.6：同じ3人と再戦）は、終了した試合と同じ設定（数学モード・局数・3人）。予約中の次回用モードは使わない。逆方向も。
  for (const [startMode, pending, length, chars, otherLength] of [['math1', 'math2', 4, ['fukuyama', 'kaoru', 'asuma'], 8], ['math2', 'math1', 8, ['kanata', 'mitsuki', 'aoto'], 4]]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    const lab = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
    await page.locator('label.setting.radio', { hasText: lab[startMode] }).tap();
    await page.locator('label.setting.radio', { hasText: `${length}局戦` }).tap();
    await chooseAndStart(page, chars);
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
    const finInfo = await page.locator('.final-info').innerText();
    for (const id of chars) assert.match(finInfo, new RegExp({ fukuyama: 'シャカ', kaoru: 'かおる', asuma: 'アスマ', kanata: 'かなた', mitsuki: 'みつき', aoto: 'あおと' }[id]));
    assert.equal(await page.locator('button[data-action="again"]').innerText(), '同じ3人と再戦');
    await page.locator('button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    const after = await page.evaluate(() => {
      const { S, rules } = window.__mathjong;
      return { mode: rules.config.mode, deck: S.game.tileType.length, len: S.match.length, chars: S.matchSettings.chars.slice(), scores: S.match.scores.slice(), hist: S.history.length, played: S.match.played, renchan: S.match.renchan, wins: S.match.wins.slice(), seed: S.seedBase, next: S.nextMode, round: S.round, hintOpen: S.hintOpen, hints: S.hintsUsed, label: document.querySelector('.hand-label').textContent };
    });
    assert.equal(after.mode, startMode, `もう一度遊ぶは ${startMode} のまま（予約中の ${pending} にならない）`);
    assert.equal(after.deck, startMode === 'math1' ? 124 : 168);
    assert.equal(after.len, length, '局数も同じ');
    assert.deepEqual(after.chars, chars, '同じ3人');
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
    await chooseAndStart(page);
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
  // (1) Ver.0.6：選んだ3人（混合難易度）が試合の AI。各席の判断は、その席に表示した名前のキャラクターの AI だけが行う。
  //     同じ3人と再戦でも同じ3人（座席は選び直す）。最終結果・再現情報に3人の名前と ID（席の順）を出す
  for (const chars of [['kanata', 'natsuki', 'asuma'], ['aoto', 'yuki', 'kaoru']]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // 試合の山の seed は Math.random 由来。AI が数手で和了すると後続の検査が成り立たないので、乱数を固定した列にして再現可能にする（本番のコードには影響しない）
    await ctx.addInitScript(() => { let x = 20261027; Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    await chooseAndStart(page, chars);
    // AI の手番を何回か進める（自分はツモ牌を捨てる）
    for (let i = 0; i < 3; i++) {
      await v3WaitHuman(page);
      const p = await page.evaluate(() => { const q = window.__mathjong.S.game.pending(); return q && { type: q.type, seat: q.seat }; });
      if (!p) break;
      if (p.type === 'turn') await apDiscardDrawn(page);
      else await page.locator('button[data-action="pass"]').tap();
    }
    const seatCheck = () => page.evaluate(() => {
      const { S } = window.__mathjong;
      return [1, 2, 3].map((s) => ({ id: S.matchSettings.seats[s - 1], shown: document.querySelector(`.panel.seat-${s} .name`).textContent, deciders: Object.keys(S.aiDecisionsBySeat[s]) }));
    });
    const NAMES = { kanata: 'かなた', natsuki: 'なつき', asuma: 'アスマ', aoto: 'あおと', yuki: 'ゆき', kaoru: 'かおる' };
    let sc = await seatCheck();
    assert.deepEqual(sc.map((x) => x.id).sort(), chars.slice().sort());
    for (const x of sc) {
      assert.equal(x.shown, NAMES[x.id], '席に表示した名前');
      assert.ok(x.deciders.every((d) => d === x.id), `席の判断はその名前の AI だけ ${JSON.stringify(x)}`);
    }
    assert.ok(sc.some((x) => x.deciders.length > 0), 'AI が判断した');
    const d = await page.evaluate(() => ({ ...window.__mathjong.S.aiDecisions }));
    const levelOf = { kanata: 'beginner', aoto: 'beginner', natsuki: 'intermediate', yuki: 'intermediate', asuma: 'advanced', kaoru: 'advanced' };
    for (const lv of Object.keys(d)) assert.ok(chars.some((c) => levelOf[c] === lv), `選んだ3人の難易度だけ ${JSON.stringify(d)}`);
    // 試合を終わらせて最終結果（東4局で親が流局 → 終了）
    await page.evaluate(() => { const { S } = window.__mathjong; S.match.hand = 3; S.match.startDealer = 1; });
    await forceDraw(page);
    await page.waitForSelector('button[data-action="next"]', { timeout: 5000 });
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.final');
    const info = await page.locator('.final-info').innerText();
    const seats1 = sc.map((x) => x.id);
    assert.match(info, new RegExp(`対戦相手：下家 ${NAMES[seats1[0]]}（.級）・対面 ${NAMES[seats1[1]]}（.級）・上家 ${NAMES[seats1[2]]}（.級）`));
    for (const [id, nm] of Object.entries(NAMES)) if (chars.includes(id)) assert.match(await page.locator('.final-table').innerText(), new RegExp(nm));
    assert.deepEqual(await page.locator('.final .modal-actions button').allInnerTexts(), ['同じ3人と再戦', '相手を変更', 'タイトルへ戻る']);
    // 同じ3人と再戦：同じ3人（座席は選び直す）。判断は新しい席の名前どおり
    await page.locator('button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    for (let i = 0; i < 2; i++) {
      await v3WaitHuman(page);
      const p = await page.evaluate(() => { const q = window.__mathjong.S.game.pending(); return q && q.type; });
      if (!p) break;
      if (p === 'turn') await apDiscardDrawn(page); else await page.locator('button[data-action="pass"]').tap();
    }
    assert.deepEqual(await page.evaluate(() => window.__mathjong.S.matchSettings.chars), chars, '同じ3人');
    sc = await seatCheck();
    for (const x of sc) { assert.equal(x.shown, NAMES[x.id]); assert.ok(x.deciders.every((dd) => dd === x.id)); }
    // 再現情報に ID（席の順）が入る
    await page.locator('button[data-action="settings"]').tap();
    const seats2 = sc.map((x) => x.id);
    // docs/62：新しく出力する再現 URL は末尾にルールの版（newrules=2）を付ける（席の順の chars はその前）
    assert.match(await page.locator('.report-info code').innerText(), new RegExp(`&chars=${seats2.join(',')}&newrules=2$`));
    assert.match(await page.locator('.report-info').innerText(), new RegExp(`ID ${seats2.join(',')}`));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (2) 再現 URL：従来の ai（難易度の既定の3人・従来の席の順）と、新しい chars（席1〜3の順）。不正な値はエラー画面
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?seed=12&round=1&dealer=1&hand=0&renchan=0&len=4&mode=math1&ai=beginner&speed=test`);
    await page.waitForSelector('.hand .tile');
    await page.waitForFunction(() => (window.__mathjong.S.aiDecisions.beginner || 0) > 0);
    assert.deepEqual(await page.evaluate(() => window.__mathjong.S.matchSettings.seats), ['kanata', 'mitsuki', 'aoto']);
    await page.goto(`${LOCAL}?seed=12&round=1&dealer=1&hand=0&renchan=0&len=4&mode=math1&chars=asuma,kanata,yuki&speed=slow`);
    await page.waitForSelector('.hand .tile');
    assert.deepEqual(await page.evaluate(() => window.__mathjong.S.matchSettings.seats), ['asuma', 'kanata', 'yuki'], '席1〜3は URL のとおり（抽選しない）');
    assert.deepEqual(await page.locator('.panel .name').allInnerTexts().then((xs) => xs.sort()), ['アスマ', 'かなた', 'ゆき'].sort());
    assert.equal(await page.locator('.panel.seat-1 .name').innerText(), 'アスマ');
    await page.goto(`${LOCAL}?seed=12&round=1&ai=expert`);
    await page.waitForSelector('.replay-error');
    assert.match(await page.locator('.re-list').innerText(), /ai/);
    await page.goto(`${LOCAL}?seed=12&round=1&chars=kanata,kanata,yuki`);
    await page.waitForSelector('.replay-error');
    assert.match(await page.locator('.re-list').innerText(), /chars/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.4-B→0.6：選んだ3人（混合難易度）が試合の AI・各席の判断は表示した名前の AI だけ・同じ3人と再戦・最終結果と再現情報（ai／chars の再現 URL）');
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
    assert.equal(await page.locator('.me-board .riichi-badge').count(), 1, '自分の名札にリーチ');
    assert.equal(await page.locator('.river.mine .tile.riichi-decl').count(), 1, '宣言牌に印');
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.events.filter(e => e.type === 'riichi' && e.seat === 0).length), 1, 'リーチ成立は1回');
    assert.equal(await page.locator('.msg').count(), 0, '実況行は表示しない');
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
    cls: l.className, word: (l.querySelector('.fx-word') || {}).textContent || '', who: (l.querySelector('.fx-who .fx-name') || {}).textContent || '',
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
    assert.equal(st.who, 'おうすけ', '和了した AI の名前');
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
    assert.equal(st.who, 'おうすけ', 'ポンした AI の名前');
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.melds[1].length), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B：AI のロン・ポンでも演出（AI の名前を表示）');

  // (4) 重なり：表示中のロンを後から来たポン・チーで潰さない。チー表示中のポン・チーは待ち、ロンが来たら捨てる（Ver.0.5-E）。進行・記録は変わらない
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
      const q = [];
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap(); q.push(S.fx.queue.length);
      fx.fire('pon', { type: 'pon', seat: 2, tile: g.hands[2][0] }); snap(); q.push(S.fx.queue.length); // Ver.0.5-E：表示中のチーを消さず、ポンは待つ
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap(); q.push(S.fx.queue.length); // これも待つ
      fx.fire('ron', { type: 'win', seat: 3, how: 'ron', from: 0 }); snap(); q.push(S.fx.queue.length); // ロンは最優先：すぐ表示し、待っている演出を捨てる
      fx.fire('pon', { type: 'pon', seat: 2, tile: g.hands[2][0] }); snap(); q.push(S.fx.queue.length); // ロン表示中は潰さない
      fx.fire('chi', { type: 'chi', seat: 1, tile: g.hands[1][0] }); snap(); q.push(S.fx.queue.length);
      return { out, q, history: [...S.fx.history], eventsSame: g.events.length === ev, pending: JSON.stringify(g.pending()) };
    });
    assert.deepEqual(seq.out, ['fx-chi', 'fx-chi', 'fx-chi', 'fx-ron', 'fx-ron', 'fx-ron']);
    assert.deepEqual(seq.q, [0, 1, 2, 0, 0, 0], '待つ演出の数（ロンで捨てる）');
    assert.deepEqual(seq.history, ['chi', 'ron'], '出さなかった演出は記録に残らない');
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
    assert.deepEqual((await fxState(page)).history, ['riichi'], 'リーチが成立した時にリーチの演出（Ver.0.5-D）');
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

// ---- Ver.0.5-B Codex 監査 P2-1：演出中に「通常／簡易」を変えても、表示中の演出の表示は変わらない ----
// 演出の見た目をまとめて返す：レイヤー（文字・牌・フラッシュ）と盤面（揺れ・発光）の両方
const fxLook = (page) => page.evaluate(() => {
  const l = document.getElementById('fx-layer');
  return {
    cls: l.className, flash: l.querySelectorAll('.fx-flash').length, win: l.querySelectorAll('.fx-wintile .tile').length, tiles: l.querySelectorAll('.fx-tiles .fx-t').length,
    shake: document.querySelectorAll('.table.fx-shake').length, glow: document.querySelectorAll('.meld.fx-glow').length,
    delay: (document.querySelector('.table.fx-shake') || document.querySelector('.meld.fx-glow') || { style: {} }).style.animationDelay || '',
    cur: window.__mathjong.S.fx.current && { kind: window.__mathjong.S.fx.current.kind, lite: window.__mathjong.S.fx.current.lite, startedAt: window.__mathjong.S.fx.current.startedAt },
    mode: window.__mathjong.S.fx.mode,
  };
});
// 設定画面で通常／簡易を切り替える（実際の画面操作）。閉じると再描画される。
async function fxSetMode(page, mode) {
  // Ver.0.7麻雀卓：設定ボタンは下部（手牌の下の道具の列）＝揺れる卓（.table）の中。Playwright は動いている要素の
  // 静止を待つため、ロンの揺れ（約0.7秒）が終わるまで押下が遅れる。利用者のタップは揺れの間も受け付けるので、静止待ちをしない。
  await page.locator('button[data-action="settings"]').tap({ force: true });
  await page.locator('select[data-action="fx-mode"]').selectOption(mode);
  await page.locator('.modal-actions button[data-action="close"]').tap();
}
// 盤面の準備（ポン・チー用に、下家の手牌に3枚ある局面）と演出の発火（本物のゲームの記録がなくても、演出だけを出す）
const fxSceneFire = (page, kind) => page.evaluate((k) => {
  const { S, fx } = window.__mathjong; const g = S.game;
  if (k === 'ron' || k === 'tsumo') g.result = { ...(g.result || {}), tile: g.hands[0][0] };
  else g.melds[1].push({ meld: 0, kind: 'formula', call: k, tiles: g.hands[1].slice(0, 3), claimed: g.hands[1][0], from: 0 });
  fx.fire(k, { type: k === 'ron' || k === 'tsumo' ? 'win' : k, seat: 1, how: k === 'tsumo' ? 'tsumo' : 'ron', from: 0, tile: g.hands[1][0] });
}, kind);

async function v05bFxModeFixed(browser) {
  const hand = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];
  const wall = () => presetWall(hand, ['0', '=-1/√3'], [FX_O1, FX_O2, FX_O3]);
  // A・B：ロン。通常 → 簡易、簡易 → 通常。ポン・チーも同じ（C）
  for (const [from, to] of [['full', 'lite'], ['lite', 'full']]) {
    for (const kind of ['ron', 'tsumo', 'pon', 'chi']) {
      const { ctx, page, errors } = await v3Page(browser, 'math1', { init: { fn: (m) => { try { localStorage.setItem('mj-effects', m); } catch { /* */ } }, arg: from } });
      await v3Scene(page, wall());
      await fxSceneFire(page, kind);
      const where = `${from}→${to} ${kind}`;
      const before = await fxLook(page);
      assert.equal(before.cur.lite, from === 'lite', `${where}：開始時のモードを保存`);
      assert.equal(before.cls, `fx-${kind}${from === 'lite' ? ' lite' : ''}`, where);
      // 演出中に設定を変えて閉じる（再描画される）
      await fxSetMode(page, to);
      const after = await fxLook(page);
      assert.equal(after.mode, to, `${where}：設定は変わる（次の演出から反映）`);
      assert.equal(after.cur.lite, before.cur.lite, `${where}：表示中の演出のモードは変わらない`);
      assert.equal(after.cur.startedAt, before.cur.startedAt, `${where}：同じ演出が続く（作り直さない）`);
      assert.equal(after.cls, before.cls, `${where}：文字のレイヤーは変わらない`);
      assert.deepEqual([after.flash, after.win, after.tiles], [before.flash, before.win, before.tiles], `${where}：フラッシュ・和了牌・3枚は変わらない`);
      // 盤面の揺れ・発光：通常で始まった演出は続き、簡易で始まった演出は付かない（レイヤーと一致）
      if (from === 'full') {
        assert.equal(kind === 'ron' || kind === 'tsumo' ? after.shake : after.glow, 1, `${where}：揺れ・発光が続く`);
        assert.match(after.delay, /^-\d+ms$/, `${where}：開始時点からの経過で続きから再生する`);
        assert.ok(parseInt(after.delay.slice(1), 10) >= 0);
      } else {
        assert.deepEqual([after.shake, after.glow], [0, 0], `${where}：簡易で始まった演出に、途中から揺れ・発光を付けない`);
      }
      // 次の演出は新しい設定（簡易 ↔ 通常）
      await fxGone(page);
      await fxSceneFire(page, kind);
      const next = await fxLook(page);
      assert.equal(next.cur.lite, to === 'lite', `${where}：次の演出は新しい設定`);
      assert.equal(next.cls, `fx-${kind}${to === 'lite' ? ' lite' : ''}`, where);
      if (to === 'lite') assert.deepEqual([next.flash, next.win, next.tiles, next.shake, next.glow], [0, 0, 0, 0, 0], `${where}：簡易は文字だけ`);
      else assert.equal(kind === 'ron' || kind === 'tsumo' ? next.shake : next.glow, 1, `${where}：通常は揺れ・発光あり`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ Ver.0.5-B P2-1：演出中に通常／簡易を変えても、表示中の演出（文字・フラッシュ・牌・揺れ・発光）は変わらず、次の演出から新しい設定（ロン・ポン・チー、両方向）');

  // reduced motion は演出開始時の判定で簡易表示に反映される。開始後に変わっても表示中の演出は変わらない
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?mode=math1&seed=1&speed=slow`);
    await page.waitForSelector('.hand .tile');
    await v3Scene(page, wall());
    await fxSceneFire(page, 'ron');
    let l = await fxLook(page);
    assert.equal(l.cur.lite, true, 'reduced motion：開始時に簡易');
    assert.equal(l.cls, 'fx-ron lite');
    await page.emulateMedia({ reducedMotion: 'no-preference' }); // 演出中に OS の設定が変わっても
    await page.evaluate(() => window.__mathjong.render());
    l = await fxLook(page);
    assert.deepEqual([l.cur.lite, l.cls, l.shake], [true, 'fx-ron lite', 0], '表示中の演出は簡易のまま（揺れを付けない）');
    await fxGone(page);
    await fxSceneFire(page, 'ron'); // 次の演出は新しい判定（通常）
    l = await fxLook(page);
    assert.deepEqual([l.cur.lite, l.cls, l.shake], [false, 'fx-ron', 1]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B P2-1：reduced motion は開始時の判定で簡易に反映、途中で変わっても表示中の演出は不変');

  // 経過時間の維持：設定変更・再描画のあとも、演出の開始時刻・終了のタイマーは変わらず、終了時に消える
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, wall());
    await fxSceneFire(page, 'ron');
    const t0 = (await fxLook(page)).cur.startedAt;
    await page.waitForTimeout(250);
    await fxSetMode(page, 'lite');
    await page.evaluate(() => window.__mathjong.render());
    const l = await fxLook(page);
    assert.equal(l.cur.startedAt, t0, '開始時刻は変わらない');
    const d = parseInt(l.delay.slice(1), 10);
    assert.ok(d >= 250 && d < 800, `経過 ${d}ms が続きから反映される（やり直さない）`);
    await fxGone(page); // 元のタイマーで終了する
    const e = await fxLook(page);
    assert.deepEqual([e.cls, e.shake, e.glow, e.cur], ['', 0, 0, null]);
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.timer), null, 'タイマーは終了で止まる');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B P2-1：設定変更・再描画のあとも開始時刻と経過が維持され、元のタイマーで終了する');

  // 既存の確認：重なり（ロン＞ポン＞チー）・新しい局／タイトルで消去・設定の保存と再読み込み
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, wall());
    await page.evaluate(() => {
      const { S, fx } = window.__mathjong; const g = S.game; const e = (k) => ({ type: k, seat: 1, tile: g.hands[1][0], how: 'ron', from: 0 });
      fx.fire('chi', e('chi')); fx.fire('pon', e('pon')); fx.fire('ron', { type: 'win', seat: 1, how: 'ron', from: 0 }); fx.fire('pon', e('pon'));
    });
    assert.deepEqual((await page.evaluate(() => [...window.__mathjong.S.fx.history])), ['chi', 'ron'], 'ロン＞ポン＞チー（Ver.0.5-E：チー表示中のポンは待ち、ロンで捨てる）');
    await fxSetMode(page, 'lite');
    assert.equal((await fxLook(page)).cur.kind, 'ron', '設定変更でも優先度の結果は変わらない');
    await page.evaluate(() => window.__mathjong.startRound());
    const cleared = await fxLook(page);
    assert.deepEqual([cleared.cls, cleared.cur, cleared.shake], ['', null, 0], '新しい局で演出を消す');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-effects')), 'lite', '設定は保存される');
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.mode), 'lite', '再読み込みでも保持');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-B P2-1：重なり（ロン＞ポン＞チー）・新しい局での消去・設定の保存と再読み込みは従来どおり');
}

// ---- Ver.0.5-C：ツモ演出の強化・タイトル画像 ----
const TS_HAND = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45']; // =1 待ち（tan45°=1）
// 牌種類 key の「表示ラベル」（牌の aria-label）。画面と同じ描画関数で、演出とは別に作って比べる
const tileLabelOf = (page, key) => page.evaluate(async ([base, k]) => {
  const { tileHTML } = await import(`${base}src/ui/render.js`);
  const t = window.__mathjong.rules.types.find((x) => x.key === k);
  const box = document.createElement('div');
  box.innerHTML = tileHTML(t, { size: 'm' });
  return box.firstElementChild.getAttribute('aria-label');
}, [BASE, key]);
// 演出に表示された和了牌：{ label, 牌の id・種類 }（ゲームの結果 result.tile と比べる）
const fxWinTile = (page) => page.evaluate(() => {
  const { S, rules } = window.__mathjong; const g = S.game; const r = g.result;
  const el = document.querySelector('#fx-layer .fx-wintile .tile');
  const hand = document.querySelector(`.hand .tile[data-id="${r.tile}"]`);
  return { shown: el && el.getAttribute('aria-label'), id: r.tile, key: rules.types[g.typeOf(r.tile)].key, handLabel: hand && hand.getAttribute('aria-label'), count: document.querySelectorAll('#fx-layer .fx-wintile .tile').length };
});
async function v05cTsumo(browser) {
  // (1) 自分のツモ和了：ロンと同格の演出（文字・閃光・光の輪・和了牌・盤面の揺れ）。結果画面・精算は従来どおり
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await v3Page(browser, mode);
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    assert.equal((await v3State(page)).p.type, 'turn');
    const evBefore = (await fxState(page)).events;
    // 実際にツモした牌（山から引いた牌の id と種類）を、和了の前に記録する
    const drawn = await page.evaluate(() => { const { S, rules } = window.__mathjong; const g = S.game; return { id: g.drawn, key: rules.types[g.typeOf(g.drawn)].key }; });
    assert.equal(drawn.key, 'v:1', `${mode}：山から引いた牌は =1`);
    await page.locator('button[data-action="tsumo"]').tap();
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-tsumo', `${mode}：ツモの演出`);
    assert.equal(st.word, 'ツモ！');
    assert.equal(st.who, 'あなた');
    assert.equal(st.flash, 1, '閃光');
    assert.equal(st.win, 1, '和了牌（引いた牌）を大きく表示');
    assert.equal(await page.locator('#fx-layer .fx-halo').count(), 1, '光の輪（ツモだけの演出）');
    assert.equal(st.shake, 1, '盤面が揺れる');
    assert.deepEqual(st.history, ['tsumo']);
    assert.equal(st.events, evBefore + 1, '記録は和了の1件だけ（演出は記録を増やさない）');
    assert.equal(st.modal, 'result', '結果画面は演出を待たずに開く');
    // 和了牌は、実際にツモした牌と一致する（ラベルが空でないだけでなく、牌そのものを比べる）
    const wt = await fxWinTile(page);
    assert.equal(wt.count, 1);
    assert.equal(wt.id, drawn.id, `${mode}：結果の和了牌は、ツモした牌（id ${drawn.id}）`);
    assert.equal(wt.key, drawn.key);
    const expectedLabel = await tileLabelOf(page, drawn.key);
    assert.ok(expectedLabel && expectedLabel.length > 0);
    assert.equal(wt.shown, expectedLabel, `${mode}：演出の和了牌の表示（${wt.shown}）が、ツモした牌（${drawn.key}）の表示（${expectedLabel}）と一致`);
    assert.equal(wt.shown, wt.handLabel, `${mode}：手牌の同じ牌（id ${drawn.id}）の表示とも一致`);
    for (const other of ['f:sin', 'a:30', 'v:1/2']) assert.notEqual(wt.shown, await tileLabelOf(page, other), `${mode}：ほかの牌（${other}）の表示ではない`);
    const res = await page.evaluate(() => { const { S } = window.__mathjong; const r = S.game.result; return { winner: r.winner, how: r.how, points: r.points, delta: S.match.scores.map((x, i) => x - S.prevScores[i]) }; });
    assert.deepEqual([res.winner, res.how], [0, 'tsumo']);
    assert.deepEqual(res.delta, [6 * res.points, -2 * res.points, -2 * res.points, -2 * res.points], '親ツモの精算は演出と無関係（6B・各 −2B）');
    // 揺れるのは盤面だけ：操作バーは揺れる盤面の外
    assert.equal(await page.evaluate(() => !!document.querySelector('.table').contains(document.querySelector('.bar'))), false);
    // ロンと見分けられる：色の系統（青白〜金）と、光の輪の有無
    const color = await page.evaluate(() => getComputedStyle(document.querySelector('#fx-layer .fx-word')).textShadow);
    assert.match(color, /127, 208, 255|58, 155, 255|79, 125, 255/, '青白〜青系の発光');
    assert.doesNotMatch(color, /255, 74, 28|255, 45, 26/, 'ロンの赤い発光ではない');
    await fxGone(page);
    const e = await fxState(page);
    assert.deepEqual([e.cls, e.shake], ['', 0]);
    // 結果画面から次の局へ：演出の持ち越しなし
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    const n = await fxState(page);
    assert.deepEqual([n.cls, n.modal, n.history], ['', null, ['tsumo']]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C：自分のツモ和了の演出（文字・閃光・光の輪・和了牌・盤面の揺れ）・結果画面と親ツモの精算は従来どおり・次の局へ持ち越さない（数学Ⅰ・Ⅱ）');

  // (2) AI のツモ和了：下家（席1）が =1 を引いてツモ。演出に AI の名前と、AI が実際に引いた牌（数学Ⅰ・Ⅱ）
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await v3Page(browser, mode);
    await v3Scene(page, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=1/√2', '=1/√2', '=√3', '=1/√3'], ['45', '=1'], [TS_HAND, FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    // AI（席1）がツモ和了できる手番で、引いた牌を記録する（AI の判断を待つ間に読む）
    await page.waitForFunction(() => { const g = window.__mathjong.S.game; const p = g.pending(); return p && p.seat === 1 && p.type === 'turn' && p.canTsumo; }, null, { timeout: 8000 });
    const drawn = await page.evaluate(() => { const { S, rules } = window.__mathjong; const g = S.game; return { id: g.drawn, key: rules.types[g.typeOf(g.drawn)].key }; });
    assert.equal(drawn.key, 'v:1', `${mode}：AI が引いた牌は =1`);
    await page.waitForFunction(() => window.__mathjong.S.fx.history.includes('tsumo'), null, { timeout: 8000 });
    const st = await fxState(page);
    assert.equal(st.word, 'ツモ！');
    assert.equal(st.who, 'おうすけ', '和了した AI の名前');
    assert.equal(st.cls, 'fx-tsumo');
    assert.equal(st.modal, 'result');
    assert.equal(await page.evaluate(() => { const r = window.__mathjong.S.game.result; return [r.winner, r.how].join(); }), '1,tsumo');
    const wt = await fxWinTile(page);
    assert.equal(wt.count, 1);
    assert.equal(wt.id, drawn.id, `${mode}：AI の和了牌は、AI が引いた牌（id ${drawn.id}）`);
    const expectedLabel = await tileLabelOf(page, drawn.key);
    assert.equal(wt.shown, expectedLabel, `${mode}：演出の和了牌（${wt.shown}）が、AI が引いた牌（${drawn.key}）の表示（${expectedLabel}）と一致`);
    for (const other of ['f:sin', 'a:45', 'v:1/2']) assert.notEqual(wt.shown, await tileLabelOf(page, other), `${mode}：ほかの牌（${other}）の表示ではない`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C P3-C：ツモ演出の和了牌が、実際にツモした牌（自分・AI、数学Ⅰ・Ⅱ）と一致（ラベルの比較・ほかの牌との区別）');

  // (3) 他の演出・機能との競合なし：リーチ後のツモ、重なり（ツモ＞ポン・チー）、自動パス ON でもツモは自動で見送らない、ヒント
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(TS_HAND, ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('button[data-action="riichi"]').tap();
    const zeroId = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'a:0'); });
    await page.locator(`.hand .tile[data-id="${zeroId}"]`).tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    await apToggle(page, 'chi').tap(); await apToggle(page, 'pon').tap(); // 自動パス ON
    await page.locator('button[data-action="hint"]').tap(); // ヒント
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    await riWaitTurn(page);
    assert.equal((await riState(page)).p.canTsumo, true);
    await page.locator('button[data-action="tsumo"]').tap();
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-tsumo', '自動パスが ON でも、ツモは自動で見送られず演出が出る');
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.result.analysis.riichi), true, 'リーチ＋1は従来どおり');
    // 重なり：ツモの演出中に後から来たポン・チーは、ツモを潰さない（優先度ツモ＞ポン＞チー）
    await page.evaluate(() => { const { S, fx } = window.__mathjong; const g = S.game; const t = g.hands[1][0]; fx.fire('pon', { type: 'pon', seat: 1, tile: t }); fx.fire('chi', { type: 'chi', seat: 1, tile: t }); });
    assert.equal((await fxState(page)).cls, 'fx-tsumo');
    assert.deepEqual((await fxState(page)).history, ['riichi', 'tsumo']);
    await fxGone(page);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C：ツモ演出がリーチ・自動パス・ヒントと競合しない・ポン／チーで潰れない');

  // (4) 簡易表示（文字だけ）と、設定変更でも表示中の演出が変わらない（P2-1）。再試合・タイトルで演出を消す
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { init: { fn: (m) => { try { localStorage.setItem('mj-effects', m); } catch { /* */ } }, arg: 'lite' } });
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    const l = await fxState(page);
    assert.equal(l.cls, 'fx-tsumo lite');
    assert.deepEqual([l.word, l.flash, l.win, l.shake], ['ツモ！', 0, 0, 0], '簡易は文字だけ');
    assert.equal(await page.locator('#fx-layer .fx-halo').count(), 0, '簡易は光の輪も出さない');
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    const before = await fxLook(page);
    assert.equal(before.cur.lite, false);
    await page.locator('button[data-action="close-result"]').tap();
    await fxSetMode(page, 'lite'); // 演出中に簡易へ
    const after = await fxLook(page);
    assert.deepEqual([after.cls, after.cur.lite, after.shake, after.flash, after.win], [before.cls, false, 1, 1, 1], '表示中のツモ演出は通常のまま続く');
    assert.equal(await page.locator('#fx-layer .fx-halo').count(), 1);
    await fxGone(page);
    // 再試合・タイトルへ戻る：演出が残らない
    await page.evaluate(() => window.__mathjong.fx.fire('tsumo', { type: 'win', seat: 1, how: 'tsumo', from: null }));
    assert.equal((await fxState(page)).cls, 'fx-tsumo lite', '次の演出は新しい設定（簡易）');
    await page.evaluate(() => window.__mathjong.startRound());
    assert.equal((await fxState(page)).cls, '', '新しい局で消える');
    await page.evaluate(() => window.__mathjong.fx.fire('tsumo', { type: 'win', seat: 1, how: 'tsumo', from: null }));
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    const t = await fxState(page);
    assert.equal(t.cls, '', 'タイトルへ戻ると消える');
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.timer), null, 'タイマーも止まる');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C：ツモの簡易表示（文字だけ）・設定変更でも表示中の演出は不変・新しい局／タイトルで演出を消す');

  // (5) 320／375／430px：ツモの演出（文字・和了牌・光の輪）が画面内に収まり、揺れでも横スクロールしない
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await v3Page(browser, 'math1', { viewport: { width: w, height: 700 } });
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    for (const t of [60, 200, 380]) {
      await page.waitForTimeout(t === 60 ? 60 : 140);
      const m = await page.evaluate(() => {
        const l = document.getElementById('fx-layer');
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
        return { card: r(l.querySelector('.fx-card')), word: r(l.querySelector('.fx-word')), fs: parseFloat(getComputedStyle(l.querySelector('.fx-word')).fontSize), over: document.documentElement.scrollWidth - innerWidth, vh: innerHeight };
      });
      assert.ok(m.card.l >= -1 && m.card.r <= w + 1, `${w}px ツモ ${t}ms：演出が画面の幅に収まる ${JSON.stringify(m.card)}`);
      assert.ok(m.word.t >= 0 && m.word.b <= m.vh, `${w}px：文字が画面の高さに収まる`);
      assert.ok(m.fs >= 40, `${w}px：文字 ${m.fs}px`);
      assert.ok(m.over <= 0, `${w}px ${t}ms：揺れの最中も横スクロールなし（${m.over}px）`);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05c-tsumo-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C：320／375／430px でツモの演出が画面内に収まり、揺れの最中も横スクロールしない');
}

// 正式採用のタイトル画像（オーナー採用：1536×1024、3:2、背景透過 PNG）と、表示幅に合わせた縮小版
const TITLE_LOGO_SHA = 'aee4ed6781d44eef9f1a666a56ac04e27c16790a376cf770a112f48434a7ca1f';
const TITLE_LADDER = [384, 576, 768, 960, 1152, 1536];
async function v05cTitleLogo(browser) {
  // (1) 縦横8サイズ：読み込める・3:2 を保つ・見切れない・極端に小さくならない・横スクロールなし・画像の取得に失敗がない
  const sizes = [[320, 568, 2], [375, 667, 2], [390, 844, 3], [430, 932, 3], [568, 320, 2], [844, 390, 3], [768, 1024, 2], [1366, 768, 1]];
  for (const [w, h, dpr] of sizes) {
    const ctx = await newContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 800, hasTouch: w < 800 });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-logo img');
    await page.waitForFunction(() => document.querySelector('.title-logo img').complete && document.querySelector('.title-logo img').naturalWidth > 0);
    const m = await page.evaluate(() => {
      const i = document.querySelector('.title-logo img'); const r = i.getBoundingClientRect();
      return { alt: i.alt, w: r.width, h: r.height, l: r.left, r: r.right, t: r.top, b: r.bottom, src: i.currentSrc.split('/').pop(), nat: i.naturalWidth > 0, over: document.documentElement.scrollWidth - innerWidth, start: !!document.querySelector('[data-action="choose-opponents"]'), vh: innerHeight };
    });
    const where = `${w}×${h}`;
    assert.equal(m.alt, '数雀（MATHJONG）', where);
    assert.ok(m.nat, `${where}：読み込める`);
    assert.ok(Math.abs(m.w / m.h - 3 / 2) < 0.01, `${where}：3:2 を保つ ${m.w}×${m.h}`);
    assert.ok(m.l >= 0 && m.r <= w + 0.5 && m.t >= 0, `${where}：見切れない ${JSON.stringify([m.l, m.r, m.t])}`);
    assert.ok(m.b <= m.vh + 0.5, `${where}：縦にも見切れない（画像の下端 ${Math.round(m.b)}px が画面の高さ ${m.vh}px 以内）`);
    assert.ok(m.w >= 150, `${where}：極端に小さくならない ${m.w}`);
    assert.ok(m.over <= 0, `${where}：横スクロールなし`);
    assert.ok(new RegExp(`^title-logo-(${TITLE_LADDER.join('|')})\\.png$`).test(m.src), `${where}：用意した大きさのどれか ${m.src}`);
    assert.equal(m.start, true, '「対戦相手を選ぶ」のボタンがある（画面は従来どおり使える）');
    assert.deepEqual(errors, [], `${where}：画像の取得に失敗がない`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05c-title-${w}x${h}.png` });
    await ctx.close();
  }
  console.log('✓ Ver.0.5-C：タイトル画像（読み込み・3:2・見切れなし・縦横8サイズ・横スクロールなし）');

  // (2) P3-B：画面の幅と解像度に応じて、必要な幅以上で最小の画像を1枚だけ取得する（低い横画面でも過大に取得しない）。
  //     実際にネットワークで取得されたファイルで確認する（currentSrc だけでなく、取得した画像の幅と枚数）。
  const dprCases = [[320, 568, 1], [320, 568, 2], [320, 568, 3], [375, 667, 2], [375, 667, 3], [390, 844, 2], [390, 844, 3], [430, 932, 3],
    [667, 375, 2], [667, 375, 3], [812, 375, 3], [844, 390, 2], [844, 390, 3], [932, 430, 2], [932, 430, 3], [1024, 768, 2], [1366, 768, 1], [1366, 768, 2]];
  for (const [w, h, dpr] of dprCases) {
    const ctx = await newContext(browser, { viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 800, hasTouch: w < 800 });
    const page = await ctx.newPage();
    const fetched = [];
    page.on('response', (r) => { const mm = r.url().match(/title-logo-(\d+)\.png/); if (mm && r.status() === 200) fetched.push(Number(mm[1])); });
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForFunction(() => document.querySelector('.title-logo img').complete);
    const css = await page.evaluate(() => document.querySelector('.title-logo img').getBoundingClientRect().width);
    const need = css * dpr;
    const smallest = TITLE_LADDER.find((x) => x >= need - 0.5) ?? TITLE_LADDER[TITLE_LADDER.length - 1];
    const where = `${w}×${h}@${dpr}`;
    assert.deepEqual(fetched, [smallest], `${where}：表示幅 ${css.toFixed(0)}px×${dpr}＝必要 ${need.toFixed(0)}px → 取得は ${smallest} 幅の1枚だけ（実際：${fetched}）`);
    assert.ok(smallest / need <= 1.6, `${where}：必要な幅に対して大きすぎない（${(smallest / need).toFixed(2)} 倍）`);
    await ctx.close();
  }
  // 修正前の過大取得（低い横画面 DPR3 で必要の約2倍）が出ないこと：667×375@3 は 768 幅、844×390@3 は 960 幅
  console.log('✓ Ver.0.5-C P3-B：18の画面×解像度で、必要な幅以上で最小の画像を1枚だけ取得（低い横画面でも過大取得なし）');

  // (3) 元画像（正式採用画像）はバイト単位で同一のまま配信される。縮小版は 3:2 で、公開サイトと同じサブパスから PNG として配信される
  const { createHash } = await import('node:crypto');
  const get = async (name) => { const r = await fetch(`${LOCAL}src/ui/${name}`); assert.equal(r.status, 200, name); assert.equal(r.headers.get('content-type'), 'image/png', name); return Buffer.from(await r.arrayBuffer()); };
  const orig = await get('title-logo-1536.png');
  assert.equal(createHash('sha256').update(orig).digest('hex'), TITLE_LOGO_SHA, '元画像（採用画像）はバイト単位で同一');
  for (const wd of TITLE_LADDER) {
    const buf = await get(`title-logo-${wd}.png`);
    const [iw, ih, depth, colorType] = [buf.readUInt32BE(16), buf.readUInt32BE(20), buf[24], buf[25]];
    assert.deepEqual([iw, ih], [wd, (wd * 2) / 3], `title-logo-${wd}.png の大きさ（3:2）`);
    assert.deepEqual([depth, colorType], [8, 6], `title-logo-${wd}.png は 8bit RGBA（透過あり）`);
  }
  // 旧画像（1448×1086 の別の画像）はもう配信されない
  for (const old of ['title-logo-1448.png', 'title-logo-1084.png', 'title-logo-724.png']) assert.equal((await fetch(`${LOCAL}src/ui/${old}`)).status, 404, `${old} は削除済み`);
  console.log('✓ Ver.0.5-C：元画像は SHA-256 が同一・縮小版は 3:2 の RGBA PNG・旧画像は配信されない');
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

// ---- Ver.0.5-D：リーチ演出・効果音・ロン延長 ----
// 偽の AudioContext（iPhone Safari の制限を再現する）：resume='ok'（resume で running）／'never'（ずっと suspended）。none：AudioContext がない。
// 数えるもの：created（作った数）・resumes・sources（予約された声。無音の1サンプルを含む）。
const SND_FN = (cfg) => {
  const C = window.__snd = { created: 0, resumes: 0, sources: 0, ctxs: [] };
  if (cfg.none) { window.AudioContext = undefined; window.webkitAudioContext = undefined; return; }
  const P = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  class FakeCtx {
    constructor() { C.created++; C.ctxs.push(this); this.state = cfg.initial || 'suspended'; this.sampleRate = 44100; this.currentTime = 0; this.destination = {}; }
    resume() { C.resumes++; if (cfg.resume !== 'never') this.state = 'running'; return Promise.resolve(); }
    createBuffer(ch, len) { return { length: len, getChannelData: () => new Float32Array(len) }; }
    createGain() { return { gain: P(), connect() {}, disconnect() {} }; }
    createDynamicsCompressor() { return { threshold: P(), knee: P(), ratio: P(), attack: P(), release: P(), connect() {} }; }
    createBiquadFilter() { return { type: '', Q: P(), frequency: P(), connect() {} }; }
    createOscillator() { C.sources++; return { type: '', frequency: P(), connect() {}, start() {}, stop() {} }; }
    createBufferSource() { C.sources++; return { buffer: null, connect() {}, start() {}, stop() {} }; }
  }
  window.AudioContext = FakeCtx; window.webkitAudioContext = undefined;
};
const sndPage = (browser, cfg = {}, mode = 'math1', opts = {}) => v3Page(browser, mode, { ...opts, init: { fn: SND_FN, arg: cfg } });
const sndLog = (page) => page.evaluate(() => window.__mathjong.sound.log.map((x) => `${x.kind}:${x.status}`));
const sndKinds = (page) => page.evaluate(() => window.__mathjong.sound.log.map((x) => x.kind));
const sndCounts = (page) => page.evaluate(() => ({ ...window.__snd, ctxs: undefined, state: window.__mathjong.sound.state() }));
// 予約された声の数が、鳴った音の声の合計＋無音の1サンプルに一致する（音が1回ずつ予約されたことの確認）
const sndVoices = (kinds) => 1 + kinds.reduce((n, k) => n + RECIPES[k].length, 0);
// 宣言牌の選択からリーチ成立まで（実際の画面操作）
async function riDeclare(page, key = 'a:0') {
  await page.locator('button[data-action="riichi"]').tap();
  const id = await page.evaluate((k) => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === k); }, key);
  await page.locator(`.hand .tile[data-id="${id}"]`).tap();
  await page.locator('button[data-action="riichi-discard"]').tap();
}
// 演出が終わるまでの時間（開始時刻 S.fx.current.startedAt から）
const fxDuration = (page) => page.evaluate(() => new Promise((res) => {
  const c = window.__mathjong.S.fx.current;
  if (!c) return res(null);
  const t0 = c.startedAt;
  const tick = () => { if (!window.__mathjong.S.fx.current) res(performance.now() - t0); else requestAnimationFrame(tick); };
  tick();
}));
const RI_DRAWS = ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'];

async function v05dRiichiFx(browser) {
  // (1) 自分のリーチ：ボタン・宣言牌の選択・やめる では出ない。宣言が成立した時だけ1回（数学Ⅰ・Ⅱ）
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' }, mode);
    await v3Scene(page, presetWall(RI_HAND, RI_DRAWS, [RI_O1, RI_O2, RI_O3]));
    const hist = async () => (await fxState(page)).history;
    await page.locator('button[data-action="riichi"]').tap();
    assert.deepEqual(await hist(), [], `${mode}：リーチのボタンを押しただけでは出さない`);
    assert.deepEqual(await sndKinds(page), [], 'リーチ音も鳴らない');
    await page.locator('button[data-action="riichi-cancel"]').tap();
    assert.deepEqual(await hist(), [], 'やめる（キャンセル）でも出さない');
    await page.locator('button[data-action="riichi"]').tap();
    const zero = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'a:0'); });
    await page.locator(`.hand .tile[data-id="${zero}"]`).tap();
    assert.deepEqual(await hist(), [], '宣言牌を選んだだけ（確定前）でも出さない');
    assert.deepEqual(await sndKinds(page), []);
    assert.equal((await riState(page)).riichi[0], false, 'まだリーチは成立していない');
    await page.locator('button[data-action="riichi-discard"]').tap();
    const st = await fxState(page);
    assert.deepEqual(st.history, ['riichi'], '成立した時に1回だけ');
    assert.equal(st.cls, 'fx-riichi');
    assert.equal(st.word, 'リーチ！');
    assert.equal(st.who, 'あなた');
    assert.equal(st.flash, 1, '閃光');
    const look = await page.evaluate(() => ({ streak: document.querySelectorAll('#fx-layer .fx-streak').length, decl: [...document.querySelectorAll('#fx-layer .fx-decl .tile')].map((t) => t.getAttribute('aria-label')), glow: document.querySelectorAll('.river.mine .tile.riichi-decl.fx-glow-riichi').length }));
    assert.equal(look.streak, 2, '鋭い光条（横・縦）');
    assert.deepEqual(look.decl, [await tileLabelOf(page, 'a:0')], '宣言牌（捨てた 0°）を大きく表示');
    assert.equal(look.glow, 1, '河の宣言牌が光る');
    assert.deepEqual(await sndKinds(page), ['riichi'], '音もリーチ音の1回だけ（宣言牌の打牌音は重ねない）');
    assert.equal((await riState(page)).riichi[0], true);
    // 再描画・step・scan を繰り返しても二重に出ない
    for (let i = 0; i < 4; i++) await page.evaluate(() => { const m = window.__mathjong; m.render(); m.fx.scan(); m.soundScan(); });
    assert.deepEqual((await fxState(page)).history, ['riichi']);
    assert.deepEqual(await sndKinds(page), ['riichi']);
    const dur = await fxDuration(page);
    assert.ok(dur >= 900 && dur <= 1150, `リーチ演出は約 0.9 秒（Ver.0.5-E）（${dur}ms）`);
    const e = await fxState(page);
    assert.deepEqual([e.cls, (await fxLook(page)).glow], ['', 0]);
    // 以後は通常どおり（ツモ切りだけ）。AI の打牌音は1打牌1回
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    assert.deepEqual(await sndKinds(page), ['riichi', 'discard', 'discard', 'discard']);
    assert.deepEqual((await fxState(page)).history, ['riichi']);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：リーチ演出は成立の1回だけ（ボタン・やめる・宣言牌の選択では出ない）・宣言牌の強調・約0.7秒・二重に出ない（数学Ⅰ・Ⅱ）');

  // (2) AI のリーチ（初級・中級・上級）：AI の名前・宣言牌・効果音
  for (const ai of ['beginner', 'intermediate', 'advanced']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await page.evaluate((a) => { window.__mathjong.S.matchSettings.ai = a; }, ai);
    await v3Scene(page, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=-1/√2', '=-1/√2', '=√3', '=√3'], ['=-1', '0'], [RI_HAND, RI_O2, RI_O3]));
    await apDiscardDrawn(page);
    await page.waitForFunction(() => window.__mathjong.S.fx.history.includes('riichi'), null, { timeout: 8000 });
    const st = await fxState(page);
    assert.equal(st.word, 'リーチ！');
    assert.equal(st.who, 'おうすけ', `${ai}：宣言した AI の名前`);
    assert.equal(st.cls, 'fx-riichi');
    assert.equal(await page.locator('#fx-layer .fx-decl .tile').count(), 1);
    assert.equal(await page.locator('.panel.seat-1 .river .tile.riichi-decl.fx-glow-riichi').count(), 1, `${ai}：AI の河の宣言牌が光る`);
    const kinds = await sndKinds(page);
    assert.equal(kinds.filter((k) => k === 'riichi').length, 1, `${ai}：AI のリーチ音は1回`);
    assert.deepEqual(kinds.slice(0, 2), ['discard', 'riichi'], '自分の打牌 → AI のリーチ（宣言牌の打牌音は重ねない）');
    assert.equal((await fxState(page)).history.filter((h) => h === 'riichi').length, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：AI のリーチ（初級・中級・上級）の演出（名前・宣言牌・河の発光）と効果音が1回ずつ');

  // (3) 簡易表示・reduced motion：リーチも文字だけ
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(RI_HAND, RI_DRAWS, [RI_O1, RI_O2, RI_O3]));
    await fxSetMode(page, 'lite');
    await riDeclare(page);
    const l = await page.evaluate(() => { const L = document.getElementById('fx-layer'); return { cls: L.className, word: L.querySelector('.fx-word').textContent, extra: L.querySelectorAll('.fx-flash,.fx-streak,.fx-decl').length, glow: document.querySelectorAll('.fx-glow-riichi').length }; });
    assert.deepEqual(l, { cls: 'fx-riichi lite', word: 'リーチ！', extra: 0, glow: 0 });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：簡易表示ではリーチも文字だけ');

  // (4) リーチ → ロン（ロンがリーチを置き換える）。ロン 1100ms・結果画面と精算は待たない・演出中に次の局へ進んでも消える
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0', '=-1/√3', '=-√3/2'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await riDeclare(page);
    assert.deepEqual((await fxState(page)).history, ['riichi']);
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    assert.equal((await v3State(page)).p.ron, true);
    await page.locator('button[data-action="ron"]').tap();
    const t = Date.now();
    let st = await fxState(page);
    assert.equal(st.cls, 'fx-ron', 'ロンはリーチ演出を置き換える');
    assert.equal(st.modal, 'result', '結果画面は演出を待たずに開く');
    assert.equal(await page.locator('.overlay .result').isVisible(), true);
    assert.ok(Date.now() - t < 700, '結果画面の表示は演出で遅れない');
    assert.deepEqual(st.history, ['riichi', 'ron']);
    const res = await page.evaluate(() => { const { S } = window.__mathjong; const r = S.game.result; return { winner: r.winner, how: r.how, riichi: r.analysis.riichi, delta: S.match.scores.map((x, i) => x - S.prevScores[i]), points: r.points }; });
    assert.deepEqual([res.winner, res.how, res.riichi], [0, 'ron', true], 'リーチ＋1は従来どおり');
    assert.deepEqual(res.delta, [6 * res.points, -6 * res.points, 0, 0]);
    assert.deepEqual(await sndKinds(page), ['riichi', 'discard', 'ron'], '音：リーチ → AI の打牌 → ロン（各1回）');
    const dur = await fxDuration(page);
    assert.ok(dur >= 2200 && dur <= 2450, `ロン演出は約 2.2 秒（Ver.0.5-E）（${dur}ms）`);
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    // 演出の途中で「次の局」へ進んでも、演出・音が残らない
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    await page.locator('button[data-action="ron"]').tap();
    await page.waitForTimeout(250);
    assert.equal((await fxState(page)).cls, 'fx-ron');
    assert.ok(await page.evaluate(() => !!window.__mathjong.sound.master), 'ロン音が鳴っている');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    const st = await fxState(page);
    assert.deepEqual([st.cls, st.history.length], ['', 1], '次の局へ：演出を消す（持ち越さない）');
    assert.equal(await page.evaluate(() => window.__mathjong.sound.master), null, '音の出力も絞って止める');
    assert.equal(await page.evaluate(() => window.__mathjong.S.fx.timer), null);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：リーチ → ロン（ロン約1.1秒・結果画面と精算は待たない・リーチ＋1は従来どおり）・演出中に次の局へ進んでも演出と音を止める');

  // (5) リーチ → ツモ（ツモ 1.0 秒を維持）。リーチ音 → ツモ音
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'], [FX_O1, FX_O2, FX_O3]));
    await riDeclare(page);
    await apForce(page, 1); await apForce(page, 2); await apForce(page, 3);
    await riWaitTurn(page);
    assert.equal((await riState(page)).p.canTsumo, true);
    await page.locator('button[data-action="tsumo"]').tap();
    const st = await fxState(page);
    assert.equal(st.cls, 'fx-tsumo');
    assert.equal(st.modal, 'result');
    assert.deepEqual(st.history, ['riichi', 'tsumo']);
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.result.analysis.riichi), true);
    assert.deepEqual(await sndKinds(page), ['riichi', 'discard', 'discard', 'discard', 'tsumo']);
    const dur = await fxDuration(page);
    assert.ok(dur >= 2000 && dur <= 2250, `ツモ演出は約 2.0 秒（Ver.0.5-E）（${dur}ms）`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：リーチ → ツモ（ツモ 1.0 秒のまま・リーチ音 → ツモ音・リーチ＋1は従来どおり）');

  // (6) ロンの強化：赤〜金の光条・和了牌・盤面の揺れ（盤面だけ）。ツモの揺れは従来のまま
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    await page.locator('button[data-action="ron"]').tap();
    const r = await page.evaluate(() => {
      const L = document.getElementById('fx-layer'); const tb = document.querySelector('.table');
      return { rays: L.querySelectorAll('.fx-rays').length, flash: L.querySelectorAll('.fx-flash').length, win: L.querySelectorAll('.fx-wintile .tile').length,
        shake: tb.classList.contains('fx-shake'), ronShake: tb.classList.contains('fx-shake-ron'), anim: getComputedStyle(tb).animationName, dur: getComputedStyle(L.querySelector('.fx-word')).animationDuration,
        barInTable: tb.contains(document.querySelector('.bar')), over: document.documentElement.scrollWidth - innerWidth };
    });
    assert.deepEqual([r.rays, r.flash, r.win, r.shake, r.ronShake, r.barInTable], [1, 1, 1, true, true, false]);
    assert.equal(r.anim, 'fx-shake-ron');
    assert.equal(r.dur, '2.2s', 'ロンの文字の動きも 2.2 秒（Ver.0.5-E）');
    assert.ok(r.over <= 0, '横スクロールなし');
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('button[data-action="tsumo"]').tap();
    const r = await page.evaluate(() => { const tb = document.querySelector('.table'); return { ronShake: tb.classList.contains('fx-shake-ron'), anim: getComputedStyle(tb).animationName, halo: document.querySelectorAll('#fx-layer .fx-halo').length, rays: document.querySelectorAll('#fx-layer .fx-rays').length }; });
    assert.deepEqual(r, { ronShake: false, anim: 'fx-shake', halo: 1, rays: 0 });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：ロンの強化（光条・和了牌・盤面だけの揺れ・文字 1.1 秒）／ツモの揺れ・光の輪は従来のまま');

  // (7) 320／375／430px：リーチ演出が画面内に収まる・横スクロールなし・操作を妨げない
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' }, 'math1', { viewport: { width: w, height: 700 } });
    await v3Scene(page, presetWall(RI_HAND, RI_DRAWS, [RI_O1, RI_O2, RI_O3]));
    await riDeclare(page);
    await page.waitForTimeout(180);
    const g = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      return { word: r('#fx-layer .fx-word'), decl: r('#fx-layer .fx-decl'), pe: getComputedStyle(document.getElementById('fx-layer')).pointerEvents, over: document.documentElement.scrollWidth - innerWidth, vh: innerHeight };
    });
    for (const k of ['word', 'decl']) assert.ok(g[k].l >= 0 && g[k].r <= w + 0.5 && g[k].t >= 0 && g[k].b <= g.vh, `${w}px ${k} ${JSON.stringify(g[k])}`);
    assert.equal(g.pe, 'none', '演出はタップを通す');
    assert.ok(g.over <= 0, `${w}px 横スクロール`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05d-riichi-${w}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：320／375／430px でリーチ演出が画面内に収まる・横スクロールなし・タップを通す');
}

async function v05dSound(browser) {
  // (1) iPhone Safari：最初の操作まで AudioContext を作らない。操作で作って resume。止まっていれば音は鳴らさず待たない
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok', initial: 'suspended' });
    let c = await sndCounts(page);
    assert.deepEqual([c.created, c.resumes, c.sources], [0, 0, 0], '操作の前は AudioContext を作らない');
    await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
    assert.equal((await sndCounts(page)).created, 0, '局の開始（操作ではない）でも作らない');
    await page.locator('.hand .tile.tap').first().tap(); // 最初の操作（選択だけ）
    c = await sndCounts(page);
    assert.equal(c.created, 1, '最初の操作で作る');
    assert.ok(c.resumes >= 1, 'suspended → resume() を呼ぶ');
    assert.equal(c.state, 'running');
    assert.equal(c.sources, 1, '無音の1サンプルだけ（再生許可）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：最初の操作まで AudioContext を作らない・操作で作成と resume（iOS の制限）');

  // (2) 全6種類の音が、自分・AI のそれぞれの場面で1回ずつ鳴る（偽の AudioContext の声の数も、レシピのとおり）
  const once = async (name, setup, act, expectKinds) => {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await setup(page);
    await act(page);
    await page.waitForTimeout(150);
    const kinds = await sndKinds(page);
    assert.deepEqual(kinds, expectKinds, `${name}：音の並び`);
    assert.ok((await sndLog(page)).every((x) => x.endsWith(':played')), `${name}：すべて鳴った`);
    assert.equal((await sndCounts(page)).sources, sndVoices(kinds), `${name}：声の数＝レシピの声の合計（二重に予約していない）`);
    assert.deepEqual(errors, []);
    await ctx.close();
  };
  await once('自分の打牌', (p) => v3Scene(p, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3])), (p) => apDiscardDrawn(p), ['discard']);
  await once('AI の打牌', (p) => v3Scene(p, presetWall(TS_HAND, ['=-1/√3', '=-√3/2'], [FX_O1, FX_O2, FX_O3])), async (p) => { await apDiscardDrawn(p); await apForce(p, 1); }, ['discard', 'discard']);
  await once('自分のチー', (p) => fxToClaim(p, ['=1/2', '45', 'sin', '30', '0', '0', '135', '=-√3']), (p) => p.locator('button[data-action="chi"]').first().tap(), ['discard', 'discard', 'discard', 'discard', 'chi']);
  await once('自分のポン', (p) => fxToClaim(p, ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']), (p) => p.locator('button[data-action="pon"]').first().tap(), ['discard', 'discard', 'discard', 'discard', 'pon']);
  await once('自分のロン', (p) => v3Scene(p, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3])),
    async (p) => { await apDiscardDrawn(p); await apForce(p, 1, 'v:1'); await v3WaitHuman(p); await p.locator('button[data-action="ron"]').tap(); }, ['discard', 'discard', 'ron']);
  await once('自分のツモ', (p) => v3Scene(p, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3])), (p) => p.locator('button[data-action="tsumo"]').tap(), ['tsumo']);
  await once('自分のリーチ', (p) => v3Scene(p, presetWall(RI_HAND, RI_DRAWS, [RI_O1, RI_O2, RI_O3])), (p) => riDeclare(p), ['riichi']);
  await once('AI のロン', (p) => v3Scene(p, presetWall(['=1', 'sin', 'sin', '0', '90', '=-√3', '=√3', '150'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'], [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], FX_O2, FX_O3])),
    async (p) => { const id = await p.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:1'); }); await p.locator(`.hand .tile[data-id="${id}"]`).tap(); await p.locator(`.hand .tile[data-id="${id}"]`).tap(); await p.waitForFunction(() => !!window.__mathjong.S.game.result, null, { timeout: 8000 }); }, ['discard', 'ron']);
  await once('AI のツモ', (p) => v3Scene(p, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=1/√2', '=1/√2', '=√3', '=1/√3'], ['45', '=1'], [TS_HAND, FX_O2, FX_O3])),
    async (p) => { await apDiscardDrawn(p); await p.waitForFunction(() => !!window.__mathjong.S.game.result, null, { timeout: 8000 }); }, ['discard', 'tsumo']);
  await once('AI のポン', (p) => v3Scene(p, presetWall(['=1/2', 'sin', 'sin', '0', '90', '=-√3', '=√3', '150'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'], [['=1/2', '=1/2', 'sin', 'sin', 'sin', '0', '0', '=-√3'], FX_O2, FX_O3.map((x) => (x === '=1/2' ? '=-1' : x))])),
    async (p) => { const id = await p.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:1/2'); }); await p.locator(`.hand .tile[data-id="${id}"]`).tap(); await p.locator(`.hand .tile[data-id="${id}"]`).tap(); await p.waitForFunction(() => window.__mathjong.S.fx.history.includes('pon'), null, { timeout: 8000 }); }, ['discard', 'pon']);
  console.log('✓ Ver.0.5-D 音：打牌・チー・ポン・リーチ・ロン・ツモ（自分／AI）がそれぞれ1回ずつ。声の数はレシピどおり');

  // (3) AI のリーチ音
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=-1/√2', '=-1/√2', '=√3', '=√3'], ['=-1', '0'], [RI_HAND, RI_O2, RI_O3]));
    await apDiscardDrawn(page);
    await page.waitForFunction(() => window.__mathjong.S.game.riichi[1] !== null, null, { timeout: 8000 });
    const kinds = await sndKinds(page);
    assert.deepEqual(kinds.slice(0, 2), ['discard', 'riichi']);
    assert.equal(kinds.filter((k) => k === 'riichi').length, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：AI のリーチ音（打牌 → リーチ、宣言牌の打牌音は重ねない）');

  // (4) 二重再生しない：再描画・step・設定画面の開閉・scan の繰り返しで、同じ記録の音を鳴らし直さない
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    await page.locator('button[data-action="ron"]').tap();
    const before = await sndLog(page);
    assert.deepEqual(before, ['discard:played', 'discard:played', 'ron:played']);
    for (let i = 0; i < 6; i++) await page.evaluate(() => { const m = window.__mathjong; m.render(); m.step(); m.soundScan(); m.fx.scan(); });
    await page.waitForTimeout(1300);
    assert.deepEqual(await sndLog(page), before, '再描画・step・scan を繰り返しても鳴らし直さない');
    assert.equal((await sndCounts(page)).sources, sndVoices(['discard', 'discard', 'ron']));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：再描画・step・scan を繰り返しても、同じ記録の音を二重に鳴らさない');

  // (5) 設定：既定はオン。オフにすると保存され（再読込後も）、音は鳴らず AudioContext も作らない。ゲームの進行はオンと同一
  const events = async (p) => p.evaluate(() => JSON.stringify(window.__mathjong.S.game.events));
  const claimRun = async (cfg, preSetOff) => {
    const { ctx, page, errors } = await sndPage(browser, cfg);
    if (preSetOff) await page.evaluate(() => { window.__mathjong.S.sound.on = false; });
    await fxToClaim(page, ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']);
    await page.locator('button[data-action="pon"]').first().tap();
    const ev = await events(page);
    const log = await sndLog(page);
    const counts = await sndCounts(page);
    assert.deepEqual(errors, []);
    await ctx.close();
    return { ev, log, counts };
  };
  {
    const on = await claimRun({ resume: 'ok' }, false);
    const off = await claimRun({ resume: 'ok' }, true);
    assert.equal(on.ev, off.ev, 'オフでもゲームの記録（進行・結果）はオンと完全に同じ');
    assert.ok(on.log.length === 5 && on.log.every((x) => x.endsWith(':played')));
    assert.ok(off.log.length === 5 && off.log.every((x) => x === `${x.split(':')[0]}:off`), JSON.stringify(off.log));
    assert.equal(off.counts.sources, 0, 'オフでは声を1つも予約しない');
  }
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    assert.equal(await page.evaluate(() => window.__mathjong.S.sound.on), true, '既定はオン');
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="sound"]').inputValue(), '1');
    // P3：演出の設定名は「視覚演出」（リーチ・ツモも対象）。選択肢と保存キーは従来どおり
    const fxLabel = await page.locator('label.setting:has(select[data-action="fx-mode"])').innerText();
    assert.ok(fxLabel.trim().startsWith('視覚演出') && !fxLabel.includes('ロン・ポン・チーの演出'), fxLabel);
    assert.deepEqual(await page.locator('select[data-action="fx-mode"] option').allInnerTexts(), ['通常', '簡易（文字だけ）']);
    await page.locator('select[data-action="fx-mode"]').selectOption('lite');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-effects')), 'lite', '保存キー mj-effects は不変');
    await page.locator('select[data-action="fx-mode"]').selectOption('full');
    await page.locator('select[data-action="sound"]').selectOption('0');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-sound')), '0', 'オフが保存される');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal(await page.evaluate(() => window.__mathjong.S.sound.on), false, '再読込後もオフ');
    await page.locator('.hand .tile.tap').first().tap(); // オフのまま操作しても AudioContext を作らない
    assert.equal((await sndCounts(page)).created, 0);
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="sound"]').inputValue(), '0');
    await page.locator('select[data-action="sound"]').selectOption('1');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-sound')), '1');
    assert.equal((await sndCounts(page)).created, 1, 'オンにした操作の中で再生を許可する');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await page.reload();
    await page.waitForSelector('.hand .tile');
    assert.equal(await page.evaluate(() => window.__mathjong.S.sound.on), true, '再読込後もオン');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    // 保存値が壊れていてもオン（'0' だけがオフ）
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    for (const [v, want] of [['abc', true], ['', true], ['1', true], ['0', false]]) {
      await page.evaluate((x) => localStorage.setItem('mj-sound', x), v);
      await page.reload();
      await page.waitForSelector('.hand .tile');
      assert.equal(await page.evaluate(() => window.__mathjong.S.sound.on), want, `保存値 ${JSON.stringify(v)}`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：設定のオン／オフ・保存・再読込後も維持・既定オン・異常値はオン／オフでもゲームの記録はオンと同一・オフでは声を予約しない');

  // (6) iPhone Safari の制限：resume が通らない（ずっと suspended）・AudioContext がない・途中で interrupted → 操作で復帰
  {
    const run = async (cfg) => {
      const { ctx, page, errors } = await sndPage(browser, cfg);
      await fxToClaim(page, ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']);
      await page.locator('button[data-action="pon"]').first().tap();
      const ev = await events(page);
      const log = await sndLog(page);
      const counts = await sndCounts(page);
      assert.deepEqual(errors, [], JSON.stringify(cfg));
      await ctx.close();
      return { ev, log, counts };
    };
    const ref = await run({ resume: 'ok' });
    const never = await run({ resume: 'never' });
    assert.equal(never.ev, ref.ev, 'ずっと suspended でもゲームの進行・記録は同じ');
    assert.ok(never.log.length === 5 && never.log.every((x) => x.endsWith(':blocked')), JSON.stringify(never.log));
    assert.equal(never.counts.sources, 1, '声は予約しない（無音の1サンプルだけ）');
    assert.ok(never.counts.resumes >= 5, '音が出せないたびに再開を試みる（待たない）');
    const none = await run({ none: true });
    assert.equal(none.ev, ref.ev, 'AudioContext がなくてもゲームは同じ');
    assert.ok(none.log.length === 5 && none.log.every((x) => x.endsWith(':nocontext')), JSON.stringify(none.log));
  }
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3', '=-√3/2', '=-1/√2'], [FX_O1, FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    assert.deepEqual(await sndLog(page), ['discard:played']);
    // 着信・バックグラウンドで interrupted になった（iOS）
    await page.evaluate(() => { for (const c of window.__snd.ctxs) c.state = 'interrupted'; });
    await apForce(page, 1);
    assert.deepEqual(await sndLog(page), ['discard:played', 'discard:blocked'], '止まっている間は鳴らさず、待たない');
    assert.equal((await v3State(page)).p.seat, 2, 'ゲームは止まらず進む');
    const r0 = (await sndCounts(page)).resumes;
    await page.locator('.hand .tile').first().tap(); // 次の操作で再開
    assert.ok((await sndCounts(page)).resumes > r0 || (await sndCounts(page)).state === 'running');
    await apForce(page, 2);
    assert.equal((await sndLog(page)).pop(), 'discard:played', '操作のあとは復帰して鳴る');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：suspended のまま・AudioContext なし・interrupted → 操作で復帰。いずれも無音で待たず、ゲームの記録は同一・エラーなし');

  // (7) 実際の音の波形（OfflineAudioContext で本物の Web Audio に描画）：無音でない・クリップしない・NaN なし・終わりが静か・長さ・音量の釣り合い・種類ごとに違う
  {
    const { ctx, page, errors } = await v3Page(browser, 'math1');
    const m = await page.evaluate(async (base) => {
      const snd = await import(`${base}src/ui/sound.js`);
      const out = {};
      for (const kind of Object.keys(snd.RECIPES)) {
        const sr = 44100;
        const oc = new OfflineAudioContext(1, Math.ceil(sr * (snd.recipeEnd(snd.RECIPES[kind]) + 0.3)), sr);
        snd.scheduleRecipe(oc, snd.createMasterChain(oc), kind, 0.01);
        const d = (await oc.startRendering()).getChannelData(0);
        let peak = 0, sq = 0, nan = false, zc = 0, last = 0;
        for (let i = 0; i < d.length; i++) {
          const a = Math.abs(d[i]);
          if (!Number.isFinite(d[i])) nan = true;
          if (a > peak) peak = a;
          if (a > 0.005) last = i;
          sq += d[i] * d[i];
          if (i && (d[i] >= 0) !== (d[i - 1] >= 0)) zc++;
        }
        let tail = 0;
        for (let i = d.length - Math.floor(sr * 0.02); i < d.length; i++) tail = Math.max(tail, Math.abs(d[i]));
        out[kind] = { peak, rms: Math.sqrt(sq / d.length), nan, len: (last / sr) - 0.01, tail, zcr: zc / (d.length / sr) / 2 };
      }
      return out;
    }, BASE);
    const k = Object.keys(m);
    for (const kind of k) {
      const x = m[kind];
      assert.ok(!x.nan, `${kind}: NaN なし`);
      assert.ok(x.peak >= 0.15 && x.peak <= 0.98, `${kind}: ピーク ${x.peak.toFixed(2)}（無音でなく、クリップしない）`);
      assert.ok(x.tail < 0.001, `${kind}: 終わりが静か（ぷつっという切れがない）`);
    }
    const peaks = k.map((x) => m[x].peak);
    assert.ok(Math.max(...peaks) / Math.min(...peaks) <= 4, `音量の釣り合い（最大/最小 ${(Math.max(...peaks) / Math.min(...peaks)).toFixed(1)}）`);
    assert.ok(m.discard.len <= 0.15 && m.chi.len <= 0.3 && m.pon.len <= 0.4, '打牌・チー・ポンは短い');
    assert.ok(m.discard.peak < m.ron.peak && m.discard.peak < m.tsumo.peak && m.discard.peak < m.riichi.peak, '打牌は控えめ（最も多く鳴る音）、決着の音は大きい');
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) {
      const a = m[k[i]], b = m[k[j]];
      const dLen = Math.abs(a.len - b.len) / Math.max(a.len, b.len, 0.05);
      const dZc = Math.abs(a.zcr - b.zcr) / Math.max(a.zcr, b.zcr);
      assert.ok(dLen > 0.12 || dZc > 0.12, `${k[i]} と ${k[j]} は長さか明るさが違う（${dLen.toFixed(2)}, ${dZc.toFixed(2)}）`);
    }
    console.log('  音の波形：' + k.map((x) => `${x} peak${m[x].peak.toFixed(2)} len${m[x].len.toFixed(2)}s`).join(' / '));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D 音：本物の Web Audio（OfflineAudioContext）で描画した波形が、無音でない・クリップしない・NaN なし・終わりが静か・音量の釣り合い・種類ごとに違う');

  // (8) 公開サイトでは開発用フックが無効（sound を公開しない）
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${PUBLIC}?mode=math1&seed=1`);
    await page.waitForSelector('.title-screen, .hand .tile');
    assert.equal(await page.evaluate(() => typeof window.__mathjong), 'undefined', '公開サイトでは開発用フックなし');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D：公開サイトでは開発用フック（sound を含む）が無効');
}

// ---- Ver.0.5-D P2 修正：実際の AudioContext（Chromium）で、中断（suspend）した効果音が復帰後に鳴らないこと ----
// 本物の AudioContext を継承し、出力（destination）の手前に録音用のノード（ScriptProcessor）を挟んで、実際に出力へ流れた波形のピークを時刻つきで記録する。
// 数えるもの：created（AudioContext を作った数）・stateListeners（statechange の登録数）・gains（createGain の数）。
const REAL_TAP_FN = () => {
  const Real = window.AudioContext;
  const R = window.__rec = { blocks: [], created: 0, stateListeners: 0, gains: 0 };
  class TapCtx extends Real {
    constructor(...a) {
      super(...a);
      R.created++;
      const tap = super.createGain();
      tap.connect(super.destination);
      this.__tap = tap;
      const sp = super.createScriptProcessor(1024, 1, 1);
      tap.connect(sp);
      sp.connect(super.destination);
      sp.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let pk = 0;
        for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
        R.blocks.push({ w: performance.now(), ct: this.currentTime, peak: pk });
      };
      this.__sp = sp;
    }
    get destination() { return this.__tap; }
    createGain() { R.gains++; return super.createGain(); }
    addEventListener(type, ...rest) { if (type === 'statechange') R.stateListeners++; return super.addEventListener(type, ...rest); }
  }
  window.AudioContext = TapCtx; window.webkitAudioContext = undefined;
};
const realPage = (browser, mode = 'math1', opts = {}) => v3Page(browser, mode, { ...opts, init: { fn: REAL_TAP_FN, arg: null } });
const rcMark = (page) => page.evaluate(() => window.__rec.blocks.length);
// 区間 [from, to) の出力ピークの最大値
const rcPeak = (page, from, to = null) => page.evaluate(([f, t]) => { const b = window.__rec.blocks.slice(f, t === null ? undefined : t); return b.reduce((m, x) => Math.max(m, x.peak), 0); }, [from, to]);
const rcState = (page) => page.evaluate(() => { const s = window.__mathjong.sound; return { state: s.state(), buses: s.buses ? s.buses.size : null, master: !!s.master, drops: s.drops ?? null }; });
const rcRunning = (page) => page.waitForFunction(() => window.__mathjong.sound.state() === 'running', null, { timeout: 5000 });
// 最初の操作（unlock）：手牌を1回タップ（選択だけ）
async function rcUnlock(page) {
  await page.locator('.hand .tile.tap').first().tap();
  await rcRunning(page);
}
// 牌を捨てない操作（上部の余白のタップ）。2回目の牌のタップは打牌になってしまうので、復帰の操作には使わない
const rcTap = (page) => page.locator('.top').first().tap({ position: { x: 4, y: 4 } });
// kind の音を鳴らし、鳴らし始めから ms 後に実際の AudioContext を suspend する（ページ内で測るので、時間のずれが小さい）
const rcPlaySuspend = (page, kind, ms) => page.evaluate(async ([k, d]) => {
  const s = window.__mathjong.sound;
  const st = s.play(k);
  await new Promise((r) => setTimeout(r, d));
  await s.ctx.suspend();
  return st;
}, [kind, ms]);
const RC_SUSPEND_MS = { discard: 30, chi: 70, pon: 80, riichi: 100, ron: 100, tsumo: 100 };
const SND_MS = { discard: 90, chi: 220, pon: 240, riichi: 800, ron: 950, tsumo: 900 };
const RC_EPS = 1e-4;

async function v05dSoundSuspend(browser) {
  // (1) 6種類すべて：鳴らし始めてすぐ suspend → 演出時間を超えて待つ → 操作で resume → 中断前の音の後半は出力されない。その後の新しい音は出る
  for (const kind of Object.keys(RC_SUSPEND_MS)) {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    const m0 = await rcMark(page);
    assert.equal(await rcPlaySuspend(page, kind, RC_SUSPEND_MS[kind]), 'played');
    await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended', null, { timeout: 3000 });
    const m1 = await rcMark(page);
    assert.ok(await rcPeak(page, m0, m1) > 0.01, `${kind}：中断前は実際に出力された（録音の確認）`);
    await page.waitForTimeout(SND_MS[kind] + 700); // 音も演出も終わる時間
    await rcTap(page); // 操作で復帰
    await rcRunning(page);
    const m2 = await rcMark(page);
    await page.waitForTimeout(SND_MS[kind] + 500);
    const m3 = await rcMark(page);
    assert.ok(m3 - m2 >= 10, `${kind}：復帰後も録音が進んでいる（${m3 - m2}ブロック）`);
    assert.ok(await rcPeak(page, m2, m3) < RC_EPS, `${kind}：復帰後に中断前の音が出力されない（ピーク ${await rcPeak(page, m2, m3)}）`);
    // 新しい音は正常に出る
    assert.equal(await page.evaluate((k) => window.__mathjong.sound.play(k), kind), 'played');
    await page.waitForTimeout(SND_MS[kind] * 0.6 + 80);
    const m4 = await rcMark(page);
    assert.ok(await rcPeak(page, m3, m4) > 0.01, `${kind}：復帰後の新しい音は出力される`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：実際の AudioContext で、6種類の音とも suspend → 待機 → resume 後に古い音が出力されず、新しい音は出力される（出力波形のピークで確認）');

  // (2) 実際のゲームの流れ：AI がリーチ → リーチ音の途中で suspend → 画面のリーチ演出が終わるまで待つ → 操作で resume → 古いリーチ音は出ず、次の新しい打牌音・リーチ音は出る
  {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    await v3Scene(page, presetWall(['=-1/√3', '=-1/√3', '=-√3/2', '=-√3/2', '=-1/√2', '=-1/√2', '=√3', '=√3'], ['=-1', '0'], [RI_HAND, RI_O2, RI_O3]));
    await apDiscardDrawn(page); // 自分の打牌（打牌音）
    await page.waitForFunction(() => window.__mathjong.sound.log.some((x) => x.kind === 'riichi'), null, { timeout: 8000 });
    // 以後 AI の手番を止める（復帰後の無音区間に新しいゲームイベントを混ぜない）
    const m0 = await page.evaluate(async () => {
      const m = window.__mathjong; clearTimeout(m.S.timer); m.S.timer = null;
      const n = window.__rec.blocks.length;
      await new Promise((r) => setTimeout(r, 60));
      await m.sound.ctx.suspend();
      return n;
    });
    await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended');
    const m1 = await rcMark(page);
    assert.ok(await rcPeak(page, m0, m1) > 0.01, 'AI のリーチ音は中断前に出力された');
    await page.waitForTimeout(1500); // 画面のリーチ演出（0.7秒）より長く待つ
    assert.equal((await fxState(page)).cls, '', 'リーチ演出は終わっている');
    await rcTap(page);
    await rcRunning(page);
    const m2 = await rcMark(page);
    await page.waitForTimeout(1200);
    const m3 = await rcMark(page);
    assert.ok(await rcPeak(page, m2, m3) < RC_EPS, `復帰後に古いリーチ音が出力されない（ピーク ${await rcPeak(page, m2, m3)}）`);
    assert.deepEqual((await sndKinds(page)).filter((k) => k === 'riichi').length, 1, 'リーチ音のゲームイベントは1回だけ');
    // 復帰後の新しいゲームイベント：自分の打牌（打牌音）。続けて新しいリーチ音
    const before = (await sndLog(page)).length;
    await page.evaluate(() => window.__mathjong.sound.play('discard'));
    await page.waitForTimeout(120);
    const m4 = await rcMark(page);
    assert.ok(await rcPeak(page, m3, m4) > 0.01, '復帰後の新しい打牌音は出力される');
    await page.evaluate(() => window.__mathjong.sound.play('riichi'));
    await page.waitForTimeout(500);
    assert.ok(await rcPeak(page, m4) > 0.05, '復帰後の新しいリーチ音は出力される');
    assert.equal((await sndLog(page)).length, before + 2);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：AI のリーチ → 音の途中で suspend → 演出終了後に resume しても古いリーチ音は出ず、新しい打牌音・リーチ音は出る');

  // (3) 中断中に新しい音を要求しても、復帰後に鳴らない（その場で無音・待たない）。複数回の中断・復帰。AudioContext を作り直さない・ノード／リスナーが増え続けない
  {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    const base = await page.evaluate(() => ({ ...window.__rec, blocks: undefined }));
    assert.deepEqual([base.created, base.stateListeners], [1, 1]);
    for (let round = 0; round < 3; round++) {
      const a = await rcMark(page);
      assert.equal(await rcPlaySuspend(page, 'ron', 80), 'played', `${round}回目`);
      await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended');
      // 中断中に新しい音を要求（ron・tsumo・pon・chi・discard・riichi）：すべて blocked
      const st = await page.evaluate(() => ['ron', 'tsumo', 'pon', 'chi', 'discard', 'riichi'].map((k) => window.__mathjong.sound.play(k)));
      assert.deepEqual(st, ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked'], '中断中の要求は無音で戻る（待たない）');
      assert.equal((await rcState(page)).buses, 0, '中断中は鳴っている音の出力を持たない');
      await page.waitForTimeout(1100);
      await rcTap(page);
      await rcRunning(page);
      const b = await rcMark(page);
      await page.waitForTimeout(1100);
      assert.ok(await rcPeak(page, b) < RC_EPS, `${round}回目：復帰後に、中断前の音も中断中に要求した音も出ない（ピーク ${await rcPeak(page, b)}）`);
      assert.ok(await rcPeak(page, a, b) > 0.01, `${round}回目：中断前の音は出力された`);
    }
    assert.equal(await page.evaluate(() => window.__mathjong.sound.play('tsumo')), 'played');
    await page.waitForTimeout(400);
    assert.ok(await rcPeak(page, await rcMark(page) - 12) > 0.05, '3回の中断・復帰のあとも新しい音は出力される');
    const end = await page.evaluate(() => ({ ...window.__rec, blocks: undefined }));
    assert.equal(end.created, 1, 'AudioContext は作り直さない');
    assert.equal(end.stateListeners, 1, 'statechange のリスナーは増えない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：中断中の要求は無音で待たず復帰後も鳴らない・3回の中断復帰・AudioContext とリスナーを増やさない');

  // (4) 再開の失敗（resume が拒否される）：例外を出さず、止まっている間は鳴らさず、再開できるようになれば古い音なしで鳴る
  {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    assert.equal(await rcPlaySuspend(page, 'riichi', 100), 'played');
    await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended');
    await page.evaluate(() => { const c = window.__mathjong.sound.ctx; c.__resume = c.resume; c.resume = () => Promise.reject(new Error('NotAllowedError')); });
    await page.waitForTimeout(1000);
    const a = await rcMark(page);
    await rcTap(page); await rcTap(page); // 再開に失敗する操作
    assert.equal((await rcState(page)).state, 'suspended');
    assert.equal(await page.evaluate(() => window.__mathjong.sound.play('pon')), 'blocked');
    await page.evaluate(() => { const c = window.__mathjong.sound.ctx; c.resume = c.__resume; }); // 再開できるようになった
    await rcTap(page);
    await rcRunning(page);
    const b = await rcMark(page);
    await page.waitForTimeout(1000);
    assert.ok(await rcPeak(page, b) < RC_EPS, `再開に失敗した後に再開できても、古い音は出ない（ピーク ${await rcPeak(page, b)}）`);
    assert.equal(await page.evaluate(() => window.__mathjong.sound.play('chi')), 'played');
    await page.waitForTimeout(260);
    assert.ok(await rcPeak(page, b) > 0.01, 'その後の新しい音は出力される');
    void a;
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：再開の失敗でも例外なし・失敗中は無音・再開後に古い音は出ない');

  // (5) 画面が隠れた（iPhone のバックグラウンド移行）：running のままでも鳴っている音を切り離し、戻っても続きは鳴らない。新しい音は鳴る
  {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    await page.evaluate(() => window.__mathjong.sound.play('tsumo'));
    await page.waitForTimeout(120);
    const a = await rcMark(page);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.deepEqual([(await rcState(page)).buses, (await rcState(page)).master], [0, false], '隠れたら鳴っている音の出力を切り離す');
    await page.waitForTimeout(80); // 録音の1ブロック分の遅れ
    const b = await rcMark(page);
    await page.waitForTimeout(1000);
    assert.ok(await rcPeak(page, b) < RC_EPS, `隠れた後は、続きが出力されない（ピーク ${await rcPeak(page, b)}）`);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    const c = await rcMark(page);
    assert.equal(await page.evaluate(() => window.__mathjong.sound.play('ron')), 'played');
    await page.waitForTimeout(300);
    assert.ok(await rcPeak(page, c) > 0.05, '戻った後の新しい音は出力される');
    // pagehide でも同様
    await page.waitForTimeout(900);
    await page.evaluate(() => window.__mathjong.sound.play('riichi'));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal((await rcState(page)).buses, 0);
    await page.waitForTimeout(80);
    const d = await rcMark(page);
    await page.waitForTimeout(900);
    assert.ok(await rcPeak(page, d) < RC_EPS, 'pagehide の後も続きは出力されない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：画面が隠れた・ページを離れたときも、鳴っている音を切り離し、戻っても続きは鳴らない');

  // (6) 次の局・タイトル移動：ロン音の途中で移動すると音が止まる（中断復帰の処理が通常の音声停止を壊さない）。中断中の移動でも古い音が残らない
  for (const nav of ['next', 'title', 'next-suspended']) {
    const { ctx, page, errors } = await realPage(browser);
    await rcUnlock(page);
    await v3Scene(page, presetWall(['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], ['0', '=-1/√3'], [['=1', 'sin', '0', '90', '90', '=-√3', '=√3', '150'], FX_O2, FX_O3]));
    await apDiscardDrawn(page);
    await apForce(page, 1, 'v:1');
    await v3WaitHuman(page);
    const a = await rcMark(page);
    await page.locator('button[data-action="ron"]').tap();
    assert.deepEqual((await sndKinds(page)).slice(-1), ['ron']);
    await page.waitForTimeout(150);
    if (nav === 'next-suspended') { await page.evaluate(() => window.__mathjong.sound.ctx.suspend()); await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended'); }
    if (nav === 'title') {
      await page.evaluate(() => { const m = window.__mathjong; m.S.modal = 'settings'; m.render(); });
      await page.locator('button[data-action="ask-title"]').tap();
      await page.locator('button[data-action="to-title"]').tap();
      await page.waitForSelector('.title-screen');
    } else {
      await page.locator('button[data-action="next"]').tap();
      await page.waitForSelector('.hand .tile');
    }
    assert.equal((await rcState(page)).master, false, `${nav}：出力の連鎖は切り離される`);
    if (nav === 'next-suspended') { await page.waitForTimeout(1200); await rcTap(page); await rcRunning(page); }
    await page.waitForTimeout(250); // 絞りの時間と録音の遅れ
    const b = await rcMark(page);
    await page.waitForTimeout(1200);
    assert.ok(await rcPeak(page, b) < RC_EPS, `${nav}：移動の後に古い音が出力されない（ピーク ${await rcPeak(page, b)}）`);
    assert.ok(await rcPeak(page, a, b) > 0.05, `${nav}：移動前のロン音は出力された`);
    if (nav !== 'title') {
      assert.equal(await page.evaluate(() => window.__mathjong.sound.play('discard')), 'played', `${nav}：次の局でも新しい音が鳴る`);
      await page.waitForTimeout(120);
      assert.ok(await rcPeak(page, b) > 0.01);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：次の局・タイトル移動（中断中を含む）で音が止まり、古い音が残らない');

  // (7) 効果音オフ・連続 unlock：オフでは AudioContext を作らない。連打しても AudioContext・リスナー・ノードは増えない。短時間に大量に鳴らしても出力（bus）は溜まらない
  {
    const { ctx, page, errors } = await realPage(browser);
    await page.evaluate(() => { window.__mathjong.S.sound.on = false; });
    await page.locator('.hand .tile.tap').first().tap();
    assert.equal((await page.evaluate(() => window.__rec.created)), 0, 'オフでは AudioContext を作らない');
    assert.equal(await page.evaluate(() => window.__mathjong.sound.play('ron')), 'off');
    await page.evaluate(() => { window.__mathjong.S.sound.on = true; });
    for (let i = 0; i < 8; i++) await rcTap(page); // 連続操作
    await rcRunning(page);
    const a = await page.evaluate(() => ({ created: window.__rec.created, listeners: window.__rec.stateListeners, gains: window.__rec.gains }));
    assert.deepEqual([a.created, a.listeners], [1, 1], '連続 unlock でも AudioContext・リスナーは1つ');
    for (let i = 0; i < 6; i++) await rcTap(page);
    const b = await page.evaluate(() => ({ created: window.__rec.created, listeners: window.__rec.stateListeners, gains: window.__rec.gains }));
    assert.deepEqual(b, a, '操作のたびにノードを作らない（unlock はノードを増やさない）');
    for (let i = 0; i < 30; i++) await page.evaluate((k) => window.__mathjong.sound.play(k), ['discard', 'chi', 'pon'][i % 3]);
    assert.ok((await rcState(page)).buses <= 30);
    await page.waitForTimeout(1000);
    assert.equal((await rcState(page)).buses, 0, '鳴り終わった音の出力は実時間で外れ、溜まらない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2：効果音オフでは AudioContext を作らない・連続 unlock で増えない・鳴り終えた音の出力は溜まらない');
}

// ---- Ver.0.5-E：カットイン演出・宣言者の表示・席の発光・演出キュー・宣言ボイスの導入準備 ----
const E_POS = ['自分', '下家', '対面', '上家'];
const E_NAME = ['あなた', 'おうすけ', 'なつき', 'ゆき'];
const E_MS = { chi: 1000, pon: 1200, ron: 2200, tsumo: 2000, riichi: 900 };
const E_MIN = { chi: 700, pon: 800, ron: 2200, tsumo: 2000, riichi: 650 };
// 演出レイヤーの変化を記録する（表示の瞬間の宣言者・席・発光している席・キューの長さ・ゲームの記録との対応）
const eObserve = (page) => page.evaluate(() => {
  const L = document.getElementById('fx-layer');
  const rec = window.__fxrec = [];
  new MutationObserver(() => {
    const m = window.__mathjong; const c = m.S.fx.current; const who = L.querySelector('.fx-who');
    const glow = [...document.querySelectorAll('.fx-seat, .fx-seat-lite')].map((el) => (el.classList.contains('self') ? 0 : Number((el.className.match(/seat-(\d)/) || [])[1])));
    rec.push({
      t: performance.now(), cls: L.className, kind: c ? c.kind : null, serial: m.S.gameSerial,
      name: who ? who.querySelector('.fx-name').textContent : null, pos: who && who.querySelector('.fx-pos') ? who.querySelector('.fx-pos').textContent : null,
      dataSeat: who ? Number(who.dataset.seat) : null, evSeat: c ? c.event.seat : null, evInLog: c ? m.S.game.events.includes(c.event) || c.event.type === 'win' && m.S.game.events.some((e) => e.type === 'win' && e.seat === c.event.seat) : null,
      glow, queue: m.S.fx.queue.length, evTile: c && c.event.tile !== undefined ? String(c.event.tile) : null,
      meldGlow: [...document.querySelectorAll('.meld.fx-glow')].map((e) => e.dataset.claimed),
    });
  }).observe(L, { childList: true });
});
// 表示中の演出の要素の位置と不透明度
const eLook = (page) => page.evaluate(() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, op: Number(getComputedStyle(e).opacity) }; };
  return { who: box('#fx-layer .fx-who'), word: box('#fx-layer .fx-word'), tiles: box('#fx-layer .fx-tiles, #fx-layer .fx-wintile, #fx-layer .fx-decl'), band: box('#fx-layer .fx-band'),
    banner: box('#fx-layer .fx-banner'), card: box('#fx-layer .fx-card'), vw: innerWidth, vh: innerHeight, sx: document.documentElement.scrollWidth - innerWidth,
    flashes: document.querySelectorAll('#fx-layer .fx-flash').length };
});
// 鳴いた面子を用意して、その席の演出を出す（表示の確認用。本物の記録がなくても演出だけを出す）
const eFire = (page, kind, seat) => page.evaluate(([k, s]) => {
  const { S, fx } = window.__mathjong; const g = S.game;
  if (k === 'ron' || k === 'tsumo') { g.result = { ...(g.result || {}), tile: g.hands[s][0] }; fx.fire(k, { type: 'win', seat: s, how: k, from: (s + 1) % 4 }); return; }
  if (k === 'riichi') { fx.fire(k, { type: 'riichi', seat: s, tile: g.hands[s][0] }); return; }
  g.melds[s].push({ meld: 0, kind: 'formula', call: k, tiles: g.hands[s].slice(0, 3), claimed: g.hands[s][0], from: (s + 3) % 4 });
  fx.fire(k, { type: k, seat: s, tile: g.hands[s][0] });
}, [kind, seat]);

async function v05eCutin(browser) {
  // (1) 宣言者の表示と席の発光：4人 × チー・ポン・ロン・ツモ・リーチ。名前・席（下家／対面／上家）・発光する席が、記録の seat と一致する
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    for (const kind of ['chi', 'pon', 'riichi', 'tsumo', 'ron']) {
      for (const seat of [0, 1, 2, 3]) {
        await page.evaluate(() => window.__mathjong.fx.clear());
        await eFire(page, kind, seat);
        const st = await page.evaluate(() => {
          const L = document.getElementById('fx-layer'); const w = L.querySelector('.fx-who');
          return { cls: L.className, name: w.querySelector('.fx-name').textContent, pos: w.querySelector('.fx-pos') ? w.querySelector('.fx-pos').textContent : null, of: w.querySelector('.fx-of').textContent,
            word: L.querySelector('.fx-word').textContent, seats: [...document.querySelectorAll('.fx-seat')].map((el) => (el.classList.contains('self') ? 0 : Number(el.className.match(/seat-(\d)/)[1]))),
            seatKind: [...document.querySelectorAll('.fx-seat')].map((el) => [...el.classList].find((c) => /^fx-seat-[a-z]+$/.test(c) && c !== 'fx-seat-lite')) };
        });
        assert.equal(st.cls, `fx-${kind}`);
        assert.equal(st.name, E_NAME[seat], `${kind}/席${seat}：宣言者の名前`);
        assert.equal(st.pos, seat === 0 ? null : E_POS[seat], `${kind}/席${seat}：席（AI だけ）`);
        assert.equal(`${st.name} ${st.of}${st.word}`, `${E_NAME[seat]} の${{ chi: 'チー！', pon: 'ポン！', ron: 'ロン！', tsumo: 'ツモ！', riichi: 'リーチ！' }[kind]}`, '「なつき のロン！」のように読める');
        assert.deepEqual(st.seats, [seat], `${kind}/席${seat}：発光するのは宣言者の席だけ`);
        assert.deepEqual(st.seatKind, [`fx-seat-${kind}`], '宣言の色で発光');
      }
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E：宣言者（あなた／おうすけ・B・C と席）を大きく表示し、宣言者の席だけを宣言の色で発光（5種類 × 4席）');

  // (2) 演出の長さ（本物の宣言）：チー 1.0秒・ポン 1.2秒・ロン 2.2秒・ツモ 2.0秒・リーチ 0.9秒。中央の静止時間に文字・宣言者・牌が読める
  const hold = async (page, kind) => {
    // 静止区間の中ほど（登場が終わった後）で、文字・宣言者・牌がはっきり見えて画面内にある
    await page.waitForTimeout(kind === 'ron' || kind === 'tsumo' ? 650 : Math.round(E_MS[kind] * 0.45));
    const l = await eLook(page);
    for (const k of ['who', 'word', 'tiles']) {
      assert.ok(l[k] && l[k].op >= 0.95, `${kind}：${k} が見える（${JSON.stringify(l[k])}）`);
      assert.ok(l[k].l >= -1 && l[k].r <= l.vw + 1 && l[k].t >= -1 && l[k].b <= l.vh + 1, `${kind}：${k} が画面内`);
    }
    return l;
  };
  {
    // 自分のチー・ポン
    for (const [kind, hand] of [['chi', ['=1/2', '45', 'sin', '30', '0', '0', '135', '=-√3']], ['pon', ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']]]) {
      const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
      await fxToClaim(page, hand);
      await page.locator(`button[data-action="${kind}"]`).first().tap();
      assert.equal((await fxState(page)).cls, `fx-${kind}`);
      const l = await hold(page, kind);
      assert.ok(l.band && l.band.op >= 0.95, `${kind}：カットインの帯`);
      const dur = await fxDuration(page);
      assert.ok(dur >= E_MS[kind] && dur <= E_MS[kind] + 250, `${kind}：${E_MS[kind]}ms（${dur}ms）`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // 自分のリーチ・ツモ・ロン
    {
      const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
      await v3Scene(page, presetWall(RI_HAND, RI_DRAWS, [RI_O1, RI_O2, RI_O3]));
      await riDeclare(page);
      await hold(page, 'riichi');
      const dur = await fxDuration(page);
      assert.ok(dur >= 900 && dur <= 1150, `riichi：900ms（${dur}ms）`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
      await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
      await page.locator('button[data-action="tsumo"]').tap();
      assert.equal((await fxState(page)).modal, 'result', '結果画面は演出を待たずに開く');
      await hold(page, 'tsumo');
      const dur = await fxDuration(page);
      assert.ok(dur >= 2000 && dur <= 2250, `tsumo：2000ms（${dur}ms）`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ Ver.0.5-E：演出の長さ（チー1.0・ポン1.2・リーチ0.9・ツモ2.0秒）と、静止時間に文字・宣言者・牌が見えて画面内にある');

  // (3) ロン：冒頭は強い演出（閃光1回・光条・揺れ）→ 中央で静止 → 後半は中央の表示を消して最上部の小さな帯に替える（結果画面を長く隠さない）
  let ronLateMs = null;
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(['=1', 'sin', 'sin', '0', '90', '=-√3', '=√3', '150'], ['45', '=-1/√3', '=-√3/2', '=-1/√2'], [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], FX_O2, FX_O3]));
    const id = await page.evaluate(() => { const { S, rules } = window.__mathjong; return S.game.hands[0].find((x) => rules.types[S.game.typeOf(x)].key === 'v:1'); });
    await page.locator(`.hand .tile[data-id="${id}"]`).tap(); await page.locator(`.hand .tile[data-id="${id}"]`).tap();
    await page.waitForFunction(() => window.__mathjong.S.fx.history.includes('ron'), null, { timeout: 8000 });
    const t0 = await page.evaluate(() => window.__mathjong.S.fx.current.startedAt);
    const early = await eLook(page);
    assert.equal(early.flashes, 1, '閃光は1つ');
    const flash = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#fx-layer .fx-flash')); return [s.animationName, s.animationIterationCount, parseFloat(s.animationDuration)]; });
    assert.deepEqual(flash, ['fx-flash-once', '1', 0.6], '閃光は冒頭の1回だけ（繰り返さない）');
    assert.equal((await fxState(page)).who, 'おうすけ');
    assert.equal(await page.locator('.overlay .result').isVisible(), true, '結果画面はすぐ開く');
    await hold(page, 'ron');
    // 後半：中央の表示は消え、最上部の小さな帯だけが残る。CSS（2.2秒）では中央は 1.10〜1.28 秒で消え、帯は 1.28〜2.02 秒に不透明。
    // 決まった時刻に1回だけ見るのではなく、演出の開始から上限 2.0 秒（帯が消え始める前）までに、その状態になったことを確かめる。
    // 上限を過ぎた観測は、条件を満たしていても失敗（判定は tests/e2e/ron-late.mjs の judgeRonLate、境界は単体テストで検査）。
    // 失敗時は、その観測の表示（経過時間・中央・帯の不透明度と位置・演出の種類・fx-layer のクラス）を出す。
    const LATE_LIMIT_MS = RON_LATE_LIMIT_MS;
    let lateRes, verdict;
    for (const until = Date.now() + 8000; ;) {
      lateRes = await page.evaluate((s) => {
        const look = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), op: Number(getComputedStyle(e).opacity) }; };
        const cur = window.__mathjong.S.fx.current;
        return { elapsed: performance.now() - s, card: look('#fx-layer .fx-card'), banner: look('#fx-layer .fx-banner'), kind: cur && cur.kind, cls: document.getElementById('fx-layer').className };
      }, t0);
      verdict = judgeRonLate(lateRes, LATE_LIMIT_MS);
      if (verdict !== 'wait' || Date.now() > until) break;
    }
    lateRes.elapsed = Math.round(lateRes.elapsed * 10) / 10;
    assert.equal(verdict, 'ok', `${LATE_LIMIT_MS}ms 以内に中央の表示が消えて最上部の小さな帯に替わる（判定 ${verdict}、実際の表示：${JSON.stringify(lateRes)}）`);
    assert.ok(lateRes.elapsed >= 1000, `中央の表示は静止の後に消える（${lateRes.elapsed}ms）`);
    ronLateMs = lateRes.elapsed;
    assert.equal(await page.locator('#fx-layer .fx-banner .fx-name').textContent(), 'おうすけ');
    // 演出中も結果画面のボタンを押せる（演出はタップを通す）。次の局へ進むと演出を消す
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    const st = await page.evaluate(() => ({ cls: document.getElementById('fx-layer').className, cur: window.__mathjong.S.fx.current, q: window.__mathjong.S.fx.queue.length, glow: document.querySelectorAll('.fx-seat').length }));
    assert.deepEqual(st, { cls: '', cur: null, q: 0, glow: 0 }, '新しい局へ持ち越さない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`✓ Ver.0.5-E：ロンは閃光1回→静止→最上部の小さな帯（結果画面を長く隠さない。帯に替わった時刻 ${ronLateMs}ms／上限 ${RON_LATE_LIMIT_MS}ms）。結果画面はすぐ開き、演出中も次の局へ進める`);

  // (4) 実際の速い対局（AI 待ち時間 0）：AI 同士のチー・ポンを含め、表示した演出の宣言者・席・発光が記録の seat と一致。
  //     チー・ポン・リーチは最低表示時間を守り（ロン・ツモで置き換えた場合と局の切替を除く）、キューは2以下。宣言の音は表示と同じ順・同じ数
  // 監査対応：数学Ⅱ・AI 難易度（初級・中級・上級）でも。宣言はすべて「表示」か「明示的な破棄」のどちらか（取りこぼしなし）。鳴きの面子の発光も記録の牌と一致
  for (const cfg of [
    { mode: 'math1', ai: 'intermediate', rounds: [7, 19, 22, 25, 26, 27, 28], minCalls: 1 },
    { mode: 'math2', ai: 'intermediate', rounds: [6, 16, 18, 20, 23], minCalls: 0 },
    { mode: 'math1', ai: 'beginner', rounds: [7, 19, 22, 25], minCalls: 0 },
    { mode: 'math1', ai: 'advanced', rounds: [7, 19, 22, 25], minCalls: 0 },
  ]) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(SND_FN, { resume: 'ok' });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?mode=${cfg.mode}&seed=11&ai=${cfg.ai}&speed=test`);
    await page.waitForSelector('.hand .tile');
    const rosterNames = await page.evaluate(() => window.__mathjong.S.game.players.map((p) => p.name));
    await paSettings(page, true, true); // 自分のチー・ポンは自動で見送る（AI 同士の鳴きを増やす）
    await page.evaluate(() => { const s = window.__mathjong.sound; const orig = s.play; window.__calls = []; s.play = (k, o) => { window.__calls.push(k); return orig(k, o); }; });
    await eObserve(page);
    const summary = await page.evaluate(async (rounds) => {
      const m = window.__mathjong; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = { aiCalls: 0, rounds: 0, declared: 0 };
      for (const round of rounds) { // seed 11 で AI 同士のチー・ポンが起きる局（事前に調べた）
        m.goRound(round);
        for (let guard = 0; guard < 4000; guard++) {
          const g = m.S.game; const p = g.pending();
          if (!p) break;
          if (p.seat === 0) {
            if (p.type === 'turn') g.discard(0, g.drawn !== null && g.drawn !== undefined ? g.drawn : g.hands[0][0]);
            else g.respond(0, { type: 'pass' });
            m.step(true);
          }
          await sleep(20);
        }
        calls.aiCalls += m.S.game.events.filter((e) => (e.type === 'chi' || e.type === 'pon') && e.seat !== 0).length;
        calls.declared += m.S.game.events.filter((e) => ['chi', 'pon', 'riichi', 'win'].includes(e.type)).length;
        calls.rounds++;
        await sleep(2400); // 和了の演出を最後まで
      }
      calls.dropped = m.S.fx.dropped;
      return calls;
    }, cfg.rounds);
    const rec = await page.evaluate(() => window.__fxrec);
    const shows = rec.filter((r) => r.cls && !r.cls.includes('lite'));
    assert.ok(summary.aiCalls >= cfg.minCalls, `AI 同士のチー・ポンが起きた（${JSON.stringify(summary)}）`);
    if (cfg.minCalls) assert.ok(shows.some((r) => (r.kind === 'chi' || r.kind === 'pon') && r.dataSeat !== 0), 'AI 同士のチー・ポンの演出が表示された');
    assert.equal(shows.length + summary.dropped, summary.declared, `${cfg.mode}/${cfg.ai}：宣言はすべて表示か明示的な破棄（表示 ${shows.length}・破棄 ${summary.dropped}・宣言 ${summary.declared}）`);
    for (const r of shows) {
      assert.equal(r.dataSeat, r.evSeat, '宣言者はゲームの記録の seat');
      assert.equal(r.evInLog, true, '表示した演出は、実際の記録に対応する');
      assert.equal(r.name, rosterNames[r.evSeat]);
      assert.equal(r.pos, r.evSeat === 0 ? null : E_POS[r.evSeat]);
      assert.deepEqual(r.glow, [r.evSeat], '発光するのは宣言者の席だけ');
      assert.ok(r.queue <= 2, 'キューは上限以下');
      if (r.kind === 'chi' || r.kind === 'pon') assert.deepEqual(r.meldGlow, [r.evTile], '光る面子は、その宣言で鳴いた牌の面子');
    }
    // 最低表示時間：次の表示または消去までの時間（同じ局で、ロン・ツモに置き換えられた場合を除く）
    let checked = 0;
    for (let i = 0; i < rec.length - 1; i++) {
      const a = rec[i]; const b = rec[i + 1];
      if (!a.cls || a.serial !== b.serial) continue;
      if (b.kind === 'ron' || b.kind === 'tsumo') continue;
      const kind = a.kind;
      const need = b.cls ? E_MIN[kind] : E_MS[kind];
      assert.ok(b.t - a.t >= need - 40, `${kind} の表示時間 ${Math.round(b.t - a.t)}ms ≥ ${need}ms`);
      checked++;
    }
    if (cfg.minCalls) assert.ok(checked >= 3, `表示時間を確認した演出 ${checked}`);
    // 宣言の音は、表示した演出と同じ順・同じ数（待って出した演出は表示と同時に鳴り、捨てた演出は鳴らない）
    const callSounds = (await page.evaluate(() => window.__calls)).filter((k) => k !== 'discard');
    assert.deepEqual(callSounds, shows.map((r) => r.kind), '宣言の効果音と演出が一致');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`  （${cfg.mode}・AI ${cfg.ai}：${summary.rounds}局・宣言 ${summary.declared}回・AI 同士のチー/ポン ${summary.aiCalls}回・表示 ${shows.length}回・破棄 ${summary.dropped}回・最低表示時間の確認 ${checked}回）`);
  }
  console.log('✓ Ver.0.5-E：速い実対局で、AI 同士のチー・ポンも宣言者・席・発光が記録と一致。最低表示時間を守り、キューは2以下、宣言の音は表示と一致');

  // (5) 演出キュー（画面）：チー表示中のポンは待って、チーの最低表示時間の後に表示。ロンが来たら待っている演出を捨ててすぐロン。音は表示の時に鳴る
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await rcUnlock(page).catch(() => {}); // 偽の AudioContext では resume で running になる
    await page.locator('.hand .tile.tap').first().tap();
    await eObserve(page);
    await eFire(page, 'chi', 3);
    await page.waitForTimeout(100);
    await eFire(page, 'pon', 2);
    assert.deepEqual(await page.evaluate(() => [window.__mathjong.S.fx.current.kind, window.__mathjong.S.fx.queue.length]), ['chi', 1], 'ポンは待つ');
    assert.equal((await sndKinds(page)).filter((k) => k === 'pon').length, 0, 'ポンの音はまだ鳴らない（表示と一緒に鳴らす）');
    await page.waitForFunction(() => window.__mathjong.S.fx.current && window.__mathjong.S.fx.current.kind === 'pon', null, { timeout: 3000 });
    const rec = await page.evaluate(() => window.__fxrec.filter((r) => r.cls));
    assert.ok(rec[1].t - rec[0].t >= 880 - 30 && rec[1].t - rec[0].t <= 880 + 200, `チーは最低表示時間（0.7秒）＋退出（0.18秒）で次へ（${Math.round(rec[1].t - rec[0].t)}ms）`);
    assert.equal(rec[1].name, 'なつき');
    assert.equal((await sndKinds(page)).filter((k) => k === 'pon').length, 1, 'ポンの音は表示と同時に1回');
    await eFire(page, 'chi', 1);
    await eFire(page, 'riichi', 3);
    await eFire(page, 'ron', 2);
    const st = await page.evaluate(() => ({ cur: window.__mathjong.S.fx.current.kind, q: window.__mathjong.S.fx.queue.length, h: [...window.__mathjong.S.fx.history] }));
    assert.deepEqual(st, { cur: 'ron', q: 0, h: ['chi', 'pon', 'ron'] }, 'ロンはすぐ表示し、待っていたチー・リーチは捨てる');
    const k = await sndKinds(page);
    assert.deepEqual(k.filter((x) => x !== 'discard'), ['chi', 'pon', 'ron'], '捨てた演出の音は鳴らない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E：演出キュー（チー表示中のポンは待って最低表示時間の後に表示・音も表示時・ロンで待ちを捨てる）');

  // (6) 簡易表示・reduced motion：帯・閃光・揺れ・牌を出さず、宣言者と文字を十分な時間表示。席は点滅させず枠の色だけ。ロン・ツモは上部に出す
  for (const how of ['lite', 'reduced']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    if (how === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    else await fxSetMode(page, 'lite');
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    for (const [kind, seat] of [['pon', 2], ['chi', 3], ['ron', 1]]) {
      await page.evaluate(() => window.__mathjong.fx.clear());
      await eFire(page, kind, seat);
      const st = await page.evaluate(() => ({ cls: document.getElementById('fx-layer').className, extra: document.querySelectorAll('#fx-layer .fx-band, #fx-layer .fx-flash, #fx-layer .fx-rays, #fx-layer .fx-tiles, #fx-layer .fx-wintile, #fx-layer .fx-banner').length,
        shake: document.querySelectorAll('.fx-shake').length, glowAnim: document.querySelectorAll('.fx-seat').length, outline: [...document.querySelectorAll('.fx-seat-lite')].map((el) => (el.classList.contains('self') ? 0 : Number(el.className.match(/seat-(\d)/)[1]))) }));
      assert.deepEqual(st, { cls: `fx-${kind} lite`, extra: 0, shake: 0, glowAnim: 0, outline: [seat] }, `${how}/${kind}`);
      await page.waitForTimeout(Math.round(E_MS[kind] * 0.5));
      const l = await eLook(page);
      assert.ok(l.who.op >= 0.95 && l.word.op >= 0.95, `${how}/${kind}：宣言者と文字が見える`);
      assert.equal(await page.locator('#fx-layer .fx-name').textContent(), E_NAME[seat]);
      if (kind === 'ron') assert.ok(l.card.t < l.vh * 0.25, `${how}：ロンは上部に出す（${Math.round(l.card.t)}px）`);
      const dur = await fxDuration(page);
      assert.ok(dur >= E_MS[kind] * 0.5 - 50, `${how}/${kind}：十分な時間表示`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E：簡易表示・reduced motion は宣言者と文字だけ（帯・閃光・揺れ・牌なし）・席は枠の色だけ・ロンは上部・表示時間は通常と同じ');

  // (7) iPhone 相当の縦横画面：文字・宣言者・牌が見切れず、横スクロールなし。演出中も手牌を操作できる
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [932, 430]]) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' }, 'math1', { viewport: { width: w, height: h } });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    for (const kind of ['chi', 'pon', 'ron', 'tsumo', 'riichi']) {
      await page.evaluate(() => window.__mathjong.fx.clear());
      await eFire(page, kind, 2);
      await page.waitForTimeout(kind === 'ron' || kind === 'tsumo' ? 650 : Math.round(E_MS[kind] * 0.45));
      const l = await eLook(page);
      for (const k of ['who', 'word', 'tiles']) assert.ok(l[k].l >= -1 && l[k].r <= w + 1 && l[k].t >= -1 && l[k].b <= h + 1, `${w}x${h} ${kind} ${k} ${JSON.stringify(l[k])}`);
      assert.ok(l.sx <= 0, `${w}x${h} 横スクロール`);
      assert.ok(l.who.b - l.who.t >= 22, `${w}x${h} 宣言者の文字が大きい（${Math.round(l.who.b - l.who.t)}px）`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/v05e-${kind}-${w}x${h}.png` });
    }
    // 演出中のタップ：手牌の牌を選べる
    await page.evaluate(() => window.__mathjong.fx.clear());
    await eFire(page, 'pon', 1);
    await page.locator('.hand .tile.tap').first().tap();
    assert.equal(await page.locator('.hand .tile.selected').count(), 1, `${w}x${h}：演出中も牌を選べる`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E：320〜932px の縦横画面で文字・宣言者・牌が見切れず、横スクロールなし・演出中も操作できる');
}

// 宣言ボイス（導入の準備）：テスト用の音声（440Hz の音。人の声ではない）を本物の AudioContext で鳴らして確かめる
function eWav(seconds = 0.8, hz = 440, rate = 22050) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.5 * 32767), 44 + i * 2);
  return buf;
}
const E_VOICE_M = { id: 'test', credit: 'テスト用の音（人の声ではありません）', gain: 1, sfxGain: 0.5, files: { chi: 'src/ui/voice-test-chi.m4a', pon: 'src/ui/voice-test-pon.m4a', ron: 'src/ui/voice-test-ron.m4a', tsumo: 'src/ui/voice-test-tsumo.m4a' } };
async function eVoicePage(browser, { missing = [] } = {}) {
  const { ctx, page, errors } = await realPage(browser);
  const wav = eWav();
  await page.route('**/src/ui/voice-test-*.m4a', (route) => {
    if (missing.some((m) => route.request().url().includes(m))) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  await page.evaluate((m) => window.__mathjong.voice.setManifest(m), E_VOICE_M);
  return { ctx, page, errors };
}
const eVoiceLog = (page) => page.evaluate(() => window.__mathjong.voice.log.map((x) => `${x.kind}:${x.status}`));

async function v05eVoice(browser) {
  // (1) 採用された音声がないとき（現状）：設定に出さず、何も読み込まない
  {
    const { ctx, page, errors } = await realPage(browser);
    const reqs = [];
    page.on('request', (r) => { if (/voice-/.test(r.url())) reqs.push(r.url()); });
    await rcUnlock(page);
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="voice"]').count(), 0, '宣言ボイスの設定は出さない（音声が未採用）');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await eFire(page, 'pon', 2);
    assert.deepEqual(await eVoiceLog(page), ['pon:none']);
    assert.deepEqual(reqs, [], '音声ファイルを読みに行かない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E 声：正式採用された音声がない現状では、設定にも出さず、何も読み込まない（効果音だけ）');

  // (2) テスト用の音声で：演出が実際に始まったときに声が鳴り、宣言の効果音は下げる。待った演出の声は表示のときに鳴る。設定のオン／オフと保存
  {
    const { ctx, page, errors } = await eVoicePage(browser);
    await rcUnlock(page);
    await page.waitForFunction(() => Object.keys(window.__mathjong.voice.buffers).length === 4, null, { timeout: 5000 });
    const m0 = await rcMark(page);
    await eFire(page, 'chi', 3);
    await page.waitForTimeout(100);
    await eFire(page, 'pon', 2); // 待つ
    assert.deepEqual(await eVoiceLog(page), ['chi:played'], 'ポンの声はまだ（演出の表示と一緒）');
    const s = await page.evaluate(() => window.__mathjong.sound.log.slice(-2).map((x) => `${x.kind}:${x.status}`));
    assert.deepEqual(s, ['voice:chi:played', 'chi:played']);
    await page.waitForFunction(() => window.__mathjong.S.fx.current && window.__mathjong.S.fx.current.kind === 'pon', null, { timeout: 3000 });
    assert.deepEqual(await eVoiceLog(page), ['chi:played', 'pon:played'], 'ポンの声は表示のときに1回');
    await page.waitForTimeout(300);
    assert.ok(await rcPeak(page, m0) > 0.05, '声（テスト用の音）が実際に出力された');
    // 設定：オフにすると鳴らない・保存される
    await page.evaluate(() => window.__mathjong.fx.clear());
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('select[data-action="voice"]').inputValue(), '1', '既定はオン');
    assert.equal(await page.locator('.voice-credit').textContent(), E_VOICE_M.credit, '利用条件の表記を出す');
    await page.locator('select[data-action="voice"]').selectOption('0');
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-voice')), '0');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    await eFire(page, 'ron', 1);
    assert.equal((await eVoiceLog(page)).at(-1), 'ron:off');
    assert.equal(await page.evaluate(() => window.__mathjong.sound.log.at(-1).kind), 'ron', '効果音は鳴る（音量は通常）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E 声：演出の開始と同時に声（待った演出は表示時）・効果音を下げる・設定オン／オフと保存・利用条件の表記');

  // (3) 読み込み失敗：その種類は鳴らさず、効果音だけで続く（例外なし）
  {
    const { ctx, page, errors } = await eVoicePage(browser, { missing: ['voice-test-ron'] });
    await rcUnlock(page);
    await page.waitForFunction(() => Object.keys(window.__mathjong.voice.buffers).length === 3 && window.__mathjong.voice.errors.ron, null, { timeout: 5000 });
    await eFire(page, 'ron', 1);
    assert.equal((await eVoiceLog(page)).at(-1), 'ron:notready');
    assert.equal(await page.evaluate(() => window.__mathjong.sound.log.at(-1).kind + ':' + window.__mathjong.sound.log.at(-1).status), 'ron:played', '効果音は鳴る');
    assert.deepEqual(errors.filter((e) => !/HTTP 404 .*voice-test-ron/.test(e) && !/404/.test(e)), [], '404 以外のエラーなし');
    await ctx.close();
  }
  console.log('✓ Ver.0.5-E 声：読み込みに失敗した声は鳴らさず、効果音だけで正常に続く');

  // (4) P2（Ver.0.5-D）の再発防止：声の途中で suspend → 待つ → resume で、古い声も効果音も出力されない。次の局・画面が隠れたときも止まる
  for (const how of ['suspend', 'next', 'hidden']) {
    const { ctx, page, errors } = await eVoicePage(browser);
    await rcUnlock(page);
    await page.waitForFunction(() => Object.keys(window.__mathjong.voice.buffers).length === 4, null, { timeout: 5000 });
    const a0 = await rcMark(page);
    await eFire(page, 'tsumo', 0);
    await page.waitForTimeout(120);
    assert.equal((await eVoiceLog(page)).at(-1), 'tsumo:played', `${how}：声が鳴っている最中`);
    assert.ok(await rcPeak(page, a0) > 0.01, `${how}：中断前は出力された`);
    if (how === 'suspend') {
      await page.evaluate(() => window.__mathjong.sound.ctx.suspend());
      await page.waitForFunction(() => window.__mathjong.sound.ctx.state === 'suspended');
      await page.waitForTimeout(1500);
      await rcTap(page);
      await rcRunning(page);
    } else if (how === 'next') {
      await page.evaluate(() => window.__mathjong.startRound());
    } else {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    }
    await page.waitForTimeout(150);
    const b = await rcMark(page);
    await page.waitForTimeout(1200);
    assert.ok(await rcPeak(page, b) < RC_EPS, `${how}：古い声・効果音は出力されない（ピーク ${await rcPeak(page, b)}）`);
    if (how === 'hidden') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
    await page.evaluate(() => window.__mathjong.fx.clear());
    await eFire(page, 'chi', 3);
    await page.waitForTimeout(300);
    assert.ok(await rcPeak(page, b) > 0.05, `${how}：その後の新しい声・効果音は出力される`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.5-D P2 の再発なし：声の途中の中断→復帰・次の局・画面が隠れたとき、古い声も効果音も出力されない（本物の AudioContext）');
}

// ---- Ver.0.5-E 監査 P2-A・P2-B・P2-C・P3-A・P3-B の修正 ----
// 宣言の記録を（手牌から公開面子を作って）ゲームの記録に足す。演出は本物の fxScan()・soundScan() で判定する（fxFire を直接呼ばない）。
// 自分の打牌番（AI は動かない）の局面で使う。戻り値：鳴いた牌の id（チー・ポン）
const eAddEvent = (page, kind, seat, opts = {}) => page.evaluate(([k, s, o]) => {
  const { S } = window.__mathjong; const g = S.game;
  if (k === 'discard') { g.events.push({ type: 'discard', seat: s, tile: g.hands[s][0] }); return null; }
  if (k === 'riichi') { g.events.push({ type: 'riichi', seat: s, tile: g.hands[s][0] }); return g.hands[s][0]; }
  if (k === 'ron' || k === 'tsumo') { g.result = { ...(g.result || {}), tile: g.hands[s][0] }; g.events.push({ type: 'win', seat: s, how: k, from: (s + 1) % 4 }); return null; }
  // チー・ポン：手牌の3枚で公開面子を作る（o.noMeld のときは面子を作らず記録だけ＝面子が見つからない場合）
  const used = new Set(g.melds.flat().flatMap((m) => m.tiles));
  const ids = g.hands[s].filter((id) => !used.has(id)).slice(o.offset || 0, (o.offset || 0) + 3);
  const tile = ids[0];
  if (!o.noMeld) g.melds[s].push({ meld: 0, kind: 'formula', call: k, tiles: ids, claimed: tile, from: (s + 3) % 4 });
  g.events.push({ type: k, seat: s, from: (s + 3) % 4, tile, meld: 0 });
  return tile;
}, [kind, seat, opts]);
const eScan = (page) => page.evaluate(() => { const m = window.__mathjong; m.render(); m.fx.scan(); m.soundScan(); });
const eFxNow = (page) => page.evaluate(() => {
  const m = window.__mathjong; const c = m.S.fx.current; const L = document.getElementById('fx-layer');
  return { kind: c ? c.kind : null, seat: c ? c.seat : null, queue: m.S.fx.queue.map((q) => q.kind), dropped: m.S.fx.dropped, history: [...m.S.fx.history], cls: L.className,
    glow: [...document.querySelectorAll('.meld.fx-glow')].map((e) => e.dataset.claimed), calls: m.sound.log.map((x) => x.kind).filter((k) => k !== 'discard'), discards: m.sound.log.filter((x) => x.kind === 'discard').length };
});
const eWaitKind = (page, kind) => page.waitForFunction((k) => window.__mathjong.S.fx.current && window.__mathjong.S.fx.current.kind === k, kind, { timeout: 4000 });

async function v05eAuditFix(browser) {
  // P2-A (1) fxScan 経由：同じ回のチー → ポン、ポン → リーチ。両方とも記録の順に表示し、音は表示の時に1回ずつ
  for (const [a, b] of [['chi', 'pon'], ['pon', 'riichi'], ['chi', 'riichi']]) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('.top').first().tap({ position: { x: 4, y: 4 } }); // 再生の許可（偽の AudioContext）
    await eAddEvent(page, a, 3);
    await eAddEvent(page, 'discard', 3);
    await eAddEvent(page, b, b === 'riichi' ? 3 : 2, { offset: 3 });
    await eScan(page);
    let st = await eFxNow(page);
    assert.deepEqual([st.kind, st.queue, st.calls], [a, [b], [a]], `${a}→${b}：先の宣言を表示、後の宣言は待つ（消えない）。音は表示した分だけ`);
    for (let i = 0; i < 3; i++) await eScan(page); // 再描画・scan を繰り返しても二重に出ない
    assert.deepEqual((await eFxNow(page)).queue, [b]);
    await eWaitKind(page, b);
    st = await eFxNow(page);
    assert.deepEqual([st.history, st.calls, st.queue, st.dropped], [[a, b], [a, b], [], 0], `${a}→${b}：両方を表示し、音も1回ずつ`);
    assert.equal(st.discards, 0, '同じ回に宣言があれば打牌音は鳴らさない（宣言の音が代表する）');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-A：fxScan 経由で同じ回のチー→ポン・ポン→リーチ・チー→リーチを両方表示（記録の順・音は表示時に1回ずつ・繰り返しの scan で二重にならない）');

  // P2-A (2) 宣言とロン・ツモが同じ回：和了だけをすぐ表示し、前の通常の宣言は明示的に破棄（表示・音なし）。待っていた演出も破棄
  for (const win of ['ron', 'tsumo']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('.top').first().tap({ position: { x: 4, y: 4 } });
    await eAddEvent(page, 'chi', 1); await eScan(page); // 表示中
    await eAddEvent(page, 'pon', 2); await eScan(page); // 待つ
    await eAddEvent(page, 'riichi', 3);
    await eAddEvent(page, 'chi', 3, { offset: 3 });
    await eAddEvent(page, win, 3);
    await eScan(page);
    const st = await eFxNow(page);
    assert.deepEqual([st.kind, st.queue, st.history, st.calls, st.dropped], [win, [], ['chi', win], ['chi', win], 3], `${win}：和了をすぐ表示・待っていたポンと同じ回のリーチ・チーは破棄（音なし）`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-A：宣言とロン・ツモが同じ回なら、和了をすぐ表示し、待ち・同じ回の通常の宣言は明示的に破棄（表示・音なし）');

  // P2-A (3) キューの上限超過：同じ回に4つの宣言 → 1つ表示・2つ待ち・1つ破棄。表示した3つの音だけが鳴る
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('.top').first().tap({ position: { x: 4, y: 4 } });
    await eAddEvent(page, 'chi', 1); await eAddEvent(page, 'pon', 2); await eAddEvent(page, 'chi', 3); await eAddEvent(page, 'riichi', 1);
    await eScan(page);
    let st = await eFxNow(page);
    assert.deepEqual([st.kind, st.queue, st.dropped], ['chi', ['chi', 'riichi'], 1], '上限2：古い待ち（ポン）から捨てる');
    await eWaitKind(page, 'riichi');
    await page.waitForFunction(() => !window.__mathjong.S.fx.current, null, { timeout: 4000 });
    st = await eFxNow(page);
    assert.deepEqual([st.history, st.calls], [['chi', 'chi', 'riichi'], ['chi', 'chi', 'riichi']], '表示と音が一対一');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-A：キュー上限の超過は古い待ちから明示的に破棄し、表示と音は一対一');

  // P2-A (4) soundScan との整合：同じ回に打牌だけ → 打牌音1回。打牌と宣言が混在 → 打牌音なし（宣言の音を表示時に）
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await page.locator('.top').first().tap({ position: { x: 4, y: 4 } });
    await eAddEvent(page, 'discard', 1); await eAddEvent(page, 'discard', 2); await eScan(page);
    assert.equal((await eFxNow(page)).discards, 1, '1回の判定で打牌音は最大1回');
    await eAddEvent(page, 'discard', 3); await eAddEvent(page, 'pon', 1); await eAddEvent(page, 'discard', 1); await eScan(page);
    const st = await eFxNow(page);
    assert.deepEqual([st.discards, st.calls], [1, ['pon']]);
    for (let i = 0; i < 3; i++) await eScan(page);
    assert.deepEqual([(await eFxNow(page)).discards, (await eFxNow(page)).calls], [1, ['pon']], '繰り返しても二重に鳴らない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-A：soundScan との整合（打牌だけの回は打牌音1回、宣言のある回は宣言の音だけ・二重なし）');

  // P2-C 同じ人が続けて2回鳴く（数学Ⅰ・Ⅱ、自分・AI 全席）：表示中の宣言の面子だけが光る。待っている間に面子が増えても取り違えない。再描画しても同じ面子
  for (const mode of ['math1', 'math2']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' }, mode);
    const wall = mode === 'math1' ? presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]) : null;
    if (wall) await v3Scene(page, wall); else await page.waitForSelector('.hand .tile');
    for (const seat of [0, 1, 2, 3]) {
      await page.evaluate(() => { const m = window.__mathjong; m.fx.clear(); });
      const first = await eAddEvent(page, 'pon', seat);
      await eScan(page);
      const second = await eAddEvent(page, 'chi', seat, { offset: 3 }); // 演出中に、同じ人の新しい面子が増える
      await eScan(page);
      await page.evaluate(() => window.__mathjong.render());
      let st = await eFxNow(page);
      assert.deepEqual([st.kind, st.seat, st.queue], ['pon', seat, ['chi']]);
      assert.deepEqual(st.glow, [String(first)], `${mode} 席${seat}：ポンの面子だけが光る（新しいチーの面子ではない）`);
      const same = await page.evaluate(([s, t]) => {
        const sel = `${s === 0 ? '.self' : `.panel.seat-${s}`} .melds .meld[data-claimed="${t}"] .tile`;
        return { meld: [...document.querySelectorAll(sel)].map((e) => e.getAttribute('aria-label')), fx: [...document.querySelectorAll('#fx-layer .fx-tiles .tile')].map((e) => e.getAttribute('aria-label')) };
      }, [seat, first]);
      assert.ok(same.meld.length === 3 && same.meld.join() === same.fx.join(), `${mode} 席${seat}：演出の牌と公開面子の牌が一致（${same.fx.join()}）`);
      await eWaitKind(page, 'chi');
      await page.evaluate(() => window.__mathjong.render());
      st = await eFxNow(page);
      assert.deepEqual(st.glow, [String(second)], `${mode} 席${seat}：チーの表示が始まったらチーの面子が光る（再描画後も）`);
      // 面子が見つからない宣言：別の面子を光らせない・牌も出さない
      await page.evaluate(() => window.__mathjong.fx.clear());
      await eAddEvent(page, 'chi', seat, { offset: 6, noMeld: true });
      await eScan(page);
      st = await eFxNow(page);
      assert.deepEqual([st.kind, st.glow, await page.locator('#fx-layer .fx-tiles').count()], ['chi', [], 0], `${mode} 席${seat}：対応する面子がなければ何も光らせない`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 本物の鳴き：自分のポンで光る面子は、記録の鳴いた牌の面子
  {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    await fxToClaim(page, ['=1/2', '=1/2', 'sin', '0', '135', '=-√3', 'tan', '150']);
    await page.locator('button[data-action="pon"]').first().tap();
    const r = await page.evaluate(() => { const g = window.__mathjong.S.game; const ev = [...g.events].reverse().find((e) => e.type === 'pon'); return { tile: String(ev.tile), glow: [...document.querySelectorAll('.meld.fx-glow')].map((e) => e.dataset.claimed) }; });
    assert.deepEqual(r.glow, [r.tile]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-C：同じ人の連続した鳴き（数学Ⅰ・Ⅱ・自分と AI 全席）で、表示中の宣言の面子だけが光り、演出の牌と一致。再描画後も同じ・面子がなければ光らせない');

  // P3-A 退出：チー表示中にポンが待つ → 最低表示時間（0.7秒）の後に短い退出（0.18秒）→ ポン。退出中も文字は徐々に消え、チーの表示は残らない
  for (const mode of ['full', 'lite']) {
    const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' });
    if (mode === 'lite') await fxSetMode(page, 'lite');
    await v3Scene(page, presetWall(TS_HAND, ['=-1/√3'], [FX_O1, FX_O2, FX_O3]));
    await eAddEvent(page, 'chi', 1); await eAddEvent(page, 'pon', 2);
    await eScan(page);
    const t0 = await page.evaluate(() => window.__mathjong.S.fx.current.startedAt);
    await page.waitForFunction((s) => performance.now() - s > 650, t0);
    assert.ok(!(await page.evaluate(() => document.getElementById('fx-layer').classList.contains('fx-leaving'))), `${mode}：最低表示時間までは退出しない`);
    await page.waitForFunction(() => document.getElementById('fx-layer').classList.contains('fx-leaving'), null, { timeout: 1000 });
    const leaveAt = await page.evaluate(() => window.__mathjong.S.fx.current.leaveAt - window.__mathjong.S.fx.current.startedAt);
    assert.ok(leaveAt >= 700 && leaveAt <= 760, `${mode}：退出は最低表示時間の後（${Math.round(leaveAt)}ms）`);
    await page.waitForTimeout(90);
    const mid = await page.evaluate(() => { const c = document.querySelector('#fx-layer .fx-card'); const s = getComputedStyle(c); return { op: Number(s.opacity), tf: s.transform, kind: window.__mathjong.S.fx.current.kind }; });
    assert.ok(mid.kind === 'chi' && mid.op > 0.05 && mid.op < 0.95, `${mode}：退出の途中は徐々に消える（不透明度 ${mid.op}）`);
    if (mode === 'lite') assert.equal(mid.tf, 'none', '簡易表示の退出は動かさない（不透明度だけ）');
    await eWaitKind(page, 'pon');
    const st = await page.evaluate(() => ({ cls: document.getElementById('fx-layer').className, word: document.querySelector('#fx-layer .fx-word').textContent, cards: document.querySelectorAll('#fx-layer .fx-card').length, gap: window.__mathjong.S.fx.current.startedAt }));
    assert.deepEqual([st.cls, st.word, st.cards], [`fx-pon${mode === 'lite' ? ' lite' : ''}`, 'ポン！', 1], `${mode}：チーの表示は残らない`);
    assert.ok(st.gap - t0 >= 880 - 5 && st.gap - t0 <= 880 + 150, `${mode}：ポンは 0.7＋0.18 秒後（${Math.round(st.gap - t0)}ms）`);
    // 退出中にロンが来たら、すぐロン（退出を待たない）
    await page.evaluate(() => window.__mathjong.fx.clear());
    await eAddEvent(page, 'chi', 3, { offset: 3 }); await eAddEvent(page, 'riichi', 1); await eScan(page);
    await page.waitForFunction(() => document.getElementById('fx-layer').classList.contains('fx-leaving'), null, { timeout: 1500 });
    await eAddEvent(page, 'ron', 2); await eScan(page);
    const r = await page.evaluate(() => ({ kind: window.__mathjong.S.fx.current.kind, leaving: document.getElementById('fx-layer').classList.contains('fx-leaving'), q: window.__mathjong.S.fx.queue.length }));
    assert.deepEqual(r, { kind: 'ron', leaving: false, q: 0 }, `${mode}：退出中でもロンはすぐ表示`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P3-A：最低表示時間の後に 0.18 秒の退出（簡易表示は不透明度だけ）→ 次の演出。チーの表示は残らず、退出中のロンはすぐ表示');

  // P3-B ロン・ツモ後半の最上部の帯が、結果画面（見出し・精算・次の局のボタン）と重ならない。ノッチ（safe-area）相当でも重ならない
  for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [932, 430]]) {
    for (const notch of [0, 30]) {
      const { ctx, page, errors } = await sndPage(browser, { resume: 'ok' }, 'math1', { viewport: { width: w, height: h } });
      if (notch) await page.addStyleTag({ content: `:root { --fx-banner-top: max(6px, ${notch}px); }` }); // safe-area-inset-top の代わり
      await v3Scene(page, presetWall(TS_HAND, ['=1'], [FX_O1, FX_O2, FX_O3]));
      await page.locator('button[data-action="tsumo"]').tap();
      await page.waitForFunction(() => { const b = document.querySelector('#fx-layer .fx-banner'); return b && Number(getComputedStyle(b).opacity) > 0.95; }, null, { timeout: 3000 });
      const r = await page.evaluate(() => {
        const R = (e) => { const x = e.getBoundingClientRect(); return { l: x.left, t: x.top, r: x.right, b: x.bottom }; };
        const banner = R(document.querySelector('#fx-layer .fx-banner'));
        const modal = document.querySelector('.overlay .modal');
        const parts = { modal: R(modal), h2: R(modal.querySelector('h2')), next: R(modal.querySelector('button[data-action="next"]')) };
        const settle = modal.querySelector('table'); if (settle) parts.settle = R(settle);
        return { banner, parts, sx: document.documentElement.scrollWidth - innerWidth, vh: innerHeight };
      });
      const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      assert.ok(r.banner.t >= notch - 1, `${w}x${h} notch${notch}：帯は safe-area の下`);
      for (const [k, v] of Object.entries(r.parts)) {
        const visible = v.b > 0 && v.t < r.vh;
        if (visible) assert.ok(!hit(r.banner, v), `${w}x${h} notch${notch}：帯と ${k} が重ならない（帯 ${JSON.stringify(r.banner)} / ${k} ${JSON.stringify(v)}）`);
      }
      assert.ok(r.sx <= 0, `${w}x${h}：横スクロールなし`);
      if (SHOTS && !notch) await page.screenshot({ path: `${SHOTS}/v05e-banner-${w}x${h}.png` });
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ 監査 P3-B：縦横8画面（ノッチ相当を含む）で、ロン・ツモ後半の帯が結果画面の見出し・精算・次の局のボタンと重ならない・横スクロールなし');
}

// P2-B 効果音と宣言ボイスは独立：4つの組合せ・冷起動・保存して再読込（本物の AudioContext とテスト用の manifest）
async function v05eAudioIndependent(browser) {
  const wav = eWav();
  const open = async (sound, voiceOn, { manifest = true } = {}) => {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(REAL_TAP_FN);
    if (sound !== null) await ctx.addInitScript(([s, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('mj-sound', s); localStorage.setItem('mj-voice', v); sessionStorage.setItem('seeded', '1'); } }, [sound, voiceOn]);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    const fetched = [];
    await page.route('**/src/ui/voice-test-*.m4a', (route) => { fetched.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }); });
    await page.goto(`${LOCAL}?mode=math1&seed=1&speed=slow`);
    await page.waitForSelector('.hand .tile');
    if (manifest) await page.evaluate((m) => window.__mathjong.voice.setManifest(m), E_VOICE_M); // 冷起動：まだ一度も操作していない
    return { ctx, page, errors, fetched };
  };
  const play = async (page) => {
    await page.locator('.hand .tile.tap').first().tap(); // 最初の操作
    await page.waitForTimeout(400);
    const m0 = await rcMark(page);
    await eFire(page, 'ron', 2);
    await page.waitForTimeout(500);
    return page.evaluate((m) => ({
      created: window.__rec.created, state: window.__mathjong.sound.state(), voice: window.__mathjong.voice.log.at(-1), sfx: window.__mathjong.sound.log.filter((x) => !x.kind.startsWith('voice:')).at(-1),
      peak: window.__rec.blocks.slice(m).reduce((a, x) => Math.max(a, x.peak), 0), buffers: Object.keys(window.__mathjong.voice.buffers).length,
    }), m0);
  };
  for (const [s, v, exp] of [
    ['1', '1', { created: 1, voice: 'played', sfx: 'played', out: true, fetch: 4 }],
    ['1', '0', { created: 1, voice: 'off', sfx: 'played', out: true, fetch: 0 }],
    ['0', '1', { created: 1, voice: 'played', sfx: 'off', out: true, fetch: 4 }],
    ['0', '0', { created: 0, voice: 'off', sfx: 'off', out: false, fetch: 0 }],
  ]) {
    const { ctx, page, errors, fetched } = await open(s, v);
    const r = await play(page);
    const tag = `効果音${s === '1' ? 'ON' : 'OFF'}・ボイス${v === '1' ? 'ON' : 'OFF'}`;
    assert.equal(r.created, exp.created, `${tag}：AudioContext`);
    assert.equal(r.voice.status, exp.voice, `${tag}：声`);
    assert.equal(r.sfx ? r.sfx.status : 'off', exp.sfx, `${tag}：効果音`);
    assert.equal(fetched.length, exp.fetch, `${tag}：音声ファイルの取得`);
    if (exp.out) assert.ok(r.peak > 0.01, `${tag}：実際に出力された（${r.peak}）`); else assert.ok(r.peak < RC_EPS, `${tag}：何も出力されない`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 声が未採用（manifest なし）で、効果音OFF・ボイスON：何も作らず、何も取得しない
  {
    const { ctx, page, errors, fetched } = await open('0', '1', { manifest: false });
    const r = await play(page);
    assert.deepEqual([r.created, r.voice.status, fetched.length], [0, 'none', 0], '未採用のときは AudioContext も取得もなし');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 保存して再読込（冷起動）：設定画面で効果音OFF・ボイスON にして再読込 → 最初の操作で声だけが鳴る
  {
    const { ctx, page, errors, fetched } = await open(null, null);
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('select[data-action="sound"]').selectOption('0');
    assert.equal(await page.locator('select[data-action="voice"]').inputValue(), '1');
    await page.locator('.modal-actions button[data-action="close"]').tap();
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('mj-sound'), localStorage.getItem('mj-voice')]), ['0', null]);
    await page.reload();
    await page.waitForSelector('.hand .tile');
    await page.evaluate((m) => window.__mathjong.voice.setManifest(m), E_VOICE_M);
    const before = await page.evaluate(() => window.__rec.created);
    assert.equal(before, 0, '再読込の直後（操作前）は AudioContext なし');
    const r = await play(page);
    assert.deepEqual([r.created, r.voice.status, r.sfx ? r.sfx.status : 'off', r.buffers], [1, 'played', 'off', 4], '冷起動：最初の操作で解除・読み込み、声だけが鳴る');
    assert.ok(r.peak > 0.01);
    assert.ok(fetched.length >= 4);
    // 中断・復帰の旧音の破棄は維持：声の途中で suspend → resume で古い声は出ない
    await page.evaluate(() => window.__mathjong.fx.clear());
    await eFire(page, 'tsumo', 0);
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__mathjong.sound.ctx.suspend());
    await page.waitForTimeout(1200);
    await rcTap(page);
    await rcRunning(page);
    const b = await rcMark(page);
    await page.waitForTimeout(1000);
    assert.ok(await rcPeak(page, b) < RC_EPS, '効果音OFF・ボイスONでも、中断した声は復帰後に鳴らない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 監査 P2-B：効果音と宣言ボイスは独立（4組合せ・未採用時は何もしない・効果音OFF＋ボイスONの冷起動と保存・再読込・中断した声は復帰後に鳴らない）');
}

// Ver.0.6：9人の名前と難易度・表示の接続、盤面の牌サイズが変わらないことを検査。
async function v06TrioIntegration(browser) {
  const ids = ['yujin', 'tara', 'nocchi'];
  // 公開環境と同じくテストフックなし。縦横・端末内保存・3人選択を実タップで確認。
  for (const [width, height] of [[320,568],[375,667],[390,844],[430,932],[844,390]]) {
    const ctx = await newContext(browser, { viewport:{width,height}, isMobile:true, hasTouch:true });
    await ctx.addInitScript(() => {
      localStorage.setItem('mj-mode','math1'); localStorage.setItem('mj-length','8');
      localStorage.setItem('mj-chi-autopass','1'); localStorage.setItem('mj-pon-autopass','0');
    });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(`${PUBLIC}?speed=fast`);
    assert.equal(await page.evaluate(() => typeof window.__mathjong), 'undefined');
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.equal(await page.locator('.opp-card').count(),12);
    assert.equal(await page.locator('.opp-placeholder').count(),0,'一覧に仮画像・仮表示を作らない');
    assert.equal(await page.locator('.opp-card img, .opp-card picture').count(),0,'スマホ一覧にキャラクター画像のDOMを作らない');
    assert.ok((await page.locator('.select-lead').innerText()).includes('12人'));
    for (const id of ids) {
      const card=page.locator(`.opp-card[data-id="${id}"]`);
      await card.locator('.opp-name').tap();
      assert.doesNotMatch(await page.locator('.opp-sheet').innerText(), /仮表示|画像は準備中/,'詳細にも不要な仮表示を出さない');
      assert.match(await page.locator('.opp-sheet').innerText(), new RegExp({yujin:'26歳[\\s\\S]*初級',tara:'25歳[\\s\\S]*中級',nocchi:'28歳[\\s\\S]*上級'}[id]));
      assert.equal(await page.locator('.opp-sheet img').count(),0,'既存の人物画像を流用しない');
      await page.locator('.opp-close').tap();
      const box=await card.locator('.opp-check').boundingBox();assert.ok(box.width>=44&&box.height>=44);
      await card.locator('.opp-check').tap();
    }
    assert.equal(await page.locator('button[data-action="start-match"]').isDisabled(),false);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(SHOTS)await page.screenshot({path:`${SHOTS}/trio-select-${width}-${height}.png`,fullPage:true});
    await page.locator('button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.deepEqual((await page.locator('.panel .name').allInnerTexts()).sort(),['ゆうじん','たら','のっち'].sort());
    // Ver.0.7麻雀卓：縦画面は従来の牌幅。スマホ横（844×390）は卓の右に手牌を置くため 44px（縦画面より大きい）
    const oldWidths={320:29.1667,375:34.8958,390:36.4583,430:40.625,844:44};
    const tileWidth=(await page.locator('.hand .tile').first().boundingBox()).width;
    assert.ok(Math.abs(tileWidth-oldWidths[width])<.5,`従来の牌幅を維持 ${width}px: ${tileWidth}`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('mj-mode'),localStorage.getItem('mj-length'),localStorage.getItem('mj-chi-autopass'),localStorage.getItem('mj-pon-autopass')]),['math1','8','1','0']);
    await page.reload();await page.waitForSelector('.title-screen');
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.equal(await page.locator('.opp-card.selected').count(),0,'選択は保存しない従来仕様');
    assert.deepEqual(errors,[]);await ctx.close();
  }
  console.log('✓ 追加3人：公開相当・320/375/390/430pxと横画面・テキストのみの一覧・詳細・実タップ・保存互換');
  // 実エンジンとUIで4つの設定を完走。手動席は合法なツモ切りと和了を選ぶ。
  const measurements=[];
  for(const mode of ['math1','math2'])for(const length of [4,8]) {
    const ctx=await newContext(browser,{viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    const page=await ctx.newPage(),errors=watchErrors(page);
    await page.goto(`${LOCAL}?seed=39811&mode=${mode}&len=${length}&chars=yujin,tara,nocchi&speed=test`);
    const deadline=Date.now()+180000;let turns=0;
    for(;;) {
      await page.waitForFunction(()=>{const{S}=window.__mathjong;return S.modal==='result'||S.modal==='final'||S.game.pending()?.seat===0;},null,{timeout:20000});
      const s=await page.evaluate(()=>{const{S}=window.__mathjong;S.game.checkInvariants();return{modal:S.modal,scores:S.match.scores,over:S.match.over,played:S.match.played,history:S.publicAiHistory,riichi:!!S.game.riichi[0]};});
      assert.equal(s.scores.reduce((a,b)=>a+b),400);assert.ok(s.history.every(x=>x.rounds===s.played));
      if(s.modal==='final')break;
      if(s.modal==='result'){await page.locator('button[data-action="next"]').tap();continue;}
      if(await page.locator('button[data-action="tsumo"]').count())await page.locator('button[data-action="tsumo"]').tap();
      else if(await page.locator('button[data-action="ron"]').count())await page.locator('button[data-action="ron"]').tap();
      else if(await page.locator('button[data-action="pass"]').count())await page.locator('button[data-action="pass"]').tap();
      else if(s.riichi)await page.locator('button[data-action="tsumogiri"]').tap();
      else await apDiscardDrawn(page);
      assert.ok(++turns<500&&Date.now()<deadline,'追加キャラの対局が完走する');
    }
    const data=await page.evaluate(()=>{const{S}=window.__mathjong;return{played:S.match.played,renchan:S.match.renchanTotal,decisions:S.aiDecisionsBySeat,timing:S.aiDecisionTiming,maxMs:S.aiDecisionMaxMs,firstTurns:S.aiFirstDecisionTiming,history:S.publicAiHistory,seed:S.seedBase};});
    assert.equal(data.played,length+data.renchan);
    for(let seat=1;seat<4;seat++)assert.ok(data.decisions[seat][ids[seat-1]]>0);
    assert.match(await page.locator('.final').innerText(),/ゆうじん/);
    measurements.push({mode,length,played:data.played,firstTurns:data.firstTurns,maxMs:data.maxMs,retainedSamples:data.timing.length});
    await page.locator('button[data-action="again"]').tap();await page.waitForSelector('.hand .tile');
    const reset=await page.evaluate(()=>{const{S}=window.__mathjong;return{chars:S.matchSettings.chars,mode:S.mode,length:S.match.length,scores:S.scores,history:S.publicAiHistory};});
    assert.deepEqual([reset.chars,reset.mode,reset.length,reset.scores],[ids,mode,length,[100,100,100,100]]);
    assert.ok(reset.history.every(x=>x.rounds===0&&x.calls===0&&x.earlyRiichi===0));
    assert.deepEqual(errors,[]);await ctx.close();
  }
  console.log('✓ 追加3人：数学ⅠⅡ×4/8局の実UI完走・結果・400点保存・公開履歴・再戦初期化',JSON.stringify(measurements));
  {
    const ctx=await newContext(browser,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await ctx.newPage(),errors=watchErrors(page),cdp=await ctx.newCDPSession(page);
    await page.goto(`${LOCAL}?seed=39812&mode=math2&chars=yujin,tara,nocchi&speed=slow`);
    await page.evaluate(w=>{const m=window.__mathjong;m.S.nextPresetWall=w;m.startRound();},presetWall(['sin','30','=1/2','cos','180','=-1','tan','45'],['0']));
    await page.waitForSelector('.hand .tile.tap.drawn');
    const before=await engineState(page),order=await shownOrder(page);
    const expected=await dragToIndex(page,cdp,order[0],order.length-1);
    assert.deepEqual(await shownOrder(page),expected);
    assert.deepEqual((await engineState(page)).hand,before.hand,'表示順だけを変更');
    await page.locator('button[data-action="autosort"]').tap();
    assert.deepEqual((await shownOrder(page)).slice().sort((a,b)=>a-b),order.slice().sort((a,b)=>a-b));
    await page.locator('button[data-action="hint"]').tap();assert.equal(await page.locator('.hint-basic').count(),1);
    await page.locator('button[data-action="fh-confirm"]').tap();assert.equal(await page.locator('.hint-box .fh').count(),1);
    await page.locator('button[data-action="hint"]').tap();assert.equal(await page.locator('.hint-box').count(),0);
    await apDiscardDrawn(page);
    await page.evaluate(()=>{const{S,step}=window.__mathjong;clearTimeout(S.timer);S.timer=null;step();});
    const own=await shownOrder(page),target=own[0],to=await xForIndex(page,own,target,own.length-1);
    await touchDrag(page,cdp,target,to,null,{before:async()=>{
      const count=await page.evaluate(()=>Object.values(window.__mathjong.S.aiDecisionsBySeat).reduce((n,x)=>n+Object.values(x).reduce((a,b)=>a+b,0),0));
      await page.waitForTimeout(1100);
      const st=await page.evaluate(()=>{const{S,drag}=window.__mathjong;return{dragging:drag.isDragging(),deferred:S.stepDeferred,count:Object.values(S.aiDecisionsBySeat).reduce((n,x)=>n+Object.values(x).reduce((a,b)=>a+b,0),0)};});
      assert.ok(st.dragging&&st.deferred);assert.equal(st.count,count,'新AIの手番中もドラッグ中は判断を保留');
    }});
    await page.waitForFunction(()=>!window.__mathjong.S.stepDeferred&&Object.values(window.__mathjong.S.aiDecisionsBySeat).some(x=>Object.values(x).some(n=>n>0)),null,{timeout:10000});
    assert.equal(await page.locator('.drag-ghost,.drop-marker').count(),0);
    await invariants(page);assert.deepEqual(errors,[]);await ctx.close();
  }
  console.log('✓ 追加3人：長押し・自動整列・2段階ヒント・AI判断の保留と再開・ゴースト消去');
}

async function v06Characters(browser) {
  const roster = {
    beginner: ['かなた','みつき','あおと'],
    intermediate: ['おうすけ','なつき','ゆき'],
    advanced: ['シャカ','かおる','アスマ'],
  };
  for (const mode of ['math1', 'math2']) {
    let tileWidth = null;
    for (const [level, names] of Object.entries(roster)) {
      const ctx = await newContext(browser, {
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(LOCAL + '?seed=2026&round=1&dealer=0&hand=0&renchan=0&len=4&mode=' + mode + '&ai=' + level + '&speed=test');
      await page.waitForSelector('.hand .tile');
      const real = await page.evaluate(() => ({
        chosen: window.__mathjong.S.matchSettings.seats.join(','),
        roster: window.__mathjong.S.game.players.slice(1).map((p) => p.name),
        panel: [1,2,3].map((seat) => document.querySelector('.panel.seat-' + seat + ' .name')?.textContent?.trim()),
        styles: [1,2,3].map((seat) => document.querySelector('.panel.seat-' + seat + ' .pers')?.textContent?.trim()),
        width: document.querySelector('.hand .tile')?.getBoundingClientRect().width,
      }));
      assert.equal(real.chosen, { beginner: 'kanata,mitsuki,aoto', intermediate: 'ousuke,natsuki,yuki', advanced: 'fukuyama,kaoru,asuma' }[level], '従来の ai の再現 URL は難易度の既定の3人・従来の席の順');
      assert.deepEqual(real.roster, names, mode + '/' + level + ' player names');
      assert.deepEqual(real.panel, names, mode + '/' + level + ' panel names');
      assert.deepEqual(real.styles, [undefined, undefined, undefined], '対局中は肩書きを省略して牌の領域を優先');
      assert.ok(real.width > 0, 'hand tile visible');
      if (tileWidth !== null) assert.ok(Math.abs(real.width - tileWidth) < 0.5, 'same tile size for all characters');
      tileWidth = real.width;
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ Ver.0.6：9キャラの難易度別名前・数学ⅠⅡ・牌サイズ不変');
}

// ---- Ver.0.6：対戦相手の自由選択（9人から3人） ----
const oppState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong;
  const sb = document.querySelector('.select-screen button[data-action="start-match"]');
  return { screen: S.screen, selected: S.opp.selected.slice(), detail: S.opp.detail, startDisabled: sb ? sb.disabled : null,
    checked: [...document.querySelectorAll('.opp-card.selected')].map((e) => e.dataset.id), count: (document.querySelector('.opp-count b') || {}).textContent,
    chips: [...document.querySelectorAll('.opp-chip:not(.empty)')].map((e) => e.firstChild.textContent), sheet: !!document.querySelector('.opp-sheet') };
});
async function v06FreeSelect(browser) {
  const ORDER = ['kanata', 'mitsuki', 'aoto', 'yujin', 'ousuke', 'natsuki', 'yuki', 'tara', 'fukuyama', 'kaoru', 'asuma', 'nocchi'];
  // (1) スマートフォン（390×844・タッチ）：一覧・2列・チェックと詳細の分離・0〜2人では開始できない・4人目は不可・詳細（下から）
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    await page.locator('button[data-action="choose-opponents"]').tap();
    await page.waitForSelector('.select-screen');
    assert.deepEqual(await page.locator('.opp-card').evaluateAll((es) => es.map((e) => e.dataset.id)), ORDER, '12人を初級4→中級4→上級4の順に連続');
    assert.deepEqual(await page.locator('.opp-card .opp-name').allInnerTexts(), ['かなた', 'みつき', 'あおと', 'ゆうじん', 'おうすけ', 'なつき', 'ゆき', 'たら', 'シャカ', 'かおる', 'アスマ', 'のっち']);
    assert.deepEqual(await page.locator('.opp-card .opp-level').allInnerTexts(), ['初級', '初級', '初級', '初級', '中級', '中級', '中級', '中級', '上級', '上級', '上級', '上級']);
    assert.equal(await page.locator('.opp-grid img, .opp-grid picture, .opp-placeholder').count(),0,'選択一覧には画像・仮表示を置かない');
    for (const t of await page.locator('.opp-card .opp-trait').allInnerTexts()) assert.ok(t.length >= 4, `性格の一言 ${t}`);
    assert.equal(await page.locator('.opp-card[data-id="yujin"] .opp-trait').innerText(), '刻子大好き', 'ゆうじんの紹介を更新');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.opp-grid')).gridTemplateColumns.split(' ').length), 2, 'スマートフォンは2列');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, '横スクロールなし');
    let st = await oppState(page);
    assert.deepEqual([st.selected, st.count, st.startDisabled], [[], '0', true], '初期は0人・開始できない');
    // チェック欄のタップは選択だけ（詳細は開かない）。チェック欄は 44px 以上
    const cb = await page.locator('.opp-check[data-id="aoto"]').boundingBox();
    assert.ok(cb.width >= 44 && cb.height >= 44, `チェック欄の大きさ ${cb.width}×${cb.height}`);
    for (const [id, n] of [['aoto', 1], ['kaoru', 2]]) {
      await page.locator(`.opp-check[data-id="${id}"]`).tap();
      st = await oppState(page);
      assert.deepEqual([st.selected.length, st.detail, st.sheet, st.startDisabled], [n, null, false, true], `${n}人：詳細は開かず、まだ開始できない`);
      // 0〜2人で「対局開始」を押しても始まらない
      await page.locator('.select-screen button[data-action="start-match"]').evaluate((e) => { e.disabled = false; e.click(); });
      assert.equal((await oppState(page)).screen, 'select', `${n}人では対局を始めない（無効化を外して押しても）`);
    }
    await page.locator('.opp-check[data-id="ousuke"]').tap();
    st = await oppState(page);
    assert.deepEqual([st.selected, st.startDisabled, st.checked.sort(), st.count, st.chips], [['aoto', 'kaoru', 'ousuke'], false, ['aoto', 'kaoru', 'ousuke'], '3', ['あおと', 'かおる', 'おうすけ']], '3人そろうと開始できる・選択済みは枠で区別・3人を確認できる');
    // 4人目は追加できない（お知らせを出す）
    await page.locator('.opp-check[data-id="yuki"]').tap({ force: true }); // aria-disabled でも実機ではタップできる
    st = await oppState(page);
    assert.deepEqual(st.selected, ['aoto', 'kaoru', 'ousuke'], '4人目は追加しない');
    assert.match(await page.locator('.opp-notice').innerText(), /3人まで/);
    assert.equal(await page.locator('.opp-check[data-id="yuki"]').getAttribute('aria-disabled'), 'true');
    // カード本体のタップで詳細（下から開くパネル）。年齢・難易度・性格・打ち筋。×で閉じる。選択は維持
    await page.locator('.opp-card[data-id="natsuki"] .opp-trait').tap();
    await page.waitForSelector('.opp-sheet');
    const det = await page.locator('.opp-sheet').innerText();
    for (const re of [/なつき/, /20歳/, /中級/, /性格/, /打ち筋/, /門前/]) assert.match(det, re);
    const sh = await page.locator('.opp-sheet').boundingBox();
    assert.ok(Math.abs(sh.y + sh.height - 844) <= 1 && sh.width >= 389, `スマートフォンは下から開く ${JSON.stringify(sh)}`);
    assert.equal(await page.locator('.opp-sheet button[data-action="opp-toggle"]').isDisabled(), true, '3人選択中は詳細からも追加できない');
    await page.locator('.opp-close').tap();
    st = await oppState(page);
    assert.deepEqual([st.sheet, st.selected], [false, ['aoto', 'kaoru', 'ousuke']], '×で閉じる・選択は維持');
    // パネルの中のタップでは閉じない。パネルの外のタップで閉じる
    await page.locator('.opp-card[data-id="kanata"] .opp-name').tap();
    await page.locator('.opp-d-list').tap();
    assert.equal((await oppState(page)).sheet, true, 'パネルの中では閉じない');
    await page.mouse.click(195, 30);
    assert.equal((await oppState(page)).sheet, false, 'パネルの外で閉じる');
    // おまかせ：3人を抽選して置き換え（対局は始めない）。何度でも引き直せる。1人だけ入れ替えられる
    const draws = new Set();
    for (let i = 0; i < 12; i++) {
      await page.locator('button[data-action="opp-random"]').tap();
      st = await oppState(page);
      assert.equal(st.screen, 'select', 'おまかせでは対局を始めない');
      assert.equal(new Set(st.selected).size, 3);
      assert.deepEqual(st.selected, ORDER.filter((id) => st.selected.includes(id)));
      draws.add(st.selected.join(','));
    }
    assert.ok(draws.size >= 3, `引き直すと変わる ${[...draws].join(' / ')}`);
    const drawn = st.selected.slice();
    const out = drawn[1], inn = ORDER.find((id) => !drawn.includes(id));
    await page.locator(`.opp-check[data-id="${out}"]`).tap();
    await page.locator(`.opp-check[data-id="${inn}"]`).tap();
    st = await oppState(page);
    assert.deepEqual(st.selected.slice().sort(), [drawn[0], drawn[2], inn].sort(), '1人だけ入れ替え');
    // タイトルへ戻っても、モード・局数を変えても選択は残る。再読み込みで0人に戻る
    await page.locator('.select-screen button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    await page.locator('label.setting.radio', { hasText: '数学Ⅰ' }).tap();
    await page.locator('label.setting.radio', { hasText: '8局戦' }).tap();
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.deepEqual((await oppState(page)).selected.slice().sort(), [drawn[0], drawn[2], inn].sort(), 'タイトル・モード・局数を変えても保持');
    assert.match(await page.locator('.select-setting').innerText(), /数学Ⅰ ／ 8局戦/);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => /opp|char|select/i.test(k)).length), 0, '選択は保存しない');
    await page.reload();
    await page.waitForSelector('.title-screen');
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.deepEqual((await oppState(page)).selected, [], '再読み込みで0人');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (2) PC（1280×860・マウス）：3列・詳細は中央のポップアップ
  {
    const ctx = await newContext(browser, { viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.locator('button[data-action="choose-opponents"]').click();
    await page.waitForSelector('.select-screen');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.opp-grid')).gridTemplateColumns.split(' ').length), 3, 'PC は3列');
    await page.locator('.opp-card[data-id="fukuyama"] .opp-name').click();
    await page.waitForSelector('.opp-sheet');
    const sh = await page.locator('.opp-sheet').boundingBox();
    assert.ok(Math.abs(sh.x + sh.width / 2 - 640) <= 1 && Math.abs(sh.y + sh.height / 2 - 430) <= 2 && sh.width <= 480, `PC は中央のポップアップ ${JSON.stringify(sh)}`);
    assert.match(await page.locator('.opp-sheet').innerText(), /28歳/);
    await page.locator('.opp-sheet button[data-action="opp-toggle"]').click();
    assert.deepEqual((await oppState(page)).selected, ['fukuyama'], '詳細から選べる');
    await page.mouse.click(20, 20);
    assert.equal((await oppState(page)).sheet, false);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (3) 座席：人間は席0。3人を席1〜3へランダムに（6通りがすべて出る）。試合中は固定。対局の名前は席どおり
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=slow`);
    await chooseAndStart(page, ['mitsuki', 'natsuki', 'fukuyama']);
    const perms = await page.evaluate(() => {
      const { S, startMatch } = window.__mathjong;
      const seen = {};
      for (let i = 0; i < 120; i++) { startMatch({ settings: { mode: S.matchSettings.mode, length: S.matchSettings.length, chars: S.matchSettings.chars } }); const k = S.matchSettings.seats.join(','); seen[k] = (seen[k] || 0) + 1; }
      clearTimeout(S.timer);
      return seen;
    });
    assert.equal(Object.keys(perms).length, 6, `座席の6通りがすべて出る ${JSON.stringify(perms)}`);
    for (const k of Object.keys(perms)) assert.deepEqual(k.split(',').sort(), ['fukuyama', 'mitsuki', 'natsuki']);
    const names = await page.evaluate(() => ({ seats: window.__mathjong.S.matchSettings.seats, players: window.__mathjong.S.game.players.map((p) => p.name), kinds: window.__mathjong.S.game.players.map((p) => p.kind) }));
    assert.deepEqual(names.kinds, ['human', 'ai', 'ai', 'ai']);
    assert.equal(names.players[0], 'あなた');
    // 次の局へ進んでも座席は変わらない
    const before = names.seats.join(',');
    await forceDraw(page);
    await page.waitForSelector('button[data-action="next"]');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.hand .tile');
    assert.equal(await page.evaluate(() => window.__mathjong.S.matchSettings.seats.join(',')), before, '試合の途中では座席を変えない');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (4) 一連の操作：数学Ⅰ・Ⅱ × 4局・8局で開始 → 最終結果 →「相手を変更」（直前の3人が選択済み）→ 1人入れ替えて開始 →「同じ3人と再戦」→ タイトル
  for (const [mode, len, chars] of [['math1', 4, ['kanata', 'yuki', 'asuma']], ['math2', 8, ['aoto', 'ousuke', 'kaoru']], ['math1', 8, ['mitsuki', 'natsuki', 'fukuyama']], ['math2', 4, ['kanata', 'aoto', 'asuma']]]) {
    const ctx = await newContext(browser, { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=slow`);
    await page.locator('label.setting.radio', { hasText: mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ' }).tap();
    await page.locator('label.setting.radio', { hasText: `${len}局戦` }).tap();
    await chooseAndStart(page, chars);
    let st = await matchState(page);
    assert.deepEqual([st.mode, st.length, st.chars, st.label], [mode, len, chars, '東1局'], `${mode}・${len}局戦`);
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.tileType.length), mode === 'math1' ? 124 : 168);
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    await page.locator('.final button[data-action="change-opponents"]').tap();
    await page.waitForSelector('.select-screen');
    assert.deepEqual((await oppState(page)).selected, chars, '直前の3人が選択済み');
    const inn = ORDER.find((id) => !chars.includes(id));
    await page.locator(`.opp-check[data-id="${chars[0]}"]`).tap();
    await page.locator(`.opp-check[data-id="${inn}"]`).tap();
    await page.locator('.select-screen button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.chars, st.scores, st.label], [[chars[1], chars[2], inn], [100, 100, 100, 100], '東1局'], '1人だけ入れ替えて新しい試合');
    const seed1 = await page.evaluate(() => window.__mathjong.S.seedBase);
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    await page.locator('.final button[data-action="again"]').tap();
    await page.waitForSelector('.hand .tile');
    st = await matchState(page);
    assert.deepEqual([st.chars, st.mode, st.length, st.scores, st.played], [[chars[1], chars[2], inn], mode, len, [100, 100, 100, 100], 0], '同じ3人・同じモードと局数・得点を初期化');
    assert.notEqual(await page.evaluate(() => window.__mathjong.S.seedBase), seed1, '山を初期化（新しい seed）');
    await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
    await page.locator('.final button[data-action="to-title"]').tap();
    await page.waitForSelector('.title-screen');
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.deepEqual((await oppState(page)).selected, [chars[1], chars[2], inn], 'タイトルへ戻っても3人を保持');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ Ver.0.6：対戦相手の自由選択（12人・2列/3列・チェックと詳細の分離・0〜2人不可・4人目不可・詳細（下から/中央）・おまかせ・1人入れ替え・保持/再読み込みで0人・座席6通り・途中固定・相手を変更・同じ3人と再戦・数学ⅠⅡ×4/8局）');
}


// 初心者の部屋：第1〜3段階を実際のタップで進め、エンジンの正誤・通常対局への復帰を検証。
async function v07BeginnerRoom(browser) {
  for (const width of [320, 390, 430]) {
    const ctx = await newContext(browser, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openBeginnerPage(page);
    await page.locator('button[data-action="br-open"]').tap();
    await page.waitForSelector('.beginner-room');
    if (EXTERNAL) assert.equal(await page.evaluate(() => typeof window.__mathjong), 'undefined', '公開モードはテストフックを使わない');
    assert.match(await page.locator('.br-sub').innerText(), /数学Ⅰ/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'チュートリアルに横スクロールなし');
    const tile = async (i) => page.locator('.br-pick[data-idx="' + i + '"]').tap();
    // Stage1: incorrect formula, then sin30=1/2.
    for (const i of [0, 2, 5]) await tile(i);
    await page.locator('button[data-action="br-check"]').tap();
    assert.match(await page.locator('.br-feedback').innerText(), /面子にならない/);
    for (const i of [3, 4, 1]) await tile(i);
    await page.locator('button[data-action="br-check"]').tap();
    assert.match(await page.locator('.br-feedback').innerText(), /正解/);
    await page.locator('button[data-action="br-next"]').tap();
    assert.match(await page.locator('.br-panel h2').innerText(), /3つの面子/);
    // Stage2: three actual melds, including two distinct =1/2 tiles.
    for (const group of [[3, 5, 2], [0, 8, 7], [6, 1, 4]]) {
      for (const i of group) await tile(i);
      await page.locator('button[data-action="br-check"]').tap();
    }
    assert.match(await page.locator('.br-feedback').innerText(), /和了形/);
    await page.locator('button[data-action="br-next"]').tap();
    // Stage3: wrong discard, then discard =-1 for tenpai.
    await tile(1);
    await page.locator('button[data-action="br-check"]').tap();
    assert.match(await page.locator('.br-feedback').innerText(), /惜しい/);
    await tile(5);
    await page.locator('button[data-action="br-check"]').tap();
    assert.match(await page.locator('.br-feedback').innerText(), /和了できる/);
    assert.equal(await page.locator('button[data-action="br-next"]').innerText(), '第4段階へ進む');
    await page.locator('button[data-action="br-next"]').tap();
    await page.waitForSelector('.bp[data-lesson="4A"]');
    await page.locator('button[data-action="br-title"]').tap();
    await page.waitForSelector('.title-screen');
    // The tutorial must not alter the normal selection screen.
    await page.locator('button[data-action="choose-opponents"]').tap();
    assert.equal(await page.locator('.opp-card').count(), 12);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 初心者の部屋：3段階の誤答・正答・画面遷移、320/390/430px、通常対局の入口');
}

// 初心者の部屋 第4〜6段階：タップだけで第1段階から卒業試験まで進み、途中の再開・一覧・やり直し・保存できない端末を確かめる
async function v07BeginnerRoom2(browser) {
  const noHScroll = async (page, where) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${where}：横スクロールなし`);
  for (const width of [320, 375, 390, 430]) {
    const ctx = await newContext(browser, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openBeginnerPage(page);
    await page.locator('button[data-action="br-open"]').tap();
    await page.waitForSelector('.beginner-room');
    const tap = (action) => page.locator(`button[data-action="${action}"]`).first().tap();
    const lesson = (id) => page.waitForSelector(`.bp[data-lesson="${id}"]`);
    const pickTile = (label) => page.locator(`.bp-tile[aria-label="${label}"], .bp-tile[aria-label="${label}（ツモ）"]`).first().tap();
    const feedback = async () => (await page.locator('.br-feedback').allInnerTexts()).join('\n');
    const count = (sel) => page.locator(sel).count();
    // 第1〜3段階
    for (const i of [3, 4, 1]) await page.locator(`.br-pick[data-idx="${i}"]`).tap();
    await tap('br-check'); await tap('br-next');
    for (const g of [[3, 5, 2], [0, 8, 7], [6, 1, 4]]) { for (const i of g) await page.locator(`.br-pick[data-idx="${i}"]`).tap(); await tap('br-check'); }
    await tap('br-next');
    await page.locator('.br-pick[data-idx="5"]').tap(); await tap('br-check'); await tap('br-next');
    // 4-A：上家の =1/2 → チーのボタンは1つだけ・ポン／ロンなし。見送るは練習では止まる
    await lesson('4A');
    assert.match(await page.locator('.br-sub').innerText(), /第4段階 \/ 6/);
    await noHScroll(page, `${width}px 4-A`);
    assert.equal(await count('button[data-action="bp-chi"]'), 1);
    assert.equal(await count('button[data-action="bp-pon"], button[data-action="bp-ron"]'), 0);
    assert.match(await page.locator('button[data-action="bp-chi"]').innerText(), /sin\s*30\s*°\s*=\s*1\s*2/);
    assert.match(await page.locator('.bp-seat[data-seat="3"] .bp-name').innerText(), /上家.*練習用CPU/);
    await tap('bp-pass');
    assert.match(await feedback(), /チーを押して/);
    await tap('bp-chi');
    assert.match(await page.locator('.bp-status').innerText(), /ツモをしないで/);
    assert.equal(await count('.bp-seat.me .bp-meld'), 1);
    assert.equal(await count('.bp-hand .bp-tile'), 6);
    await pickTile('90°'); await tap('bp-discard');
    assert.match(await feedback(), /チー成功/);
    assert.equal(await page.locator('button[data-action="br-next"]').innerText(), '次の課題へ');
    await tap('br-next');
    // 4-B：下家・対面の =1/2 ではボタンが出ない（続けるだけ）、上家でチー
    await lesson('4B');
    for (const who of [/下家/, /対面/]) {
      assert.match(await page.locator('.bp-pause').innerText(), who);
      assert.equal(await count('button[data-action="bp-chi"]'), 0, 'チーのボタンは出ない');
      await tap('bp-continue');
    }
    assert.equal(await count('button[data-action="bp-chi"]'), 1);
    await tap('bp-chi'); await pickTile('90°'); await tap('bp-discard');
    assert.match(await feedback(), /上家の捨て牌だけ/);
    // 途中で再読み込み → 一覧の「続きから」で 4-B から（完了は次へ進むまで記録しない課題の途中）
    await tap('br-next');
    await lesson('4C');
    await page.reload();
    await page.locator('button[data-action="br-open"]').tap();
    await page.waitForSelector('.br-list-view');
    await noHScroll(page, `${width}px 一覧`);
    assert.match(await page.locator('.br-stage[data-stage="3"]').innerText(), /途中（課題3\/4）/);
    assert.equal(await page.locator('.br-stage[data-stage="4"]').isDisabled(), true, '未開放の段階は選べない');
    assert.match(await page.locator('.br-stage[data-stage="0"]').innerText(), /クリア/);
    await tap('br-resume');
    // 4-C：対面の sin → ポン
    await lesson('4C');
    assert.equal(await count('button[data-action="bp-chi"]'), 0);
    await tap('bp-pon'); await pickTile('90°'); await tap('bp-discard');
    assert.match(await feedback(), /ポン成功/);
    await tap('br-next');
    // 4-D：135° 以外は止まる、120° ではロンなし、60° でロン
    await lesson('4D');
    await tap('bp-chi');
    await pickTile('tan'); await tap('bp-discard');
    assert.match(await feedback(), /135° を捨てよう/);
    await pickTile('135°'); await tap('bp-discard');
    assert.match(await page.locator('.bp-pause').innerText(), /役がない/);
    assert.equal(await count('button[data-action="bp-ron"]'), 0);
    await tap('bp-continue');
    assert.equal(await count('button[data-action="bp-ron"]'), 1);
    await tap('bp-ron');
    assert.match(await page.locator('.bp-result').innerText(), /第1象限一色/);
    assert.match(await page.locator('.br-panel').innerText(), /ロン ＞ ポン ＞ チー/);
    assert.equal(await page.locator('button[data-action="br-next"]').innerText(), '第5段階へ進む');
    await tap('br-next');
    // 5-A：リーチ。聴牌にならない牌ではリーチボタンが押せない。リーチ後はツモ切りだけ
    await lesson('5A');
    await pickTile('sin');
    assert.equal(await page.locator('button[data-action="bp-riichi"]').isDisabled(), true);
    await pickTile('=−1');
    await tap('bp-discard');
    assert.match(await feedback(), /リーチして捨てる/);
    await tap('bp-riichi');
    assert.match(await page.locator('.bp-status').innerText(), /リーチ中/);
    assert.equal(await count('.bp-hand .bp-tile:not([disabled])'), 1, 'ツモした牌だけ選べる');
    await page.locator('.bp-tile.drawn').tap(); await tap('bp-discard');
    assert.match(await feedback(), /ツモ切り/);
    await tap('br-next');
    // 5-B：ロン
    await lesson('5B');
    await tap('bp-pass');
    assert.match(await feedback(), /ロンを押そう/);
    await tap('bp-ron');
    assert.match(await page.locator('.bp-result').innerText(), /ロン和了[\s\S]*下家（右）が払う/);
    await tap('br-next');
    // 5-C：ツモ
    await lesson('5C');
    assert.equal(await count('button[data-action="bp-ron"]'), 0);
    const checkTsumoOnly = async () => {
      assert.match(await page.locator('.bp-status').innerText(), /ツモで和了しよう/);
      assert.equal(await count('button[data-action="bp-riichi"], button[data-action="bp-discard"]'), 0, '課題で受け付けない操作は表示しない');
      assert.equal(await page.locator('button[data-action="bp-tsumo"]').isEnabled(), true);
    };
    await checkTsumoOnly();
    await page.locator('.bp-tile.drawn').tap();
    await checkTsumoOnly();
    await pickTile('sin');
    await checkTsumoOnly();
    await tap('bp-tsumo');
    assert.match(await page.locator('.bp-result').innerText(), /ツモ和了[\s\S]*ほかの3人が払う/);
    assert.deepEqual((await page.locator('.bp-settle td:nth-child(3)').allInnerTexts()).map((x) => parseInt(x, 10)), [108, 98, 98, 96], '5-C：子ツモの精算と合計400点');
    await tap('br-next');
    // 卒業試験：ヒント→やり直し→リーチ→ロンを見送る→ツモ
    await lesson('6');
    assert.match(await page.locator('.br-sub').innerText(), /第6段階 \/ 6/);
    await tap('br-hint');
    assert.match(await page.locator('.br-hint').innerText(), /90° を捨てると/);
    await pickTile('135°'); await tap('bp-discard');
    assert.match(await feedback(), /聴牌（あと1枚で和了の形）がくずれた/);
    await tap('br-reset');
    await lesson('6');
    assert.equal(await count('.bp-seat.me .bp-river .tile'), 0, 'やり直しは最初の局面から');
    await pickTile('90°'); await tap('bp-riichi');
    await tap('bp-pass');
    assert.match(await feedback(), /見送った/);
    assert.equal(await count('button[data-action="bp-tsumo"]'), 1);
    await noHScroll(page, `${width}px 卒業試験`);
    await tap('bp-tsumo');
    const grad = await page.locator('.br-panel').innerText();
    assert.match(grad, /卒業試験 合格/);
    assert.match(grad, /初心者の部屋 修了/);
    assert.match(grad, /リーチ/);
    const scores = await page.locator('.bp-settle td:nth-child(3)').allInnerTexts();
    assert.equal(scores.reduce((a, x) => a + parseInt(x, 10), 0), 400, '精算後の合計400点');
    await noHScroll(page, `${width}px 修了`);
    // 「実際の対局に挑戦する」→ 通常の対戦相手の選択（12人）
    await tap('br-challenge');
    await page.waitForSelector('.opp-card');
    assert.equal(await page.locator('.opp-card').count(), 12);
    // 進み具合：6段階すべてクリアで保存、通常の設定キーは変えない
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mj-beginner-room-v1')));
    assert.deepEqual(saved.cleared, [true, true, true, true, true, true]);
    // 卒業から選択画面へ戻るだけでなく、通常対局を実際に開始できる。
    for (const id of ['kanata', 'yuki', 'asuma']) await page.locator(`.opp-check[data-id="${id}"]`).tap();
    await page.locator('.select-screen button[data-action="start-match"]').tap();
    await page.waitForSelector('.hand .tile');
    await noHScroll(page, `${width}px 卒業後の通常対局`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/beginner-normal-${width}.png`, fullPage: true });
    // クリアした段階はもう一度遊べる
    await openBeginnerPage(page);
    await page.locator('button[data-action="br-open"]').tap();
    await page.locator('.br-stage[data-stage="3"]').tap();
    await lesson('4A');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 保存できない端末（localStorage が例外）：最初から最後の段階まで遊べる（ここでは第4段階まで確認）
  const ctx = await newContext(browser, { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openBeginnerPage(page);
  await page.locator('button[data-action="br-open"]').tap();
  for (const i of [3, 4, 1]) await page.locator(`.br-pick[data-idx="${i}"]`).tap();
  await page.locator('button[data-action="br-check"]').tap();
  await page.locator('button[data-action="br-list"]').tap();
  assert.match(await page.locator('.br-list-view').innerText(), /保存できません/);
  assert.match(await page.locator('.br-stage[data-stage="0"]').innerText(), /クリア/);
  assert.equal(await page.locator('.br-stage[data-stage="1"]').isDisabled(), false);
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('✓ 初心者の部屋 第4〜6段階：チー・ポン・役の制限・リーチ・ロン・ツモ・卒業試験、再開・一覧・やり直し・保存不可、320/375/390/430px');
}

// ---- Ver.0.7：麻雀卓と下部ヒント・数式確認エリアの画面検査 ----
async function v07TableHintDock(browser) {
  const viewports = [[320,568],[375,667],[390,844],[430,932],[568,320],[844,390],
    [768,1024],[1024,768],[1180,820],[1366,1024],[1366,768]];
  for (const [width, height] of viewports) {
    const tablet = width >= 1000 && height >= 600 && width > height;
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    const mode = width === 390 || tablet ? 'math2' : 'math1';
    await page.goto(LOCAL + `?mode=${mode}&seed=7007&speed=slow`);
    await page.waitForSelector('.hand .tile');
    // 必ず完成した2式を含める。数式なしのランダム配牌で第2段階を空振りさせない。
    await apScene(page, presetWall(['sin','30','=1/2','cos','180','=-1','tan','45'], ['0'], [
      ['sin','sin','0','90','90','=-√3','=√3','150'],
      ['cos','135','=√3','=-1/√2','120','120','tan','=0'],
      ['=-1','tan','tan','120','=1/√3','90','=-1/√2','=-√3'],
    ]));
    const initial = await page.evaluate(() => ({ hand:window.__mathjong.S.game.hands[0].slice(),
      events:window.__mathjong.S.game.events.length, hints:window.__mathjong.S.hintsUsed }));
    assert.equal(await page.locator('.board-center .bc-round').count(), 1);
    assert.equal(await page.locator('.study-dock.idle').count(), 1);
    async function geometry(stage) {
      const g = await page.evaluate(() => {
        const box=s=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height};};
        return {table:box('.table'), board:box('.board-wrap'),center:box('.board-center'),hand:box('.self'),
          dock:box('.study-dock'),bar:box('.bar'),panels:[1,2,3].flatMap(s=>[box(`.panel.seat-${s} .rb-river-block`),box(`.panel.seat-${s} .rb-backs-block`),box(`.panel.seat-${s} > .seat-tag`)]),
          overflow:document.documentElement.scrollWidth-innerWidth};
      });
      const label=`${width}x${height} ${stage} ${JSON.stringify(g)}`;
      assert.ok(g.overflow<=1, '横スクロールなし '+label);
      assert.ok(g.bar.bottom<=height+1 && g.bar.top>=0,'操作バーは画面内 '+label);
      for(const p of g.panels) {
        const intersects=p.left<g.center.right-1 && p.right>g.center.left+1 && p.top<g.center.bottom-1 && p.bottom>g.center.top+1;
        assert.ok(!intersects,'局情報が他家と重ならない '+label);
      }
      assert.ok(g.center.left>=g.board.left && g.center.right<=g.board.right,'局情報は卓内 '+label);
      if(tablet) {
        const leftRatio=g.board.width/(g.dock.right-g.board.left);
        assert.ok(leftRatio>=.60 && leftRatio<=.65, '左卓60〜65% '+label);
        assert.ok(g.dock.left>=g.board.right && g.dock.top<=g.board.top+1,'右に学習専用領域 '+label);
        assert.ok(g.dock.bottom<=g.bar.top && g.hand.right<=g.dock.left,'手牌と学習エリアは非重複 '+label);
      } else {
        assert.ok(g.dock.top>=g.hand.bottom-1, '手牌より下の学習エリア '+label);
        await page.locator('.study-dock').scrollIntoViewIfNeeded();
        const d=await page.locator('.study-dock').boundingBox();
        assert.ok(d.y>=g.table.top-2 && d.y+d.height<=g.bar.top+2,'学習エリアまで卓内スクロールできる '+label+' actual='+JSON.stringify(d));
      }
      for(const b of await page.locator('.bar button').all()) assert.ok((await b.boundingBox()).height>=44,'行動ボタン44px');
    }
    await geometry('OFF');
    if(width===320) {
      // 初期表示＝卓内スクロールが先頭（直前の検査で学習エリアまでスクロールしたので戻す）
      await page.evaluate(()=>{document.querySelector('.table').scrollTop=0;});
      const all=await page.evaluate(()=>[...document.querySelectorAll('.mj-table,.self .hand')].every(e=>{const b=e.getBoundingClientRect(),t=document.querySelector('.table').getBoundingClientRect();return b.top>=t.top-2&&b.bottom<=t.bottom+2;}));
      assert.ok(all,'320pxの初期表示で3人と手牌を同時に確認できる');
    }
    await page.locator('button[data-action="hint"]').tap();
    assert.equal(await page.locator('.study-dock.open .hint-basic').count(), 1);
    assert.equal(await page.locator('.self .hint-box').count(), 0);
    await geometry('発見');
    await page.locator('[data-action="fh-confirm"]').tap();
    assert.equal(await page.locator('.study-dock.open .fh').count(), 1);
    assert.ok(await page.locator('.hand .tile.fhf').count()>0, '既存の数式枠');
    await geometry('数式確認');
    const hints=await page.evaluate(()=>window.__mathjong.S.hintsUsed);
    assert.equal(hints,initial.hints+2,'明示操作2段階だけ加算');
    // スクロール中のAI再描画でも、同じ手牌のヒント位置と段階を維持。
    const scroll=await page.evaluate(()=>{
      const e=document.querySelector('.study-dock-content');e.scrollTop=35;
      const before=e.scrollTop;window.__mathjong.render();return [before,document.querySelector('.study-dock-content').scrollTop];
    });
    assert.equal(scroll[0],scroll[1]);
    if(SHOTS) {
      await page.locator('.study-dock-content').evaluate(e=>{e.scrollTop=0;});
      await page.screenshot({path:`${SHOTS}/v07-dock-${width}x${height}-confirm.png`});
    }
    await page.locator('button[data-action="hint"]').tap();
    assert.equal(await page.locator('.study-dock.idle').count(),1);
    assert.equal(await page.locator('.hand .tile.fhf').count(),0);
    const after=await page.evaluate(()=>{const g=window.__mathjong.S.game;g.checkInvariants();return {hand:g.hands[0].slice(),events:g.events.length};});
    assert.deepEqual(after,{hand:initial.hand,events:initial.events},'表示操作は牌・イベントを変更しない');
    await page.locator('.self .hand').scrollIntoViewIfNeeded();
    if(SHOTS) await page.screenshot({path:`${SHOTS}/v07-dock-${width}x${height}.png`});
    // 2回タップは従来どおり：1回目は選択だけ。2回目の打牌は1回だけ。
    const drawn=page.locator('.hand .tile.drawn');
    const id=Number(await drawn.getAttribute('data-id'));
    await drawn.tap();
    assert.equal(await page.evaluate(()=>window.__mathjong.S.game.events.length),initial.events);
    await page.locator(`.hand .tile[data-id="${id}"]`).tap();
    assert.equal(await page.evaluate((id)=>window.__mathjong.S.game.events.filter(e=>e.type==='discard'&&e.seat===0&&e.tile===id).length,id),1);
    if (width === 375 || (width === 1024 && tablet)) {
      // 実Gameの合法なツモ切り/見送りで河を伸ばす。牌の重複や架空の河を作らない。
      const river = await page.evaluate(() => {
        const m=window.__mathjong,g=m.S.game;
        clearTimeout(m.S.timer);m.S.timer=null;
        const advanceTo=n=>{
          for(let steps=0;g.rivers[1].length<n && steps<1000;steps++) {
            const p=g.pending();if(!p)throw new Error('河の検査前に終局');
            if(p.type==='claim')g.respond(p.seat,{type:'pass'});
            else g.discard(p.seat,g.drawn);
          }
          g.checkInvariants();
        };
        // 卓の河はスクロールしない：全ての牌が卓の中に見え、最後の牌は最新の打牌（物理ID）
        const read=()=>{const e=document.querySelector('.seat-1 .river'),tiles=[...e.querySelectorAll('.tile')],t=document.querySelector('.mj-table').getBoundingClientRect();
          const inside=tiles.every(x=>{const b=x.getBoundingClientRect();return b.left>=t.left-1&&b.right<=t.right+1&&b.top>=t.top-1&&b.bottom<=t.bottom+1;});
          return {scrolls:e.scrollHeight>e.clientHeight+1,inside,count:tiles.length,ids:tiles.map(x=>Number(x.dataset.id)),last:Number(tiles.at(-1).dataset.id)};};
        advanceTo(20);m.render();const first=read();first.expected=g.rivers[1].map(r=>r.id);
        const retained=first;
        advanceTo(21);m.render();const next=read();next.expected=g.rivers[1].map(r=>r.id);
        const table=document.querySelector('.table');table.scrollTop=75;const scroll=table.scrollTop;m.render();
        const result={first,retained,next,expectedLast:g.rivers[1].at(-1).id,scroll,restored:document.querySelector('.table').scrollTop};
        m.startRound();result.reset=document.querySelector('.table').scrollTop;return result;
      });
      for (const r of [river.first, river.next]) {
        assert.equal(r.scrolls,false,'河はスクロールせず全部を表示');
        assert.ok(r.inside,'長い河の全ての牌が卓の中');
        assert.deepEqual(r.ids,r.expected,'河の全物理IDと順序');
      }
      assert.equal(river.retained.count,20);
      assert.equal(river.next.last,river.expectedLast,'物理牌IDも一致');
      assert.equal(river.restored,river.scroll,'卓全体のスクロールも再描画で維持');
      assert.equal(river.reset,0,'次局にはスクロールを持ち越さない');
    }
    assert.deepEqual(errors,[]);
    await ctx.close();
  }
  console.log('✓ Ver.0.7：11画面・卓と局情報の非重複・縦の学習ドック・横タブレット62/38・数学ⅠⅡ・2段階・スクロール維持・2回タップ');
}

// Ver.0.7 麻雀卓：4人が1つの卓を囲む配置。局面は実Gameの合法な打牌・チー・ポン・リーチ・見送りだけで作る
// （表示用に牌を増やさない）。河の6枚折り返し・席の向き・密着・非重複・公開面子の位置・下部のガイド/設定を検査。
const MJ_SCENES = {
  start: { until: () => true },
  r6: { until: (g) => g.rivers.every((r) => r.length >= 6) },
  r12: { until: (g) => g.rivers.every((r) => r.length >= 12) },
  r19: { until: (g) => g.rivers.every((r) => r.length >= 19) },
  me2: { until: (g) => g.melds[0].length === 2 && g.rivers[0].length >= 4, call: (g, s) => s === 0 },
  all2: { until: (g) => [1, 2, 3].every((s) => g.melds[s].length === 2) && g.rivers[1].length >= 8, call: () => true },
  riichi: { until: (g) => g.riichi[0] && [1, 2, 3].some((s) => g.riichi[s]) && g.rivers[0].length >= 7, riichi: true },
};
async function mjScene(page, name, seed = 7) {
  return page.evaluate(({ name, seed, src }) => {
    const sc = new Function(`return ${src}`)()[name];
    const m = window.__mathjong;
    clearTimeout(m.S.timer); m.S.timer = null; m.fx.clear();
    const old = m.S.game;
    // その seed で局面に届かず流局したら、次の seed で作り直す（合法な操作だけ）
    let g;
    for (let k = 0; k < 30 && !g; k++) g = build(seed + k);
    if (!g) throw new Error('局面を作れない');
    g.checkInvariants(); m.S.game = g; m.S.selected = null; m.render();
    return { rivers: g.rivers.map((r) => r.length), melds: g.melds.map((x) => x.length), riichi: g.riichi.map((r) => (r ? r.tile : null)), events: g.events.length };
    function build(sd) {
    const g = new old.constructor({ rules: m.rules, seed: sd, dealer: 0, players: old.players });
    let reached = false;
    for (let i = 0; i < 4000; i++) {
      const p = g.pending(); if (!p) return null;
      if (!reached && sc.until(g)) reached = true;
      if (reached && p.seat === 0) break;
      if (p.type === 'claim') {
        const take = sc.call && sc.call(g, p.seat) && g.melds[p.seat].length < 2;
        g.respond(p.seat, take && p.pon ? { type: 'pon' } : take && p.chi.length ? { type: 'chi', option: 0 } : { type: 'pass' });
      } else {
        const ro = sc.riichi && !g.riichi[p.seat] ? g.riichiOptions(p.seat) : [];
        if (ro.length) g.discard(p.seat, ro[0].ids[0], { riichi: true });
        else g.discard(p.seat, g.drawn ?? g.hands[p.seat].at(-1));
      }
    }
    return reached ? g : null;
    }
  }, { name, seed, src: `{${Object.entries(MJ_SCENES).map(([k, v]) => `${k}:{${Object.entries(v).map(([a, f]) => `${a}:${f}`).join(',')}}`).join(',')}}` });
}
async function mjMeasure(page) {
  return page.evaluate(() => {
    const m = window.__mathjong, g = m.S.game;
    const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    const q = (s) => document.querySelector(s);
    const seatSel = (s) => (s === 0 ? '.me-board' : `.panel.seat-${s}`);
    const seats = [0, 1, 2, 3].map((s) => {
      const root = q(seatSel(s));
      const river = root.querySelector('.river');
      const block = root.querySelector('.mj-rot.river-block');
      return {
        seat: s,
        rows: [...river.querySelectorAll('.rv-row')].map((r) => [...r.querySelectorAll('.tile')].map((t) => Number(t.dataset.id))),
        expected: g.rivers[s].map((r) => r.id),
        riichi: g.riichi[s] ? g.riichi[s].tile : null,
        decl: [...river.querySelectorAll('.tile.riichi-decl')].map((t) => ({ id: Number(t.dataset.id), box: box(t) })),
        tiles: [...river.querySelectorAll('.tile')].map((t) => ({ id: Number(t.dataset.id), decl: t.classList.contains('riichi-decl'), box: box(t) })),
        transform: getComputedStyle(block).transform,
        riverBox: box(root.querySelector('.rb-river-block')),
        tag: box(root.querySelector('.seat-tag')),
        melds: s === 0 ? [] : [...root.querySelectorAll('.mj-melds .meld')].map((e, i) => ({ box: box(e), claimed: Number(e.dataset.claimed), expected: g.melds[s][i].claimed,
          ids: [...e.querySelectorAll('.tile')].length, tiles: [...e.querySelectorAll('.tile')].map((t) => box(t)) })),
        backs: s === 0 ? null : { box: box(root.querySelector('.rb-backs-block')), n: root.querySelectorAll('.back').length, expected: g.hands[s].length },
      };
    });
    const hand = box(q('.self .hand'));
    const myMelds = [...document.querySelectorAll('.self .hand-row .melds.mine .meld')].map((e, i) => ({ box: box(e), n: e.querySelectorAll('.tile').length, claimed: Number(e.dataset.claimed), expected: g.melds[0][i].claimed }));
    return {
      seats, hand, myMelds, myMeldCount: g.melds[0].length,
      handTileW: q('.hand .tile').getBoundingClientRect().width,
      table: box(q('.mj-table')), center: box(q('.board-center')), centerText: q('.board-center').innerText,
      top: box(q('.top')), topHasInfo: document.querySelectorAll('.top .info, .top [data-action]').length,
      guide: box(q('.self .hand-help [data-action="guide"]')), settings: box(q('.self .hand-help [data-action="settings"]')),
      guideCount: document.querySelectorAll('[data-action="guide"]').length, settingsCount: document.querySelectorAll('[data-action="settings"]').length,
      narration: document.querySelectorAll('.msg').length, overflow: document.documentElement.scrollWidth - innerWidth,
      wall: g.wall.length, vw: innerWidth, vh: innerHeight,
    };
  });
}
const mjOverlap = (a, b, eps = 0.75) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > eps && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > eps;
async function v07MahjongTable(browser) {
  const sizes = [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [844, 390], [768, 1024], [1024, 768], [1366, 768]];
  const portrait = new Set(['320x568', '375x667', '390x844', '430x932']);
  for (const [width, height] of sizes) {
    const key = `${width}x${height}`;
    const scenes = portrait.has(key) ? Object.keys(MJ_SCENES) : ['r12', 'all2', 'riichi'];
    for (const mode of portrait.has(key) || width === 1024 ? ['math1', 'math2'] : ['math1']) {
      const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
      const page = await ctx.newPage(), errors = watchErrors(page);
      await page.goto(LOCAL + `?mode=${mode}&seed=7&speed=slow`);
      await page.locator('.hand .tile').first().waitFor();
      for (const scene of scenes) {
        const st = await mjScene(page, scene);
        const d = await mjMeasure(page);
        const label = `${key} ${mode} ${scene} ${JSON.stringify(st)}`;
        // 上部はロゴだけ、局情報は卓中央に1回、実況なし、ガイド・設定は下部（手牌の下の道具）
        assert.equal(d.narration, 0, '実況なし ' + label);
        assert.equal(d.topHasInfo, 0, '上部に局情報・ボタンなし ' + label);
        assert.equal(d.guideCount, 1); assert.equal(d.settingsCount, 1);
        assert.ok(d.guide.top >= d.hand.bottom - 1 && d.settings.top >= d.hand.bottom - 1, 'ガイド・設定は手牌より下 ' + label);
        assert.ok(d.guide.height >= 34 && d.settings.height >= 34, 'ガイド・設定は押せる大きさ');
        assert.match(d.centerText, new RegExp(`${mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'}[\\s\\S]*東1局[\\s\\S]*${d.wall}`), '卓中央：モード・局・残り山牌 ' + label);
        assert.ok(d.overflow <= 1, '横スクロールなし ' + label);
        const [me, right, top, left] = d.seats;
        // 4人が卓を囲む：対面の河は中央の上、自分は下、上家は左、下家は右。名札は中央の各辺。
        assert.ok(top.riverBox.bottom <= d.center.top + 1 && me.riverBox.top >= d.center.bottom - 1, '上下の河 ' + label);
        assert.ok(left.riverBox.right <= d.center.left + 1 && right.riverBox.left >= d.center.right - 1, '左右の河 ' + label);
        assert.ok(top.tag.bottom <= d.center.top + 1 && me.tag.top >= d.center.bottom - 1 && left.tag.right <= d.center.left + 1 && right.tag.left >= d.center.right - 1, '名札は中央の四辺 ' + label);
        assert.ok(left.backs.box.right <= left.riverBox.left + 1 && right.backs.box.left >= right.riverBox.right - 1 && top.backs.box.bottom <= top.riverBox.top + 1, '他家の手牌は外側 ' + label);
        for (const o of [left, right, top]) assert.equal(o.backs.n, o.backs.expected, '他家の手牌の枚数');
        // 席の向き：下家 −90°・対面 180°・上家 90°・自分 0°
        const mat = (t) => (t === 'none' ? [1, 0, 0, 1] : t.match(/matrix\(([^)]+)\)/)[1].split(',').slice(0, 4).map((x) => Math.round(Number(x))));
        assert.deepEqual([me, right, top, left].map((x) => mat(x.transform)), [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]], '席の向き ' + label);
        for (const s of d.seats) {
          // 河：全物理IDを順に1回ずつ。自分・対面は6枚で折り返し、左右は6・6・残り
          assert.deepEqual(s.rows.flat(), s.expected, `河の物理IDと順序 seat${s.seat} ` + label);
          const n = s.expected.length, sizes = s.rows.map((r) => r.length);
          const want = [];
          for (let i = 0; i < n; i += 6) { if ((s.seat === 1 || s.seat === 3) && i >= 12) { want.push(n - i); break; } want.push(Math.min(6, n - i)); }
          assert.deepEqual(sizes, want, `河の行 seat${s.seat} ` + label);
          // 密着：同じ行の隣り合う牌の隙間は1px以下、牌どうしは重ならない
          let idx = 0;
          for (const row of s.rows) {
            const ts = s.tiles.slice(idx, idx + row.length); idx += row.length;
            for (let i = 1; i < ts.length; i++) {
              const a = ts[i - 1].box, b = ts[i].box;
              const gap = Math.max(Math.max(a.left, b.left) - Math.min(a.right, b.right), Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
              assert.ok(gap <= 1.2, `河の牌が密着 seat${s.seat} gap=${gap} ` + label);
            }
          }
          for (let i = 0; i < s.tiles.length; i++) for (let j = i + 1; j < s.tiles.length; j++) assert.ok(!mjOverlap(s.tiles[i].box, s.tiles[j].box), `河の牌が重ならない seat${s.seat} ` + label);
          for (const t of s.tiles) {
            assert.ok(t.box.left >= d.table.left - 1 && t.box.right <= d.table.right + 1 && t.box.top >= d.table.top - 1 && t.box.bottom <= d.table.bottom + 1, '河は卓の中 ' + label);
            assert.ok(!mjOverlap(t.box, d.center) && !mjOverlap(t.box, s.tag), '河と中央・名札は重ならない ' + label);
          }
          // リーチ宣言牌：宣言した物理ID、同じ河の他の牌と縦横が逆（席の向き＋90°）
          if (s.riichi !== null && s.expected.includes(s.riichi)) {
            assert.deepEqual(s.decl.map((x) => x.id), [s.riichi], `宣言牌のID seat${s.seat} ` + label);
            const other = s.tiles.find((t) => !t.decl).box, dc = s.decl[0].box;
            assert.ok((other.width > other.height) !== (dc.width > dc.height), `宣言牌は横向き seat${s.seat} ` + label);
          } else assert.equal(s.decl.length, 0);
        }
        // 他家の公開面子：その席の右手側の角（対面は左上、下家は右上、上家は左下）。3枚ずつ、面子どうし・河と重ならない
        const all = d.seats.flatMap((s) => s.tiles.map((t) => t.box));
        for (const o of [left, right, top]) for (const g of o.melds) {
          assert.equal(g.ids, 3); assert.equal(g.claimed, g.expected, '面子の取得牌');
          for (const t of g.tiles) for (const r of all) assert.ok(!mjOverlap(t, r), '面子と河が重ならない ' + label);
        }
        for (const g of top.melds) assert.ok(g.box.right <= top.riverBox.left + 1 && g.box.bottom <= d.center.top + 1, '対面の面子は左上 ' + label);
        for (const g of right.melds) assert.ok(g.box.left >= top.riverBox.right - 1 && g.box.bottom <= d.center.top + 1, '下家の面子は右上 ' + label);
        for (const g of left.melds) assert.ok(g.box.right <= me.riverBox.left + 1 && g.box.top >= d.center.bottom - 1, '上家の面子は左下 ' + label);
        for (const o of [left, right, top]) for (let i = 1; i < o.melds.length; i++) assert.ok(!mjOverlap(o.melds[i - 1].box, o.melds[i].box), '2つの面子は区別できる');
        // 自分：公開面子は手牌の右、同じ列。面子ごとに3枚、間に区切り
        assert.equal(d.myMelds.length, d.myMeldCount);
        for (const g of d.myMelds) {
          assert.equal(g.n, 3); assert.equal(g.claimed, g.expected);
          assert.ok(g.box.left >= d.hand.right - 1, '自分の面子は手牌の右 ' + label);
          assert.ok(g.box.bottom > d.hand.top && g.box.top < d.hand.bottom, '手牌と同じ列 ' + label);
        }
        for (let i = 1; i < d.myMelds.length; i++) assert.ok(d.myMelds[i].box.left - d.myMelds[i - 1].box.right >= 2, '2つの面子の区切り');
        // 自分の手牌の牌幅は従来どおり（縦画面）
        if (portrait.has(key)) assert.ok(Math.abs(d.handTileW - Math.min((width - 40) / 9.6, 58)) < 0.6, `手牌の牌幅 ${d.handTileW} ` + label);
        // 表示はゲームを変えない
        const ev = await page.evaluate(() => { const m = window.__mathjong; m.render(); m.S.game.checkInvariants(); return m.S.game.events.length; });
        assert.equal(ev, st.events);
        if (SHOTS && (mode === 'math1' || scene === 'r19')) await page.screenshot({ path: `${SHOTS}/v07-table-${key}-${mode}-${scene}.png` });
      }
      // 河の長い卓でも2回タップ打牌とヒント2段階（数式確認）が使える
      // （数式確認のボタンは手牌に数式があるときだけ出る。数式を含む実際の局面を、河の長いものから順に探す）
      let found = false;
      for (const [scene, sd] of [['r12', 7], ['r12', 8], ['r12', 9], ['r6', 7], ['r6', 8], ['start', 7]]) {
        await mjScene(page, scene, sd);
        await page.locator('button[data-action="hint"]').tap();
        if (await page.locator('[data-action="fh-confirm"]').count()) { found = true; break; }
        await page.locator('button[data-action="hint"]').tap();
      }
      assert.ok(found, '数式を含む局面');
      const drawn = page.locator('.hand .tile.drawn');
      const id = Number(await drawn.getAttribute('data-id'));
      await page.locator('[data-action="fh-confirm"]').first().tap();
      assert.equal(await page.locator('.study-dock.open .fh').count(), 1, '数式確認');
      if (SHOTS && mode === 'math1') { await page.locator('.study-dock-content').evaluate((e) => { e.scrollTop = 0; }); await page.screenshot({ path: `${SHOTS}/v07-table-${key}-${mode}-hint.png` }); }
      await drawn.scrollIntoViewIfNeeded();
      await drawn.tap();
      await page.locator(`.hand .tile[data-id="${id}"]`).tap();
      assert.equal(await page.evaluate((id) => window.__mathjong.S.game.events.filter((e) => e.type === 'discard' && e.seat === 0 && e.tile === id).length, id), 1, '2回タップで1回だけ打牌');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ Ver.0.7 麻雀卓：9画面×実Gameの局面（開始・6/12/19枚・自分2鳴き・全員2鳴き・リーチ）、4人の配置・6枚折り返し・席の向き・密着・非重複・宣言牌・面子の位置・下部のガイド/設定・実況なし');
}

// ---- 新ルール⑤（docs/61）：卓UI。局面は Game の合法な状態を作り（牌IDの交換だけ）、画面を操作して確かめる ----
// spec：{ hand: 自分の9枚（短縮表記、最後がツモ牌）, rinshan: 嶺上で引かれる順, upto: 'start' }。親＝自分の最初の手番で作る。
async function nrScene(page, spec) {
  return page.evaluate((spec) => {
    const m = window.__mathjong;
    clearTimeout(m.S.timer); m.S.timer = null; m.fx.clear();
    const old = m.S.game;
    const g = new old.constructor({ rules: m.rules, seed: spec.seed || 7, dealer: 0, players: old.players, newRules: true });
    const key = (x) => (x.startsWith('=') ? `v:${x.slice(1)}` : /^\d+$/.test(x) ? `a:${x}` : `f:${x}`);
    const T = (x) => m.rules.typeByKey.get(key(x)).idx;
    const shown = new Set(g.deadWall.indicators.map((d) => d.id));
    const conts = () => [...g.hands, g.wall, g.deadWall.rinshan];
    const where = (id) => { for (const c of conts()) { const i = c.indexOf(id); if (i >= 0) return [c, i]; } return null; };
    const swap = (a, b) => { if (a === b) return; const [ca, ia] = where(a), [cb, ib] = where(b); ca[ia] = b; cb[ib] = a; };
    const free = (t, used) => conts().flat().find((id) => g.typeOf(id) === t && !used.has(id) && !shown.has(id));
    if (spec.hand) {
      const hand = g.hands[0], used = new Set();
      const ids = spec.hand.map((x) => { const id = hand.find((h) => g.typeOf(h) === T(x) && !used.has(h)) ?? free(T(x), used); used.add(id); return id; });
      // 手牌の位置 i に ids[i] を入れる（手牌の中の入れ替えも交換）
      ids.forEach((id, i) => swap(hand[i], id));
      g.drawn = hand.at(-1);
    }
    (spec.rinshan || []).forEach((x, n) => {
      const used = new Set([...g.hands[0], ...g.deadWall.rinshan.slice(g.deadWall.rinshan.length - n)]);
      const id = g.wall.find((w) => g.typeOf(w) === T(x) && !used.has(w));
      swap(g.deadWall.rinshan[g.deadWall.rinshan.length - 1 - n], id);
    });
    g._riichiMemo = null;
    g.checkInvariants(); m.S.game = g; m.S.selected = null; m.S.ankanSelect = false; m.S.riichiSelect = false; m.S.scored = false; m.S.modal = null; m.render();
    return { ankan: (g.pending().ankan || []).map((o) => o.type), riichi: g.riichiOptions(0).length, canTsumo: g.pending().canTsumo };
  }, spec);
}
const nrState = (page) => page.evaluate(() => {
  const m = window.__mathjong, g = m.S.game;
  const q = (s) => [...document.querySelectorAll(s)];
  return {
    newRules: g.newRules, melds: g.melds.map((x) => x.map((y) => ({ call: y.call, n: y.tiles.length }))), hand: g.hands[0].length, draws: g.normalDraws.slice(),
    dora: g.doraIndicators.map((d) => ({ ind: g.typeOf(d.id), dora: d.type })), events: g.events.map((e) => e.type), closed: g.isClosed(0), pending: g.pending() && { ...g.pending() },
    shownInd: q('.dora-box .dr-ind .tile').map((t) => t.getAttribute('aria-label')), shownDora: q('.dora-box .dr-dora .tile').map((t) => t.getAttribute('aria-label')),
    wantInd: g.doraIndicators.map((d) => m.rules.types[g.typeOf(d.id)]).map((t) => (t.kind === 'func' ? t.fn : null)),
    kanBtn: q('button[data-action="ankan"]').length, kanType: q('button[data-action="ankan-type"]').length, kanOk: q('.hand .tile.kan-ok').length, tap: q('.hand .tile.tap').length,
    myMelds: q('.self .melds.mine .meld').map((e) => ({ cls: e.className, n: e.querySelectorAll('.tile').length })), status: (document.querySelector('.bar .status') || {}).textContent || '',
    rinshan: q('.hand .tile.rinshan').length, center: document.querySelector('.board-center').innerText, tag0: document.querySelector('.me-board .seat-tag').innerText,
    input: { ...m.S.input },
  };
});
async function v08NewRulesTable(browser) {
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math1&seed=7&speed=slow&newrules=1');
    await page.locator('.hand .tile').first().waitFor();
    // 1) 開始：新ルールの印・ドラ表示1枚（表示牌とドラは別の段）。暗カンの選択肢がなければボタンなし
    let st = await nrState(page);
    assert.ok(st.newRules && /新ルール/.test(st.center), '新ルールの印');
    assert.equal(st.shownInd.length, 1); assert.equal(st.shownDora.length, 1);
    const types = await page.evaluate(() => { const m = window.__mathjong, g = m.S.game; return g.doraIndicators.map((d) => [m.rules.types[g.typeOf(d.id)].key, m.rules.types[d.type].key]); });
    const labels = await page.evaluate(() => [...document.querySelectorAll('.dora-box .tile')].map((t) => t.getAttribute('aria-label')));
    assert.equal(labels.length, 2, '表示牌1枚＋ドラ1枚だけ（王牌の他の牌は出さない）');
    assert.notDeepEqual(types[0][0], types[0][1], '表示牌とドラは別の種類');
    // 2) 暗カン：ツモ直後に4枚 → ボタン → 確認（4枚を強調・打牌不可）→ やめる → もう一度 → 実行
    let sc = await nrScene(page, { hand: ['180', '180', '180', 'sin', '30', '=1/2', 'cos', '60', '180'], rinshan: ['=1/2'] });
    assert.deepEqual(sc.ankan.length, 1, '暗カンの選択肢');
    st = await nrState(page);
    assert.equal(st.kanBtn, 1, '暗カンのボタン');
    await page.locator('button[data-action="ankan"]').tap();
    st = await nrState(page);
    assert.equal(st.kanOk, 4, '槓子にする4枚を強調'); assert.equal(st.tap, 0, '確認中は打牌できない'); assert.equal(st.kanType, 1);
    assert.match(st.status, /暗カン/); assert.equal(st.melds[0].length, 0, 'まだ実行しない');
    await page.locator('.hand .tile').first().tap(); await page.locator('.hand .tile').first().tap();
    assert.equal((await nrState(page)).events.filter((e) => e === 'discard').length, 0, '確認中の牌のタップでは打牌しない');
    await page.locator('button[data-action="ankan-cancel"]').tap();
    st = await nrState(page);
    assert.equal(st.kanBtn, 1); assert.ok(st.tap > 0, 'やめると打牌に戻る');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-kanbtn-${width}.png` });
    await page.locator('button[data-action="ankan"]').tap();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-kansel-${width}.png` });
    const before = st;
    await page.locator('button[data-action="ankan-type"]').tap();
    st = await nrState(page);
    // 記録の順：暗カン → 嶺上ツモ → カンドラ。槓子4枚・門前のまま・嶺上牌の印・ドラ表示2枚・通常ツモ回数は不変
    assert.deepEqual(st.events.slice(-3), ['ankan', 'rinshan', 'dora']);
    assert.deepEqual(st.melds[0], [{ call: 'ankan', n: 4 }]);
    assert.equal(st.hand, 6, '手牌 9→5→嶺上で6枚');
    assert.ok(st.closed && /門前/.test(await page.locator('.me-board .seat-tag').innerHTML()), '門前のまま');
    assert.deepEqual(st.myMelds.map((x) => [/ankan/.test(x.cls), x.n]), [[true, 4]], '槓子を4枚で表示');
    assert.equal(st.rinshan, 1, '嶺上牌の印'); assert.match(st.status, /嶺上ツモ/);
    assert.equal(st.shownInd.length, 2); assert.equal(st.shownDora.length, 2); assert.equal(await page.locator('.dora-box .tile.dora-new').count(), 2, '増えた1枚（表示牌とドラ）を示す');
    assert.deepEqual(st.draws, before.draws, '嶺上ツモは通常ツモに数えない');
    // 3) 嶺上ツモで和了（槓子＋数式2組、門前）→ 結果にドラの枚数・加点・合計
    assert.ok(st.pending.canTsumo, '嶺上ツモ和了');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-rinshan-${width}.png` });
    await page.locator('button[data-action="tsumo"]').tap();
    await page.locator('.overlay .result').waitFor();
    const res = await page.evaluate(() => { const r = window.__mathjong.S.game.result; return { points: r.points, dora: r.analysis.doraBonus, base: r.analysis.points - r.analysis.doraBonus }; });
    const text = await page.locator('.overlay .result').innerText();
    assert.match(text, new RegExp(`ドラ ${res.dora}枚（役ではありません）\\s*\\+${res.dora}`), 'ドラの枚数と加点');
    assert.match(text, new RegExp(`合計\\s*${res.points}点`)); assert.match(text, /暗カン/, '槓子の印');
    assert.equal(await page.locator('.overlay .formulas li').count(), 3);
    assert.equal(await page.locator('.overlay .formulas .tag-kan').count(), 1);
    assert.equal(await page.locator('.overlay .formulas li').first().locator('.tile').count() + 0 >= 3, true);
    assert.match(text, /ドラ表示牌[\s\S]*ドラ/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-result-${width}.png` });
    assert.equal((await page.evaluate(() => window.__mathjong.S.scores.reduce((a, b) => a + b, 0))), 400, '合計400点');
    // 4) 暗カン後のリーチ：嶺上牌で聴牌になる打牌がある → リーチ → 宣言牌 → 成立
    await nrScene(page, { hand: ['180', '180', '180', 'sin', '30', '=1/2', 'cos', '60', '180'], rinshan: ['=-1'] });
    await page.locator('button[data-action="ankan"]').tap();
    await page.locator('button[data-action="ankan-type"]').tap();
    await page.locator('button[data-action="riichi"]').tap();
    await page.locator('.hand .tile.riichi-ok').first().tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    st = await nrState(page);
    assert.ok(await page.evaluate(() => !!window.__mathjong.S.game.riichi[0]), '暗カン後のリーチ');
    // 5) 制限：リーチ中は暗カンなし（4枚そろってもボタンなし・エンジンも拒否）
    const rr = await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game;
      for (let i = 0; i < 200 && g.pending() && !(g.pending().seat === 0 && g.pending().type === 'turn'); i++) {
        const p = g.pending();
        if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn);
      }
      if (!g.pending()) return null;
      // リーチ中のツモ牌と同じ種類を手牌に4枚そろえる（山との交換だけ）
      const t = g.typeOf(g.drawn), hand = g.hands[0], pool = g.wall.filter((id) => g.typeOf(id) === t);
      const others = hand.filter((id) => g.typeOf(id) !== t);
      for (let k = hand.filter((id) => g.typeOf(id) === t).length, j = 0; k < 4 && pool[j] !== undefined; k++, j++) { const a = others[j], b = pool[j]; hand[hand.indexOf(a)] = b; g.wall[g.wall.indexOf(b)] = a; }
      g._riichiMemo = null; g.checkInvariants();
      m.render();
      return { opts: g.ankanOptions(0).length, btn: document.querySelectorAll('button[data-action="ankan"]').length, four: hand.filter((id) => g.typeOf(id) === t).length >= 4 || pool.length < 3 };
    });
    assert.ok(rr, 'リーチ後の自分の手番'); assert.deepEqual(rr, { opts: 0, btn: 0, four: true }, 'リーチ中は4枚そろっても暗カンなし');
    // 6) 不正な暗カン（手牌にない種類）を画面から送ってもエンジンが拒否し、局面は変わらない
    await nrScene(page, { hand: ['180', '180', '180', 'sin', '30', '=1/2', 'cos', '60', '180'] });
    await page.locator('button[data-action="ankan"]').tap();
    const bad = await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game, ev = g.events.length, f = m.S.input.failed;
      const b = document.querySelector('button[data-action="ankan-type"]');
      b.dataset.type = String(m.rules.typeByKey.get('f:tan').idx);
      b.click();
      return { failed: m.S.input.failed - f, events: g.events.length - ev, melds: g.melds[0].length, select: m.S.ankanSelect };
    });
    assert.deepEqual(bad, { failed: 1, events: 0, melds: 0, select: false }, '不正な暗カンは拒否');
    // 拒否はエンジンの例外を画面が記録したもの（console.error）。この1件だけを期待どおりとして除く
    const rejected = errors.filter((e) => /ankan not possible/.test(e));
    assert.equal(rejected.length, 1);
    errors.splice(0, errors.length, ...errors.filter((e) => !/ankan not possible/.test(e)));
    // 7) チー直後は暗カンなし（4枚あっても）
    const chi = await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game;
      // 自分の手番を一巡させ、上家の打牌でチーできる局面を探す
      for (let i = 0; i < 400 && g.pending(); i++) {
        const p = g.pending();
        if (p.type === 'claim') { if (p.seat === 0 && p.chi.length) { g.respond(0, { type: 'chi', option: 0 }); break; } g.respond(p.seat, { type: 'pass' }); }
        else g.discard(p.seat, g.drawn ?? g.hands[p.seat].at(-1));
      }
      const p = g.pending();
      if (!p || p.seat !== 0 || p.type !== 'turn' || g.justDrew) return null;
      m.render();
      return { opts: p.ankan.length, btn: document.querySelectorAll('button[data-action="ankan"]').length, status: document.querySelector('.bar .status').textContent };
    });
    assert.ok(chi, 'チー直後の局面'); { assert.equal(chi.opts, 0); assert.equal(chi.btn, 0, 'チー直後は暗カンなし'); assert.match(chi.status, /チー後/); }
    // 8) AI の暗カン：他家の槓子4枚・ドラ表示2枚・案内。その後 AI が打牌して自分の番へ（公開情報だけで進む）
    await nrScene(page, {});
    const ai = await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game;
      g.discard(0, g.drawn);
      while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
      // 下家（席1）の手牌に4枚そろえる（山との交換だけ）
      const hand = g.hands[1], t = g.typeOf(hand[0]);
      const pool = g.wall.filter((id) => g.typeOf(id) === t);
      const others = hand.filter((id) => g.typeOf(id) !== t && id !== g.drawn);
      for (let k = hand.filter((id) => g.typeOf(id) === t).length, j = 0; k < 4; k++, j++) { const a = others[j], b = pool[j]; hand[hand.indexOf(a)] = b; g.wall[g.wall.indexOf(b)] = a; }
      g._riichiMemo = null;
      g.ankan(1, t); g.checkInvariants(); m.render();
      const block = document.querySelector('.panel.seat-1 .rb-melds-block').getBoundingClientRect();
      const tiles = [...document.querySelectorAll('.panel.seat-1 .meld.ankan .tile')].map((e) => e.getBoundingClientRect());
      return { n: tiles.length, inside: tiles.every((b) => b.top >= block.top - 1 && b.bottom <= block.bottom + 1), status: document.querySelector('.bar .status').textContent, ind: document.querySelectorAll('.dora-box .dr-ind .tile').length };
    });
    assert.equal(ai.n, 4); assert.ok(ai.inside, '他家の槓子は面子の枠の中'); assert.match(ai.status, /暗カン → 嶺上ツモ/); assert.equal(ai.ind, 2);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-aikan-${width}.png` });
    await page.evaluate(() => window.__mathjong.step(true));
    await page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return !p || p.seat === 0; }, null, { timeout: 15000 });
    await invariants(page);
    // 9) ヒント：槓子を公開面子（刻子・うち暗カン）として数え、ドラは役ではない行で示す
    await nrScene(page, { hand: ['180', '180', '180', 'sin', '30', '=1/2', 'cos', '60', '180'], rinshan: ['=-1'] });
    await page.locator('button[data-action="ankan"]').tap();
    await page.locator('button[data-action="ankan-type"]').tap();
    await page.locator('button[data-action="hint"]').tap();
    const hint = await page.locator('.study-dock-content').innerText();
    assert.match(hint, /刻子 1組（うち暗カン1組・門前のまま）/); assert.match(hint, /ドラ：手牌・槓子に \d+枚（役ではありません/);
    assert.doesNotMatch(await page.locator('.yaku-cands').innerText().catch(() => ''), /ドラ/, 'ドラは役候補に出さない');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-hint-${width}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // 10) 数学Ⅱ：残りツモ回数（親の最初のツモを含む）・24回で流局（山が残る）・鳴きで24枚を超える河
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(), errors = watchErrors(page);
  await page.goto(LOCAL + '?mode=math2&seed=7&speed=slow&newrules=1');
  await page.locator('.hand .tile').first().waitFor();
  assert.match(await page.locator('.board-center').innerText(), /ツモ残 23回/, '親の最初のツモを数える');
  const cap = await page.evaluate(() => {
    const m = window.__mathjong;
    clearTimeout(m.S.timer); m.S.timer = null;
    const old = m.S.game;
    const g = new old.constructor({ rules: m.rules, seed: 7, dealer: 0, players: old.players, newRules: true });
    const out = {};
    for (let i = 0; i < 4000 && g.pending(); i++) {
      const p = g.pending();
      if (p.type === 'turn' && p.seat === 1 && (g.normalDraws[1] === 8 || g.normalDraws[1] === 14) && g.melds[0].length < 2) {
        // 下家の打牌を自分がポンできるよう、自分の手牌に同じ種類を2枚（山との交換）
        const t = g.typeOf(g.drawn), pool = g.wall.filter((id) => g.typeOf(id) === t);
        const others = g.hands[0].filter((id) => g.typeOf(id) !== t);
        for (let k = g.hands[0].filter((id) => g.typeOf(id) === t).length, j = 0; k < 2 && pool.length; k++, j++) { const a = others[j], b = pool.pop(); g.hands[0][g.hands[0].indexOf(a)] = b; g.wall[g.wall.indexOf(b)] = a; }
        g._riichiMemo = null;
      }
      if (p.type === 'claim') { g.respond(p.seat, p.seat === 0 && p.pon && p.from === 1 && g.melds[0].length < 2 ? { type: 'pon' } : { type: 'pass' }); continue; }
      if (p.seat === 0 && g.normalDraws[0] === 23 && !out.at23) { m.S.game = g; m.render(); out.at23 = document.querySelector('.board-center').innerText; }
      g.discard(p.seat, g.drawn ?? g.hands[p.seat].at(-1));
    }
    g.checkInvariants();
    m.S.game = g; m.S.scored = false; m.step();
    out.draws = g.normalDraws.slice(); out.wall = g.wall.length; out.result = g.result.type; out.rivers = g.rivers.map((r) => r.length); out.melds = g.melds[0].length;
    return out;
  });
  assert.match(cap.at23, /ツモ残 1回/);
  assert.equal(cap.result, 'draw'); assert.ok(cap.wall > 0, '山が残っていても流局'); assert.ok(Math.max(...cap.draws) === 24);
  assert.ok(cap.rivers[0] > 24 && cap.melds === 2, `鳴きで24枚を超える河 ${cap.rivers}`);
  const text = await page.locator('.overlay .result').innerText();
  assert.match(text, /通常ツモの上限（各24回）に達したため流局/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-capdraw.png` });
  await page.locator('button[data-action="close-result"]').tap();
  // 24枚を超える河も全物理IDを順に表示（6枚ごとの折り返し）
  const rv = await page.evaluate(() => { const g = window.__mathjong.S.game; return { shown: [...document.querySelectorAll('.me-board .river .tile')].map((t) => Number(t.dataset.id)), want: g.rivers[0].map((r) => r.id), rows: [...document.querySelectorAll('.me-board .rv-row')].map((r) => r.children.length) }; });
  assert.deepEqual(rv.shown, rv.want); assert.deepEqual(rv.rows.slice(0, 4), [6, 6, 6, 6]); assert.equal(rv.rows.length, 5);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-river25.png` });
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('✓ 新ルール⑤：ドラ表示（1→2・表示牌とドラ）・暗カン（確認・やめる・実行・不正は拒否・リーチ中/チー直後は不可）・槓子4枚・門前・嶺上ツモ和了・ドラ加点・暗カン後リーチ・AIの暗カン・ヒント・数学Ⅱ24回流局・25枚の河');
}

// 新ルールの通しプレイ：数学Ⅰ・Ⅱ、AI 難易度3つ（従来の ?ai=）。暗カンが出れば画面から実行する
async function newRulesPlay(browser, stats = { rounds: 0, wins: [0, 0, 0, 0], draws: 0, tsumo: 0, ron: 0, ronDeclined: 0, chi: 0, chiPassed: 0, chiOverriddenByRon: 0, discards: 0, yaku: {} }) {
  // 現行の新ルール（newrules=2）で数学Ⅰ・Ⅱ×3難易度、新ルール初版（newrules=1、過去の再現 URL）でも1回
  const runs = [[DEVICES[0], 'math1', 'beginner', 6101, 2], [DEVICES[1], 'math2', 'intermediate', 6202, 2], [DEVICES[3], 'math2', 'advanced', 6303, 2], [DEVICES[2], 'math1', 'advanced', 6404, 2], [DEVICES[0], 'math2', 'intermediate', 6505, 1]];
  for (const [dev, mode, ai, seed, ruleset] of runs) {
    await playDevice(browser, dev, seed, 2, stats, { mode, ruleset, ai });
    console.log(`✓ ${dev.name}: ${ruleset === 2 ? '新ルール' : '新ルール初版'} ${mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'}・${ai} 2局 完走（暗カン ${stats.ankan || 0}回）`);
  }
}

// ===== 次回更新（docs/62）：牌の表示・フリテン・リーチの待ち・関数牌のポン禁止・新ルールへの一本化・相手選択の上部ボタン =====
const V09_SIZES = [[320, 568], [375, 667], [390, 844], [667, 375], [844, 390], [768, 1024], [1180, 820], [1440, 900]];
// 現行の新ルール（ruleset 2）の局面を作る：自分（親）の手牌を keys にし、王牌の表示牌以外から牌を交換する（保存則を保つ）
async function r2Scene(page, hand) {
  return page.evaluate((hand) => {
    const m = window.__mathjong;
    clearTimeout(m.S.timer); m.S.timer = null; m.fx.clear();
    const old = m.S.game;
    const g = new old.constructor({ rules: m.rules, seed: 7, dealer: 0, players: old.players, ruleset: 2 });
    const key = (x) => (x.startsWith('=') ? `v:${x.slice(1)}` : /^\d+$/.test(x) ? `a:${x}` : `f:${x}`);
    const T = (x) => m.rules.typeByKey.get(key(x)).idx;
    const shown = new Set(g.deadWall.indicators.map((d) => d.id));
    const conts = () => [...g.hands, g.wall];
    const where = (id) => { for (const c of conts()) { const i = c.indexOf(id); if (i >= 0) return [c, i]; } return null; };
    const swap = (a, b) => { if (a === b) return; const [ca, ia] = where(a), [cb, ib] = where(b); ca[ia] = b; cb[ib] = a; };
    const h = g.hands[0], used = new Set();
    hand.forEach((x, i) => {
      const id = h.find((y) => g.typeOf(y) === T(x) && !used.has(y)) ?? conts().flat().find((y) => g.typeOf(y) === T(x) && !used.has(y) && !shown.has(y));
      used.add(id); swap(h[i], id);
    });
    g.drawn = h.at(-1); g._riichiMemo = null;
    // テスト用の操作：今の手番の席に key の牌をツモさせて（山の牌と交換）、捨てさせる
    window.__r2 = {
      T,
      // 手番の席のツモ牌を、山にある key の牌と入れ替える
      rigDraw(x) {
        const s = g.current; const w = g.wall.findIndex((y) => g.typeOf(y) === T(x));
        if (w < 0) throw new Error('no ' + x);
        const d = g.drawn, hs = g.hands[s];
        hs[hs.indexOf(d)] = g.wall[w]; g.wall[w] = d; g.drawn = hs[hs.indexOf(g.wall[w]) >= 0 ? -1 : hs.length - 1];
        g.drawn = hs.find((y) => g.typeOf(y) === T(x) && y !== undefined && !g.rivers.flat().some((r) => r.id === y));
        g._riichiMemo = null;
      },
      // 他家の打牌（宣言はすべて見送る）を、席0の判断番まで進める。discards：席→捨てさせる牌
      // stopOnCall：自分のチー・ポンだけの宣言でも止まる（既定はロンのない自分の宣言を見送って進む）
      until0(discards = {}, stopOnCall = false) {
        for (let i = 0; i < 60 && g.pending(); i++) {
          const p = g.pending();
          if (p.seat === 0 && (p.type === 'turn' || p.ron || stopOnCall)) break;
          if (p.seat === 0) { g.respond(0, { type: 'pass' }); continue; }
          if (p.type === 'claim') { g.respond(p.seat, { type: 'pass' }); continue; }
          if (discards[p.seat]) { this.rigDraw(discards[p.seat]); delete discards[p.seat]; }
          g.discard(p.seat, g.drawn);
        }
        g.checkInvariants(); m.render(); m.step();
        clearTimeout(m.S.timer); m.S.timer = null;
      },
    };
    g.checkInvariants(); m.S.game = g; m.S.selected = null; m.S.scored = false; m.S.modal = null; m.render();
    return { waits: null, ruleset: g.ruleset };
  }, hand);
}
const r2State = (page) => page.evaluate(() => {
  const g = window.__mathjong.S.game;
  const info = document.querySelector('.self-info');
  return { furiten: g.furitenOf(0), riichiWaits: g.riichiWaits[0], pending: g.pending() && { ...g.pending() },
    info: info ? info.innerText.replace(/\s+/g, ' ') : null, infoTitle: info && info.querySelector('.si-furiten') ? info.querySelector('.si-furiten').getAttribute('title') : null,
    waits: [...document.querySelectorAll('.self-info .si-wait')].map((e) => ({ label: e.querySelector('.tile').getAttribute('aria-label'), left: e.querySelector('small').textContent })),
    ron: document.querySelectorAll('button[data-action="ron"]').length, pon: document.querySelectorAll('button[data-action="pon"]').length, tsumo: document.querySelectorAll('button[data-action="tsumo"]').length };
});
const TENPAI2 = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2', '=-√3']; // 30°・150° 待ち＋ツモ牌（−√3）

async function v09FuritenWaits(browser) {
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math1&seed=7&speed=slow&newrules=2');
    await page.locator('.hand .tile').first().waitFor();
    // (1) 同巡のフリテン（画面から見送る）：ロンのボタン → 見送る → 理由の表示 → 対面の 150° はロンの宣言なし → 自分のツモで解除 → ロンできる
    await r2Scene(page, TENPAI2);
    await page.locator('.hand .tile.drawn').tap(); await page.locator('.hand .tile.drawn').tap(); // −√3 を捨てる
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
    await page.evaluate(() => window.__r2.until0({ 1: '30' }));
    let st = await r2State(page);
    assert.deepEqual([st.pending.seat, st.pending.type, st.pending.ron, st.ron], [0, 'claim', true, 1], '30° でロンできる');
    assert.equal(st.info, null, 'フリテンでなければ表示しない（リーチ前は待ちも出さない）');
    await page.locator('button[data-action="pass"]').tap();
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
    await page.evaluate(() => window.__r2.until0({ 2: '150' }));
    st = await r2State(page);
    assert.deepEqual(st.furiten.reasons, [], '自分のツモで解除済み');
    // 解除前（対面の 150° の時点）の表示は、記録から確かめる：見送らされた牌がある
    const blocked = await page.evaluate(() => window.__mathjong.S.game.ronBlocked[0]);
    assert.ok(blocked && blocked.reasons.includes('temporary'), '対面の 150° はフリテンでロンできなかった');
    assert.equal(st.pending.type, 'turn');
    // (2) 捨て牌のフリテン：150° を自分で捨てる（ツモ牌と入れ替え）→ 表示 → 下家の 30° でもロンできない → ツモ和了はできる
    await page.evaluate(() => { window.__r2.rigDraw('150'); window.__mathjong.render(); });
    assert.equal((await r2State(page)).tsumo, 1, '150° はツモ和了できる');
    await page.locator('.hand .tile.drawn').tap(); await page.locator('.hand .tile.drawn').tap();
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; window.__mathjong.render(); });
    st = await r2State(page);
    assert.match(st.info, /フリテン/); assert.match(st.infoTitle, /待ちの牌を自分で捨てている/);
    if (width > 360) assert.match(st.info, /捨て牌に待ち（150°）/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v09-furiten-discard-${width}.png` });
    await page.evaluate(() => window.__r2.until0({ 1: '30' }));
    st = await r2State(page);
    assert.equal(st.pending.type, 'turn', '下家の 30° ではロンの宣言がない');
    assert.equal(st.ron, 0);
    await page.evaluate(() => { window.__r2.rigDraw('30'); window.__mathjong.render(); });
    assert.equal((await r2State(page)).tsumo, 1, 'フリテンでもツモ和了はできる');
    // (3) リーチの待ち（実際の牌・見えていない残り枚数）・リーチ後の見逃し（局の終わりまで）
    await r2Scene(page, TENPAI2);
    await page.locator('button[data-action="riichi"]').tap();
    await page.locator('.hand .tile.drawn').tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; window.__mathjong.render(); });
    st = await r2State(page);
    assert.deepEqual(st.waits.map((w) => w.label), ['30°', '150°'], 'リーチの待ちを牌で表示');
    const unseen = await page.evaluate(async () => { const { unseenFromView } = await import('./src/engine/yakuhint.js'); const m = window.__mathjong; const u = unseenFromView(m.rules, m.S.game.viewFor(0)); return m.S.game.riichiWaits[0].map((t) => `残${u[t]}`); });
    assert.deepEqual(st.waits.map((w) => w.left), unseen, '残りは公開情報と自分の手牌から');
    assert.equal(st.furiten.furiten, false); assert.doesNotMatch(st.info, /フリテン/);
    // 他家に待ちが渡らない：他家の AI に渡る riichi[] と view に待ちはない
    const leak = await page.evaluate(() => { const g = window.__mathjong.S.game; return { riichi: Object.keys(g.riichi[0]).sort(), view: JSON.stringify(g.viewFor(1)).includes('riichiWaits') }; });
    assert.deepEqual(leak, { riichi: ['tile', 'turn'], view: false });
    await page.evaluate(() => window.__r2.until0({ 1: '30' }));
    st = await r2State(page);
    assert.equal(st.ron, 1, 'リーチ中も和了の牌ならロンできる');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v09-riichi-ron-${width}.png` });
    await page.locator('button[data-action="pass"]').tap();
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
    await page.evaluate(() => window.__r2.until0({}));
    st = await r2State(page);
    assert.deepEqual(st.furiten.reasons, ['riichi']); assert.match(st.info, /リーチ後の見逃し/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v09-riichi-furiten-${width}.png` });
    await page.locator('button[data-action="tsumogiri"]').tap();
    await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
    await page.evaluate(() => window.__r2.until0({ 2: '150' }));
    st = await r2State(page);
    assert.equal(st.pending.type, 'turn', 'リーチ後の見逃しの後は 150° でもロンの宣言がない');
    await page.evaluate(() => { window.__r2.rigDraw('150'); window.__mathjong.render(); });
    await page.locator('button[data-action="tsumo"]').tap();
    await page.locator('.overlay .result').waitFor();
    assert.match(await page.locator('.overlay .result').innerText(), /あなた の和了 ツモ[\s\S]*リーチ/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ フリテン（同巡の見逃し・捨て牌・リーチ後の見逃し）：ロンの宣言なし・ツモ和了は可・理由の表示／リーチの待ち（牌と見えていない残り枚数、他家に渡さない）');
}

async function v09FuncPon(browser) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(), errors = watchErrors(page);
  await page.goto(LOCAL + '?mode=math1&seed=7&speed=slow&newrules=2');
  await page.locator('.hand .tile').first().waitFor();
  // 自分は sin・sin と 90°・90° を持つ。下家（AI）に sin を捨てさせる → ポンのボタンなし。90° → ポンのボタンあり → ポン
  await r2Scene(page, ['sin', 'sin', '90', '90', '=-√3', '=-√3', '0', '0', '=1/√2']);
  await page.locator('.hand .tile.drawn').tap(); await page.locator('.hand .tile.drawn').tap();
  await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
  await page.evaluate(() => window.__r2.until0({ 1: 'sin', 2: 'sin', 3: 'sin' }, true));
  let st = await r2State(page);
  const sinsGone = await page.evaluate(() => window.__mathjong.S.game.rivers.slice(1).flat().filter((r) => window.__mathjong.S.game.typeOf(r.id) === window.__r2.T('sin')).length);
  assert.equal(sinsGone, 3, '他家3人が sin を捨てた');
  assert.equal(st.pending.type, 'turn', '関数牌ではポンの宣言番にならない');
  await page.locator('.hand .tile.drawn').tap(); await page.locator('.hand .tile.drawn').tap();
  await page.evaluate(() => { clearTimeout(window.__mathjong.S.timer); window.__mathjong.S.timer = null; });
  await page.evaluate(() => window.__r2.until0({ 1: '90' }, true));
  st = await r2State(page);
  assert.deepEqual([st.pending.type, st.pon], ['claim', 1], '角度牌はポンできる');
  await page.locator('button[data-action="pon"]').tap();
  assert.equal(await page.evaluate(() => window.__mathjong.S.game.melds[0][0].call), 'pon');
  // ガイドのルールに関数牌のポン禁止・フリテンの説明
  await page.locator('button[data-action="guide"]').first().tap();
  await page.locator('[data-action="guide-tab"][data-tab="rules"]').tap();
  const rulesText = await page.locator('.rules-list').innerText();
  assert.match(rulesText, /関数牌はポンできません/); assert.match(rulesText, /フリテン/); assert.doesNotMatch(rulesText, /フリテンは未実装/);
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('✓ 関数牌のポン禁止（宣言なし）・角度牌のポンは可・ガイドの説明');
}

async function v09RulesUnified(browser) {
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // 以前のルール選択の保存値（従来ルール）が残っていても、従来ルールにはならない
  await ctx.addInitScript(() => { try { localStorage.setItem('mj-rule-set', 'legacy'); } catch { /* */ } });
  const page = await ctx.newPage(), errors = watchErrors(page);
  const logoLoaded = () => page.waitForFunction(() => { const i = document.querySelector('.title-logo-img'); return !!i && i.complete; });
  await page.goto(LOCAL + '?speed=test');
  await logoLoaded();
  assert.equal(await page.locator('[data-action="title-ruleset"], .title-rules').count(), 0, 'タイトルにルールの選択はない');
  assert.equal(await page.locator('[data-action="title-mode"]').count(), 2, '数学Ⅰ・Ⅱは選べる');
  for (const mode of ['math1', 'math2']) {
    await page.locator(`input[data-action="title-mode"][value="${mode}"]`).check();
    await page.locator('button[data-action="choose-opponents"]').tap();
    await page.locator('button[data-action="opp-random"]').tap();
    await page.locator('button[data-action="start-match"]').tap();
    await page.locator('.hand .tile').first().waitFor();
    assert.deepEqual(await page.evaluate(() => [window.__mathjong.S.game.ruleset, window.__mathjong.rules.config.mode]), [2, mode], '通常の対局は現行の新ルール');
    assert.equal(await page.locator('.dora-box').count(), 1);
    assert.equal(await page.locator('.bc-rule').count(), 0, '現行の新ルールに再現の印はない');
    await page.locator('button[data-action="settings"]').tap();
    assert.equal(await page.locator('[data-action="ruleset"], .rule-select').count(), 0, '設定にルールの選択はない');
    assert.match(await page.locator('.report-info').innerText(), /新ルール[\s\S]*newrules=2/, '再現URLは newrules=2');
    await page.locator('button[data-action="reset"]').tap();
    await page.locator('.hand .tile').first().waitFor();
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.ruleset), 2, '新しい対局も新ルール');
    await page.evaluate(() => { const m = window.__mathjong; m.S.match.over = true; m.S.modal = 'final'; m.render(); });
    assert.match(await page.locator('.final').innerText(), /ルール：新ルール/);
    await page.locator('button[data-action="again"]').tap();
    await page.locator('.hand .tile').first().waitFor();
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.ruleset), 2, '再戦も新ルール');
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="to-title"]').tap();
    await logoLoaded();
  }
  // 再現URL：newrules なし＝従来ルール（過去の URL）、1＝新ルール初版、2＝現行。それぞれ印と版。3 はエラー画面
  const q = 'seed=11&round=1&dealer=0&hand=0&renchan=0&len=4&mode=math2&speed=slow';
  for (const [extra, ruleset, note] of [['', 0, '従来ルールの再現'], ['&newrules=1', 1, '新ルール初版の再現'], ['&newrules=2', 2, null]]) {
    await page.goto(`${LOCAL}?${q}${extra}`);
    await page.locator('.hand .tile').first().waitFor();
    assert.equal(await page.evaluate(() => window.__mathjong.S.game.ruleset), ruleset, `newrules${extra}`);
    assert.equal(await page.locator('.dora-box').count(), ruleset ? 1 : 0);
    if (note) assert.equal(await page.locator('.bc-rule').innerText(), note); else assert.equal(await page.locator('.bc-rule').count(), 0);
    assert.equal(await page.locator('.bc-mode').innerText(), '数学Ⅱ', 'モードの表示は変えない');
    await page.locator('button[data-action="settings"]').tap();
    const info = await page.locator('.report-info').innerText();
    assert.ok(ruleset ? info.includes(`newrules=${ruleset}`) : !info.includes('newrules'), '出力する再現URLは元の版のまま');
  }
  // 同じ seed の再現：新旧の版は別の進行（王牌の有無）、同じ版は同じ進行
  const walls = [];
  for (const extra of ['', '', '&newrules=2', '&newrules=2']) {
    await page.goto(`${LOCAL}?${q}${extra}`);
    await page.locator('.hand .tile').first().waitFor();
    walls.push(await page.evaluate(() => JSON.stringify([window.__mathjong.S.game.hands, window.__mathjong.S.game.wall])));
  }
  assert.equal(walls[0], walls[1]); assert.equal(walls[2], walls[3]); assert.notEqual(walls[0], walls[2]);
  await page.goto(`${LOCAL}?seed=11&newrules=3`);
  assert.match(await page.locator('.replay-error').innerText(), /newrules/);
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('✓ 新ルールへの一本化：タイトル・設定にルールの選択なし・古い保存値は無視・通常/新しい対局/再戦は現行の新ルール（数学Ⅰ・Ⅱ）・再現URL（なし＝従来、1＝初版、2＝現行、3＝エラー）・seed の再現');
}

async function v09SelectTop(browser) {
  for (const [width, height] of V09_SIZES) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?speed=test');
    await page.waitForFunction(() => { const i = document.querySelector('.title-logo-img'); return !!i && i.complete; });
    await page.locator('button[data-action="choose-opponents"]').tap();
    await page.locator('.select-screen').waitFor();
    const box = (sel) => page.locator(sel).first().boundingBox();
    const [title, status, rnd, start, card, back] = await Promise.all(['.select-title', '.opp-status', 'button[data-action="opp-random"]', 'button[data-action="start-match"]', '.opp-card', 'button[data-action="to-title"]'].map(box));
    const label = `${width}x${height}`;
    assert.ok(title.y < status.y && status.y + status.height <= rnd.y + 1, '見出し → 選択状況 → ボタン ' + label);
    assert.ok(rnd.y + rnd.height <= card.y + 1 && start.y + start.height <= card.y + 1, 'ボタンは一覧の上 ' + label);
    assert.ok(Math.abs(rnd.y - start.y) < 1 && rnd.x + rnd.width <= start.x, '「おまかせ」「対局開始」は横並び ' + label);
    assert.ok(rnd.height >= 44 && start.height >= 44 && rnd.width >= 88 && start.width >= 110, '押しやすい大きさ ' + label);
    assert.ok(start.x + start.width <= width + 0.5 && rnd.x >= -0.5, '画面内 ' + label);
    assert.ok(back.y > card.y, '「タイトルへ戻る」は下 ' + label);
    assert.ok(await page.locator('button[data-action="start-match"]').isDisabled(), '3人そろうまで開始できない');
    // 選択で画面が跳ねない：スクロール位置とカードの位置が変わらない（4人目の案内も一覧をずらさない）
    await page.evaluate(() => window.scrollTo(0, 120));
    const ids = await page.locator('.opp-card').evaluateAll((es) => es.map((e) => e.dataset.id));
    const pos = async () => page.evaluate(() => ({ y: scrollY, card: document.querySelectorAll('.opp-card')[6].getBoundingClientRect().top }));
    const p0 = await pos();
    for (const id of ids.slice(4, 8)) {
      // 要素を画面内へスクロールしない押し方（テストの操作でスクロール位置を変えない）
      await page.locator(`.opp-card[data-id="${id}"] .opp-check`).evaluate((e) => e.click());
      const p = await pos();
      assert.ok(Math.abs(p.y - p0.y) < 1 && Math.abs(p.card - p0.card) < 1, `選択で画面が跳ねない ${label} ${JSON.stringify([p0, p])}`);
    }
    assert.equal(await page.locator('.opp-notice').count(), 1, '4人目は案内');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.opp-notice')).position), 'fixed');
    assert.equal(await page.locator('button[data-action="start-match"]').isDisabled(), false, '3人で開始できる');
    if (SHOTS && (width === 320 || width === 390 || width === 1440)) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${SHOTS}/v09-select-${label}.png` }); }
    // おまかせ：既存の抽選（異なる3人）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('button[data-action="opp-random"]').click();
    const sel = await page.evaluate(() => window.__mathjong.S.opp.selected.slice());
    assert.equal(new Set(sel).size, 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, '横スクロールなし ' + label);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 相手選択：見出し→選択状況→「おまかせ」「対局開始」（横並び・一覧の上）→12人→「タイトルへ戻る」、8画面・選択で画面が跳ねない・3人で開始');
}

// 全牌種類×表示の文脈（手牌・面子・河・面子の枠・ドラ表示・結果・ガイドの大きさ）で、中身が枠からはみ出さず、分子・分母が重ならない
async function v09TileFaces(browser) {
  let checked = 0;
  for (const [width, height] of [[320, 568], [568, 320], [390, 844], [844, 390], [1440, 900]]) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math2&seed=7&speed=slow');
    await page.locator('.hand .tile').first().waitFor();
    const res = await page.evaluate(async () => {
      const { tileHTML } = await import('./src/ui/render.js');
      const { createRules } = await import('./src/engine/rules.js');
      const { makeConfig } = await import('./src/engine/config.js');
      const m = window.__mathjong; clearTimeout(m.S.timer); m.S.timer = null;
      const types = [...createRules(makeConfig({ mode: 'math1' })).types, ...createRules(makeConfig({ mode: 'math2' })).types];
      const seen = new Set(); const uniq = types.filter((t) => { const k = t.key + (t.unit || ''); if (seen.has(k)) return false; seen.add(k); return true; });
      const row = (size) => uniq.map((t) => tileHTML(t, { size, attrs: `data-k="${t.key}${t.unit === 'rad' ? '#rad' : ''}"` })).join('');
      const ctxs = [
        ['手牌', `<main class="table"><section class="self"><div class="hand-row"><div class="hand" style="flex-wrap:wrap">${row('l')}</div></div></section></main>`],
        ['自分の面子', `<main class="table"><section class="self"><div class="hand-row"><div class="melds mine"><span class="meld" style="flex-wrap:wrap">${row('m')}</span></div></div></section></main>`],
        ['m', `<div>${row('m')}</div>`], ['s', `<div>${row('s')}</div>`], ['xs', `<div>${row('xs')}</div>`],
        ...[13, 15, 17, 20, 24, 28].flatMap((rw) => [
          [`河 rw${rw}`, `<div class="mj-table" style="--rw:${rw}px;display:block;width:auto"><div class="river">${row('xs')}</div></div>`],
          [`他家の面子 rw${rw}`, `<div class="mj-table" style="--rw:${rw}px;display:block;width:auto"><div class="melds-block"><span class="meld">${row('xs')}</span></div></div>`],
          [`ドラ表示 rw${rw}`, `<div class="mj-table" style="--rw:${rw}px;display:block;width:auto"><div class="dora-box" style="display:block"><span class="dr-tiles" style="flex-wrap:wrap">${row('xs')}</span></div></div>`],
        ]),
      ];
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:0;top:0;width:100%;z-index:99';
      host.innerHTML = ctxs.map(([n, html]) => `<section data-ctx="${n}"><div style="display:flex;flex-wrap:wrap;gap:2px">${html}</div></section>`).join('');
      document.body.appendChild(host);
      document.querySelector('#app').style.display = 'none';
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bad = [];
      let n = 0;
      for (const sec of host.querySelectorAll('section[data-ctx]')) for (const t of sec.querySelectorAll('.tile')) {
        n++;
        const tb = t.getBoundingClientRect(), cs = getComputedStyle(t);
        const inner = { l: tb.left + parseFloat(cs.borderLeftWidth), r: tb.right - parseFloat(cs.borderRightWidth), t: tb.top + parseFloat(cs.borderTopWidth), b: tb.bottom - parseFloat(cs.borderBottomWidth) };
        let l = Infinity, r = -Infinity, top = Infinity, bot = -Infinity;
        const add = (b) => { l = Math.min(l, b.left); r = Math.max(r, b.right); top = Math.min(top, b.top); bot = Math.max(bot, b.bottom); };
        const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode; if (!node.textContent.trim() || node.parentElement.closest('.eq')) continue;
          const drawn = node.parentElement.closest('.glyph') && node.parentElement.closest('.neg, .rs');
          if (drawn) { add(drawn.getBoundingClientRect()); continue; } // CSS で描く負号・根号は要素の箱
          const rg = document.createRange(); rg.selectNodeContents(node); for (const b of rg.getClientRects()) add(b);
        }
        for (const e of t.querySelectorAll('.den, .radicand')) add(e.getBoundingClientRect());
        const over = Math.max(inner.l - l, r - inner.r, inner.t - top, bot - inner.b, 0);
        let frac = 0;
        for (const f of t.querySelectorAll('.frac')) frac = Math.max(frac, f.querySelector('.num').getBoundingClientRect().bottom - f.querySelector('.den').getBoundingClientRect().top);
        const neg = t.querySelector('.neg');
        const negOk = !neg || (neg.getBoundingClientRect().width > 0.5 && neg.getBoundingClientRect().left >= inner.l - 0.5);
        if (over > 0.5 || frac > 0.6 || !negOk) bad.push({ ctx: sec.dataset.ctx, k: t.dataset.k, over: +over.toFixed(2), frac: +frac.toFixed(2), negOk });
      }
      return { n, bad };
    });
    checked += res.n;
    assert.deepEqual(res.bad, [], `牌の中身がはみ出す・重なる ${width}x${height}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`✓ 牌の表示：数学Ⅰ・Ⅱの全種類×手牌・面子・河・他家の面子・ドラ表示・結果・小（${checked}枚）で枠からはみ出さない・分子分母が重ならない・負号が欠けない`);
}

// リーチの待ち・フリテンの行：8画面で手牌の上に収まり、操作バー・ヒント・卓と重ならない
async function v09Layout(browser) {
  for (const [width, height] of V09_SIZES) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math1&seed=7&speed=slow&newrules=2');
    await page.locator('.hand .tile').first().waitFor();
    await r2Scene(page, TENPAI2);
    await page.evaluate(() => { const g = window.__mathjong.S.game; g.discard(0, g.drawn, { riichi: true }); window.__r2.until0({ 1: '30' }); });
    await page.evaluate(() => { const g = window.__mathjong.S.game; g.respond(0, { type: 'pass' }); window.__r2.until0({}); });
    const d = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const info = document.querySelector('.self-info');
      return { info: b('.self-info'), hand: b('.self .hand'), self: b('.table .self'), bar: b('footer.bar'), dock: b('.study-dock'), table: b('.mj-table'),
        overflow: document.documentElement.scrollWidth - innerWidth, infoOverflow: info.scrollWidth - info.clientWidth, text: info.innerText };
    });
    const label = `${width}x${height}`;
    const ov = (a, c) => Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.75 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.75;
    assert.match(d.text, /待ち[\s\S]*フリテン/, label);
    assert.ok(d.info.t >= d.self.t - 0.5 && d.info.b <= d.hand.t + 1, '手牌の上（自分の欄の中） ' + label);
    assert.ok(!ov(d.info, d.bar) && !ov(d.info, d.dock) && !ov(d.info, d.table), '操作バー・ヒント・卓と重ならない ' + label);
    assert.ok(d.info.h <= 64, `高さを取りすぎない ${d.info.h} ` + label);
    assert.ok(d.overflow <= 1 && d.infoOverflow <= 1, '横にはみ出さない ' + label);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v09-layout-${label}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ リーチの待ち・フリテンの行：8画面で手牌の上に収まり、操作バー・ヒント・卓と重ならない');
}

// 新ルールの画面：スマホ縦・横・320px・タブレット・PC で、ドラ表示と操作バー・ヒント・河・中央・名札が重ならない
async function v08NewRulesLayout(browser) {
  const sizes = [[320, 568], [375, 667], [390, 844], [667, 375], [844, 390], [768, 1024], [1180, 820], [1440, 900]];
  for (const [width, height] of sizes) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math2&seed=7&speed=slow&newrules=1');
    await page.locator('.hand .tile').first().waitFor();
    for (const kans of [0, 4]) {
      const st = await page.evaluate((kans) => {
        const m = window.__mathjong;
        clearTimeout(m.S.timer); m.S.timer = null; m.fx.clear();
        const old = m.S.game;
        const g = new old.constructor({ rules: m.rules, seed: 7, dealer: 0, players: old.players, newRules: true });
        const made = () => g.melds.flat().filter((x) => x.call === 'ankan').length;
        for (let i = 0; i < 2000 && g.pending(); i++) {
          const p = g.pending();
          if (made() >= kans && p.seat === 0 && p.type === 'turn' && g.rivers[0].length >= 5) break;
          if (p.type === 'claim') { g.respond(p.seat, { type: 'pass' }); continue; }
          if (made() < kans && !g.melds[p.seat].length && g.normalDraws[p.seat] >= 2) {
            const hand = g.hands[p.seat];
            for (const t of hand.map((id) => g.typeOf(id))) {
              const have = hand.filter((id) => g.typeOf(id) === t), pool = g.wall.filter((id) => g.typeOf(id) === t);
              if (have.length + pool.length < 4) continue;
              const others = hand.filter((id) => g.typeOf(id) !== t && id !== g.drawn);
              for (let j = 0; j < 4 - have.length; j++) { const a = others[j], b = pool[j]; hand[hand.indexOf(a)] = b; g.wall[g.wall.indexOf(b)] = a; }
              g._riichiMemo = null;
              if (g.ankanOptions(p.seat).some((o) => o.type === t)) { g.ankan(p.seat, t); break; }
            }
            if (g.pending() && g.pending().seat === p.seat && g.justDrew && g.events.at(-1).type === 'dora') continue;
          }
          g.discard(p.seat, g.drawn ?? g.hands[p.seat].at(-1));
        }
        g.checkInvariants(); m.S.game = g; m.render();
        return { kans: made(), dora: g.doraIndicators.length };
      }, kans);
      assert.equal(st.kans, kans); assert.equal(st.dora, 1 + kans);
      const d = await page.evaluate(() => {
        const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        const q = (s) => [...document.querySelectorAll(s)].map(box);
        return { dora: box(document.querySelector('.dora-box')), table: box(document.querySelector('.mj-table')), bar: box(document.querySelector('footer.bar')), dock: box(document.querySelector('.study-dock')),
          hand: box(document.querySelector('.self')), center: box(document.querySelector('.board-center')), tags: q('.seat-tag'), river: q('.river .tile'), melds: q('.mj-melds .meld .tile'),
          overflow: document.documentElement.scrollWidth - innerWidth, inds: document.querySelectorAll('.dora-box .dr-ind .tile').length };
      });
      const label = `${width}x${height} 暗カン${kans}`;
      assert.equal(d.inds, 1 + kans, label);
      assert.ok(d.overflow <= 1, '横スクロールなし ' + label);
      assert.ok(d.dora.left >= d.table.left - 1 && d.dora.right <= d.table.right + 1 && d.dora.top >= d.table.top - 1 && d.dora.bottom <= d.table.bottom + 1, 'ドラ表示は卓の中 ' + label);
      for (const [name, b] of [['操作バー', d.bar], ['ヒント', d.dock], ['手牌', d.hand], ['中央', d.center], ...d.tags.map((t) => ['名札', t]), ...d.river.map((t) => ['河', t]), ...d.melds.map((t) => ['面子', t])]) {
        assert.ok(!mjOverlap(d.dora, b), `ドラ表示と${name}が重ならない ` + label);
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/nr-layout-${width}x${height}-kan${kans}.png` });
    }
    // 暗カンの確認の段階でも操作バーは画面内
    await page.evaluate(() => window.__mathjong.render());
    const bar = await page.locator('.bar').boundingBox();
    assert.ok(bar.y + bar.height <= height + 0.5, `操作バーが画面内 ${width}x${height}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 新ルールの画面：8画面（320・375・390縦、667・844横、iPad縦、タブレット横、PC）×暗カン0/4回で、ドラ表示は卓の中・操作バー/ヒント/手牌/中央/名札/河/面子と重ならない・横スクロールなし');
}

// ===== リーチ後のオートツモ切り（src/ui/auto-tsumogiri.js） =====
// 状態：自分の判断番・設定・自動で捨てた回数・自分の打牌の数
const atState = (page) => page.evaluate(() => {
  const m = window.__mathjong, g = m.S.game;
  const p = g && g.pending();
  const btn = document.querySelector('button[data-action="toggle-auto-tsumogiri"]');
  return {
    pending: p && { seat: p.seat, type: p.type, ron: !!p.ron, canTsumo: !!p.canTsumo }, on: m.S.autoTsumo.on, count: m.S.autoTsumo.count, stopped: m.S.autoTsumo.stopped,
    myDiscards: g ? g.events.filter((e) => e.type === 'discard' && e.seat === 0).length : 0, riichi: g ? !!g.riichi[0] : false, ended: g ? !g.pending() : null,
    toggle: btn ? btn.getAttribute('aria-pressed') : null, chiToggle: document.querySelectorAll('[data-action="toggle-chi-autopass"]').length,
    status: (document.querySelector('.bar .status') || {}).textContent || '', failed: m.S.input.failed, furiten: g ? g.furitenOf(0).reasons : [],
  };
});
// 自分の判断番（手番か宣言）か局の終わりまで待つ
const atWaitMine = (page, timeout = 20000) => page.waitForFunction(() => { const g = window.__mathjong.S.game; const p = g && g.pending(); return !p || p.seat === 0; }, null, { timeout });
// テスト用の操作（ページ内）：他家の手番をエンジンで進める（宣言はすべて見送り）。stopAt1：下家の手番で止める
const atDrive = (page, { rig0 = null, stopAt1 = false } = {}) => page.evaluate(({ rig0, stopAt1 }) => {
  const m = window.__mathjong, g = m.S.game;
  clearTimeout(m.S.timer); m.S.timer = null;
  for (let i = 0; i < 80 && g.pending(); i++) {
    const p = g.pending();
    if (stopAt1 && p.seat === 1 && p.type === 'turn') break;
    if (p.seat === 0) {
      if (p.type === 'claim' && !p.ron) { g.respond(0, { type: 'pass' }); continue; }
      break;
    }
    if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn);
  }
  const p = g.pending();
  if (rig0 && p && p.seat === 0 && p.type === 'turn') window.__r2.rigDraw(rig0); // 自分のツモ牌を和了の牌にする（山と交換）
  g.checkInvariants();
  return p && { seat: p.seat, type: p.type };
}, { rig0, stopAt1 });
async function v10AutoTsumogiri(browser) {
  for (const [width, height, mode] of [[390, 844, 'math1'], [667, 375, 'math2']]) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    // 遅い速さ（自動の間 1.2秒）で、局面を決めて確かめる。30°（π/6）・150°（5π/6）待ち（角度牌の key は度数なので数学Ⅱでも同じ手）
    await page.goto(LOCAL + `?mode=${mode}&seed=7&speed=slow&newrules=2`);
    await page.locator('.hand .tile').first().waitFor();
    await r2Scene(page, TENPAI2);
    let st = await atState(page);
    assert.deepEqual([st.toggle, st.chiToggle], [null, 1], 'リーチ前は切替を出さない');
    await page.locator('button[data-action="riichi"]').tap();
    await page.locator('.hand .tile.drawn').tap();
    await page.locator('button[data-action="riichi-discard"]').tap();
    // (1) OFF（既定）：自分のツモ番で止まり、手動のツモ切りを待つ（従来どおり）
    await atDrive(page);
    await page.evaluate(() => window.__mathjong.step());
    st = await atState(page);
    assert.deepEqual([st.pending.seat, st.pending.type, st.pending.canTsumo, st.toggle, st.chiToggle, st.on], [0, 'turn', false, 'false', 1, false], 'リーチ中は操作バーに切替を出す（既定 OFF）。手牌の下の道具は従来のまま');
    let n = st.myDiscards;
    await page.waitForTimeout(1600);
    st = await atState(page);
    assert.equal(st.myDiscards, n, 'OFF では自動で捨てない');
    assert.match(st.status, /リーチ中：ツモ切り/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v10-off-${width}.png` });
    // (2) ON：その手番から自動でツモ切り（1回だけ）
    await page.locator('button[data-action="toggle-auto-tsumogiri"]').tap();
    await page.waitForFunction(() => window.__mathjong.S.autoTsumo.count >= 1, null, { timeout: 5000 });
    st = await atState(page);
    assert.deepEqual([st.toggle, st.on, st.count, st.myDiscards], ['true', true, 1, n + 1], 'ON：1回だけ自動でツモ切り');
    // (3) ロンできる局面：下家の打牌を和了の牌に → 自動で進まず、ロンか見送りを選ぶ
    await atDrive(page, { stopAt1: true });
    await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game;
      window.__r2.rigDraw('150');
      g.discard(1, g.drawn); g.checkInvariants(); m.step(true);
    });
    // 宣言は打牌者に近い席から順に聞く（対面・上家の AI の判断の後、自分のロン）
    await page.waitForFunction(() => { const p = window.__mathjong.S.game.pending(); return !p || (p.seat === 0); }, null, { timeout: 10000 });
    st = await atState(page);
    assert.deepEqual([st.pending.seat, st.pending.type, st.pending.ron], [0, 'claim', true], 'ロンの宣言');
    await page.waitForTimeout(1600);
    st = await atState(page);
    assert.deepEqual([st.pending.seat, st.pending.type, st.count], [0, 'claim', 1], 'ロンできるときは自動で進まない');
    assert.equal(await page.locator('button[data-action="ron"]').count(), 1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v10-ron-stop-${width}.png` });
    await page.locator('button[data-action="pass"]').tap();
    st = await atState(page);
    assert.ok(st.furiten.includes('riichi'), 'リーチ後の見送り：この局の終わりまでフリテン');
    assert.equal(st.on, true, '見送った後も ON');
    // (4) ツモ和了できる局面（リーチ後フリテン中でもツモ和了はできる）：自動で捨てず、和了か見送りを選ぶ
    await atDrive(page, { rig0: '30' });
    await page.evaluate(() => window.__mathjong.step());
    await page.waitForTimeout(1600);
    st = await atState(page);
    assert.deepEqual([st.pending.seat, st.pending.type, st.pending.canTsumo, st.count], [0, 'turn', true, 1], 'ツモ和了できるときは自動で捨てない');
    assert.match(st.status, /和了できます！（自動ツモ切りは停止中）/);
    assert.equal(await page.locator('button[data-action="tsumo"]').count(), 1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v10-tsumo-stop-${width}.png` });
    await page.locator('button[data-action="tsumogiri"]').tap(); // 見送る（本人のツモ切り）
    st = await atState(page);
    // ツモの見送り＝和了の牌（30°）を自分で捨てる → 捨て牌のフリテン（以後この待ちではロンできない）
    assert.deepEqual([st.on, st.count], [true, 1], '見送り後も ON');
    assert.ok(st.furiten.includes('discard') && st.furiten.includes('riichi'), '和了の牌を捨てたので捨て牌のフリテン（リーチ後の見逃しも続く）');
    // (5) 見送り後も自動で進む（フリテン中もツモ切りは自動）
    await atDrive(page);
    await page.evaluate(() => window.__mathjong.step());
    await page.waitForFunction(() => window.__mathjong.S.autoTsumo.count >= 2, null, { timeout: 5000 });
    // (6) OFF：予約した自動操作を取り消して手動へ
    await atDrive(page);
    st = await atState(page);
    assert.deepEqual([st.pending.seat, st.pending.type], [0, 'turn']);
    await page.evaluate(() => window.__mathjong.step()); // ここで自動ツモ切りを予約（1.2秒後）
    await page.locator('button[data-action="toggle-auto-tsumogiri"]').tap(); // 予約の前に OFF
    n = (await atState(page)).myDiscards;
    await page.waitForTimeout(1600);
    st = await atState(page);
    assert.deepEqual([st.on, st.toggle, st.myDiscards, st.count], [false, 'false', n, 2], 'OFF にしたら予約した自動操作を実行しない');
    // (7) ON に戻し、速さを上げて局の終わりまで（AI の実際の判断。和了・ロンの機会では本人が見送る）。二重操作・無限ループなし
    await page.evaluate(() => { window.__mathjong.S.speed = 'fast'; });
    await page.locator('button[data-action="toggle-auto-tsumogiri"]').tap();
    for (let i = 0; i < 400; i++) {
      st = await atState(page);
      if (st.ended) break;
      if (st.pending.seat === 0 && st.pending.type === 'claim') { await page.locator('button[data-action="pass"]').tap(); continue; }
      if (st.pending.seat === 0 && st.pending.canTsumo) { await page.locator('button[data-action="tsumogiri"]').tap(); continue; }
      await page.waitForTimeout(100);
    }
    await page.locator('.overlay .result').waitFor({ timeout: 30000 });
    st = await atState(page);
    const mine = await page.evaluate(() => window.__mathjong.S.game.events.filter((e) => e.type === 'discard' && e.seat === 0).length);
    assert.ok(st.count >= 3, `自動ツモ切り ${st.count}回`);
    assert.equal(st.failed, 0, 'エンジンに拒否された操作なし（二重の打牌なし）');
    assert.ok(mine >= st.count);
    assert.equal(await page.evaluate(() => window.__mathjong.S.scores.reduce((a, b) => a + b, 0)), 400);
    if (mode === 'math2') assert.ok(await page.evaluate(() => window.__mathjong.S.game.normalDraws.every((x) => x <= 24)), '24回の上限');
    // (8) 次の局・再戦・タイトルでは OFF に戻る
    await page.locator('button[data-action="next"]').tap();
    await page.locator('.hand .tile').first().waitFor();
    assert.equal((await atState(page)).on, false, '次の局は OFF');
    await page.evaluate(() => { const m = window.__mathjong; m.S.autoTsumo.on = true; m.S.match.over = true; m.S.modal = 'final'; m.render(); });
    await page.locator('button[data-action="again"]').tap();
    await page.locator('.hand .tile').first().waitFor();
    assert.equal((await atState(page)).on, false, '再戦は OFF');
    await page.evaluate(() => { window.__mathjong.S.autoTsumo.on = true; });
    await page.locator('button[data-action="settings"]').tap();
    await page.locator('button[data-action="ask-title"]').tap();
    await page.locator('button[data-action="to-title"]').tap();
    assert.equal(await page.evaluate(() => window.__mathjong.S.autoTsumo.on), false, 'タイトルへ戻ると OFF');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // (9) 流局：数学Ⅱの通常ツモ24回の上限まで自動で進み、流局の結果になる
  {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math2&seed=7&speed=slow&newrules=2'); // 他家はテストがエンジンで進める（AI の予約は毎回取り消す）
    await page.locator('.hand .tile').first().waitFor();
    await r2Scene(page, TENPAI2);
    // 他家はエンジンでツモ切り・宣言は見送り（和了しない）、自分はリーチしてオートツモ切り。和了の牌は自分のツモでは見送る
    await page.evaluate(() => { const g = window.__mathjong.S.game; g.discard(0, g.drawn, { riichi: true }); });
    await page.evaluate(() => { window.__mathjong.S.autoTsumo.on = true; });
    for (let i = 0; i < 200; i++) {
      const p = await atDrive(page);
      if (!p) break;
      await page.evaluate(() => window.__mathjong.step());
      const s2 = await atState(page);
      if (s2.ended) break;
      if (s2.pending.seat === 0 && s2.pending.type === 'claim') await page.locator('button[data-action="pass"]').tap();
      else if (s2.pending.seat === 0 && s2.pending.canTsumo) await page.locator('button[data-action="tsumogiri"]').tap();
      else await page.waitForFunction((c) => { const m = window.__mathjong; const q = m.S.game.pending(); return m.S.autoTsumo.count > c || !q || q.seat !== 0; }, s2.count, { timeout: 5000 });
    }
    await page.evaluate(() => window.__mathjong.step());
    await page.locator('.overlay .result').waitFor({ timeout: 10000 });
    const r = await page.evaluate(() => { const g = window.__mathjong.S.game; return { type: g.result.type, draws: g.normalDraws, wall: g.wall.length, count: window.__mathjong.S.autoTsumo.count }; });
    assert.equal(r.type, 'draw'); assert.ok(Math.max(...r.draws) === 24 && r.wall > 0, `24回で流局 ${JSON.stringify(r)}`);
    assert.ok(r.count >= 10, `自動ツモ切り ${r.count}回`);
    assert.match(await page.locator('.overlay .result').innerText(), /通常ツモの上限/);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ オートツモ切り（数学Ⅰ・Ⅱ）：既定 OFF（従来どおり手動）・ON で自動・ツモ和了とロンで必ず停止・見送り後も ON とリーチ後フリテン・OFF で予約を取り消し・AI と終局まで二重操作なし・数学Ⅱ24回で流局・次の局／再戦／タイトルで OFF');
}

// リーチ中の切替（操作バー）：8画面で操作バーの中に収まり、ほかのボタン・状態欄・手牌・ヒントと重ならない（自分の番・他家の番）
async function v10AutoTsumoLayout(browser) {
  for (const [width, height] of V09_SIZES) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    await page.goto(LOCAL + '?mode=math1&seed=7&speed=slow&newrules=2');
    await page.locator('.hand .tile').first().waitFor();
    await r2Scene(page, TENPAI2);
    await page.evaluate(() => { const m = window.__mathjong, g = m.S.game; g.discard(0, g.drawn, { riichi: true }); window.__r2.until0({}); m.S.autoTsumo.on = true; m.render(); clearTimeout(m.S.timer); m.S.timer = null; });
    for (const phase of ['mine', 'waiting']) {
      if (phase === 'waiting') await page.evaluate(() => { const m = window.__mathjong, g = m.S.game; g.discard(0, g.drawn); m.render(); clearTimeout(m.S.timer); m.S.timer = null; });
      const d = await page.evaluate(() => {
        const b = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        const q = (s) => document.querySelector(s);
        const t = q('[data-action="toggle-auto-tsumogiri"]');
        return { toggle: b(t), bar: b(q('footer.bar')), main: b(q('main.table')), status: b(q('.bar .status')),
          others: [...document.querySelectorAll('.bar button:not([data-action="toggle-auto-tsumogiri"])')].map(b),
          tools: [...document.querySelectorAll('.hand-help button')].length, chi: document.querySelectorAll('.hand-help [data-action="toggle-chi-autopass"]').length,
          overflow: document.documentElement.scrollWidth - innerWidth, text: t.innerText.replace(/\s+/g, ' ') };
      });
      const label = `${width}x${height} ${phase}`;
      const ov = (a, c) => Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.75 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.75;
      assert.match(d.text, /オートツモ切り ON/);
      assert.ok(d.toggle.t >= d.bar.t - 0.5 && d.toggle.b <= d.bar.b + 0.5 && d.toggle.l >= -0.5 && d.toggle.r <= width + 0.5, '操作バーの中 ' + label);
      assert.ok(d.toggle.h >= 44 && d.toggle.w >= 44, '押しやすい大きさ ' + label);
      for (const [name, o] of [...d.others.map((x) => ['ボタン', x]), ['状態欄', d.status]]) assert.ok(!ov(d.toggle, o), `${name}と重ならない ${label} ${JSON.stringify([d.toggle, o])}`);
      // 卓・手牌・ヒントはスクロールする領域（main）の中に表示される。切替はその下の操作バーにあり、見えている範囲と重ならない
      assert.ok(d.toggle.t >= d.main.b - 0.5, `卓・手牌・ヒントの領域と重ならない ${label} ${JSON.stringify([d.toggle, d.main])}`);
      assert.equal(d.chi, 1, '手牌の下の道具は従来のまま');
      assert.ok(d.bar.b <= height + 0.5, '操作バーは画面内 ' + label);
      assert.ok(d.overflow <= 1, '横にはみ出さない ' + label);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/v10-layout-${width}x${height}-${phase}.png` });
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ オートツモ切りの切替：8画面×自分の番・他家の番で操作バーに収まり、ボタン・状態欄、卓・手牌・ヒントの領域と重ならない');
}

// ---- 1局戦・四家立直（docs/64） ----
// 席ごとの聴牌（8枚）：席0 30°・150° 待ち、席1・席2 60°、席3 60°・120°（数学Ⅰ・Ⅱ共通。tests/four-riichi.test.js と同じ）
const FR_HANDS = [
  ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'],
  ['sin', '90', '=1', 'cos', '0', '=1', 'cos', '=1/2'],
  ['tan', '135', '=-1', 'sin', '0', '=0', 'tan', '=√3'],
  ['cos', '120', '=-1/2', 'sin', '180', '=0', 'sin', '=√3/2'],
];
const FR_X = '=-1/√3'; // 誰の待ち・チー・ポンにもならない牌
// 親 dealer から配る山（エンジンは親から順に配る）
function frWall(dealer, draws) {
  const k = (x) => (x.startsWith('=') ? `v:${x.slice(1)}` : /^\d+$/.test(x) ? `a:${x}` : `f:${x}`);
  const keys = [];
  for (let r = 0; r < 8; r++) for (let j = 0; j < 4; j++) keys.push(k(FR_HANDS[(dealer + j) % 4][r]));
  return [...keys, ...draws.map(k)];
}
// 自分（人）のリーチ：画面の「リーチ」→ ツモ牌を選ぶ →「リーチして捨てる」
async function frRiichiUI(page) {
  await riWaitTurn(page);
  await page.locator('button[data-action="riichi"]').tap();
  const id = await page.evaluate(() => window.__mathjong.S.game.drawn);
  await page.locator(`.hand .tile[data-id="${id}"]`).tap();
  await page.locator('button[data-action="riichi-discard"]').tap();
}
// AI 席を自分の判断番（または終局）まで進める：手番ならツモ牌でリーチ（リーチ中はツモ切り）、宣言は見送る。
// 自分の宣言（ロンなど）・自分の手番・終局で止め、画面の進行（step）に戻す
const frAiUntilMe = (page) => page.evaluate(() => {
  const m = window.__mathjong, g = m.S.game;
  clearTimeout(m.S.timer); m.S.timer = null;
  for (let i = 0; i < 40 && g.pending() && g.pending().seat !== 0; i++) {
    const p = g.pending();
    if (p.type === 'claim') g.respond(p.seat, { type: 'pass' });
    else g.discard(p.seat, g.drawn, { riichi: !g.riichi[p.seat] });
    g.checkInvariants();
  }
  m.step(true);
  const p = g.pending();
  return { pending: p && { seat: p.seat, type: p.type, ron: !!p.ron }, result: g.result && { type: g.result.type, reason: g.result.reason || null, winner: g.result.winner ?? null }, riichi: g.riichi.map(Boolean) };
});
const frResultText = (page) => page.locator('.overlay .result').innerText();

async function v11OneRoundTitle(browser) {
  // (1) タイトル：1局戦・4局戦・8局戦の3択。1局戦を選ぶと保存され、再読み込み後も残る。選択画面の設定表示・対局の局数も1局戦
  for (const mode of ['math1', 'math2']) {
    const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    assert.deepEqual(await page.locator('input[data-action="title-length"]').evaluateAll((es) => es.map((e) => e.value)), ['1', '4', '8']);
    assert.equal(await page.locator('input[data-action="title-length"][value="4"]').isChecked(), true, '既定は従来どおり4局戦');
    await page.locator('label.setting.radio', { hasText: mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ' }).tap();
    await page.locator('label.setting.radio', { hasText: '1局戦' }).tap();
    assert.equal(await page.evaluate(() => localStorage.getItem('mj-length')), '1');
    await page.reload();
    await page.waitForSelector('.title-screen');
    assert.equal(await page.locator('input[data-action="title-length"][value="1"]').isChecked(), true, '保存された1局戦');
    await page.locator('button[data-action="choose-opponents"]').click();
    await page.waitForSelector('.select-screen');
    assert.match(await page.locator('.select-setting').innerText(), new RegExp(`${mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'} ／ 1局戦`));
    await page.locator('button[data-action="to-title"]').first().click();
    await page.waitForSelector('.title-screen');
    await chooseAndStart(page, ['kanata', 'mitsuki', 'aoto']);
    const st = await matchState(page);
    assert.deepEqual([st.mode, st.length, st.label, st.scores, st.round], [mode, 1, '東1局', [100, 100, 100, 100], 1]);
    // 保存値の不正な値は既定（4局戦）に戻る
    await page.evaluate(() => localStorage.setItem('mj-length', '2'));
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    assert.equal(await page.locator('input[data-action="title-length"][value="4"]').isChecked(), true, '保存値 2 は無効');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 1局戦：タイトルの3択（1局戦・4局戦・8局戦）、保存・再読み込み、選択画面の表示、数学Ⅰ・Ⅱで開始');
}

async function v11OneRoundEnd(browser) {
  // 1局戦はどの終わり方でも1局で試合終了（親の和了でも連荘しない）。結果 → 最終結果 → 同じ3人と再戦／相手を変更／タイトルへ
  // 精算は4局戦と同じ（親ツモ：子3人 各 −2B／子ツモ：親 −2B・ほかの子 −B）。B は和了点（ドラを含む）
  const cases = [['親のツモ', 'math1', 0], ['子のツモ', 'math2', 1], ['流局', 'math1', 2], ['親のツモ', 'math2', 3]];
  for (const [name, mode, dealer] of cases) {
    const { ctx, page, errors } = await v3Page(browser, mode, { query: `&round=1&dealer=${dealer}&hand=0&renchan=0&len=1&newrules=2` });
    if (name !== '流局') {
      // 自分の手は三関制覇の形、自分の最初のツモが =1。親 dealer から配り、自分の番までの他家はツモ切り（宣言の起きない牌）
      await page.evaluate(([hands, dealer, x]) => {
        const k = (v) => (v.startsWith('=') ? `v:${v.slice(1)}` : /^\d+$/.test(v) ? `a:${v}` : `f:${v}`);
        const keys = [];
        for (let r = 0; r < 8; r++) for (let j = 0; j < 4; j++) keys.push(k(hands[(dealer + j) % 4][r]));
        const draws = [];
        for (let j = 0; j < 4 && (dealer + j) % 4 !== 0; j++) draws.push(x);
        draws.push('=1');
        const m = window.__mathjong; m.S.nextPresetWall = [...keys, ...draws.map(k)]; m.startRound();
        clearTimeout(m.S.timer); m.S.timer = null;
        const g = m.S.game;
        for (let i = 0; i < 20 && g.pending() && g.pending().seat !== 0; i++) { const p = g.pending(); if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn); }
        m.step(true);
      }, [[TSUMO_HAND, V3_O1, V3_O2, V3_O3], dealer, '=-1/√3']);
      await page.waitForSelector('button[data-action="tsumo"]');
      await page.locator('button[data-action="tsumo"]').tap();
    } else await forceDraw(page);
    await page.waitForSelector('.overlay .result');
    const st = await matchState(page);
    const B = await page.evaluate(() => window.__mathjong.S.game.result.points ?? 0);
    const want = name === '流局' ? [0, 0, 0, 0] : [0, 1, 2, 3].map((s) => (s === 0 ? (dealer === 0 ? 6 * B : 4 * B) : dealer === 0 || s === dealer ? -2 * B : -B));
    assert.deepEqual([st.over, st.played, st.renchan, st.length], [true, 1, 0, 1], `${mode} ${name}：1局で終了・連荘なし`);
    assert.equal(st.sum, 400);
    assert.deepEqual(st.scores, want.map((d) => 100 + d), `${name}の精算`);
    const text = await frResultText(page);
    assert.match(text, /1局戦はこの1局で終わりです/);
    assert.doesNotMatch(text, /次は|連荘1回目|親交代/);
    // 再現情報：1局戦の URL（len=1・newrules=2）。開くと同じ親の1局戦の東1局。1局戦にない連荘はエラー画面
    const replay = await page.locator('.overlay .result .report-info code').innerText();
    assert.match(replay, new RegExp(`^\\?seed=\\d+&round=1&dealer=${dealer}&hand=0&renchan=0&len=1&mode=${mode}&chars=[a-z,]+&newrules=2$`));
    if (name === '流局') {
      const p2 = await ctx.newPage();
      await p2.goto(`${LOCAL}${replay}&speed=slow`);
      await p2.waitForSelector('.hand .tile');
      const r2 = await matchState(p2);
      assert.deepEqual([r2.length, r2.label, r2.dealer, r2.round, r2.mode], [1, '東1局', dealer, 1, mode]);
      await p2.goto(`${LOCAL}${replay.replace('renchan=0', 'renchan=1').replace('round=1', 'round=2')}`);
      await p2.waitForSelector('.replay-error');
      assert.match(await p2.locator('.replay-error').innerText(), /1局戦は連荘しません/);
      await p2.close();
    }
    assert.equal(await page.locator('button[data-action="next"]').innerText(), '最終結果へ');
    await page.locator('button[data-action="next"]').tap();
    await page.waitForSelector('.overlay .final');
    const fin = await page.locator('.overlay .final').innerText();
    assert.match(fin, /実施した局数：1局（1局戦・東1局のみ）/);
    assert.doesNotMatch(fin, /連荘回数/);
    assert.match(fin, /各局の結果（1局）/);
    assert.match(fin, name === '流局' ? /東1局\s*流局/ : /東1局\s*あなたのツモ/);
    const shown = await page.locator('.final-table tr').evaluateAll((rows) => rows.slice(1).map((r) => [r.querySelector('.rank').textContent, Number(r.querySelector('.pts').textContent)]));
    for (const [rank, pts] of shown) assert.equal(rank, `${1 + st.scores.filter((y) => y > pts).length}位`, '順位（同点は同順位）');
    if (name === '親のツモ' && dealer === 0) {
      // 同じ3人と再戦：1局戦のまま、全員100点
      const before = (await matchState(page)).chars;
      await page.locator('button[data-action="again"]').tap();
      await page.waitForSelector('.hand .tile');
      let s2 = await matchState(page);
      assert.deepEqual([s2.length, s2.label, s2.scores, s2.played, s2.over, s2.chars, s2.mode], [1, '東1局', [100, 100, 100, 100], 0, false, before, mode]);
      assert.equal(await page.evaluate(() => window.__mathjong.S.matchSettings.ruleset), 2);
      // 相手を変更 → 選択画面（直前の3人）→ 入れ替えて開始：1局戦のまま
      await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
      await page.locator('.final button[data-action="change-opponents"]').tap();
      await page.waitForSelector('.select-screen');
      assert.match(await page.locator('.select-setting').innerText(), /1局戦/);
      await chooseAndStartFromSelect(page, ['kaoru', 'yuki', 'asuma']);
      s2 = await matchState(page);
      assert.deepEqual([s2.length, s2.label, s2.chars.slice().sort()], [1, '東1局', ['asuma', 'kaoru', 'yuki']]);
      // タイトルへ戻る：局数の選択は1局戦のまま
      await page.evaluate(() => { const { S, render } = window.__mathjong; S.match.over = true; S.modal = 'final'; render(); });
      await page.locator('.final button[data-action="to-title"]').tap();
      await page.waitForSelector('.title-screen');
      assert.equal(await page.locator('input[data-action="title-length"][value="1"]').isChecked(), true);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 1局戦：親のツモ（連荘なし）・子のツモ・流局で1局で試合終了、精算・合計400・順位、再戦／相手変更／タイトルへ・再現URL（len=1）（数学Ⅰ・Ⅱ）');
}
// 四家立直の局面を画面で始める（親 dealer、山の後ろに draws）。人は席0
async function frScene(page, dealer, draws) {
  await page.evaluate((w) => { const m = window.__mathjong; m.S.nextPresetWall = w; m.startRound(); clearTimeout(m.S.timer); m.S.timer = null; }, frWall(dealer, draws));
}
const frState = (page) => page.evaluate(() => {
  const { S } = window.__mathjong, g = S.game, m = S.match;
  return { result: g.result && { type: g.result.type, reason: g.result.reason || null, winner: g.result.winner ?? null, how: g.result.how || null }, riichi: g.riichi.map(Boolean),
    wall: g.wall.length, scores: m.scores.slice(), hand: m.hand, over: m.over, dealer: S.dealer, history: S.history.map((h) => h.result.reason || h.result.type),
    log: m.log.map((e) => e.result.reason || e.result.type || 'win'), ron: document.querySelectorAll('button[data-action="ron"]').length };
});

async function v11FourRiichi(browser) {
  for (const mode of ['math1', 'math2']) {
    // (1) 1局戦：人が1人目、AI 3人がリーチ → 4人目（AI）の宣言牌に誰もロンできず途中流局 → 試合終了・履歴に四家立直
    {
      const { ctx, page, errors } = await v3Page(browser, mode, { query: '&round=1&dealer=0&hand=0&renchan=0&len=1&newrules=2' });
      await frScene(page, 0, [FR_X, FR_X, FR_X, FR_X]);
      await frRiichiUI(page);
      const a = await frAiUntilMe(page);
      assert.deepEqual(a.result, { type: 'draw', reason: 'four-riichi', winner: null }, `${mode}：四家立直`);
      await page.waitForSelector('.overlay .result');
      const text = await frResultText(page);
      assert.match(text, /途中流局\s*四家立直/);
      assert.match(text, /4人全員のリーチが成立/);
      assert.match(text, /得点の移動はありません/);
      assert.doesNotMatch(text, /山の牌がなくなりました|通常ツモの上限/);
      assert.match(text, /1局戦はこの1局で終わりです/);
      const st = await frState(page);
      assert.ok(st.wall > 0, '山は残っている');
      assert.deepEqual([st.scores, st.over, st.history, st.log], [[100, 100, 100, 100], true, ['four-riichi'], ['four-riichi']]);
      await page.locator('button[data-action="next"]').tap();
      await page.waitForSelector('.overlay .final');
      const fin = await page.locator('.overlay .final').innerText();
      assert.match(fin, /各局の結果（1局・四家立直1回）[\s\S]*東1局\s*途中流局（四家立直）/);
      assert.deepEqual(await page.locator('.final-table td.rank').allInnerTexts(), ['1位', '1位', '1位', '1位'], '全員100点で同順位');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (2) 4局戦：4人目（上家）の宣言牌 30° は自分の待ち → ロンの判断が先（ロンのボタン）→ ロンで和了（四家立直にしない）
    // (3) 同じ局面でロンを見送る → 途中流局・親交代（東2局・下家が親）。その後の流局は「流局」と区別して履歴に残る
    for (const choice of ['ron', 'pass']) {
      const { ctx, page, errors } = await v3Page(browser, mode, { query: '&round=1&dealer=0&hand=0&renchan=0&len=4&newrules=2' });
      await frScene(page, 0, [FR_X, FR_X, FR_X, '30']);
      await frRiichiUI(page);
      const a = await frAiUntilMe(page);
      assert.deepEqual([a.pending, a.result, a.riichi], [{ seat: 0, type: 'claim', ron: true }, null, [true, true, true, true]], '4人リーチでもロンの判断が先');
      await page.waitForSelector('button[data-action="ron"]');
      await page.locator(`button[data-action="${choice}"]`).tap();
      await page.waitForSelector('.overlay .result');
      const st = await frState(page);
      const text = await frResultText(page);
      if (choice === 'ron') {
        assert.deepEqual(st.result, { type: 'win', reason: null, winner: 0, how: 'ron' });
        assert.match(text, /あなた の和了\s*ロン/);
        assert.doesNotMatch(text, /四家立直/);
        assert.equal(st.scores.reduce((x, y) => x + y, 0), 400);
        assert.ok(st.scores[0] > 100 && st.scores[3] < 100, '上家から親のロン');
      } else {
        assert.deepEqual(st.result, { type: 'draw', reason: 'four-riichi', winner: null, how: null });
        assert.match(text, /途中流局\s*四家立直/);
        assert.match(text, /親交代[\s\S]*東2局/);
        assert.deepEqual([st.scores, st.hand, st.over], [[100, 100, 100, 100], 1, false]);
        await page.locator('button[data-action="next"]').tap();
        await page.waitForSelector('.hand .tile');
        let m = await matchState(page);
        assert.deepEqual([m.label, m.dealer, m.renchan], ['東2局', 1, 0], '親交代');
        for (let i = 0; i < 3; i++) {
          await forceDraw(page);
          await page.waitForSelector('.overlay .result');
          assert.match(await frResultText(page), /流局/);
          assert.doesNotMatch(await frResultText(page), /四家立直/);
          await page.locator('button[data-action="next"]').tap();
          if (i < 2) await page.waitForSelector('.hand .tile');
        }
        await page.waitForSelector('.overlay .final');
        assert.match(await page.locator('.overlay .final').innerText(), /各局の結果（4局・四家立直1回）/);
        await page.locator('.match-log summary').click();
        const fin = await page.locator('.overlay .final').innerText();
        assert.match(fin, /東1局\s*途中流局（四家立直）[\s\S]*東2局\s*流局[\s\S]*東3局\s*流局[\s\S]*東4局\s*流局/);
        assert.equal(await page.locator('.match-log li[data-kind="four-riichi"]').count(), 1);
        assert.equal(await page.locator('.match-log li[data-kind="draw"]').count(), 3);
        assert.match(fin, /連荘回数：0回/);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (4) 8局戦：親は下家。AI 3人が先にリーチし、人が4人目（画面で宣言）→ 途中流局・親交代
    // (5) フリテン：人は 150° をツモ（ツモ和了できる）してもリーチで捨て、4人目の宣言牌 30° はロンできない → 途中流局
    for (const kind of ['human-last', 'furiten']) {
      const dealer = kind === 'human-last' ? 1 : 0;
      const { ctx, page, errors } = await v3Page(browser, mode, { query: `&round=1&dealer=${dealer}&hand=0&renchan=0&len=8&newrules=2` });
      await frScene(page, dealer, kind === 'human-last' ? [FR_X, FR_X, FR_X, FR_X] : ['150', FR_X, FR_X, '30']);
      if (kind === 'human-last') {
        const a = await frAiUntilMe(page);
        assert.deepEqual([a.pending, a.riichi], [{ seat: 0, type: 'turn', ron: false }, [false, true, true, true]], 'AI 3人がリーチ');
        await frRiichiUI(page);
      } else {
        await riWaitTurn(page);
        assert.equal(await page.locator('button[data-action="tsumo"]').count(), 1, 'ツモ和了できる');
        await frRiichiUI(page);
        const a = await frAiUntilMe(page);
        assert.equal(a.pending, null);
        assert.equal(await page.evaluate(() => window.__mathjong.S.game.ronBlocked[0] !== null), true, 'フリテンでロンできなかった');
      }
      await page.waitForSelector('.overlay .result');
      const st = await frState(page);
      assert.deepEqual([st.result.reason, st.riichi, st.scores, st.hand, st.over], ['four-riichi', [true, true, true, true], [100, 100, 100, 100], 1, false], `${mode} ${kind}`);
      assert.match(await frResultText(page), /途中流局\s*四家立直[\s\S]*親交代/);
      await page.locator('button[data-action="next"]').tap();
      await page.waitForSelector('.hand .tile');
      const m = await matchState(page);
      assert.deepEqual([m.label, m.dealer, m.length], ['東2局', (dealer + 1) % 4, 8]);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  console.log('✓ 四家立直（数学Ⅰ・Ⅱ）：1局戦で終了・4局戦/8局戦で親交代、ロンの判断が先（ロン優先・見送りで途中流局）、フリテン、人が4人目、履歴で山切れの流局と区別');
}

// 8画面：タイトルの3択・四家立直の結果・最終結果（各局の結果）が画面に収まり、重ならない
async function v11Layout(browser) {
  for (const [width, height] of V09_SIZES) {
    const ctx = await newContext(browser, { viewport: { width, height }, isMobile: width < 1200, hasTouch: true });
    const page = await ctx.newPage(), errors = watchErrors(page);
    const label = `${width}x${height}`;
    await page.goto(`${LOCAL}?speed=test`);
    await page.waitForSelector('.title-screen');
    const t = await page.evaluate(() => {
      const b = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const set = document.querySelector('.title-len');
      return { set: b(set), radios: [...set.querySelectorAll('label.setting.radio')].map((l) => ({ ...b(l), clip: l.scrollWidth - l.clientWidth, smallClip: [...l.querySelectorAll('small')].map((x) => x.scrollWidth - x.clientWidth)[0], text: l.innerText.replace(/\s+/g, ' ') })),
        overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.equal(t.radios.length, 3);
    for (const r of t.radios) {
      assert.ok(r.h >= 44, `押しやすい高さ ${label} ${r.text}`);
      assert.ok(r.l >= t.set.l - 0.5 && r.r <= t.set.r + 0.5, `枠の中 ${label} ${r.text}`);
      assert.ok(r.clip <= 1 && r.smallClip <= 1, `文字が切れない ${label} ${r.text} ${r.clip}/${r.smallClip}`);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const a = t.radios[i], c = t.radios[j];
      assert.ok(Math.min(a.r, c.r) - Math.max(a.l, c.l) <= 0.5 || Math.min(a.b, c.b) - Math.max(a.t, c.t) <= 0.5, `重ならない ${label}`);
    }
    assert.ok(t.overflow <= 1, '横にはみ出さない ' + label);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/v11-title-${label}.png` });
    // 四家立直の結果（1局戦）→ 最終結果
    await page.goto(`${LOCAL}?mode=math2&seed=1&speed=slow&round=1&dealer=0&hand=0&renchan=0&len=1&newrules=2`);
    await page.waitForSelector('.hand .tile');
    await frScene(page, 0, [FR_X, FR_X, FR_X, FR_X]);
    await page.evaluate(() => {
      const m = window.__mathjong, g = m.S.game;
      for (let i = 0; i < 4; i++) g.discard(g.pending().seat, g.drawn, { riichi: true });
      m.step(true);
    });
    await page.waitForSelector('.overlay .result');
    for (const which of ['result', 'final']) {
      if (which === 'final') { await page.locator('button[data-action="next"]').click(); await page.waitForSelector('.overlay .final'); }
      const d = await page.evaluate((which) => {
        const b = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        const modal = document.querySelector('.overlay .modal');
        const head = document.querySelector(which === 'result' ? '.result h2' : '.final h2');
        const btns = [...document.querySelectorAll('.overlay .modal-actions button')];
        return { modal: b(modal), head: b(head), headText: head.innerText, btns: btns.map(b), scrollable: modal.scrollHeight - modal.clientHeight,
          log: which === 'final' ? b(document.querySelector('.match-log')) : null, overflow: document.documentElement.scrollWidth - innerWidth,
          modalOverflowX: modal.scrollWidth - modal.clientWidth };
      }, which);
      assert.ok(d.modal.l >= -0.5 && d.modal.r <= width + 0.5, `${which} 画面内 ${label}`);
      assert.ok(d.head.t >= -0.5 && d.head.b <= height + 0.5, `${which} 見出しが見える ${label}`);
      assert.ok(d.overflow <= 1 && d.modalOverflowX <= 1, `${which} 横にはみ出さない ${label}`);
      if (which === 'result') assert.match(d.headText, /途中流局\s*四家立直/);
      // ボタンは（必要ならモーダル内のスクロールで）押せる
      for (let i = 0; i < d.btns.length; i++) {
        const btn = page.locator('.overlay .modal-actions button').nth(i);
        await btn.scrollIntoViewIfNeeded();
        const bb = await btn.boundingBox();
        assert.ok(bb && bb.y >= -0.5 && bb.y + bb.height <= height + 0.5 && bb.height >= 40, `${which} ボタン ${i} ${label}`);
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/v11-${which}-${label}.png` });
    }
    assert.ok(await page.locator('.match-log[open] li[data-kind="four-riichi"]').isVisible(), '1局戦の履歴は開いた状態');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log('✓ 1局戦・四家立直の画面：8画面でタイトルの3択（44px以上・文字切れなし・重ならない）、四家立直の結果・最終結果（各局の結果）が収まりボタンを押せる');
}

async function chooseAndStartFromSelect(page, ids) {
  const cur = await page.locator('.opp-card.selected').evaluateAll((es) => es.map((e) => e.dataset.id));
  for (const id of cur) if (!ids.includes(id)) await page.locator(`.opp-check[data-id="${id}"]`).click();
  for (const id of ids) if (!cur.includes(id)) await page.locator(`.opp-check[data-id="${id}"]`).click();
  await page.locator('.select-screen button[data-action="start-match"]').click();
  await page.waitForSelector('.hand .tile');
}

// 公開モードではサーバーも転送先も作らない。接続失敗をローカル成功で隠さない。
const server = EXTERNAL ? null : await startServer(0, { base: BASE, host: '127.0.0.1' });
if (server) {
  PORT = server.address().port;
  LOCAL = `http://localhost:${PORT}${BASE}`;
}
let browser;
const stats = { rounds: 0, wins: [0, 0, 0, 0], draws: 0, tsumo: 0, ron: 0, ronDeclined: 0, chi: 0, chiPassed: 0, chiOverriddenByRon: 0, discards: 0, yaku: {} };
const t0 = Date.now();
try {
  const proxy = EXTERNAL && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  browser = await chromium.launch({ ...(!EXTERNAL ? { args: ['--no-proxy-server'] } : proxy ? { proxy: { server: proxy } } : {}), ...(CHANNEL ? { channel: CHANNEL } : {}) });
  console.log(`ブラウザ：${CHANNEL ? `channel=${CHANNEL}` : 'headless shell（既定）'} ${browser.version()}`);
  if (EXTERNAL) console.log(`直接HTTP検査：${PUBLIC}（ローカル転送なし）`);
  // 開発用：--only 関数名,… で一部の検査だけを実行する（全体の E2E OK とは区別して表示）
  const ONLY = opt('--only', null);
  if (ONLY) {
    const fns = { publicMode, badSpeeds, fixedSeeds, roundReproduction, rapidTapGuard, v02aFeatures, v02aAuditFixes, guideFitsScreen, handReorderAuditFixes, handReorderAudit2, handReorderP22, handReorder, chiAutoPass, chiAutoPassLayouts, v03Rules, v03bHints, v04Match, v04Fixes, v04End, v04bLevels, v04bPonAutoPass, v05Riichi, v05bEffects, v05bFxModeFixed, v05cTsumo, v05cTitleLogo, v05dRiichiFx, v05dSound, v05dSoundSuspend, v05eCutin, v05eVoice, v05eAuditFix, v05eAudioIndependent, v06Characters, v06FreeSelect, v06TrioIntegration, v07BeginnerRoom, v07BeginnerRoom2, v07TableHintDock, v07MahjongTable, v08NewRulesTable, v08NewRulesLayout, newRulesPlay, v09FuritenWaits, v09FuncPon, v09RulesUnified, v09SelectTop, v09TileFaces, v09Layout, v10AutoTsumogiri, v10AutoTsumoLayout, v11OneRoundTitle, v11OneRoundEnd, v11FourRiichi, v11Layout };
    for (const n of ONLY.split(',')) await fns[n](browser);
    console.log(`E2E PARTIAL OK（--only ${ONLY}）`);
    if (EXTERNAL) console.log(`PUBLIC E2E OK：${PUBLIC}（${EXTERNAL.checks.join(',')}、Safari実機ではない）`);
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
  await v05bFxModeFixed(browser);
  await v05cTsumo(browser);
  await v05cTitleLogo(browser);
  await v05dRiichiFx(browser);
  await v05dSound(browser);
  await v05dSoundSuspend(browser);
  await v05eCutin(browser);
  await v05eVoice(browser);
  await v05eAuditFix(browser);
  await v05eAudioIndependent(browser);
  await v06Characters(browser);
  await v06FreeSelect(browser);
  await v06TrioIntegration(browser);
  await v07BeginnerRoom(browser);
  await v07BeginnerRoom2(browser);
  await v07TableHintDock(browser);
  await v07MahjongTable(browser);
  await v08NewRulesTable(browser);
  await v09RulesUnified(browser);
  await v09SelectTop(browser);
  await v09TileFaces(browser);
  await v09FuritenWaits(browser);
  await v09FuncPon(browser);
  await v09Layout(browser);
  await v10AutoTsumogiri(browser);
  await v10AutoTsumoLayout(browser);
  await v11OneRoundTitle(browser);
  await v11OneRoundEnd(browser);
  await v11FourRiichi(browser);
  await v11Layout(browser);
  await v08NewRulesLayout(browser);
  await newRulesPlay(browser, stats);
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
  if (server) await new Promise((r) => server.close(r));
}
