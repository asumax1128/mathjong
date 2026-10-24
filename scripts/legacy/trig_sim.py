import random,collections,math,time
F=['sin','cos','tan']; A=[0,30,45,60,90,120,135,150,180,210,225,240,270,300,315,330,360]
# value label mapping; tan 90/270 undefined
vals={
0:[0,1,0],30:['h','q','u'],45:['t','t',1],60:['q','h','v'],90:[1,0,None],
120:['q','-h','-v'],135:['t','-t',-1],150:['h','-q','-u'],180:[0,-1,0],
210:['-h','-q','u'],225:['-t','-t',1],240:['-q','-h','v'],270:[-1,0,None],
300:['-q','h','-v'],315:['-t','t',-1],330:['-h','q','-u'],360:[0,1,0]}
V=[0,1,-1,'h','-h','t','-t','q','-q','u','-u','v','-v']
# tiles 0..2 func,3..19 angles, 20..32 values
N=33; triples=[]
for j,a in enumerate(A):
 for i in range(3):
  v=vals[a][i]
  if v is not None: triples.append((i,3+j,20+V.index(v)))
TBY=[[] for _ in range(N)]
for t in triples:
 for x in t:TBY[x].append(t)
# combos of triples in concealed hand with n=3,6,9; return representative group

def completions(cnt,n,limit=1):
 if n==0:return [()]
 if n<0:return []
 out=[]
 for t in triples:
  if all(cnt[x]>=1 for x in t):
   for x in t:cnt[x]-=1
   for s in completions(cnt,n-3,limit):
    out.append((t,)+s)
    if len(out)>=limit:break
   for x in t:cnt[x]+=1
   if len(out)>=limit:break
 return out

def winning(cnt,expo,require_role):
 n=sum(cnt)
 if n !=3*(3-len(expo)):return None
 sols=completions(cnt,n,30)
 for sol in sols:
  all3=expo+list(sol)
  roles=getroles(all3)
  if not require_role or roles:return (all3,roles)
 return None

def getroles(ts):
 if len(ts)!=3:return []
 fi=[t[0] for t in ts]; ang=[A[t[1]-3] for t in ts]; vv=[t[2] for t in ts]
 r=[]
 if len(set(fi))==3:r.append('三関制覇')
 if len(set(fi))==1:r.append('同関一色')
 if len(set(vv))==1:r.append('同値三連')
 if len(set(ang))==1 and len(set(fi))==3:r.append('同角三関')
 if any(x[0]==0 and y[0]==1 and A[x[1]-3]+A[y[1]-3]==90 and x[2]==y[2] for x in ts for y in ts):r.append('余角対')
 return r
SCORES={'三関制覇':1,'同関一色':2,'同値三連':4,'同角三関':4,'余角対':2}
# scoring sum roles, menzen bonus +1, tsumo bonus +1

def handpotential(cnt,expo,strat,draw=False):
 # each triplet gets 3 if complete; 2 if two present, etc; overlap corrected via greedy selection
 c=cnt.copy(); target=3-len(expo); score=0
 for step in range(target):
  best=(-1,None)
  for t in triples:
   present=sum(c[x]>0 for x in t)
   if present>best[0]:best=(present,t)
  p,t=best
  score += (0,0.55,2.0,5.0)[p]
  for x in t:
   if c[x]>0:c[x]-=1
 # additional support for less common synergy across all tiles
 if strat=='役重視型':
  fs=[t[0] for t in expo]
  for f in range(3):
   score+=0.48*sum(cnt[f] for _ in [0]) if not fs or f in fs else 0
  if len(fs)==1:score+=1.0*cnt[fs[0]]
 elif strat=='門前重視型':
  score += 0.08*sum(cnt)
 elif strat=='バランス型':
  score += .16*sum(min(cnt[f],2) for f in range(3))
 return score

def choose_discard(cnt,expo,strat,rng):
 best=-1e9; ix=[]
 for x in range(N):
  if cnt[x]==0:continue
  cnt[x]-=1
  sc=handpotential(cnt,expo,strat)
  # improve avoid dead wait: immediate potential number of 2tile pairs
  pairs=0
  for t in triples:
   if sum(cnt[z]>0 for z in t)==2:pairs+=1
  sc += .024*pairs
  cnt[x]+=1
  if sc>best+1e-8:best=sc;ix=[x]
  elif abs(sc-best)<1e-8:ix.append(x)
 return rng.choice(ix)

def chi_options(cnt,tile):
 for t in TBY[tile]:
  required=[x for x in t if x!=tile]
  if all(cnt[x]>0 for x in required):yield t,required

def run(seed,mode='mixed'):
 rng=random.Random(seed)
 deck=[]
 for x in range(N):
  copies=12 if x<3 else 4
  deck += [x]*copies
 rng.shuffle(deck)
 kind=['速攻型','役重視型','門前重視型','バランス型']
 offset=seed%4
 types=kind[offset:]+kind[:offset]
 hands=[[0]*N for _ in range(4)];expos=[[] for _ in range(4)]; calls=[0]*4
 for _ in range(8):
  for p in range(4): hands[p][deck.pop()]+=1
 turn=0; ndiscard=0; discards=[]
 while deck and ndiscard<190:
  p=turn%4; t=types[p]
  hands[p][deck.pop()]+=1
  w=winning(hands[p],expos[p],bool(expos[p]))
  if w:return dict(winner=t,way='ツモ',calls=calls[p],roles=w[1],points=1+sum(SCORES[r] for r in w[1])+(1 if not expos[p] else 0)+1,discards=ndiscard,types=types)
  d=choose_discard(hands[p],expos[p],t,rng)
  hands[p][d]-=1;ndiscard+=1
  # Ron priority in turn order
  ron=[]
  for k in (1,2,3):
   q=(p+k)%4
   hands[q][d]+=1
   w=winning(hands[q],expos[q],bool(expos[q]))
   hands[q][d]-=1
   if w:ron.append((q,w))
  if ron:
   q,w=ron[0]
   return dict(winner=types[q],way='ロン',calls=calls[q],roles=w[1],points=1+sum(SCORES[r] for r in w[1])+(1 if not expos[q] else 0),discards=ndiscard,types=types)
  # only next player q can chi; next player takes turn and discards, without drawing
  q=(p+1)%4; qt=types[q]
  if qt!='門前重視型' and len(expos[q])<2:
   opts=list(chi_options(hands[q],d))
   # candidate chi only when legal role possibility: 3 remaining sets must contain role. If 2 exposed, check can complete role by 1 more theoretical set.
   choice=None;bestgain=-999
   before=handpotential(hands[q],expos[q],qt)
   for triple,req in opts:
    temp=hands[q].copy()
    for x in req:temp[x]-=1
    potential=handpotential(temp,expos[q]+[triple],qt)
    # potential scale after chi; compensate new full meld as +5
    gain=potential+5-before
    if qt=='速攻型':threshold=0.0
    elif qt=='役重視型':threshold=2.0
    else:threshold=1.0
    # role-viability conservative: a completion consistent with possible other 1-2 sets
    ff=[z[0] for z in expos[q]+[triple]]
    if len(expos[q])==1:
     feasible= (len(set(ff))==1 or len(set(ff))==2) # always can make same or all different
    else:feasible=True
    if feasible and gain>threshold and gain>bestgain:
     choice=(triple,req);bestgain=gain
   if choice:
    triple,req=choice
    for x in req:hands[q][x]-=1
    expos[q].append(triple);calls[q]+=1
    # cannot win immediately on chi unless it is third complete meld (needs 2 prior, hand after chi has 0? actually with 2 exposed hand 2, chi third yields 0)
    w=winning(hands[q],expos[q],True)
    if w:return dict(winner=qt,way='チー和了',calls=calls[q],roles=w[1],points=1+sum(SCORES[r] for r in w[1]),discards=ndiscard,types=types)
    # discard one from remaining 8-2=6 physical counts after chi -> should be 5; recursively turn to q, with no draw
    d2=choose_discard(hands[q],expos[q],qt,rng);hands[q][d2]-=1;ndiscard+=1
    ron=[]
    for k in (1,2,3):
     z=(q+k)%4
     hands[z][d2]+=1
     w=winning(hands[z],expos[z],bool(expos[z]))
     hands[z][d2]-=1
     if w:ron.append((z,w))
    if ron:
     z,w=ron[0]
     return dict(winner=types[z],way='ロン',calls=calls[z],roles=w[1],points=1+sum(SCORES[r] for r in w[1])+(1 if not expos[z] else 0),discards=ndiscard,types=types)
    turn=q+1
    continue
  turn+=1
 return dict(winner='流局',way='流局',calls=0,roles=[],points=0,discards=ndiscard,types=types)

if __name__=='__main__':
 import sys
 n=int(sys.argv[1]) if len(sys.argv)>1 else 100
 st=time.time();result=[run(i) for i in range(n)]
 print('time',round(time.time()-st,2),'n',n)
 print('winners',collections.Counter(r['winner'] for r in result))
 print('ways',collections.Counter(r['way'] for r in result))
 print('roles',collections.Counter(role for r in result for role in r['roles']))
 for who in ['速攻型','役重視型','門前重視型','バランス型']:
  x=[r for r in result if r['winner']==who]
  print(who,len(x), 'call',round(sum(r['calls'] for r in x)/max(len(x),1),2),'score',round(sum(r['points'] for r in x)/max(len(x),1),2))
 print('discards mean',sum(r['discards'] for r in result)/n)
