// 振り返りの画面の窓口（src/ui/paifu-review-ui.js）：偽の保存先で、一覧の詳細の読込の排他（画面の作り直しをまたいで同時1件・
// 閉じた画面は続きを読まない・失敗で止まらない）と、閲覧中の同一性の確認（削除・更新・全件削除の後の作り直し）を確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { playRecorded } from './paifu-harness.mjs';
import { decodePaifu, encodePaifu } from '../src/engine/paifu.js';
import { createReviewUI } from '../src/ui/paifu-review-ui.js';

const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const REC = (i, mode = 'math1', length = 1) => decodePaifu(encodePaifu(playRecorded({ mode, length, seedBase: 8800 + i, id: `u-${i}` }).record));

// 偽の保存先：rows（id → { record, token, revision }）・epoch。loadPrivate は gate で止められる。同時の読込数を数える
function fakeSys(records) {
  const rows = new Map(records.map((p, i) => [p.id, { record: p, token: String(i).padStart(32, '0'), revision: 1 }]));
  const s = { epoch: 0, active: 0, max: 0, loads: [], gate: null, failNext: false };
  const meta = (id) => { const r = rows.get(id); return { id, token: r.token, revision: r.revision, savedAt: 1000 - [...rows.keys()].indexOf(id), mode: r.record.settings.mode, length: r.record.settings.length, status: r.record.status, rounds: r.record.rounds.length }; };
  s.rows = rows;
  s.store = {
    list: async () => ({ ok: true, entries: [...rows.keys()].map(meta), unreadable: 0, bytes: 0 }),
    loadPrivate: async (id) => {
      s.active++; s.max = Math.max(s.max, s.active); s.loads.push(id);
      try {
        if (s.gate) { const g = s.gate; s.gate = null; await g; }
        if (s.failNext) { s.failNext = false; throw new Error('boom'); }
        if (!rows.has(id)) return { ok: false, error: { code: 'not-found' } };
        return { ok: true, record: rows.get(id).record, metadata: meta(id), epoch: s.epoch };
      } finally { s.active--; }
    },
    stat: async (id) => (rows.has(id) ? { ok: true, metadata: meta(id), epoch: s.epoch } : { ok: false, error: { code: 'not-found' } }),
  };
  return s;
}

test('一覧の詳細：最初の読込を止めて閉じる → 新しい画面を開く → 再開：古い画面は続きを読まず、同時の読込は最大1件、新しい一覧は全部', async () => {
  const s = fakeSys(Array.from({ length: 10 }, (_, i) => REC(i, i % 2 ? 'math2' : 'math1')));
  let release; s.gate = new Promise((r) => { release = r; });
  const ui1 = createReviewUI({ sys: s });
  ui1.open();
  await settle();
  assert.equal(s.loads.length, 1, '最初の1件が止まっている');
  ui1.close();
  assert.equal(ui1.closed(), true);
  const ui2 = createReviewUI({ sys: s });
  ui2.open();
  await settle();
  assert.equal(s.loads.length, 1, '古い読込が終わるまで新しい画面は読まない（排他）');
  release();
  await settle(200);
  assert.equal(s.max, 1, '同時の読込は最大1件');
  assert.equal(s.loads.length, 11, '古い画面は残り9件を読まない（古い1件＋新しい10件）');
  assert.equal(ui2.debug().details, 10, '新しい一覧は全部');
  assert.doesNotMatch(ui2.html(), /確認中/);
  assert.equal(ui1.handle('pr-more'), false, '閉じた画面は操作を受け付けない');
});

test('一覧の詳細：読込の失敗（例外）で列が止まらない・「さらに表示」の連打でも同時1件', async () => {
  const s = fakeSys(Array.from({ length: 25 }, (_, i) => REC(20 + i)));
  s.failNext = true;
  const ui = createReviewUI({ sys: s });
  ui.open();
  await settle(5);
  ui.handle('pr-more'); ui.handle('pr-more'); ui.handle('pr-more');
  await settle(400);
  assert.equal(s.max, 1);
  assert.equal(ui.debug().details, 24, '失敗した1件以外は要約');
  assert.match(ui.html(), /確認できません/);
});

for (const how of ['update', 'recreate', 'delete']) {
  test(`閲覧中に同じ ID が${{ update: '更新', recreate: '全件削除の後に作り直し', delete: '削除' }[how]}されたら、別の局を開くときに古い記録の局面を出さず一覧へ`, async () => {
    const p = REC(60, 'math1', 4);
    const s = fakeSys([p]);
    const ui = createReviewUI({ sys: s });
    ui.open();
    await settle(100);
    ui.handle('pr-pick', { id: p.id });
    await settle(200);
    assert.equal(ui.debug().view, 'viewer');
    assert.ok(p.rounds.length > 1);
    const row = s.rows.get(p.id);
    if (how === 'update') { row.record = REC(61, 'math2', 1); row.record = { ...row.record, id: p.id }; row.token = 'f'.repeat(32); row.revision = 2; }
    if (how === 'recreate') { s.epoch = 1; row.token = 'e'.repeat(32); row.revision = 1; }
    if (how === 'delete') s.rows.delete(p.id);
    ui.handle('pr-round', { round: 1 });
    await settle(200);
    assert.equal(ui.debug().view, 'list', '古い局面を出さない');
    assert.match(ui.html(), { update: /別のタブで更新されました/, recreate: /同じ番号で別の牌譜/, delete: /削除されました/ }[how]);
  });
}

test('閲覧中：同じ保存のまま（トークンが同じ）なら局を切り替えられる。DB の一時的な失敗では表示を続ける', async () => {
  const p = REC(62, 'math2', 4);
  const s = fakeSys([p]);
  const ui = createReviewUI({ sys: s });
  ui.open(); await settle(100);
  ui.handle('pr-pick', { id: p.id }); await settle(200);
  ui.handle('pr-round', { round: 1 }); await settle(200);
  assert.deepEqual([ui.debug().view, ui.debug().ri], ['viewer', 1]);
  s.store.stat = async () => ({ ok: false, error: { code: 'timeout' } });
  ui.handle('pr-round', { round: 0 }); await settle(200);
  assert.deepEqual([ui.debug().view, ui.debug().ri], ['viewer', 0]);
});
