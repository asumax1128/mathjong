// 三角関数の有名角の値を「(p/q)·√r」の厳密な形で計算する。
// 文字列表記ではなく、この正規化された値で面子の正誤を判定する。

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

// √r の平方因子を外へ出し、符号を分子に寄せ、約分する。
export function normalize(p, q, r) {
  if (q === 0) throw new Error('zero denominator');
  if (p === 0) return { p: 0, q: 1, r: 1 };
  for (let k = 2; k * k <= r; k++) {
    while (r % (k * k) === 0) { r /= k * k; p *= k; }
  }
  if (q < 0) { p = -p; q = -q; }
  const g = gcd(p, q);
  return { p: p / g, q: q / g, r };
}

export const exact = (p, q = 1, r = 1) => normalize(p, q, r);
export const neg = (x) => normalize(-x.p, x.q, x.r);
export const key = (x) => `${x.p}/${x.q}r${x.r}`;
export const equals = (x, y) => key(x) === key(y);
export const toNumber = (x) => (x.p / x.q) * Math.sqrt(x.r);

// x / y を厳密に計算。y=0 のときは null（定義なし）。
export function divide(x, y) {
  if (y.p === 0) return null;
  // (p1/q1)√r1 / ((p2/q2)√r2) = (p1 q2)/(q1 p2 r2) · √(r1 r2)
  return normalize(x.p * y.q, x.q * y.p * y.r, x.r * y.r);
}

// 第1象限の基準角（0〜90°）の sin
const BASE_SIN = {
  0: exact(0),
  30: exact(1, 2),
  45: exact(1, 2, 2),
  60: exact(1, 2, 3),
  90: exact(1),
};

const mod360 = (deg) => ((deg % 360) + 360) % 360;

export function sinExact(deg) {
  const d = mod360(deg);
  let ref, sign;
  if (d <= 90) { ref = d; sign = 1; }
  else if (d <= 180) { ref = 180 - d; sign = 1; }
  else if (d <= 270) { ref = d - 180; sign = -1; }
  else { ref = 360 - d; sign = -1; }
  const base = BASE_SIN[ref];
  if (!base) throw new Error(`unsupported angle ${deg}`);
  return sign === 1 ? base : neg(base);
}

export const cosExact = (deg) => sinExact(90 - deg);

export function tanExact(deg) {
  return divide(sinExact(deg), cosExact(deg));
}

export function trigExact(fn, deg) {
  if (fn === 'sin') return sinExact(deg);
  if (fn === 'cos') return cosExact(deg);
  if (fn === 'tan') return tanExact(deg);
  throw new Error(`unknown function ${fn}`);
}

// 象限（軸上は 0）
export function quadrantOf(deg) {
  if (deg > 0 && deg < 90) return 1;
  if (deg > 90 && deg < 180) return 2;
  if (deg > 180 && deg < 270) return 3;
  if (deg > 270 && deg < 360) return 4;
  return 0;
}
