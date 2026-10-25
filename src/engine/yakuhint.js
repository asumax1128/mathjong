// 役候補ヒント（Ver.0.2-A、Ver.0.3-A で刻子・ポン・新役に対応）。docs/13-ver0.2-spec.md の A-2、docs/14-ver0.3-a.md。
// 入力は公開情報だけ（自分の手牌・自分の公開面子・全員の河・全員の公開面子）。
// 完成形の評価には既存の rules.evaluateMelds / 特殊和了の設定をそのまま使い、和了条件と食い違わないようにする。
// AI（ai.js）とは独立しており、AI の判断には使わない。

// rules ごとの事前計算：k 面子の組合せ（重複可）と、各組合せの必要牌（種類・枚数）
const comboCache = new WeakMap();
function combosFor(rules, k) {
  let byK = comboCache.get(rules);
  if (!byK) comboCache.set(rules, (byK = {}));
  if (byK[k]) return byK[k];
  const M = rules.melds.length;
  const list = [];
  const rec = (start, acc) => {
    if (acc.length === k) {
      const req = new Map();
      for (const mi of acc) for (const t of rules.melds[mi].tiles) req.set(t, (req.get(t) || 0) + 1);
      list.push({ melds: acc.slice(), req: [...req.entries()] });
      return;
    }
    for (let m = start; m < M; m++) { acc.push(m); rec(m, acc); acc.pop(); }
  };
  rec(0, []);
  byK[k] = list;
  return list;
}

// 公開面子ごとの評価結果（成立役と点数）。必要になった組合せだけを評価してキャッシュする。
// ron: ロン和了としての評価（三暗刻の暫定規則 sanankouRonCounts が効く）。キャッシュはロンかどうかで分ける。
const evalCache = new WeakMap();
function evaluatorFor(rules, exposed, ron = false) {
  let cache = evalCache.get(rules);
  if (!cache) evalCache.set(rules, (cache = new Map()));
  const key = (ron ? 'ron:' : '') + exposed.slice().sort((a, b) => a - b).join(',');
  let ev = cache.get(key);
  if (ev) return ev;
  const closed = exposed.length === 0;
  const combos = combosFor(rules, 3 - exposed.length);
  const memo = new Array(combos.length);
  ev = (i) => memo[i] || (memo[i] = rules.evaluateMelds([...exposed, ...combos[i].melds], closed, { ron }));
  cache.set(key, ev);
  return ev;
}

// 見えている牌を除いた残り枚数（公開情報のみ）
export function unseenFromView(rules, view) {
  const u = rules.types.map((t) => t.copies);
  for (const h of view.hand) u[h.type]--;
  for (const r of view.rivers) for (const t of r) u[t]--;
  for (const ms of view.melds) for (const m of ms) for (const t of m.tiles) u[t]--;
  return u;
}

// 並び順（Ver.0.3）：数式系の役を優先し、刻子系の役は「あと何枚」に koutsuPenalty 枚を足した順位で並べる
// （同じくらいの近さなら数式系が先。明らかに近い刻子系は隠さない）。完成（あと0枚）は系統によらず最優先。
// 同じ順位なら数式系 → 得点の高い順 → 設定の順。「あと何枚」の表示自体は常に正確な値。
function rankOf(rules, c) {
  if (c.missing === 0) return 0;
  const pen = rules.config.hint ? rules.config.hint.koutsuPenalty : 0;
  return c.missing + (c.category === 'koutsu' ? pen : 0);
}
const compare = (rules, order) => (a, b) => rankOf(rules, a) - rankOf(rules, b)
  || (a.category === 'koutsu') - (b.category === 'koutsu')
  || b.points - a.points || order.get(a.id) - order.get(b.id);

function orderOf(rules) {
  const order = new Map(rules.config.yaku.map((y, i) => [y.id, i]));
  rules.config.specialHands.forEach((sp, i) => order.set(sp.id, rules.config.yaku.length + i));
  return order;
}

// 現在の宣言（ロン・ポン・チー）の対象牌を、その席が「いま実際に宣言できる」場合だけ取り出す。
// pending は Game.pending() の値（その席の宣言権＝自分の手牌と公開された打牌から決まる情報）。
// 他の席が判断中・宣言権がない・判断が終わった後は null（河の牌は取得不能として扱う）。
export function claimForSeat(pending, seat, typeOf) {
  if (!pending || pending.type !== 'claim' || pending.seat !== seat) return null;
  if (!pending.ron && !pending.chi.length && !pending.pon) return null;
  return {
    type: typeOf(pending.tile), from: pending.from, ron: !!pending.ron,
    chiMelds: pending.chi.map((o) => o.meld), ponMeld: pending.pon ? pending.pon.meld : null,
  };
}

// 河から1枚（打牌者の河の最後の同種牌）を取り除いた rivers を返す
function riversWithout(rivers, from, type) {
  const out = rivers.map((r) => r.slice());
  const i = out[from].lastIndexOf(type);
  if (i < 0) throw new Error('claim tile is not in the river');
  out[from].splice(i, 1);
  return out;
}

// 役候補を返す（あと何枚の少ない順 → 得点の高い順 → 設定の順）。
// 各候補: { id, name, yakuPoints, yakuman, closedOnly, special, missing, points, example, via }
//   missing: 目標の完成形に足りない牌の枚数（重複枚数込み）。ツモ回数や巡数ではない。
//   points:  その役を含む代表的な完成形の点数（既存の得点処理による）
//   example: 代表的な完成形（面子 index の配列。特殊和了は null）— テスト・監査用。画面には表示しない。
//   via:     null（通常）/ 'ron'（いまの打牌でロン）/ 'chi' / 'pon'（いまの打牌で鳴いた後）— テスト・監査用。
//   category: 'formula'（数式系）/ 'koutsu'（刻子系）。並び順に使う。
// claim: claimForSeat() の結果。現在の宣言対象牌は、実際の宣言（ロン・ポン・チー）で取れる場合だけ、
//        その宣言を行った後の局面として評価する（1枚だけ。宣言しなければ取得不能）。
export function yakuCandidates(rules, view, { limit = 3, claim = null } = {}) {
  const order = orderOf(rules);
  const routes = baseCandidates(rules, view, limit).map((c) => ({ ...c, via: null }));
  if (claim) {
    const rivers = riversWithout(view.rivers, claim.from, claim.type);
    if (claim.ron) {
      // ロン：手牌＋対象牌でいま完成している形（あと0枚）だけが、この宣言で実現できる
      const v = { seat: view.seat, melds: view.melds, rivers, hand: [...view.hand, { id: -1, type: claim.type }] };
      // ロン和了として評価する（成立役・代表得点ともエンジンのロン判定と同じ。三暗刻の設定も反映）
      for (const c of baseCandidates(rules, v, limit, { ron: true })) if (c.missing === 0) routes.push({ ...c, via: 'ron' });
    }
    const calls = claim.chiMelds.map((mi) => ['chi', mi]);
    if (claim.ponMeld !== null && claim.ponMeld !== undefined) calls.push(['pon', claim.ponMeld]);
    for (const [via, mi] of calls) {
      // チー・ポン：対象牌と手牌2枚で面子を公開した後の局面（鳴いた手として評価）
      const hand = view.hand.slice();
      let usedClaim = false;
      for (const t of rules.melds[mi].tiles) {
        if (t === claim.type && !usedClaim) { usedClaim = true; continue; } // 刻子でも対象牌は1枚だけ
        const i = hand.findIndex((h) => h.type === t);
        if (i < 0) throw new Error(`${via} option does not match the hand`);
        hand.splice(i, 1);
      }
      const melds = view.melds.map((ms) => ms.slice());
      melds[view.seat].push({ meld: mi, tiles: rules.melds[mi].tiles.slice(), from: claim.from });
      for (const c of baseCandidates(rules, { seat: view.seat, hand, melds, rivers }, limit)) routes.push({ ...c, via });
    }
  }
  // 役ごとに最良（順位が上 → 点数が高い）を採用。各経路の上位 limit 件の統合で全体の上位 limit 件は正確に求まる。
  const best = new Map();
  const cmp = compare(rules, order);
  for (const c of routes) {
    const cur = best.get(c.id);
    if (!cur || cmp(c, cur) < 0) best.set(c.id, c);
  }
  return [...best.values()].sort(cmp).slice(0, limit);
}

// 宣言を考慮しない基本の役候補（河の牌はすべて取得不能）。ron: ロン和了として評価する（ロン経路）
function baseCandidates(rules, view, limit, { ron = false } = {}) {
  const counts = rules.countsOf(view.hand.map((h) => h.type));
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const closed = exposed.length === 0;
  const unseen = unseenFromView(rules, view);
  const combos = combosFor(rules, 3 - exposed.length);
  const evaluate = evaluatorFor(rules, exposed, ron);
  const order = orderOf(rules);
  const best = new Map();

  // 特殊和了（門前限定は鳴いた手では候補にしない）は別判定
  const specials = [];
  for (const sp of rules.config.specialHands) {
    if (!sp.enabled || (sp.closedOnly && !closed)) continue;
    const idxs = sp.angles.map((d) => rules.typeByKey.get(`a:${d}`));
    if (!idxs.every(Boolean)) continue; // 必要な角度牌が無効
    let missing = 0;
    let possible = true;
    for (const t of idxs) {
      if (counts[t.idx] >= 1) continue;
      if (unseen[t.idx] < 1) { possible = false; break; }
      missing++;
    }
    if (!possible) continue;
    specials.push({
      id: sp.id, name: sp.name, yakuPoints: sp.points, yakuman: !!sp.yakuman, closedOnly: !!sp.closedOnly,
      special: true, missing, points: sp.points, example: null, category: sp.category || 'formula',
    });
  }

  // 1) 全組合せの「あと何枚」を計算（不可能な組合せは除外）し、枚数ごとに分ける
  const levels = [];
  for (let i = 0; i < combos.length; i++) {
    let missing = 0;
    let possible = true;
    for (const [t, n] of combos[i].req) {
      const miss = n - counts[t];
      if (miss <= 0) continue;
      if (unseen[t] < miss) { possible = false; break; }
      missing += miss;
    }
    if (!possible) continue;
    (levels[missing] || (levels[missing] = [])).push(i);
  }
  // 2) あと何枚の少ない順に評価。ある枚数の組合せをすべて評価し終えた時点で、
  //    その枚数以下の候補が limit 件以上そろえば、より多い枚数の候補は上位に入れないので打ち切る。
  for (let L = 0; L < levels.length; L++) {
    for (const i of levels[L] || []) {
      const ev = evaluate(i);
      if (!ev.yaku.length) continue; // 役のない完成形（門前の役なし和了は「役候補」ではない／鳴いた手は和了不可）
      for (const y of ev.yaku) {
        const cur = best.get(y.id);
        if (!cur || L < cur.missing || (L === cur.missing && ev.points > cur.points)) {
          const def = rules.config.yaku.find((d) => d.id === y.id);
          best.set(y.id, {
            id: y.id, name: y.name, yakuPoints: y.points, yakuman: y.yakuman, closedOnly: !!def.closedOnly,
            special: false, missing: L, points: ev.points, example: [...exposed, ...combos[i].melds],
            category: def.category || 'formula',
          });
        }
      }
    }
    // 打ち切り：順位（rankOf）が L 以下の候補が limit 件以上そろえば、未評価（あと L+1 枚以上＝順位 L+1 以上）の
    // 候補はそれより上に入らない。
    const settled = [...best.values(), ...specials].filter((c) => rankOf(rules, c) <= L).length;
    if (settled >= limit) break;
  }
  for (const c of specials) best.set(c.id, c);

  return [...best.values()].sort(compare(rules, order)).slice(0, limit);
}

// 評価キャッシュを少しずつ作っておく（ヒントを押したときの待ち時間を減らす）。
// schedule には setTimeout などを渡す。1回の処理は chunk 個の組合せだけなので画面操作を妨げない。
// 実行状態は rules と公開面子の組合せごとに管理し、実行中・完了済みなら何もしない（false を返す）。
// 途中で例外が出たら状態を戻し、次回の呼び出しで最初からやり直せるようにする（キャッシュの内容は常に正しい）。
const warmState = new WeakMap();
export function warmUpState(rules, exposed = []) {
  const m = warmState.get(rules);
  return (m && m.get(exposed.slice().sort((a, b) => a - b).join(','))) || 'idle';
}
export function warmUp(rules, exposed = [], { chunk = 300, schedule = (f) => setTimeout(f, 0) } = {}) {
  let states = warmState.get(rules);
  if (!states) warmState.set(rules, (states = new Map()));
  const key = exposed.slice().sort((a, b) => a - b).join(',');
  if (states.get(key) === 'running' || states.get(key) === 'done') return false;
  states.set(key, 'running');
  const evaluate = evaluatorFor(rules, exposed);
  const n = combosFor(rules, 3 - exposed.length).length;
  let i = 0;
  const step = () => {
    try {
      const end = Math.min(n, i + chunk);
      for (; i < end; i++) evaluate(i);
      if (i < n) schedule(step);
      else states.set(key, 'done');
    } catch (e) {
      states.delete(key);
      throw e;
    }
  };
  try {
    schedule(step);
  } catch (e) {
    states.delete(key);
    throw e;
  }
  return true;
}
