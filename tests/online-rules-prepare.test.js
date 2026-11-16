// ルール候補作成スクリプト（scripts/prepare-mathjong-rules.cjs）の試験。本番には接続しない（手元の JSON だけ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { prepare } = require('../scripts/prepare-mathjong-rules.cjs');
const fragment = require('../firebase/mathjong-rules.cjs');

// 他ゲームの枝を持つ「現行ルール全文」の見本（所有者の書き出しを模したもの）
const current = () => ({
  rules: {
    games: {
      factor: { rooms: { $code: { '.read': 'auth != null', '.write': 'auth != null' } } },
      iroyomi: { rooms: { $code: { '.read': 'auth != null', '.write': 'auth != null', '.validate': "newData.hasChildren(['host'])" } } },
    },
    users: { $uid: { '.read': 'auth.uid === $uid' } },
  },
});

test('games/mathjong だけを追加し、他は1文字も変えない', () => {
  const before = current();
  const snapshot = JSON.stringify(before);
  const after = prepare(before);
  assert.equal(JSON.stringify(before), snapshot, '入力を書き換えない');
  assert.deepEqual(after.rules.games.mathjong, JSON.parse(JSON.stringify(fragment)));
  const rest = JSON.parse(JSON.stringify(after));
  delete rest.rules.games.mathjong;
  assert.deepEqual(rest, before);
});

test('想定外の形・既存の mathjong・祖先の広い権限では止まる', () => {
  assert.throws(() => prepare(null), /UNEXPECTED_CURRENT_RULES/);
  assert.throws(() => prepare({ rules: {} }), /UNEXPECTED_CURRENT_RULES/);
  const withBranch = current(); withBranch.rules.games.mathjong = {};
  assert.throws(() => prepare(withBranch), /EXISTING_MATHJONG_BRANCH_REQUIRES_REVIEW/);
  const broad = current(); broad.rules['.read'] = 'auth != null';
  assert.throws(() => prepare(broad), /BROAD_ANCESTOR_PERMISSION_REQUIRES_REVIEW/);
  const broadGames = current(); broadGames.rules.games['.write'] = true;
  assert.throws(() => prepare(broadGames), /BROAD_ANCESTOR_PERMISSION_REQUIRES_REVIEW/);
  const closed = current(); closed.rules['.read'] = false;
  assert.ok(prepare(closed).rules.games.mathjong, 'false は広い権限ではない');
});

test('CLI：入力パスと出力先を引数で受け、候補を書き出す（0600）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mj-rules-'));
  const input = join(dir, 'current.json');
  writeFileSync(input, JSON.stringify(current()));
  const out = join(dir, 'out');
  const msg = execFileSync(process.execPath, ['scripts/prepare-mathjong-rules.cjs', input, out], { encoding: 'utf8' });
  assert.match(msg, /Only games\/mathjong added/);
  const file = join(out, 'mathjong-candidate.rules.json');
  const cand = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(cand.rules.games.mathjong.rooms.$code);
  assert.deepEqual(cand.rules.games.factor, current().rules.games.factor);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => execFileSync(process.execPath, ['scripts/prepare-mathjong-rules.cjs'], { stdio: 'pipe' }));
});

test('断片の方針：rooms/$code に読取を付けない・config は書けない・ルールセット2固定', () => {
  const $code = fragment.rooms.$code;
  assert.equal($code['.read'], undefined);
  assert.equal(fragment.config['.write'], false);
  assert.equal($code.meta.ruleset['.validate'], 'newData.val() === 2');
  assert.deepEqual($code.$other, { '.validate': false });
  assert.match($code.priv.$seat['.read'], /auth\.uid/);
});
