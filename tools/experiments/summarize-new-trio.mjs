import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
export function summarize(rows) {
  const buckets = new Map();
  for (const r of rows) for (const [s, id] of r.seats.entries()) {
    const key = [r.caseId, r.mode, r.length, id].join('|');
    if (!buckets.has(key)) buckets.set(key, { caseId: r.caseId, mode: r.mode, length: r.length, id, matches: new Set(), seats: 0, ranks: [], points: [], groups: new Map(), top: 0, last: 0, totals: {} });
    const b = buckets.get(key); b.seats++; b.matches.add(r.sample); b.ranks.push(r.ranks[s]); b.points.push(r.scores[s]); b.top += r.shares[s][0]; b.last += r.shares[s][3];
    if (!b.groups.has(r.group)) b.groups.set(r.group, []);
    b.groups.get(r.group).push(r.ranks[s]);
    for (const [k, v] of Object.entries(r.stats[s])) {
      if (k === 'maxMs' || k === 'weightMax') b.totals[k] = Math.max(b.totals[k] || 0, v);
      else if (k === 'weightMin') b.totals[k] = Math.min(b.totals[k] ?? 2, v);
      else b.totals[k] = (b.totals[k] || 0) + v;
    }
  }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  // 小標本では正規近似1.96ではなくt分布。既定4組なので自由度3。
  const t95 = n => [null, null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262][n] ?? (n <= 20 ? 2.262 : 2.093);
  const tables = [...buckets.values()].map(b => {
    const groups = [...b.groups.values()].map(mean), n = groups.length, center = mean(groups);
    const se = n < 2 ? null : Math.sqrt(groups.reduce((s, x) => s + (x - center) ** 2, 0) / (n - 1) / n);
    const st = b.totals;
    return { caseId: b.caseId, mode: b.mode, length: b.length, id: b.id, matches: b.matches.size, seatSamples: b.seats,
      groups: n, rank: mean(b.ranks), rank95HalfWidth: se === null ? null : t95(n) * se, points: mean(b.points),
      topRate: b.top / b.seats, lastRate: b.last / b.seats, winRate: st.wins / st.rounds, dealInRate: st.dealIn / st.rounds,
      riichiRate: st.riichi / st.rounds, chiRate: st.chi / st.rounds, ponRate: st.pon / st.rounds,
      meanBasePoints: st.wins ? st.basePoints / st.wins : null, meanDecisionMs: st.ms / st.decisions, totals: st };
  });
  return { matches: rows.length, rounds: rows.reduce((s, r) => s + r.played, 0),
    draws: rows.reduce((s, r) => s + r.logs.filter(x => x.result.type === 'draw').length, 0),
    decisions: rows.reduce((s, r) => s + r.stats.reduce((n, t) => n + t.decisions, 0), 0),
    tables };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2]; let bytes = readFileSync(src); if (src.endsWith('.gz')) bytes = gunzipSync(bytes);
  const data = summarize(bytes.toString('utf8').trim().split('\n').map(x => JSON.parse(x)));
  writeFileSync(process.argv[3] || '/tmp/new-trio-summary.json', JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify({ matches: data.matches, rounds: data.rounds, draws: data.draws, decisions: data.decisions }));
}
