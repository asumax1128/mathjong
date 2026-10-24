// 依存なしのローカル静的サーバー（開発・実機テスト用。公開サーバーとしては使わない）。
//   node tools/serve.mjs [port] [--base /mathjong/] [--lan]
// - 既定は 127.0.0.1 のみで待ち受ける。同じ Wi-Fi の iPhone から開くときだけ --lan を付ける。
// - --base を付けると GitHub Pages と同じサブパス（https://<user>.github.io/mathjong/）で配信する。
// - 配信するのはゲームに必要な静的ファイル（index.html と src/ 以下の .js/.css など）だけ。
//   .git・.env・ドキュメント・テスト・シンボリックリンク経由のファイルは配信しない。
import { createServer } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

export const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// 配信を許可するパス（base を除いた相対パス）。これ以外はすべて 404。
const ALLOWED = [
  /^index\.html$/,
  /^src\/(?:engine|ui)\/[a-z0-9][a-z0-9-]*\.(?:js|css|svg|png)$/,
];
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/; // 先頭がドット（隠しファイル）の要素は不可

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// URL のパス部分（base 除去前）を検証し、配信してよい相対パスを返す。不可なら RequestError。
export function resolveRequestPath(rawPath, base = '/') {
  if (rawPath.includes('\\')) throw new RequestError(400, 'backslash');
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new RequestError(400, 'malformed URL encoding');
  }
  if (/[\x00-\x1f\x7f]/.test(path)) throw new RequestError(400, 'control character');
  if (path.includes('\\')) throw new RequestError(400, 'backslash');
  if (!path.startsWith(base)) throw new RequestError(404, 'outside base');
  let rel = path.slice(base.length);
  if (rel === '' ) rel = 'index.html';
  const segments = rel.split('/');
  if (segments.some((s) => s === '.' || s === '..')) throw new RequestError(400, 'dot segment');
  if (!segments.every((s) => SEGMENT.test(s))) throw new RequestError(404, 'hidden or invalid name');
  if (!ALLOWED.some((re) => re.test(rel))) throw new RequestError(404, 'not an allowed asset');
  return rel;
}

// 実体のパスを確認：シンボリックリンクを一切たどらず、ルート内の通常ファイルであること。
async function openSafely(root, rel) {
  const realRoot = await realpath(root);
  const candidate = join(realRoot, ...rel.split('/'));
  let real;
  try {
    real = await realpath(candidate);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new RequestError(404, 'not found');
    throw e;
  }
  const r = relative(realRoot, real);
  if (r === '' || r.startsWith('..' + sep) || r === '..' || isAbsolute(r)) throw new RequestError(403, 'outside root');
  if (real !== candidate) throw new RequestError(403, 'symbolic link');
  const fh = await open(real, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new RequestError(404, 'not a file');
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

function send(res, status, body = '', headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function startServer(port = 8080, { base = '/', host = '127.0.0.1', root = REPO_ROOT, log = null } = {}) {
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base += '/';
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      const rawUrl = req.url || '/';
      const q = rawUrl.indexOf('?');
      const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
      const search = q >= 0 ? rawUrl.slice(q) : '';
      if (!rawPath.startsWith('/')) return send(res, 400, 'bad request');
      // GitHub Pages と同様、/mathjong → /mathjong/ にリダイレクト
      if (base !== '/' && rawPath === base.slice(0, -1)) return send(res, 301, '', { location: base + search });
      const rel = resolveRequestPath(rawPath, base);
      const body = await openSafely(root, rel);
      const type = TYPES[extname(rel)];
      if (!type) return send(res, 404, 'not found');
      send(res, 200, req.method === 'HEAD' ? '' : body, { 'content-type': type });
    } catch (e) {
      if (e instanceof RequestError) return send(res, e.status, e.status === 400 ? 'bad request' : e.status === 403 ? 'forbidden' : 'not found');
      if (log) log(e);
      send(res, 500, 'internal error');
    }
  });
  // 壊れた HTTP リクエストでもプロセスを止めない
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : null; };
  const base = take('--base') || '/';
  const lan = argv.includes('--lan');
  const port = Number(argv.filter((a) => a !== '--lan')[0] || process.env.PORT || 8080);
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  startServer(port, { base, host, log: console.error }).then(() => {
    const path = base.endsWith('/') ? base : base + '/';
    console.log(`MATHJONG: http://localhost:${port}${path}`);
    if (lan) {
      console.log('LAN 公開中（同じネットワークの端末からアクセス可能）。テストが終わったら Ctrl+C で停止してください。');
      for (const a of lanAddresses()) console.log(`  iPhone などから: http://${a}:${port}${path}`);
    } else {
      console.log('このPCからのみアクセスできます。同じ Wi-Fi の iPhone で開くには --lan を付けて起動してください。');
    }
  }, (e) => {
    console.error(`起動できません: ${e.message}`);
    process.exitCode = 1;
  });
}
