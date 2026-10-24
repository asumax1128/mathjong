"""4-player trig mahjong Monte Carlo, derived from the existing trig_sim.py.
Compare 12 versus 16 copies of sin/cos/tan with 17 angles and 13 value tiles.
Simplifications: no furiten, no defensive tile reads, no payments, no multi-ron.
"""
import collections, random, statistics, argparse, time
import trig_sim as base

ORIG_ROLES=base.getroles
QUADS={1:{30,45,60},2:{120,135,150},3:{210,225,240},4:{300,315,330}}
FRONT={0,30,45,60,90,120,135,150,180}
BACK={180,210,225,240,270,300,315,330,360}
FUNCTIONS=['速攻型','役重視型','門前重視型','バランス型']


def roles_with_new(ts):
    result=ORIG_ROLES(ts)
    angles=[base.A[t[1]-3] for t in ts]
    for q,angs in QUADS.items():
        if all(a in angs for a in angles):result.append(f'第{q}象限一色')
    if len(set(ts))==1:result.append('三重同式')
    if any(sorted(angles)==sorted(angs) for angs in QUADS.values()):
        result.append('象限三角揃い')
    return result
base.getroles=roles_with_new
base.SCORES.update({f'第{q}象限一色':3 for q in QUADS})
base.SCORES.update({'三重同式':16,'象限三角揃い':4,'同角三関':8})

# Modify the original runner in memory to parameterize function copies and count extra information.
# Keeping turn/chi/ron logic identical makes the control and intervention comparable.
from pathlib import Path
import inspect
src=inspect.getsource(base.run)
src=src.replace("def run(seed,mode='mixed'):","def run(seed, copies=12, mode='mixed'):")
src=src.replace('copies=12 if x<3 else 4','copies=copies if x<3 else 4')
src=src.replace("w=winning(hands[p],expos[p],bool(expos[p]))", "w=winning_extra(hands[p],expos[p],bool(expos[p]))")
src=src.replace("w=winning(hands[q],expos[q],bool(expos[q]))", "w=winning_extra(hands[q],expos[q],bool(expos[q]))")
src=src.replace("w=winning(hands[q],expos[q],True)", "w=winning_extra(hands[q],expos[q],True)")
src=src.replace("w=winning(hands[z],expos[z],bool(expos[z]))", "w=winning_extra(hands[z],expos[z],bool(expos[z]))")
src=src.replace('winning_extra(', 'winning_extra(')
src=src.replace("'チー和了'", "'チー和了'")

# Guard for presence of a completed 9-angle yakuman.
def winning_extra(cnt,expo,require_role):
    if not expo and sum(cnt)==9:
        a={base.A[k-3] for k in range(3,20) if cnt[k]>0}
        if a == FRONT and all(cnt[k]==1 for k in range(3,20) if cnt[k]):
            return ([('九角無双',)], ['九角無双'])
        if a == BACK and all(cnt[k]==1 for k in range(3,20) if cnt[k]):
            return ([('裏九角無双',)], ['裏九角無双'])
    return base.winning(cnt,expo,require_role)

base.SCORES.update({'九角無双':16,'裏九角無双':16})

# The dynamically built function refers to base symbols by the original global names.
context = dict(base.__dict__)
context['winning_extra']=winning_extra
exec(src,context)
run=context['run']


def experiment(n, copies, seed0=0):
    totals=collections.Counter(); rolecounts=collections.Counter(); who=collections.Counter()
    winners=[]; chi_winners=0; ron=0; sum_discards=0; sum_points=0
    for i in range(n):
        r=run(seed0+i,copies)
        who[r['winner']]+=1
        totals[r['way']]+=1
        rolecounts.update(r['roles'])
        chi_winners+=int(r['calls']>0)
        sum_discards+=r['discards']
        sum_points+=r['points']
        winners.append(r)
    return {'n':n,'copies':copies,'deck':120+3*copies,
      'winners':dict(who),'ways':dict(totals),'roles':dict(rolecounts),
      'winner_called_pct':round(100*chi_winners/n,2),
      'mean_discards':round(sum_discards/n,3),
      'mean_points':round(sum_points/n,3)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--games',type=int,default=1500); parser.add_argument('--seed',type=int,default=10000)
    args=parser.parse_args()
    import json
    st=time.perf_counter()
    for copies in (12,16):
        r=experiment(args.games,copies,args.seed)
        print(json.dumps(r,ensure_ascii=False,sort_keys=True),flush=True)
    print('runtime',round(time.perf_counter()-st,2),flush=True)
