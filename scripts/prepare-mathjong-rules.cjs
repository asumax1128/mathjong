// 数雀のオンライン対戦のルール候補を作る（docs/79「5.3」・docs/80「4」）。FACTOR×FACTOR の scripts/prepare-iroyomi-rules.cjs と同じ作法。
// 入力：所有者が Firebase Console から書き出した「現行ルール全文」（JSON）。出力：games/mathjong だけを追加した候補（JSON）。
// ・本番には接続しない（読むのは手元のファイルだけ）。適用は所有者が Console へ貼り付けて行う。
// ・games/mathjong 以外が1文字も変わらないことを deepEqual で確かめる。
// ・既に games/mathjong がある、祖先（rules・games）に広い権限がある、想定と違う形のときは止まる（人の確認が要る）。
// 使い方：node scripts/prepare-mathjong-rules.cjs <現行ルール全文.json> <出力先ディレクトリ>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function prepare(before) {
  if (!before || typeof before !== 'object' || !before.rules || typeof before.rules !== 'object') throw Error('UNEXPECTED_CURRENT_RULES');
  if (!before.rules.games || typeof before.rules.games !== 'object') throw Error('UNEXPECTED_CURRENT_RULES');
  for (const node of [before.rules, before.rules.games]) {
    for (const p of ['.read', '.write']) {
      if (node[p] !== undefined && node[p] !== false && node[p] !== 'false') throw Error('BROAD_ANCESTOR_PERMISSION_REQUIRES_REVIEW');
    }
  }
  if (before.rules.games.mathjong !== undefined) throw Error('EXISTING_MATHJONG_BRANCH_REQUIRES_REVIEW');
  const after = JSON.parse(JSON.stringify(before));
  after.rules.games.mathjong = JSON.parse(JSON.stringify(require('../firebase/mathjong-rules.cjs')));
  const unchanged = JSON.parse(JSON.stringify(after));
  delete unchanged.rules.games.mathjong;
  assert.deepEqual(unchanged, before);
  return after;
}

if (require.main === module) {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) throw Error('Current Console export and private output directory required');
  const before = JSON.parse(fs.readFileSync(input, 'utf8'));
  const after = prepare(before);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(out, 'mathjong-candidate.rules.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
  console.log('Only games/mathjong added; every existing rule preserved; no deployment.');
}

module.exports = { prepare };
