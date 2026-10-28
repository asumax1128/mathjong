// 公開サイトではDOM操作だけの初心者教材検査に限定する。ローカルのテストフックは使わない。
const CHECKS = new Set(['v07BeginnerRoom', 'v07BeginnerRoom2']);

export function publicTarget(args) {
  const i = args.indexOf('--public-url');
  if (i < 0) return null;
  const raw = args[i + 1];
  if (!raw || raw.startsWith('--')) throw new Error('--public-url requires an HTTP(S) URL');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--public-url requires an HTTP(S) base URL without credentials, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const j = args.indexOf('--only');
  const checks = j < 0 ? [] : (args[j + 1] || '').split(',');
  if (!checks.length || checks.some((n) => !CHECKS.has(n)) || new Set(checks).size !== checks.length) {
    throw new Error('--public-url requires --only v07BeginnerRoom,v07BeginnerRoom2 (either or both; no test-hook checks)');
  }
  return { url: url.href, base: url.pathname, checks };
}
