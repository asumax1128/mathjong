import test from 'node:test';
import assert from 'node:assert/strict';
import { publicTarget } from './e2e/public-target.mjs';

test('公開E2E：通常コマンドのローカル配信モードを維持', () => {
  assert.equal(publicTarget([]), null);
  assert.equal(publicTarget(['--only', 'v05Riichi']), null);
});

test('公開E2E：初心者教材のDOM検査だけを許可し、URLのサブパスを維持', () => {
  assert.deepEqual(publicTarget(['--public-url', 'https://asumax1128.github.io/mathjong', '--only', 'v07BeginnerRoom,v07BeginnerRoom2']), {
    url: 'https://asumax1128.github.io/mathjong/', base: '/mathjong/', checks: ['v07BeginnerRoom', 'v07BeginnerRoom2'],
  });
  assert.equal(publicTarget(['--public-url', 'http://127.0.0.2:8080/', '--only', 'v07BeginnerRoom2']).base, '/');
});

test('公開E2E：フック依存検査・全体実行・重複・不正URLを拒否し、ローカルへ代替しない', () => {
  for (const only of [null, '', 'v05Riichi', 'v07BeginnerRoom,v06FreeSelect', 'v07BeginnerRoom2,v07BeginnerRoom2']) {
    assert.throws(() => publicTarget(['--public-url', 'https://asumax1128.github.io/mathjong/', ...(only === null ? [] : ['--only', only])]), /requires --only/);
  }
  for (const url of ['file:///tmp/index.html', 'https://user:pass@example.com/', 'https://example.com/?seed=1', 'https://example.com/#local', '--only']) {
    assert.throws(() => publicTarget(['--public-url', url, '--only', 'v07BeginnerRoom2']), /HTTP\(S\)/);
  }
  assert.throws(() => publicTarget(['--public-url']), /requires an HTTP/);
});
