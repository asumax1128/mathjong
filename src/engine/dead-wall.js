// Opt-in Ver.next rules only. Four replacement tiles plus five pairs of indicator candidates.
export function createDeadWall(wall, tileType, types) {
  if (wall.length < 14) throw new Error('not enough tiles for dead wall');
  const reserved = wall.splice(0, 14);
  const rinshan = reserved.slice(0, 4);
  const pairs = Array.from({length:5}, (_,i)=>reserved.slice(4+2*i,6+2*i));
  const replenished = [];
  const indicators = [];
  const byKind = kind => types.filter(t=>t.kind===kind).map(t=>t.idx);
  const order = {
    func: byKind('func'),
    angle: byKind('angle').sort((a,b)=>types[a].deg-types[b].deg),
    value: byKind('value').sort((a,b)=>{
      const value = t => {
        const x=types[t].exact;
        return x.p / x.q * Math.sqrt(x.r);
      };
      return value(a)-value(b) || a-b;
    }),
  };
  // Numeric values are ordered by the configuration's conventional sequence if exact shape differs.
  function doraTypeOf(id) {
    const idx=tileType[id], kind=types[idx].kind;
    const sequence=order[kind];
    return sequence[(sequence.indexOf(idx)+1)%sequence.length];
  }
  function reveal() {
    const pair=pairs[indicators.length];
    if(!pair) throw new Error('no more dora indicators');
    const id=types[tileType[pair[0]]].kind==='func'?pair[1]:pair[0];
    indicators.push({id,type:doraTypeOf(id)});
    return indicators.at(-1);
  }
  function replacement() {
    if(!rinshan.length || !wall.length) throw new Error('no rinshan or live tile');
    // After a kan, a live-wall bottom tile replaces the tile drawn from dead wall.
    const id=rinshan.pop();
    replenished.push(wall.shift());
    return id;
  }
  reveal();
  return {rinshan,pairs,replenished,indicators,reveal,replacement,allPhysical:()=>[...rinshan,...pairs.flat(),...replenished],get liveCount(){return wall.length;}};
}
