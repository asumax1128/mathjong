// 手牌の長押しドラッグによる並び替え（Ver.0.2-D）。表示順だけを変え、打牌は一切行わない。
//
// 状態：idle → pressing（押している・長押し待ち）→ dragging（並び替え中）→ idle
// - タッチ／ペン：350ms 押したまま、移動 8px 未満で dragging。それより前に 8px 以上動いたらスクロール等とみなし idle。
//   350ms より前に離した場合は通常のタップ（既存の click 処理：1回目で選択、2回目で打牌）に任せる。
// - マウス：押したまま 6px 以上動かしたら dragging（スクロールとの衝突がないため待ち時間なし）。
// - dragging 中は、牌を浮かせて表示し、挿入位置に線を出す。手牌の帯の上で動かして離すと並び替え確定。
//   帯の外で離す・動かさずに離す・pointercancel・回転・アプリ切替・スクロール・Esc・状態変化・再描画では中止。
// - 「タップではなくなった操作」（押下中に 8px 以上動いた、またはドラッグになった）に由来する click は、
//   そのポインターの操作に対応付けて1回だけ抑止する（createClickGuard）。ブラウザが click を作る移動量の閾値は
//   アプリの 8px より大きいことがある（Chromium は 9〜12px 動いても click を送る）ため、閾値を合わせるのではなく、
//   アプリがタップでないと判断した操作の click をすべて抑止する。

import { insertionIndex, moveTo } from './handorder.js';

// 「タップとして無効になった操作」に由来する click だけを抑止する（純粋なロジック。tests/handorder.test.js で検証）。
// 抑止の状態はこの1か所だけで持つ（同時に追跡するのは1つの操作だけ）。
// - invalidate(pointerId)：その操作がタップではなくなった時点で呼ぶ（押下中に閾値以上動いた／ドラッグになった）。
// - release(pointerId)：そのポインターの pointerup / pointercancel。期限（ttlMs）はここから数える
//   （指を離すまでの時間に左右されない）。
// - pointerDown(ev)：新しい「主ポインター」の押下で解除する（新しいタップを抑止しない）。
//   2本目の指（isPrimary=false）の押下では解除しない（1本目の操作の click が後から届くため）。
// - shouldSuppress(ev)：対象の click なら true を返して解除する。キーボード由来（detail === 0）と、
//   ポインター ID が分かっていて別のポインターの click は抑止しない。iOS Safari の合成 click は pointerId を
//   持たないことがあるので、ID 不明の click は無効になった操作の click とみなす（合成 click は指を離した直後、
//   次の押下より前に届く）。
export function createClickGuard({ ttlMs = 1000, now = () => Date.now() } = {}) {
  let inv = null; // { pointerId, releasedAt: number | null }
  const expired = () => inv && inv.releasedAt !== null && now() - inv.releasedAt > ttlMs;
  return {
    invalidate(pointerId) {
      if (!inv || inv.pointerId !== pointerId) inv = { pointerId, releasedAt: null };
    },
    release(pointerId) {
      if (inv && inv.pointerId === pointerId && inv.releasedAt === null) inv.releasedAt = now();
    },
    pointerDown(ev) {
      if (!ev || ev.isPrimary !== false) inv = null;
    },
    isArmed() {
      if (expired()) inv = null;
      return inv !== null;
    },
    shouldSuppress(ev) {
      if (!inv) return false;
      if (expired()) { inv = null; return false; }
      if (ev.detail === 0) return false; // キーボード等
      const pid = ev.pointerId;
      if (typeof pid === 'number' && pid >= 0 && pid !== inv.pointerId) return false; // 別のポインター
      inv = null;
      return true;
    },
  };
}

export const DRAG_DEFAULTS = { longPressMs: 350, slopPx: 8, mouseSlopPx: 6, zonePadY: 60, zonePadX: 24 };

// root: 手牌を含む要素（#app）。DOM は再描画で作り直されるので、手牌は毎回 root から探す。
// hooks:
//   canStart()            並び替えを始めてよいか（宣言待ち・モーダル・終局中は false）
//   snapshot()            状態のキー（変われば中止）：局・手牌 ID・宣言状態・モーダルなど
//   getOrder()            現在の表示順（牌 ID 配列）
//   onDragStart()         dragging に入ったとき（AI の保留・選択解除など）
//   onDragEnd(result)     終了時 { committed, order|null, reason }（再描画・AI の再開は呼び出し側）
export function createHandDrag(root, hooks, options = {}) {
  const opt = { ...DRAG_DEFAULTS, ...options };
  const guard = createClickGuard();
  let st = { phase: 'idle' };
  let ghost = null;
  let marker = null;

  const handEl = () => root.querySelector('.hand');
  const tileEl = (id) => root.querySelector(`.hand .tile[data-id="${id}"]`);

  function cleanupDom() {
    if (ghost) { ghost.remove(); ghost = null; }
    if (marker) { marker.remove(); marker = null; }
    root.querySelectorAll('.hand .tile.drag-src').forEach((el) => el.classList.remove('drag-src'));
    const h = handEl();
    if (h) h.classList.remove('dragging');
  }

  function toIdle() {
    if (st.timer) clearTimeout(st.timer);
    // 押した牌に直接付けた touchmove の抑止を外す（下記 onPointerDown）
    if (st.el) st.el.removeEventListener('touchmove', onTouchMove);
    st = { phase: 'idle' };
  }

  // 中止（元の並びのまま）。reason === 'render' のときは呼び出し側が再描画中。
  function cancel(reason) {
    // 押下中の中止（回転・Esc・アプリ切替など）も、タップとしては無効（指を離した後の click を別の牌に当てない）
    if (st.phase === 'pressing') { guard.invalidate(st.pointerId); toIdle(); return; }
    if (st.phase !== 'dragging') return;
    cleanupDom();
    toIdle(); // この操作は activate() で invalidate 済み。指を離した時点で guard.release される
    hooks.onDragEnd({ committed: false, order: null, reason });
  }

  function activate() {
    const s = st;
    if (s.phase !== 'pressing') return;
    // 再描画で DOM が作り直されていても、同じ牌が手牌にあればその要素で続ける。状態が変わっていれば中止。
    const el = tileEl(s.id);
    if (!el || !el.isConnected || !hooks.canStart() || hooks.snapshot() !== s.snap) { toIdle(); return; }
    const r = el.getBoundingClientRect();
    // ドラッグになった時点で、この操作はタップではない（中止・確定のどちらでも、この操作の click は抑止）
    guard.invalidate(s.pointerId);
    // 移動は押した位置（x0, y0）から測る。マウスで閾値を超えてドラッグになった場合は、その移動自体が有効な移動。
    const moved = s.pointerType === 'mouse' && Math.hypot(s.x - s.x0, s.y - s.y0) >= opt.mouseSlopPx;
    st = { ...s, phase: 'dragging', timer: null, w: r.width, h: r.height, moved, index: null };
    el.classList.add('drag-src');
    el.classList.remove('selected');
    handEl().classList.add('dragging');
    ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('drag-src', 'selected', 'hint', 'tap');
    ghost.removeAttribute('data-action');
    ghost.removeAttribute('tabindex');
    ghost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ghost);
    marker = document.createElement('span');
    marker.className = 'drop-marker';
    hooks.onDragStart();
    update(s.x, s.y);
  }

  // 浮かせた牌と挿入位置の表示を更新
  function update(x, y) {
    const hand = handEl();
    if (!hand || !hand.isConnected) { cancel('dom'); return; }
    ghost.style.transform = `translate(${x - st.w / 2}px, ${y - st.h - 28}px) scale(1.12)`;
    const hr = hand.getBoundingClientRect();
    const inZone = x >= hr.left - opt.zonePadX && x <= hr.right + opt.zonePadX && y >= hr.top - opt.zonePadY && y <= hr.bottom + opt.zonePadY;
    ghost.classList.toggle('drag-cancel', !inZone);
    if (!inZone) { marker.remove(); st.index = null; return; }
    const others = [...hand.querySelectorAll('.tile[data-id]')].filter((el) => Number(el.dataset.id) !== st.id);
    const centers = others.map((el) => { const q = el.getBoundingClientRect(); return (q.left + q.right) / 2; });
    const i = insertionIndex(centers, x);
    st.index = i;
    // 挿入位置の線（絶対配置なので牌の位置はずれない）：i 番目の牌の左端、末尾なら最後の牌の右端
    if (!marker.isConnected) hand.appendChild(marker);
    const edge = i < others.length ? others[i].getBoundingClientRect().left - 2.5 : others.length ? others[others.length - 1].getBoundingClientRect().right + 0.5 : hr.left + hr.width / 2;
    const tr = (others[0] || hand).getBoundingClientRect();
    marker.style.left = `${edge - hr.left}px`;
    marker.style.top = `${tr.top - hr.top}px`;
    marker.style.height = `${tr.height}px`;
  }

  function finish(x, y) {
    // 指を離した位置でも移動量と挿入位置を更新する（移動イベントの回数に結果が左右されない）
    noteMove(x, y);
    update(x, y);
    if (st.phase !== 'dragging') return; // update の中で中止された
    const s = st;
    const valid = s.moved && s.index !== null && hooks.snapshot() === s.snap && hooks.canStart();
    cleanupDom();
    toIdle();
    if (!valid) {
      hooks.onDragEnd({ committed: false, order: null, reason: s.moved ? 'outside' : 'no-move' });
      return;
    }
    hooks.onDragEnd({ committed: true, order: moveTo(hooks.getOrder(), s.id, s.index), reason: 'drop' });
  }

  function slopFor(type) { return type === 'mouse' ? opt.mouseSlopPx : opt.slopPx; }
  function noteMove(x, y) {
    if (Math.hypot(x - st.x0, y - st.y0) >= slopFor(st.pointerType)) st.moved = true;
  }

  // ---- イベント ----
  function onPointerDown(ev) {
    guard.pointerDown(ev);
    if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    if (st.phase === 'dragging') return; // 2本目の指などは無視
    const el = ev.target.closest && ev.target.closest('.hand .tile[data-id]');
    if (!el || !hooks.canStart()) { toIdle(); return; }
    toIdle();
    st = {
      phase: 'pressing', pointerId: ev.pointerId, pointerType: ev.pointerType, id: Number(el.dataset.id),
      x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, snap: hooks.snapshot(), timer: null, el,
    };
    // タッチの touchmove は、押した要素に届き続ける。長押し中に他家の手番で再描画されてその要素が DOM から外れると、
    // document まで伝わらずスクロールを止められない（ブラウザがスクロールを始めて pointercancel になる）。
    // そのため押した要素にも直接、非 passive の touchmove を付ける（idle に戻るときに外す）。
    if (ev.pointerType !== 'mouse') el.addEventListener('touchmove', onTouchMove, { passive: false });
    if (ev.pointerType !== 'mouse') st.timer = setTimeout(activate, opt.longPressMs);
  }

  function onPointerMove(ev) {
    if (st.phase === 'idle' || ev.pointerId !== st.pointerId) return;
    st.x = ev.clientX; st.y = ev.clientY;
    if (st.phase === 'pressing') {
      const d = Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0);
      if (st.pointerType === 'mouse') { if (d >= opt.mouseSlopPx) activate(); }
      else if (d >= opt.slopPx) {
        // スクロール等：ドラッグにしない。タップとしても無効（ブラウザが click を作っても抑止する）
        guard.invalidate(st.pointerId);
        toIdle();
      }
      return;
    }
    if (hooks.snapshot() !== st.snap) { cancel('state'); return; }
    noteMove(ev.clientX, ev.clientY);
    ev.preventDefault();
    update(ev.clientX, ev.clientY);
  }

  function onPointerUp(ev) {
    guard.release(ev.pointerId); // 無効になった操作なら、ここから抑止の期限を数える
    if (st.phase === 'idle' || ev.pointerId !== st.pointerId) return;
    if (st.phase === 'pressing') { toIdle(); return; } // 通常のタップ：click 処理に任せる
    finish(ev.clientX, ev.clientY);
  }

  function onPointerCancel(ev) {
    guard.release(ev.pointerId);
    if (st.phase !== 'idle' && ev.pointerId === st.pointerId) cancel('pointercancel');
  }

  // dragging 中はページのスクロールを止める（iOS Safari：非 passive の touchmove で preventDefault）
  function onTouchMove(ev) { if (st.phase === 'dragging' && ev.cancelable) ev.preventDefault(); }

  // ドラッグ中の click はすべて無視し、ドラッグ由来の click は1回だけ抑止（捕捉段階）
  function onClickCapture(ev) {
    if (st.phase === 'dragging' || guard.shouldSuppress(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onContextMenu(ev) { if (ev.target.closest && ev.target.closest('.hand .tile')) ev.preventDefault(); }
  const onResize = () => cancel('resize');
  const onScroll = () => { if (st.phase === 'dragging') cancel('scroll'); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') cancel('hidden'); };
  const onKey = (ev) => { if (ev.key === 'Escape') cancel('escape'); };

  root.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('click', onClickCapture, true);
  root.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.addEventListener('scroll', onScroll, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('keydown', onKey);

  return {
    phase: () => st.phase,
    isDragging: () => st.phase === 'dragging',
    cancel,
    guard,
  };
}
