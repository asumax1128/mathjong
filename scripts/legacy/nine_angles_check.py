import random
from collections import Counter
# 156 tile set: 36 function, 17 angle types x4, 13 results x4
base = [-1]*36 + [a for a in [0,30,45,60,90,120,135,150,180,210,225,240,270,300,315,330,360] for _ in range(4)] + [-2]*52
target=set([0,30,45,60,90,120,135,150,180]);rng=random.Random(20261024)
n=100000
counts=Counter()
for _ in range(n):
    # Upper bound: collector sees initial 8 plus own t draws, opponents never remove useful tiles
    seq=rng.sample(base,33)
    held=set()
    for k,t in enumerate(seq):
        if t in target:held.add(t)
        if k>=7 and len(held)==9:
            for turn in (8,12,16,20,25):
                if k < 8+turn: counts[turn]+=1
            break
for turn in (8,12,16,20,25):print(turn, counts[turn],n,counts[turn]/n)
print('deck',len(base))
