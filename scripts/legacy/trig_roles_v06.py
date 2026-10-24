import sys,collections,itertools,time,random
sys.path.insert(0,'/mnt/data')
import trig_sim as old
Q={a:(1 if 0<a<90 else 2 if 90<a<180 else 3 if 180<a<270 else 4 if 270<a<360 else 0) for a in old.A}

base_roles=old.getroles
def roles(ts):
 r=base_roles(ts)
 if len(ts)!=3:return r
 angles=[old.A[t[1]-3] for t in ts]
 quadrants=[Q[a] for a in angles]
 # 3 triple all angles strictly inside same quadrant
 if quadrants[0] and len(set(quadrants))==1:r.append('象限一色'+str(quadrants[0]))
 if len(set(ts))==1:r.append('三重同式')
 # one from each three distinct quadrants (4 choose 3), exclude axes
 if 0 not in quadrants and len(set(quadrants))==3:r.append('三象限巡り')
 if len(set(angles))==3 and sorted(angles)==[30,45,60]:r.append('基本三角三連')
 if len(set(angles))==3 and sorted(angles)==[120,135,150]:r.append('第二象限三連')
 if len(set(angles))==3 and sorted(angles)==[210,225,240]:r.append('第三象限三連')
 if len(set(angles))==3 and sorted(angles)==[300,315,330]:r.append('第四象限三連')
 # 3 functions each have identical 2+ angle? original same angle three funcs
 return r
old.getroles=roles
old.SCORES.update({'三重同式':16,'三象限巡り':2,'基本三角三連':2,'第二象限三連':2,'第三象限三連':2,'第四象限三連':2, **{'象限一色'+str(i):3 for i in range(1,5)}})
# enumerate all unordered combinations of 3 valid triples, each tile <= 4 copies except func <=12
possible=collections.Counter();total=0
for trio in itertools.combinations_with_replacement(old.triples,3):
 counts=collections.Counter(x for t in trio for x in t)
 if any(k>=3 and v>4 for k,v in counts.items()):continue
 total+=1
 for r in roles(trio):possible[r]+=1
print('LEGAL_COMBINATIONS',total)
print('POSSIBLE_ROLES',dict(possible))
print('NINE_DISTINCT_ANGLES_POSSIBLE',False)
n=int(sys.argv[1]) if len(sys.argv)>1 else 120
start=time.time();results=[]
for i in range(n):results.append(old.run(i+44000))
print('TIME',round(time.time()-start,1),'GAMES',n)
print('WIN',dict(collections.Counter(r['winner'] for r in results)))
print('WAYS',dict(collections.Counter(r['way'] for r in results)))
print('ROLES',dict(collections.Counter(x for r in results for x in r['roles'])))
print('AVG_DISCARDS',round(sum(r['discards'] for r in results)/n,2))
print('AVG_POINTS', {w:round(sum(r['points'] for r in results if r['winner']==w)/max(1,sum(r['winner']==w for r in results)),2) for w in ['速攻型','役重視型','門前重視型','バランス型']})
