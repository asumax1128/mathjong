import { jobsFor } from './sim-new-trio.mjs';
export const PLAN = Object.freeze({ tuningSeed: 206102901, evaluationSeed: 206102902,
  tuningGroups: 4, peerGroups: 8, mixedGroups: 16, selfGroups: 8, controlGroups: 2,
  workers: 4, rankDegradationLimit: 0.25, tripletIncreaseRequired: 0.005 });
const tagged = (jobs, variant, experimental) => jobs.map(j => ({ ...j, pair: j.sample,
  sample: `${variant}|${j.sample}`, variant, experimental }));
export function tuningJobs() {
  const jobs = jobsFor({ seed: PLAN.tuningSeed, groups: PLAN.tuningGroups, only: 'yujin-low' });
  return [...tagged(jobs, 'initial', {}), ...tagged(jobs, 'supply', { yujin: { policy: 'supply' } })];
}
export function selectPolicy(rows) {
  const stats = variant => {
    const rs = rows.filter(r => r.variant === variant), samples = rs.flatMap(r => r.seats.flatMap((id, s) => id === 'yujin' ? [{ rank: r.ranks[s], ...r.stats[s] }] : []));
    const sum = key => samples.reduce((s, x) => s + x[key], 0);
    return { matches: rs.length, rank: sum('rank') / samples.length, tripletPerRound: sum('sanankou') / sum('rounds'), rounds: sum('rounds'), wins: sum('wins'), sanankou: sum('sanankou') };
  };
  const initial = stats('initial'), supply = stats('supply');
  // 0.015 - 0.01 が0.005をわずかに下回る丸めを避ける。今回の閾値は1/1000単位。
  const rise = 1000 * (supply.sanankou * initial.rounds - initial.sanankou * supply.rounds);
  const required = (PLAN.tripletIncreaseRequired * 1000) * supply.rounds * initial.rounds;
  const chooseSupply = rise >= required && supply.rank - initial.rank <= PLAN.rankDegradationLimit;
  return { selected: chooseSupply ? 'supply' : 'initial', initial, supply,
    rule: '刻子役の参加局あたり成立率が0.5ポイント以上増加し、平均順位の悪化が0.25以内ならsupply。調整試験のみで固定し、本評価後は選び直さない。' };
}
export function evaluationJobs(selection) {
  const tiers = { low: ['kanata', 'mitsuki', 'aoto'], mid: ['ousuke', 'natsuki', 'yuki'], high: ['fukuyama', 'kaoru', 'asuma'] };
  const peers = Object.keys({ yujin: 1, tara: 1, nocchi: 1 }).flatMap(id => Object.entries(tiers).map(([tier, others]) => ({ id: `${id}-${tier}`, lineup: [id, ...others] })));
  const config = { seed: PLAN.evaluationSeed };
  const exp = { yujin: { policy: selection.selected } };
  const jobs = [
    ...jobsFor({ ...config, groups: PLAN.peerGroups, cases: peers }),
    ...jobsFor({ ...config, groups: PLAN.mixedGroups, only: 'mixed' }),
    ...jobsFor({ ...config, groups: PLAN.selfGroups, only: 'self-yujin,self-tara,self-nocchi' }),
    ...jobsFor({ ...config, groups: PLAN.controlGroups, only: 'control-low,control-mid,control-high' }),
  ];
  const out = tagged(jobs, 'final', exp);
  for (const [id, caseId, change] of [
    ['yujin', 'yujin-low', { yujin: { policy: selection.selected === 'supply' ? 'initial' : 'supply' } }],
    ['tara', 'tara-mid', { tara: { maxDelay: 0 } }],
    ['nocchi', 'nocchi-high', { nocchi: { adaptive: false } }],
  ]) {
    const base = jobs.filter(j => j.caseId === caseId);
    out.push(...tagged(base, 'ablate-' + id, { ...exp, ...change }));
  }
  return out;
}
