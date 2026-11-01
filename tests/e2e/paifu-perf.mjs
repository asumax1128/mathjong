// 牌譜の保存の前の検証（記録された選択の再生）が主スレッドを止める時間の実測（PR #69 監査の性能ゲート・docs/74）。
// 数学Ⅰ・Ⅱの8局戦の記録を、Chromium で次の3通りに保存し、保存中の主スレッドの最長の停止（4ms ごとの心拍の最大の間隔）と
// 保存の所要時間を測る。CPU の速さは通常と6倍の低速（CDP の CPU スロットリング）。
//   sync：修正前（主スレッドで同期に検証）／worker：修正後（Web Worker で検証）／chunked：Worker が使えないときの代替（主スレッドで分割）
// 使い方：node tests/e2e/paifu-perf.mjs [--out docs/validation/paifu-perf.json]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { startServer } from '../../tools/serve.mjs';
import { playRecorded } from '../paifu-harness.mjs';
import { encodePaifu } from '../../src/engine/paifu.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const server = await startServer(0, { base: '/mathjong/', host: '127.0.0.1' });
const url = `http://localhost:${server.address().port}/mathjong/?speed=test`;
const records = { math1: encodePaifu(playRecorded({ mode: 'math1', length: 8, seedBase: 8101, id: 'perf-m1' }).record),
  math2: encodePaifu(playRecorded({ mode: 'math2', length: 8, seedBase: 8202, id: 'perf-m2' }).record) };
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const results = [];
try {
  for (const rate of [1, 6]) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector('.title-screen');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    for (const [mode, json] of Object.entries(records)) {
      for (const how of ['sync', 'worker', 'chunked']) {
        const r = await page.evaluate(async ({ json, how }) => {
          const pf = await import(new URL('src/engine/paifu.js', location.href));
          const st = await import(new URL('src/ui/paifu-storage.js', location.href));
          const sys = await import(new URL('src/ui/paifu-system.js', location.href));
          const rec = pf.decodePaifu(json);
          const encode = how === 'sync' ? async (p) => pf.encodePaifu(p)
            : how === 'worker' ? sys.createWorkerEncoder({ url: new URL('src/ui/paifu-worker.js', location.href), fallback: (p) => pf.encodePaifuAsync(p) })
              : (p) => pf.encodePaifuAsync(p);
          const store = st.createPaifuStore({ encode });
          const epoch = (await store.clearAll()).epoch;
          if (how === 'worker') await encode(rec); // Worker の起動（モジュールの読込）は1回目だけなので先に済ませる
          // 心拍：4ms ごとのタイマーの最大の間隔＝主スレッドの最長の停止
          let last = performance.now(), maxGap = 0, beats = 0;
          const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; beats++; }, 4);
          await new Promise((res) => setTimeout(res, 50));
          maxGap = 0; last = performance.now();
          const t0 = performance.now();
          const saved = await store.save(rec, { epoch });
          const ms = performance.now() - t0;
          await new Promise((res) => setTimeout(res, 20));
          clearInterval(timer);
          const usingWorker = how === 'worker' && typeof encode.usingWorker === 'function' ? encode.usingWorker() : false;
          await store.clearAll();
          return { ok: saved.ok, saveMs: Math.round(ms), maxMainThreadBlockMs: Math.round(maxGap), beats, usingWorker };
        }, { json, how });
        results.push({ cpu: `${rate}x`, mode, length: 8, bytes: json.length, how, ...r });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
if (out) writeFileSync(out, JSON.stringify({ tool: 'tests/e2e/paifu-perf.mjs', browser: 'Chromium (headless shell)', note: 'CPU 6x は CDP の CPU スロットリング（主スレッドのページ）。iPhone 実機の値ではない', results }, null, 2) + '\n');
