// 牌譜の機能の入口（src/ui/paifu-system.js）と非同期の検証（PR #69 監査の性能改善・P2-3）：
// ・主スレッドの検証（verifyPaifuAsync・encodePaifuAsync）は同期の検証と同じ結果で、途中でイベントループへ戻る（検証は省略しない）
// ・Worker の encode：成功・検証エラー・Worker のエラー・時間切れ・作れない場合は主スレッドの検証へ切り替える
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPaifu, verifyPaifuAsync, encodePaifu, encodePaifuAsync, encodePaifuSnapshot, encodePaifuSnapshotAsync, takePaifuSnapshot, PaifuError } from '../src/engine/paifu.js';
import { createWorkerEncoder, createPaifuSystem } from '../src/ui/paifu-system.js';
import { playRecorded } from './paifu-harness.mjs';

const { record } = playRecorded({ mode: 'math2', length: 8, seedBase: 7070 });
const snap = takePaifuSnapshot(record); // Worker・代替の encode の入力は保存の開始時のスナップショット（文字列）

test('非同期の検証：同期の検証と同じ結果・同じ JSON。予算ごとに処理を区切り（pause が呼ばれる）、検証は省略しない', async () => {
  let pauses = 0, t = 0;
  const v = await verifyPaifuAsync(record, { budgetMs: 1, pause: async () => { pauses++; }, now: () => (t += 1) });
  assert.deepEqual(v, verifyPaifu(record));
  assert.ok(pauses > record.rounds.length, `区切り ${pauses} 回`);
  assert.equal(await encodePaifuAsync(record), encodePaifu(record));
  // 改ざんは非同期でも拒否
  const bad = JSON.parse(JSON.stringify(record));
  bad.rounds.at(-1).steps.at(-1).digest = '0000000000000000';
  await assert.rejects(verifyPaifuAsync(bad, { pause: async () => {} }), (e) => e instanceof PaifuError && /digest/.test(e.message));
  await assert.rejects(encodePaifuAsync(bad), PaifuError);
});

// 偽の Worker：postMessage を受けて、mode に応じて返事・エラー・無応答
function fakeWorker(mode) {
  return () => {
    const w = { posted: 0, terminated: false, postMessage(msg) {
      w.posted++;
      queueMicrotask(() => {
        if (mode === 'ok') w.onmessage({ data: { id: msg.id, ok: true, json: encodePaifuSnapshot(msg.snapshot) } });
        else if (mode === 'invalid') w.onmessage({ data: { id: msg.id, ok: false, path: 'rounds.0.steps.0.digest', message: 'mismatch' } });
        else if (mode === 'error') w.onerror({ preventDefault() {} });
        // 'silent'：返事をしない（時間切れ）
      });
    }, terminate() { w.terminated = true; } };
    fakeWorker.last = w;
    return w;
  };
}

test('Worker の encode：成功は Worker の結果。検証エラーは呼び出し元へ（保存しない）', async () => {
  let fb = 0;
  const enc = createWorkerEncoder({ url: 'x', fallback: async (x) => { fb++; return encodePaifuSnapshot(x); }, makeWorker: fakeWorker('ok') });
  assert.equal(await enc(snap), encodePaifu(record));
  assert.equal(fb, 0);
  assert.equal(enc.usingWorker(), true);
  const enc2 = createWorkerEncoder({ url: 'x', fallback: async () => { fb++; return 'never'; }, makeWorker: fakeWorker('invalid') });
  await assert.rejects(enc2(snap), (e) => e.path === 'rounds.0.steps.0.digest');
  assert.equal(fb, 0, '検証エラーは主スレッドでやり直さない（同じ結果になるため）');
});

for (const mode of ['error', 'silent', 'throw']) {
  test(`Worker の encode：${mode === 'throw' ? 'Worker を作れない' : mode === 'error' ? 'Worker のエラー（読込・構文エラーなど）' : '時間切れ'}なら主スレッドの検証へ切り替え、以後も主スレッドで行う`, async () => {
    let fb = 0;
    const make = mode === 'throw' ? () => { throw new Error('no worker'); } : fakeWorker(mode);
    const enc = createWorkerEncoder({ url: 'x', timeoutMs: 20, fallback: async (x) => { fb++; return encodePaifuSnapshotAsync(x); }, makeWorker: make });
    assert.equal(await enc(snap), encodePaifu(record));
    assert.equal(fb, 1);
    assert.equal(await enc(snap), encodePaifu(record));
    assert.equal(fb, 2, '以後も主スレッド');
    assert.equal(enc.usingWorker(), false);
    if (mode !== 'throw') assert.equal(fakeWorker.last.terminated, true);
  });
}

test('入口：起動時に削除の世代を読む。読めなければ（保存できない端末）error を持ち、全件削除で世代を進めて覚える', async () => {
  let epoch = 3, fail = false;
  const store = { epoch: async () => (fail ? { ok: false, error: { code: 'unavailable' } } : { ok: true, epoch }),
    clearAll: async () => { epoch++; return { ok: true, cleared: true, epoch }; }, list: async () => ({ ok: true, entries: [] }), save: async () => ({ ok: true }) };
  const sys = createPaifuSystem({ appVersion: '0.7.0', store, useWorker: false });
  await sys.ready;
  assert.deepEqual(sys.epochState(), { epoch: 3, error: null });
  const r = await sys.clearAll();
  assert.equal(r.epoch, 4);
  assert.equal(sys.epochState().epoch, 4);
  fail = true;
  const sys2 = createPaifuSystem({ appVersion: '0.7.0', store, useWorker: false });
  await sys2.ready;
  assert.deepEqual(sys2.epochState(), { epoch: null, error: 'unavailable' });
  assert.equal(sys2.describe({ state: 'off', reason: 'storage-unavailable' }).kind, 'not-recorded');
  sys.close(); sys2.close();
});
