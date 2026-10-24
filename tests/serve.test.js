// ローカル HTTP サーバー（tools/serve.mjs）の安全性テスト。秘密情報は使わず、一時ディレクトリのダミーファイルで検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer, resolveRequestPath, RequestError, REPO_ROOT } from '../tools/serve.mjs';

const BASE = '/mathjong/';
let dir, root, outside, server, repoServer;

// 生のリクエスト（パスを一切加工せずに送る）
function get(srv, path, method = 'GET') {
  const { port } = srv.address();
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mj-serve-'));
  root = join(dir, 'site');
  outside = join(dir, 'outside');
  await mkdir(join(root, 'src', 'ui'), { recursive: true });
  await mkdir(join(root, 'src', 'engine'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html>INDEX');
  await writeFile(join(root, 'src', 'ui', 'app.js'), 'APP');
  await writeFile(join(root, 'src', 'ui', 'styles.css'), 'CSS');
  await writeFile(join(root, 'src', 'engine', 'rules.js'), 'RULES');
  await writeFile(join(root, 'src', 'ui', 'notes.md'), 'DUMMY-MD');
  await writeFile(join(root, 'src', 'ui', '.hidden.js'), 'DUMMY-HIDDEN');
  await writeFile(join(root, '.git', 'config'), 'DUMMY-GIT-CONFIG');
  await writeFile(join(root, '.env'), 'DUMMY_ENV=not-a-secret');
  await writeFile(join(root, 'package.json'), '{"dummy":true}');
  await writeFile(join(root, 'tests', 'x.test.js'), 'DUMMY-TEST');
  await writeFile(join(root, 'docs', 'a.md'), 'DUMMY-DOC');
  await writeFile(join(outside, 'outside.js'), 'DUMMY-OUTSIDE');
  // ルート外を指すシンボリックリンク（ファイル・ディレクトリ）
  await symlink(join(outside, 'outside.js'), join(root, 'src', 'ui', 'link.js'));
  await symlink(outside, join(root, 'src', 'ui', 'linkdir'));
  await symlink(outside, join(root, 'src', 'engine-link'));
  // ルート内を指すリンクも配信しない（実体と同じパスでないものは拒否）
  await symlink(join(root, 'src', 'ui', 'app.js'), join(root, 'src', 'ui', 'inner-link.js'));
  server = await startServer(0, { base: BASE, root });
  repoServer = await startServer(0, { base: BASE });
});

after(async () => {
  server.close();
  repoServer.close();
  await rm(dir, { recursive: true, force: true });
});

test('既定では 127.0.0.1 にのみバインドする', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('正常なゲーム用アセットを取得できる', async () => {
  for (const [path, body] of [[BASE, 'INDEX'], [`${BASE}index.html`, 'INDEX'], [`${BASE}?seed=1`, 'INDEX'],
    [`${BASE}src/ui/app.js`, 'APP'], [`${BASE}src/ui/styles.css`, 'CSS'], [`${BASE}src/engine/rules.js`, 'RULES']]) {
    const r = await get(server, path);
    assert.equal(r.status, 200, path);
    assert.ok(r.body.includes(body), path);
  }
  const js = await get(server, `${BASE}src/ui/app.js`);
  assert.match(js.headers['content-type'], /text\/javascript/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  const redirect = await get(server, '/mathjong?seed=3');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/mathjong/?seed=3');
});

test('.git・.env・隠しファイル（URLエンコード含む）を配信しない', async () => {
  const paths = [
    `${BASE}.git/config`, `${BASE}.env`, `${BASE}%2Egit/config`, `${BASE}%2egit%2fconfig`, `${BASE}%2Eenv`,
    `${BASE}src/ui/.hidden.js`, `${BASE}src/ui/%2Ehidden.js`, `${BASE}.git`, `${BASE}.git/`,
  ];
  for (const p of paths) {
    const r = await get(server, p);
    assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.body.includes('DUMMY'), p);
  }
});

test('不要な拡張子・ゲームに不要なファイルを配信しない', async () => {
  for (const p of [`${BASE}package.json`, `${BASE}tests/x.test.js`, `${BASE}docs/a.md`, `${BASE}src/ui/notes.md`, `${BASE}src/`, `${BASE}src/ui/`]) {
    const r = await get(server, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('DUMMY'), p);
  }
});

test('シンボリックリンクを通じたファイル取得を拒否する（ルート外・ルート内とも）', async () => {
  for (const p of [`${BASE}src/ui/link.js`, `${BASE}src/ui/linkdir/outside.js`, `${BASE}src/ui/inner-link.js`]) {
    const r = await get(server, p);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.body.includes('DUMMY') && !r.body.includes('APP'), p);
  }
});

test('.. を含むパス（生・エンコード）を拒否する', async () => {
  const paths = [
    `${BASE}../outside/outside.js`, `${BASE}src/../index.html`, `${BASE}%2e%2e/outside/outside.js`,
    `${BASE}src/%2E%2E/%2E%2E/outside/outside.js`, `${BASE}src/ui/..%2f..%2f..%2foutside/outside.js`,
    `${BASE}..%5c..%5coutside%5coutside.js`, '/../site/index.html',
  ];
  for (const p of paths) {
    const r = await get(server, p);
    assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.body.includes('DUMMY'), p);
  }
});

test('不正な URL エンコードは 400。サーバーは停止せず、直後の正常リクエストも処理する', async () => {
  for (const bad of ['%', '%C0%AF', '%E0%A4%A', '%00', 'src/ui/%', 'src%00/ui/app.js', '%ZZ']) {
    const r = await get(server, `${BASE}${bad}`);
    assert.equal(r.status, 400, bad);
    const ok = await get(server, `${BASE}index.html`);
    assert.equal(ok.status, 200, `after ${bad}`);
  }
});

test('GET/HEAD 以外は 405、HEAD は本文なし', async () => {
  assert.equal((await get(server, `${BASE}index.html`, 'POST')).status, 405);
  const h = await get(server, `${BASE}index.html`, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.body, '');
});

test('resolveRequestPath の単体検査', () => {
  assert.equal(resolveRequestPath('/mathjong/', BASE), 'index.html');
  assert.equal(resolveRequestPath('/mathjong/src/ui/app.js', BASE), 'src/ui/app.js');
  assert.throws(() => resolveRequestPath('/mathjong/%', BASE), (e) => e instanceof RequestError && e.status === 400);
  assert.throws(() => resolveRequestPath('/other/index.html', BASE), (e) => e.status === 404);
});

test('実際のリポジトリ：ゲームのアセットは取得でき、.git や資料は取得できない', async () => {
  for (const p of ['', 'index.html', 'src/ui/app.js', 'src/ui/styles.css', 'src/ui/render.js', 'src/ui/icon.svg',
    'src/engine/rules.js', 'src/engine/game.js', 'src/engine/ai.js', 'src/engine/config.js', 'src/engine/exact.js', 'src/engine/rng.js']) {
    assert.equal((await get(repoServer, `${BASE}${p}`)).status, 200, p);
  }
  for (const p of ['.git/HEAD', '.git/config', 'package.json', 'AGENTS.md', 'README.md', 'docs/01-game-rules.md', 'tests/serve.test.js', 'tools/serve.mjs', 'scripts/legacy/trig_sim.py', '.nojekyll']) {
    const r = await get(repoServer, `${BASE}${p}`);
    assert.equal(r.status, 404, p);
  }
  assert.ok(REPO_ROOT);
});
