// 依存なしの簡易静的サーバー。 node tools/serve.mjs [port] [--base /mathjong/]
// （ES モジュールは file:// では読み込めないため、ローカルでは HTTP で配信する）
// --base を付けると GitHub Pages と同じサブパス（https://<user>.github.io/mathjong/）で配信し、相対パスを検証できる。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const cliBase = baseIdx >= 0 ? argv.splice(baseIdx, 2)[1] : '/';
const port = Number(argv[0] || process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

export function startServer(p = port, { base = '/' } = {}) {
  if (!base.endsWith('/')) base += '/';
  const server = createServer(async (req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // GitHub Pages と同様、/mathjong → /mathjong/ にリダイレクト
    if (base !== '/' && pathname === base.slice(0, -1)) {
      res.writeHead(301, { location: base + new URL(req.url, 'http://x').search });
      return res.end();
    }
    if (!pathname.startsWith(base)) { res.writeHead(404); return res.end('not found'); }
    pathname = '/' + pathname.slice(base.length);
    const path = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(p, '0.0.0.0', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(port, { base: cliBase }).then(() => {
    console.log(`MATHJONG: http://localhost:${port}${cliBase.endsWith('/') ? cliBase : cliBase + '/'}`);
    console.log('同じ Wi-Fi のスマホからは http://<このPCのIPアドレス>:' + port + '/ で開けます');
  });
}
