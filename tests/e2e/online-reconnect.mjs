// オンライン対戦 段階3：切断と復帰の E2E（docs/79「8」）。エミュレータ（demo- プロジェクト）だけ。
//  A. ゲストの切断：タブを閉じると10秒程度で代打ち（全員の画面に「代打ち」）。試合は止まらない。同じ端末で開き直すと自分の席に戻って操作できる
//  B. ホストの再読み込み：ゲストに「ホストの復帰を待っています（残り時間）」。ホストが開き直すと記録の再生で同じ局面から再開し、そのまま完走。
//     両端末で持ち点・順位が一致
//  C. ホストが戻らない：猶予（試験用に ?onlineHostGraceMs= で短縮）を過ぎると、ゲストに「途中終了（結果は確定しません）」
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/e2e/online-reconnect.mjs"
import assert from 'node:assert/strict';
import { setup, enter, createRoomUI, joinUI, onlineState, playUntil, stepOnce, waitScreen, owner, shotter, argOf, watchRiichiFlash, assertRiichiFlashed } from './online-helpers.mjs';

const shot = shotter(argOf('--shots'));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const env = await setup({ extra: '&onlineCpuDelay=150' });

try {
  // ---- A・B：ホスト＋ゲスト＋CPU 2人で4局戦 ----
  const H = await env.newCtx();
  const G = await env.newCtx();
  await enter(H.page, env.url(), 'ホスト');
  const code = await createRoomUI(H.page, { length: 4 });
  await enter(G.page, env.url(), 'ゲスト');
  await joinUI(G.page, code);
  await H.page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  await H.page.click('[data-action="ol-start"]');
  await H.page.waitForSelector('.self', { timeout: 20000 });
  await G.page.waitForSelector('.self', { timeout: 20000 });
  const g0 = await onlineState(G.page);
  const gSeat = g0.mySeat;
  await watchRiichiFlash(G.page); // 画面 0.7.4：ゲストの画面でリーチ宣言の席が光るか
  await playUntil([H.page, G.page], async () => ((await onlineState(H.page)) || { pub: { game: { events: [] } } }).pub.game.events.length > 25);

  const rf1 = await assertRiichiFlashed(G.page, 'ゲスト');
  ok(`ゲストの画面：リーチを宣言した席はすべて名札が光った（宣言 ${rf1} 件）`);
  // A. ゲストがタブを閉じる
  await G.page.close();
  const tClose = Date.now();
  let awayAt = null;
  await playUntil([H.page], async () => {
    const s = await onlineState(H.page);
    if (s && s.pub.players[gSeat].away) { awayAt = Date.now(); return true; }
    return false;
  }, { timeoutMs: 60000 });
  const sec = (awayAt - tClose) / 1000;
  assert.ok(sec >= 8 && sec <= 25, `切断から代打ちまで ${sec.toFixed(1)} 秒（10秒程度）`);
  const seats = await owner('GET', `games/mathjong/rooms/${code}/seats`);
  assert.equal(seats[gSeat].away, true, 'seats に away');
  await H.page.waitForFunction(() => document.body.textContent.includes('（代打ち）'));
  ok(`ゲストの切断：${sec.toFixed(1)} 秒で離席・代打ち（ホストの画面に「代打ち」）`);
  // 代打ちで試合が止まらない：ゲストの席の打牌が増える
  const before = (await onlineState(H.page)).pub.game;
  const countSeat = (g) => (g.events || []).filter((e) => e.type === 'discard' && e.seat === gSeat).length;
  const n0 = countSeat(before);
  const round0 = (await onlineState(H.page)).pub.round;
  await playUntil([H.page], async () => { const s = await onlineState(H.page); return s && (s.pub.round > round0 || countSeat(s.pub.game) >= n0 + 2); }, { timeoutMs: 90000 });
  ok('代打ちが打って試合が止まらない');
  await shot(H.page, 'reconnect-host-proxy');

  // 同じ端末（同じコンテキスト）で開き直すと、自分の席に戻る
  const gp = await G.open();
  await gp.goto(env.url());
  await gp.click('[data-action="online-open"]');
  await gp.waitForSelector('.self', { timeout: 30000 });
  const back = await onlineState(gp);
  assert.equal(back.mySeat, gSeat, '自分の席に戻る');
  await H.page.waitForFunction((s) => { const o = window.__mathjong.S.online; return o && o.pub && !o.pub.players[s].away; }, gSeat, { timeout: 30000 });
  assert.equal((await owner('GET', `games/mathjong/rooms/${code}/seats/${gSeat}/away`)), null, 'away が消える');
  ok('同じ端末で開き直すと自分の席に戻り、代打ちが止まる');
  await watchRiichiFlash(gp);
  // 戻った後は自分で操作できる（ゲストの手で打牌が届く）
  const humanBefore = (await onlineState(gp)).pub.game.events.length;
  let gActed = false;
  await playUntil([H.page, gp], async () => {
    if (!gActed) { const r = await stepOnce(gp); if (r === 'discard') gActed = true; }
    const s = await onlineState(H.page);
    return gActed && s && s.pub.game.events.length > humanBefore;
  }, { timeoutMs: 120000 });
  assert.ok(gActed, 'ゲストが自分で打牌した');
  ok('戻った後は自分で操作できる');

  // B. ホストの再読み込み
  const hb = await onlineState(H.page);
  const beforeEvents = hb.pub.game.events;
  const beforeScores = hb.pub.match.scores;
  const beforeRound = hb.pub.round;
  await H.page.reload();
  await gp.waitForSelector('.ol-host-wait', { timeout: 30000 });
  const left = Number(await gp.textContent('.ol-host-left'));
  assert.ok(left > 60 && left <= 90, `残り ${left} 秒`);
  assert.equal((await owner('GET', `games/mathjong/rooms/${code}/meta/status`)), 'paused');
  ok(`ホストの切断：ゲストに「ホストの復帰を待っています（残り ${left} 秒）」・meta は paused`);
  await shot(gp, 'reconnect-guest-hostwait');
  await H.page.click('[data-action="online-open"]');
  await H.page.waitForSelector('.self', { timeout: 30000 });
  const ha = await onlineState(H.page);
  assert.equal(ha.pub.round, beforeRound, '同じ局');
  assert.deepEqual(ha.pub.game.events.slice(0, beforeEvents.length), beforeEvents, '同じ局面から（記録の再生）');
  assert.deepEqual(ha.pub.match.scores, beforeScores, '同じ持ち点');
  await gp.waitForSelector('.ol-host-wait', { state: 'detached', timeout: 30000 });
  assert.equal((await owner('GET', `games/mathjong/rooms/${code}/meta/status`)), 'playing');
  ok('ホストが開き直すと、記録の再生で同じ局面から再開（ゲストの待ちの表示も消える）');

  await playUntil([H.page, gp], null, { timeoutMs: 420000 });
  const hf = await onlineState(H.page);
  const gf = await onlineState(gp);
  assert.equal(hf.pub.phase, 'final');
  assert.deepEqual(gf.pub.match.scores, hf.pub.match.scores, '両端末の持ち点が一致');
  assert.ok(hf.pub.match.played >= 4);
  const rf2 = await assertRiichiFlashed(gp, 'ゲスト（再接続後）');
  ok(`再接続後のゲストの画面：リーチを宣言した席はすべて名札が光った（宣言 ${rf2} 件）`);
  ok(`再開後もそのまま4局戦を完走（${hf.pub.match.played}局・持ち点 ${hf.pub.match.scores.join('・')}）`);
  await shot(gp, 'reconnect-final-guest');
  await H.page.click('[data-action="online-leave"]');
  await waitScreen(gp, 'closed');

  // ---- C. ホストが戻らない（猶予を試験用に3秒へ短縮）----
  const H2 = await env.newCtx();
  const G2 = await env.newCtx();
  const quick = env.url('&onlineHostGraceMs=3000');
  await enter(H2.page, quick, 'ホスト2');
  const code2 = await createRoomUI(H2.page, { length: 1 });
  await enter(G2.page, quick, 'ゲスト2');
  await joinUI(G2.page, code2);
  await H2.page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  await H2.page.click('[data-action="ol-start"]');
  await G2.page.waitForSelector('.self', { timeout: 20000 });
  await H2.page.close();
  await G2.page.waitForSelector('.ol-host-wait', { timeout: 30000 });
  await G2.page.waitForSelector('.ol-host-ended', { timeout: 30000 });
  assert.match(await G2.page.textContent('.ol-host-ended'), /途中で終了.*結果は確定しません/s);
  ok('ホストが猶予内に戻らないと、ゲストに「途中終了（結果は確定しません）」');
  await shot(G2.page, 'reconnect-guest-ended');
  // 猶予を過ぎてからホストが開き直しても続きはせず、部屋を閉じる
  const hp2 = await H2.open();
  await hp2.goto(quick);
  await hp2.click('[data-action="online-open"]');
  await waitScreen(hp2, 'closed');
  assert.equal(await hp2.getAttribute('.ol-closed', 'data-reason'), 'host-timeout');
  assert.equal(await owner('GET', `games/mathjong/rooms/${code2}`), null);
  ok('猶予を過ぎて戻ったホストは続けず、部屋を閉じる');

  for (const x of [H, G, H2, G2]) assert.deepEqual(x.errors, [], 'ページのエラーなし');
  ok('全端末でページのエラーなし');
  console.log(`✓ オンライン 切断と復帰 E2E：${passed}件すべて合格`);
} finally {
  await env.close();
}
