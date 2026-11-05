// 牌譜の振り返りの画面（第2段階・docs/76・docs/77）。app.js はタイトルの「牌譜を振り返る」で、このモジュールを動的 import する。
// 読込・表示の失敗はこの画面の中だけで扱い、通常対局・タイトル・初心者の部屋には影響させない。
//
// ・一覧：保存の索引（日時・モード・局数・状態・局の数）だけで描き、相手・順位・最終点・開始日時は、表示中の行だけを
//   1件ずつ検証して要約（公開してよい項目だけ）にする（全件の一括読込はしない。要約の後は記録を手放す）。
// ・再生：選んだ1件を読み込み（保存時と同じ検証を Worker で行う）、検証済みの記録から各時点の「自分の視点」だけを作る
//   （src/ui/paifu-review.js）。画面へ渡すのはその射影だけ。記録の本文を DOM・URL・ログ・保存へ出さない。
// ・再生はゲーム本体（app.js の S.game・S.match）を変更しない。保存・削除もしない（削除の世代も変えない）。
// ・閲覧画面に打牌の操作バーは出さない（前後の移動・局の選択・一覧へ戻るだけ）。
import { tileHTML, backHTML, formulaHTML } from './render.js';
import { paifuRules } from '../engine/paifu.js';
import { createReviewSession, publicSummary, entryFromIndex, relSeat, SEAT_POS } from './paifu-review.js';

const PAGE = 10; // 一覧の詳細（相手・順位）を読む行数（「さらに表示」で増やす）
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MODE = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
const STATUS = { complete: '完走', aborted: '中断', recording: '記録途中' };
const STATUS_NOTE = { complete: '最後まで対局', aborted: '途中で終了（未精算の局はそのまま）', recording: '保存の後に終わっていない対局（ページを閉じた等）' };
const TERM = { 'left-match': 'タイトルへ戻った・相手を変更', reset: '新しい対局・再戦', 'recording-error': '記録できない操作' };
const LOAD_ERROR = {
  'not-found': 'この牌譜は削除されています（別のタブなど）。',
  corrupt: 'この牌譜は壊れているため再生できません。',
  'unsupported-version': 'この牌譜は別の版の形式のため、この版では再生できません。',
  unavailable: 'この端末では牌譜を読み込めません（ブラウザの設定・プライベートモードなど）。',
  timeout: '読み込みに時間がかかりすぎました。もう一度お試しください。',
  conflict: '読み込みの間にこの牌譜が更新されました（別のタブなど）。もう一度開いてください。',
  gone: 'この牌譜は削除されました（別のタブなど）。一覧へ戻ります。',
  updated: 'この牌譜は別のタブで更新されました。古い内容は表示しません。一覧から開き直してください。',
  recreated: 'この牌譜は削除され、同じ番号で別の牌譜が保存されました。古い内容は表示しません。一覧から開き直してください。',
};
const loadError = (code) => LOAD_ERROR[code] || '読み込めませんでした。もう一度お試しください。';
const fmtDate = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

// 一覧の詳細の読込の排他（モジュールで1つ）：画面の作り直し（タイトルへ戻って再び開く）をまたいでも、
// 詳細の loadPrivate は同時に1件だけ。古い画面の処理は、閉じた後は次の読込を始めない（下の closed）
let detailTail = Promise.resolve();
function detailLock(fn) {
  const run = detailTail.then(fn, fn);
  detailTail = run.then(() => {}, () => {}); // 失敗しても列は止めない
  return run;
}

// sys：createPaifuSystem() の戻り値（store だけ使う）。onChange：再描画の依頼
export function createReviewUI({ sys, onChange = () => {} }) {
  let gen = 0; // 画面の世代（古い非同期の結果を捨てる）
  let closed = false; // close() の後：この画面の処理は何も始めず、結果も反映しない
  const changed = () => { if (closed) return; try { onChange(); } catch { /* 無視 */ } };
  const st = {
    view: 'list',
    list: { loading: true, error: null, entries: [], unreadable: 0, shown: PAGE, details: new Map(), notice: null },
    opening: null, // 読込中の id
    viewer: null, // { session, rules, ri, frames, k, loading, error }
  };

  // ---- 一覧 ----
  async function loadList() {
    if (closed) return;
    const my = ++gen;
    st.view = 'list'; st.viewer = null; st.opening = null;
    st.list = { ...st.list, loading: true, error: null };
    changed();
    let r;
    try { r = await sys.store.list(); } catch { r = { ok: false, error: { code: 'storage-error' } }; }
    if (my !== gen || closed) return;
    if (!r.ok) { st.list = { ...st.list, loading: false, error: r.error.code, entries: [] }; changed(); return; }
    const ids = new Set(r.entries.map((e) => `${e.id}:${e.token}`));
    for (const k of [...st.list.details.keys()]) if (!ids.has(k)) st.list.details.delete(k); // 削除・更新された行の要約を捨てる
    st.list = { ...st.list, loading: false, entries: r.entries.map((e) => ({ ...entryFromIndex(e), key: `${e.id}:${e.token}` })), unreadable: r.unreadable };
    changed();
    pumpDetails();
  }
  // 表示中の行の要約を作る：1本の処理の列（同時に1件だけ読み込み・検証する。検証は Worker。記録は要約の後に手放す）。
  // 毎回いまの一覧から「表示中で要約のない行」を選ぶので、一覧の読み直し・画面の移動・「さらに表示」の連打でも
  // 並行して読まず、古い要求が新しい一覧の要約を消すこともない（要約は「ID:トークン」ごとで、要求の番号で照合する）
  let pumping = false, reqSeq = 0;
  const wanted = () => !closed && st.view === 'list' && !st.list.loading && !st.list.error;
  const nextEntry = () => st.list.entries.slice(0, st.list.shown).find((x) => !st.list.details.has(x.key));
  async function pumpDetails() {
    if (pumping || closed) return;
    pumping = true;
    try {
      for (;;) {
        if (!wanted()) return;
        const e = nextEntry();
        if (!e) return;
        const req = ++reqSeq;
        st.list.details.set(e.key, { loading: true, req });
        changed();
        let r;
        try {
          // 排他の中で、読む直前にもう一度確かめる（閉じた・一覧が読み直されて要らなくなった行は読まない）
          r = await detailLock(() => {
            const cur = st.list.details.get(e.key);
            if (closed || !cur || cur.req !== req) return null;
            return sys.store.loadPrivate(e.id);
          });
        } catch { r = { ok: false, error: { code: 'storage-error' } }; }
        if (closed) return; // 閉じた画面には反映しない（新しい画面は別のインスタンスで読み直す）
        const cur = st.list.details.get(e.key);
        if (!cur || cur.req !== req) continue; // 一覧の読み直しで捨てられた行（新しい要求の loading は消さない）
        if (r === null) { st.list.details.delete(e.key); continue; }
        try {
          if (r.ok && `${r.metadata.id}:${r.metadata.token}` !== e.key) { st.list.details.set(e.key, { ok: false, code: 'changed' }); loadList(); return; } // 読む間に更新された
          st.list.details.set(e.key, r.ok ? { ok: true, summary: publicSummary(r.record) } : { ok: false, code: r.error.code });
        } catch { st.list.details.set(e.key, { ok: false, code: 'corrupt' }); }
        changed();
        if (!r.ok && (r.error.code === 'not-found' || r.error.code === 'conflict')) { loadList(); return; } // 読む間に削除・更新された
      }
    } finally {
      pumping = false;
      // 処理中に一覧が読み直された・行が増えたときは、続きを読む（同時に動くのは常に1本）
      queueMicrotask(() => { if (wanted() && nextEntry()) pumpDetails(); });
    }
  }

  // ---- 再生 ----
  async function open(id) {
    if (st.opening || closed) return; // 二度開き：読込中は受け付けない
    const e = st.list.entries.find((x) => x.id === id);
    if (!e) return;
    const my = ++gen;
    st.opening = id; st.list.notice = null;
    changed();
    let r;
    try { r = await sys.store.loadPrivate(id); } catch { r = { ok: false, error: { code: 'storage-error' } }; }
    if (my !== gen || closed) return;
    st.opening = null;
    if (!r.ok) {
      st.list.notice = { id, text: loadError(r.error.code) };
      st.list.details.set(e.key, { ok: false, code: r.error.code });
      if (r.error.code === 'not-found' || r.error.code === 'conflict') { loadList(); return; }
      changed();
      return;
    }
    let session;
    try { session = createReviewSession(r.record); } catch { st.list.notice = { id, text: loadError('corrupt') }; changed(); return; }
    if (!session.info.roundList.length) { st.list.notice = { id, text: 'この牌譜には再生できる局がありません（局が始まる前に終了）。' }; changed(); return; }
    st.view = 'viewer';
    // 開いたときの同一性（ID・トークン・版・削除の世代）。局を開くたびに DB の現在の値と比べる
    st.viewer = { session, rules: paifuRules(session.info.mode), ri: 0, frames: null, k: 0, loading: true, error: null,
      id, token: r.metadata.token, revision: r.metadata.revision, epoch: r.epoch };
    changed();
    await gotoRound(0, 0, my);
  }
  // 局 ri へ（at：'first' か 'last' か時点の番号）
  async function gotoRound(ri, at = 0, my = ++gen) {
    const v = st.viewer;
    if (!v) return;
    v.ri = ri; v.loading = true; v.error = null;
    changed();
    let frames = null;
    try { frames = await v.session.framesAsync(ri, { isCancelled: () => my !== gen || st.viewer !== v }); } catch { frames = null; v.error = '再生できませんでした（記録と再生が一致しません）。'; }
    if (my !== gen || st.viewer !== v) return;
    // 局を開くたびに、開いたときと同じ牌譜がまだ保存されているかを DB で確かめる（BroadcastChannel に依存しない）。
    // 削除・更新・全件削除の後の同じ ID の作り直しのどれでも、古い記録の局面は表示せず一覧へ戻る
    const same = await sameRecord(v);
    if (my !== gen || st.viewer !== v || closed) return;
    if (same !== 'same' && same !== 'unknown') { st.list.notice = { id: v.id, text: loadError(same) }; loadList(); return; }
    v.loading = false;
    if (frames) { v.frames = frames; v.k = at === 'last' ? frames.length - 1 : Math.max(0, Math.min(at, frames.length - 1)); }
    changed();
  }
  // 表示中の牌譜が、開いたときと同じ保存のままか。'same'／'gone'（削除）／'updated'（同じ ID の更新）／
  // 'recreated'（全件削除の後に同じ ID で新しく保存）／'unknown'（DB の一時的な失敗：表示中の局は続ける）
  async function sameRecord(v) {
    if (typeof sys.store.stat !== 'function') return 'unknown';
    let r;
    try { r = await sys.store.stat(v.id); } catch { return 'unknown'; }
    if (!r.ok) return r.error.code === 'not-found' ? 'gone' : 'unknown';
    if (r.metadata.token === v.token) return 'same'; // トークンは保存ごとに新しい乱数（同じなら同じ保存）
    return Number.isSafeInteger(v.epoch) && r.epoch !== v.epoch ? 'recreated' : 'updated';
  }
  function move(d) {
    const v = st.viewer;
    if (!v || v.loading || !v.frames) return;
    const k = v.k + d;
    if (k >= 0 && k < v.frames.length) { v.k = k; changed(); return; }
    const n = v.session.info.roundList.length;
    if (k < 0 && v.ri > 0) gotoRound(v.ri - 1, 'last');
    else if (k >= v.frames.length && v.ri < n - 1) gotoRound(v.ri + 1, 0);
  }

  // ---- 描画 ----
  function listHTML() {
    const L = st.list;
    let body;
    if (L.loading) body = '<p class="pr-note" aria-live="polite">読み込み中…</p>';
    else if (L.error) body = `<p class="pr-note pr-error">${L.error === 'unavailable' ? 'この端末では牌譜を確認できません（ブラウザの設定・プライベートモードなど）。' : '牌譜の一覧を読み込めませんでした。'}対局はできます。</p>`;
    else if (!L.entries.length) body = '<p class="pr-note">保存された牌譜はありません。通常対局を遊ぶと自動で記録されます。</p>';
    else {
      body = `<ol class="pr-list">${L.entries.slice(0, L.shown).map(entryHTML).join('')}</ol>`
        + (L.entries.length > L.shown ? `<button class="pr-more" data-action="pr-more">さらに表示（残り${L.entries.length - L.shown}件）</button>` : '');
    }
    const unread = L.unreadable ? `<p class="pr-note">読めない記録が${L.unreadable}件あります（壊れている・別の版の形式）。一覧には出しません。</p>` : '';
    return `<main class="pr-screen pr-list-screen" aria-label="牌譜の一覧">
      <header class="pr-head"><button class="pr-back" data-action="pr-exit">← タイトルへ</button><h1>牌譜を振り返る</h1></header>
      <p class="pr-note">この端末のブラウザ内だけに保存された通常対局の牌譜です（送信しません）。再生中は自分の手牌と、各時点で公開されていた情報だけを表示します。</p>
      ${L.notice ? `<p class="pr-note pr-error" role="alert">${esc(L.notice.text)}</p>` : ''}
      ${unread}${body}
    </main>`;
  }
  function entryHTML(e) {
    const d = st.list.details.get(e.key);
    const s = d && d.ok ? d.summary : null;
    const opp = s ? s.players.filter((x) => !x.human).map((x) => esc(x.name)).join('・') : d && d.loading ? '確認中…' : '';
    const result = s && s.final ? `<span class="pr-rank">${s.final.myRank}位</span><span class="pr-score">${s.final.myScore}点</span>` : '';
    const bad = d && d.ok === false ? `<span class="pr-bad">${esc(d.code === 'unsupported-version' ? '非対応の形式' : d.code === 'corrupt' ? '破損' : d.code === 'not-found' ? '削除済み' : '確認できません')}</span>` : '';
    const term = s && s.termination ? `（${esc(TERM[s.termination] || '')}）` : '';
    const busy = st.opening === e.id;
    return `<li><button class="pr-entry st-${e.status}" data-action="pr-pick" data-id="${esc(e.id)}"${st.opening ? ' disabled' : ''} aria-label="${esc(fmtDate(s ? s.createdAt : e.savedAt))} ${MODE[e.mode]} ${e.length}局戦 ${STATUS[e.status]}">
      <span class="pr-line1"><span class="pr-date">${esc(fmtDate(s ? s.createdAt : e.savedAt))}</span><span class="pr-mode">${MODE[e.mode]}</span><span class="pr-len">${e.length}局戦</span><span class="pr-status st-${e.status}" title="${esc(STATUS_NOTE[e.status])}">${STATUS[e.status]}</span>${result}</span>
      <span class="pr-line2"><span class="pr-opp">${opp ? `相手：${opp}` : ''}</span><span class="pr-rounds">${e.rounds}局${term}</span>${bad}${busy ? '<span class="pr-busy">読み込み中…</span>' : ''}</span>
    </button></li>`;
  }

  const T = () => st.viewer.rules.types;
  const tile = (t, size = 'xs', cls = '') => tileHTML(T()[t], { size, cls });
  function seatName(seat) {
    const info = st.viewer.session.info;
    return seat === info.me ? 'あなた' : `${SEAT_POS[relSeat(seat, info.me)]} ${esc(info.players[seat].name)}`;
  }
  function eventText(e, f) {
    const who = (s) => seatName(s);
    switch (e.type) {
      case 'draw': return e.seat === st.viewer.session.info.me ? `あなた：ツモ ${f.drawn !== null ? tile(f.drawn) : ''}` : null;
      case 'discard': return `${who(e.seat)}：打 ${tile(e.tile)}${e.riichi ? '<b class="pr-riichi">リーチ</b>' : ''}${e.tsumogiri ? '<small>ツモ切り</small>' : ''}`;
      case 'chi': case 'pon': return `${who(e.seat)}：<b>${e.type === 'chi' ? 'チー' : 'ポン'}</b>（${who(e.from)}の ${tile(e.tile)}）`;
      case 'ankan': return `${who(e.seat)}：<b>暗カン</b> ${tile(e.tile)}×4`;
      case 'dora': return `新しいドラ表示牌 ${tile(e.indicator)}`;
      case 'win': return `${who(e.seat)}：<b class="pr-win">${e.how === 'ron' ? 'ロン' : 'ツモ'}</b>`;
      case 'exhaustive-draw': return '<b>流局</b>';
      case 'abortive-draw': return '<b>途中流局（四家立直）</b>';
      default: return null; // riichi は打牌に含める・rinshan は省略
    }
  }
  function mineText(m) {
    if (!m) return '';
    const auto = m.source === 'auto-pass' ? '（自動パス）' : m.source === 'auto-tsumogiri' ? '（自動ツモ切り）' : '';
    const name = { discard: '打牌', pass: '見送り', chi: 'チー', pon: 'ポン', ron: 'ロン', tsumo: 'ツモ', ankan: '暗カン' }[m.type];
    return `<p class="pr-mine">あなたの判断：<b>${name}</b>${m.type === 'discard' && m.tile !== null ? ` ${tile(m.tile)}` : ''}${m.riichi ? '（リーチ宣言）' : ''}${auto}</p>`;
  }
  function pendingText(f) {
    const info = st.viewer.session.info;
    const p = f.pending;
    if (!p) return ''; // 局の終わり（時点は安定した点だけなので、他家の判断待ちの時点はない）
    if (p.type === 'turn') return `<p class="pr-next">次：${p.seat === info.me ? '<b>あなたの手番</b>' : `${seatName(p.seat)}の手番`}</p>`;
    const opts = [p.ron ? 'ロン' : null, p.pon ? 'ポン' : null, p.chi ? 'チー' : null].filter(Boolean).join('・');
    return `<p class="pr-next">次：<b>あなたの判断</b>（${seatName(p.from)}の ${tile(p.tile)}：${opts}／見送り）</p>`;
  }
  function meldsHTML(ms, size = 'xs') {
    return ms.map((m) => `<span class="pr-meld ${m.call}" title="${m.call === 'ankan' ? '暗カン' : m.call === 'pon' ? 'ポン' : 'チー'}">${m.tiles.map((t, i) => tile(t, size, i === m.claimed ? 'claimed' : '')).join('')}</span>`).join('');
  }
  function riverHTML(r) {
    return r.map((x) => tile(x.tile, 'xs', [x.tsumogiri ? 'tsumogiri' : '', x.riichi ? 'riichi-decl' : ''].join(' '))).join('');
  }
  function seatHTML(f, seat) {
    const info = st.viewer.session.info;
    const me = seat === info.me;
    // 数学Ⅱだけ：通常ツモの上限（各24回）の残り。数学Ⅰには上限がないので出さない
    const draws = info.mode === 'math2' && f.normalDraws ? `<span class="pr-draws" title="数学Ⅱ：通常ツモの残り（各24回）">ツモ残${Math.max(0, 24 - f.normalDraws[seat])}</span>` : '';
    return `<section class="pr-seat${me ? ' me' : ''}${f.pending && f.pending.type === 'turn' && f.pending.seat === seat ? ' active' : ''}" aria-label="${me ? 'あなた' : seatName(seat)}">
      <div class="pr-tag"><span class="pr-pos">${me ? '自分' : SEAT_POS[relSeat(seat, info.me)]}</span><span class="pr-name">${me ? 'あなた' : esc(info.players[seat].name)}</span>
        <span class="pr-pts">${f.scores[seat]}<small>点</small></span>${f.dealer === seat ? '<span class="oya">親</span>' : ''}${f.riichi[seat] ? '<span class="pr-rb">リーチ</span>' : ''}${draws}
        ${me ? '' : `<span class="pr-backs" title="手牌${f.handCounts[seat]}枚（中身は表示しません）">${backHTML(f.handCounts[seat])}</span>`}</div>
      ${f.melds[seat].length ? `<div class="pr-melds">${meldsHTML(f.melds[seat])}</div>` : ''}
      <div class="pr-river" aria-label="河">${riverHTML(f.rivers[seat]) || '<span class="pr-empty">河なし</span>'}</div>
    </section>`;
  }
  function handHTML(f) {
    const s = f.self;
    const fur = s.furiten.length ? `<span class="pr-furiten">フリテン（${s.furiten.map((r) => ({ discard: '捨て牌に待ち', temporary: '見逃し', riichi: 'リーチ後の見逃し' })[r]).join('・')}）</span>` : '';
    const waits = s.waits ? `<span class="pr-waits">待ち ${s.waits.map((t) => tile(t)).join('')}</span>` : '';
    return `<section class="pr-hand" aria-label="あなたの手牌">
      <div class="pr-hand-tiles">${f.hand.map((t) => tile(t, 's')).join('')}${f.drawn !== null ? `<span class="pr-drawn">${tile(f.drawn, 's', 'drawn')}</span>` : ''}</div>
      ${f.melds[st.viewer.session.info.me].length ? `<div class="pr-melds">${meldsHTML(f.melds[st.viewer.session.info.me], 's')}</div>` : ''}
      <p class="pr-self">${s.closed ? '門前' : '鳴き'}${waits}${fur}</p>
    </section>`;
  }
  function resultHTML(f) {
    const r = f.result;
    if (!r) return '';
    const info = st.viewer.session.info;
    const R = st.viewer.rules;
    let head;
    if (r.win) {
      const w = r.win;
      const how = w.how === 'ron' ? `ロン（${seatName(w.from)}から）` : 'ツモ';
      const forms = w.kind === 'special' ? `<p>特殊和了</p><div class="pr-tiles">${w.hand.map((t) => tile(t, 's')).join('')}</div>`
        : `<ol class="pr-forms">${w.melds.map((mi) => `<li>${R.melds[mi].tiles.map((t) => tile(t, 's')).join('')}${formulaHTML(R, mi)}</li>`).join('')}</ol>`;
      const yaku = [...(w.yakuman ? [] : [`<li><span>通常和了</span><b>${w.base}</b></li>`]), ...w.yaku.map((y) => `<li><span>${esc(y.name)}${y.yakuman ? '（役満）' : ''}</span><b>${w.yakuman ? '' : '+'}${y.points}</b></li>`),
        ...(w.yakuman ? [] : [`<li><span>ドラ ${w.doraBonus}枚</span><b>+${w.doraBonus}</b></li>`]), `<li class="total"><span>合計</span><b>${w.points}点</b></li>`].join('');
      head = `<h3>${seatName(w.winner)}の和了 <small>${how}</small></h3>${forms}<ul class="pr-yaku">${yaku}</ul>`;
    } else {
      head = `<h3>${r.draw.reason === 'four-riichi' ? '途中流局（四家立直）' : '流局'}</h3><p class="pr-note">${r.draw.reason === 'four-riichi' ? '4人全員のリーチが成立しました。この局のリーチ宣言料は宣言者へ返します。' : r.draw.math2Cap ? `数学Ⅱの通常ツモの上限に達しました（山の残り${r.draw.wallLeft}枚）。` : '山の牌がなくなりました。'}得点の移動はありません。</p>`;
    }
    const sign = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : '±0');
    const before = r.scoresAfter.map((x, i) => x - r.deltas[i]);
    const pot = r.potWon ? `<p class="pr-note">供託 ${r.potWon}点は和了者へ。</p>` : r.potAfter ? `<p class="pr-note">供託 ${r.potAfter}点は次の局へ持ち越し。</p>` : '';
    const ret = r.potReturned && r.potReturned.some(Boolean) ? '<p class="pr-note">試合終了のため、残った供託は宣言者へ返しました。</p>' : '';
    const table = `<table class="pr-scores"><tr><th></th>${[0, 1, 2, 3].map((s) => `<th>${s === info.me ? 'あなた' : esc(info.players[s].name)}</th>`).join('')}</tr>
      <tr><th>局前</th>${before.map((x) => `<td>${x}</td>`).join('')}</tr>
      <tr><th>増減</th>${r.deltas.map((x) => `<td class="${x > 0 ? 'plus' : x < 0 ? 'minus' : ''}">${sign(x)}</td>`).join('')}</tr>
      <tr><th>局後</th>${r.scoresAfter.map((x) => `<td>${x}</td>`).join('')}</tr></table>`;
    const next = r.over ? `<p class="pr-next"><b>試合終了</b>${r.endReason === 'agari-yame' ? '（アガリやめ）' : r.endReason === 'round-limit' ? '（局数の上限）' : ''}</p>`
      : r.next ? `<p class="pr-next">次：${esc(r.next.label)}${r.next.renchan ? `（連荘${r.next.renchan}）` : ''}・親は${seatName(r.next.dealer)}</p>` : '';
    return `<section class="pr-result" aria-label="局の結果">${head}<h4>精算</h4>${table}${pot}${ret}${next}</section>`;
  }
  function viewerHTML() {
    const v = st.viewer;
    const info = v.session.info;
    const rounds = info.roundList.map((r) => `<button class="pr-round${r.index === v.ri ? ' on' : ''}" data-action="pr-round" data-round="${r.index}" aria-pressed="${r.index === v.ri}">${esc(r.label)}${r.renchan ? `<small>連${r.renchan}</small>` : ''}${r.settled ? '' : '<small>未精算</small>'}</button>`).join('');
    const head = `<header class="pr-head"><button class="pr-back" data-action="pr-list">← 一覧へ</button><h1>${MODE[info.mode]}・${info.length}局戦</h1><span class="pr-status st-${info.status}">${STATUS[info.status]}</span><button class="pr-back pr-exit" data-action="pr-exit">タイトルへ</button></header>
      <nav class="pr-rounds" aria-label="局の選択">${rounds}</nav>`;
    if (v.error) return `<main class="pr-screen pr-viewer">${head}<p class="pr-note pr-error" role="alert">${v.error}</p></main>`;
    if (v.loading || !v.frames) return `<main class="pr-screen pr-viewer">${head}<p class="pr-note" aria-live="polite">局面を準備しています…</p></main>`;
    const f = v.frames[v.k];
    const r = info.roundList[v.ri];
    const lines = f.index === 0 ? [`配牌（親：${seatName(f.dealer)}）`] : f.events.map((e) => eventText(e, f)).filter(Boolean);
    const unsettled = !r.settled && v.k === v.frames.length - 1 ? `<p class="pr-note pr-warn">この局は${info.status === 'aborted' ? '中断' : '記録途中'}のため、ここまでです（未精算・結果なし）。</p>` : '';
    const dora = f.dora.length ? `<span class="pr-dora">ドラ表示 ${f.dora.map((d) => tile(d.type)).join('')}</span>` : '';
    const order = [1, 2, 3].map((k) => (info.me + k) % 4); // 下家・対面・上家
    const atFirst = v.ri === 0 && v.k === 0, atLast = v.ri === info.roundList.length - 1 && v.k === v.frames.length - 1;
    return `<main class="pr-screen pr-viewer">${head}
      <div class="pr-state"><b>${esc(r.label)}</b>${r.renchan ? `<span>連荘${r.renchan}</span>` : ''}<span>残り${f.wallCount}枚</span><span>供託${f.pot}点</span>${dora}</div>
      <section class="pr-step" aria-live="polite"><p class="pr-count">${v.k + 1} / ${v.frames.length}</p>
        <div class="pr-events">${lines.map((x) => `<p>${x}</p>`).join('')}</div>${mineText(f.mine)}${pendingText(f)}${unsettled}</section>
      ${order.map((s) => seatHTML(f, s)).join('')}
      ${seatHTML(f, info.me)}
      ${handHTML(f)}
      ${resultHTML(f)}
      <nav class="pr-nav" aria-label="再生の操作">
        <button data-action="pr-first" ${v.k === 0 ? 'disabled' : ''} aria-label="この局の最初へ">⏮</button>
        <button data-action="pr-prev" ${atFirst ? 'disabled' : ''} aria-label="前の判断へ">◀ 前</button>
        <button data-action="pr-next" ${atLast ? 'disabled' : ''} aria-label="次の判断へ">次 ▶</button>
        <button data-action="pr-last" ${v.k === v.frames.length - 1 ? 'disabled' : ''} aria-label="この局の最後（精算）へ">⏭</button>
      </nav>
    </main>`;
  }

  return Object.freeze({
    open: () => loadList(),
    html: () => (st.view === 'viewer' && st.viewer ? viewerHTML() : listHTML()),
    closed: () => closed,
    // 操作：処理したら true。'exit' はタイトルへ戻る合図（app.js が画面を切り替える）
    handle(act, data = {}) {
      if (closed) return false;
      switch (act) {
        case 'pr-pick': open(String(data.id || '')); return true;
        case 'pr-more': st.list.shown += PAGE; changed(); pumpDetails(); return true;
        case 'pr-list': loadList(); return true;
        case 'pr-round': { const n = Number(data.round); if (st.viewer && Number.isSafeInteger(n) && n >= 0 && n < st.viewer.session.info.roundList.length && n !== st.viewer.ri) gotoRound(n, 0); return true; }
        case 'pr-prev': move(-1); return true;
        case 'pr-next': move(1); return true;
        case 'pr-first': if (st.viewer && st.viewer.frames && !st.viewer.loading) { st.viewer.k = 0; changed(); } return true;
        case 'pr-last': if (st.viewer && st.viewer.frames && !st.viewer.loading) { st.viewer.k = st.viewer.frames.length - 1; changed(); } return true;
        default: return false;
      }
    },
    key(k) { if (st.view !== 'viewer') return false; if (k === 'ArrowLeft') { move(-1); return true; } if (k === 'ArrowRight') { move(1); return true; } return false; },
    // 画面を離れる：進行中の読込の結果を捨て、記録への参照を手放す
    close() { closed = true; gen++; st.viewer = null; st.opening = null; st.view = 'closed'; },
    // テスト用（ローカルの検証だけ）：表示中の状態の公開してよい要約
    debug: () => ({ view: st.view, ri: st.viewer ? st.viewer.ri : null, k: st.viewer ? st.viewer.k : null, frames: st.viewer && st.viewer.frames ? st.viewer.frames.length : null,
      loading: st.viewer ? st.viewer.loading : st.list.loading, entries: st.list.entries.length, details: [...st.list.details.values()].filter((d) => d.ok).length }),
  });
}
