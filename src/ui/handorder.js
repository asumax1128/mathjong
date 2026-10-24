// 手牌の表示順（Ver.0.2-D）。画面だけが持つ「牌 ID の並び」で、ゲームエンジンには一切反映しない。
// すべて純粋関数（入力の配列は変更しない）。tests/handorder.test.js で検証。

// 従来の並び：ツモ牌以外を「牌の種類順 → ID 順」、ツモ牌（drawnId）があれば右端。
export function defaultOrder(handIds, typeOf, drawnId = null) {
  const rest = handIds.filter((id) => id !== drawnId).sort((a, b) => typeOf(a) - typeOf(b) || a - b);
  return handIds.includes(drawnId) ? [...rest, drawnId] : rest;
}

// エンジンの手牌（handIds）と表示順（order）を突き合わせる。
// - order が null（局の開始・初期化後）なら従来の並び。
// - order のうち手牌にある ID だけを元の順番で残す（打牌・チー・ロンで抜けた牌だけが消える）。
// - 手牌にあって order にない ID（新しいツモ牌）は右端に追加（複数なら従来の並びの順）。
// 戻り値の ID の集合は handIds と常に一致する（重複なし）。
export function reconcileOrder(order, handIds, typeOf, drawnId = null) {
  if (!order) return defaultOrder(handIds, typeOf, drawnId);
  const inHand = new Set(handIds);
  const seen = new Set();
  const kept = [];
  for (const id of order) {
    if (inHand.has(id) && !seen.has(id)) { kept.push(id); seen.add(id); }
  }
  const added = defaultOrder(handIds.filter((id) => !seen.has(id)), typeOf, drawnId);
  return [...kept, ...added];
}

// id を、それ以外の牌の並びの index 番目（0 = 先頭、length = 末尾）に移す
export function moveTo(order, id, index) {
  const rest = order.filter((x) => x !== id);
  if (rest.length === order.length) throw new Error(`tile ${id} is not in the order`);
  const i = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}

// 挿入位置：移動する牌以外の牌の中心（x 座標、左から順）のうち、指の位置より左にある数
export function insertionIndex(centers, x) {
  let i = 0;
  while (i < centers.length && centers[i] < x) i++;
  return i;
}

// 表示順と手牌の ID の集合が一致するか（重複・欠落・余分がないか）
export function sameIdSet(order, handIds) {
  if (order.length !== handIds.length) return false;
  const a = new Set(order);
  return a.size === order.length && handIds.every((id) => a.has(id));
}
