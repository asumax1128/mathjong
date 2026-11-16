// オンライン対戦 段階3：実画面での長い試合と再戦の E2E（docs/79「9.3」）。エミュレータ（demo- プロジェクト）だけ。
//  ・4つのブラウザコンテキスト（人間4人・CPU なし）で4局戦を画面の操作だけで完走し、全端末で持ち点・順位が一致する
//  ・最終結果の「もう一戦」：ゲスト2人が押し、1人は押さずに部屋を出る。ホストが押すと、押した人とホストだけでロビーに戻り（matchNo を進める）、
//    2試合目を開始できる。押さなかった人は部屋から抜ける
// 8局戦は段階2の単体の通し（tests/online-host.test.js）で確かめている。
// 実行：firebase emulators:exec --only auth,database --project demo-mathjong --config firebase.emulator.json "node tests/e2e/online-long.mjs"
import assert from 'node:assert/strict';
import { setup, enter, createRoomUI, joinUI, onlineState, playUntil, waitScreen, owner, shotter, argOf } from './online-helpers.mjs';

const shot = shotter(argOf('--shots'));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const env = await setup({ extra: '&onlineCpuDelay=0' });

try {
  const names = ['ホスト', 'ゲスト1', 'ゲスト2', 'ゲスト3'];
  const P = [];
  for (let i = 0; i < 4; i++) P.push(await env.newCtx(i === 3 ? { width: 1366, height: 768 } : { width: 390, height: 844 }));
  await enter(P[0].page, env.url(), names[0]);
  const code = await createRoomUI(P[0].page, { length: 4, mode: 'math1' });
  for (let i = 1; i < 4; i++) { await enter(P[i].page, env.url(), names[i]); await joinUI(P[i].page, code); }
  await P[0].page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  assert.equal(await P[0].page.locator('select[data-action="ol-cpu"]').count(), 0, '満席なので CPU の枠はない');
  await P[0].page.click('[data-action="ol-start"]');
  for (const x of P) await x.page.waitForSelector('.self', { timeout: 20000 });
  const seats = new Set();
  for (const x of P) seats.add((await onlineState(x.page)).mySeat);
  assert.equal(seats.size, 4, '4人が別々の席');
  ok('4コンテキスト（人間4人）で4局戦を開始');

  const t0 = Date.now();
  await playUntil(P.map((x) => x.page), null, { timeoutMs: 900000 });
  const states = [];
  for (const x of P) states.push(await onlineState(x.page));
  for (const s of states) assert.equal(s.pub.phase, 'final');
  for (const s of states.slice(1)) assert.deepEqual(s.pub.match.scores, states[0].pub.match.scores, '全端末の持ち点が一致');
  assert.equal(states[0].pub.match.scores.reduce((a, b) => a + b, 0), 400);
  assert.ok(states[0].pub.match.played >= 4);
  // 画面の最終結果：各自の順位・得点が配信と一致
  for (let i = 0; i < 4; i++) {
    const st = states[i];
    const pts = st.pub.match.scores[st.mySeat];
    const rank = 1 + st.pub.match.scores.filter((x) => x > pts).length;
    const me = await P[i].page.textContent('.final-me');
    assert.ok(me.includes(`${rank}位`) && me.includes(`${pts}点`), `画面の順位：${me}`);
  }
  ok(`4局戦を4コンテキストの画面操作だけで完走（${states[0].pub.match.played}局・${Math.round((Date.now() - t0) / 1000)}秒）。全端末で持ち点 ${states[0].pub.match.scores.join('・')}・順位が一致`);
  await shot(P[3].page, 'long-final-desktop');
  await shot(P[1].page, 'long-final-phone');

  // ---- 再戦：ゲスト1・2は「もう一戦」、ゲスト3は部屋を出る。ホストが押すとロビーへ ----
  await P[1].page.click('[data-action="online-rematch"]');
  await P[2].page.click('[data-action="online-rematch"]');
  await P[1].page.waitForSelector('[data-action="online-rematch"][disabled]');
  await P[3].page.click('[data-action="online-leave"]');
  await waitScreen(P[3].page, 'menu');
  await P[0].page.waitForFunction(() => /2人が参加/.test(document.querySelector('[data-action="online-rematch"]').textContent), null, { timeout: 20000 });
  ok('最終結果の「もう一戦」：押した人数がホストに見える。押さない人は部屋を出られる');
  await P[0].page.click('[data-action="online-rematch"]');
  for (const i of [0, 1, 2]) await waitScreen(P[i].page, 'lobby');
  const meta = await owner('GET', `games/mathjong/rooms/${code}/meta`);
  assert.equal(meta.status, 'lobby');
  assert.equal(meta.matchNo, 1, 'matchNo を進める');
  const roomSeats = await owner('GET', `games/mathjong/rooms/${code}/seats`);
  const kept = Object.values(roomSeats).map((x) => x.name);
  assert.equal(kept[0], names[0], 'ホストが席0');
  assert.deepEqual(kept.slice().sort(), [names[0], names[1], names[2]].sort(), 'もう一戦の人とホストだけ（並びは前の試合の席の順）');
  assert.equal(await owner('GET', `games/mathjong/rooms/${code}/pub`), null, '前の試合の配信は消える');
  ok('再戦：押した人とホストだけでロビーへ戻る（matchNo 1・前の試合の pub/host を消す）');
  await shot(P[0].page, 'long-rematch-lobby');

  // 2試合目を開始できる（空いた1席は CPU）
  await P[0].page.waitForSelector('[data-action="ol-start"]:not([disabled])');
  await P[0].page.click('[data-action="ol-start"]');
  for (const i of [0, 1, 2]) await P[i].page.waitForSelector('.self', { timeout: 20000 });
  const s2 = await onlineState(P[1].page);
  assert.equal(s2.pub.phase, 'play');
  assert.equal(s2.pub.round, 1, '新しい試合の東1局から');
  assert.deepEqual(s2.pub.match.scores, [100, 100, 100, 100], '持ち点は全員100から');
  assert.equal(s2.pub.players.filter((p) => p.kind === 'cpu').length, 1);
  ok('2試合目を開始（同じ長さ・全員100点から・空いた席は CPU）');

  for (const x of P) assert.deepEqual(x.errors, [], 'ページのエラーなし');
  ok('全端末でページのエラーなし');
  console.log(`✓ オンライン 4人で4局戦・再戦 E2E：${passed}件すべて合格`);
} finally {
  await env.close();
}
