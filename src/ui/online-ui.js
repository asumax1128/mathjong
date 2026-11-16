// オンライン対戦の画面（段階1：ロビーまで・docs/79「7.1」）。app.js がタイトルの「オンライン対戦」で動的 import する。
// Firebase SDK はこの画面に入ったときだけ読み込む（online-transport.js）。読込・接続に失敗しても、この画面に文で示すだけで、
// オフラインの通常対局・初心者の部屋・牌譜には影響しない（app.js の状態 S には触れない）。
// 画面：接続中 → （停止中／読込失敗）→ ニックネーム（初回）→ メニュー（作る／入る）→ ロビー → 開始済み（段階1の終点）
import { NAME_KEY, NAME_MAX, ROOM_KEY, ONLINE_PUBLIC, MODES, LENGTHS, modeLabel, normalizeName, normalizeCode } from './online-config.js';
import { createFirebaseTransport } from './online-transport.js';
import { isEnabled, createRoom, joinRoom, changeSettings, startMatch, leaveRoom, enterPresence, watchRoom, setCpu, CPU_AUTO, reopenLobby } from './online-lobby.js';
import { OPPONENTS } from './opponents.js';
import { createHostSession, createGuestSession, loadResume, hostWaitState, HOST_GRACE_MS, AWAY_AFTER_MS } from './online-session.js';
import * as proto from './online-protocol.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEN_LABEL = { 1: '1局戦', 4: '4局戦', 8: '8局戦' };
const CLOSED_TEXT = {
  'host-left': '部屋が閉じられました（ホストが退出しました）。',
  'host-timeout': 'ホストが90秒以内に戻らなかったため、試合は途中で終了しました（結果は確定しません）。',
  'rematch-out': '再戦は「もう一戦」を押した人だけで始まりました。この部屋からは抜けました。',
};

function errorText(e, appVersion) {
  const code = e && e.code;
  switch (code) {
    case 'bad-code': return '部屋コードは6文字です（英大文字と数字。I・O・0・1 は使いません）。';
    case 'not-found': return 'その部屋は見つかりません。コードを確かめてください。';
    case 'full': return 'その部屋は満席です（4人）。';
    case 'expired': return 'その部屋は期限切れです（作成から12時間）。';
    case 'started': return 'その部屋はもう対局が始まっています。';
    case 'version': return `版が違うため入れません（この端末 v${appVersion}／部屋 v${e.detail || '?'}）。ページを再読み込みしてから入り直してください。`;
    case 'bad-name': return `ニックネームは1〜${NAME_MAX}文字で入力してください。`;
    case 'need-two': return '開始には人間が2人以上必要です。';
    case 'not-host': return '設定の変更と開始はホストだけができます。';
    default: return '通信できませんでした。時間をおいてやり直してください。';
  }
}

// store：{ get(k, d), set(k, v) }（app.js の localStorage の窓口）。root：#app。rerender：app.js の render。onExit：タイトルへ戻る
// game：app.js の対局画面の窓口（enter・update・leave・rulesFor）。hostOptions：進行役の設定（CPU の待ち時間など）
export function createOnlineUI({ appVersion, emulator = false, store, root, rerender, onExit, connect = createFirebaseTransport, game = null, hostOptions = {} }) {
  const st = {
    screen: 'connecting', // connecting | load-failed | disabled | name | menu | lobby | started | closed
    name: normalizeName(store.get(NAME_KEY, '')),
    error: null, errorKind: null, busy: false,
    mode: 'math1', length: 4, codeDraft: '',
    view: null, code: null, closedReason: null,
  };
  const graceMs = hostOptions.graceMs ?? HOST_GRACE_MS; // ホストの復帰の猶予（試験用に短くできる）
  let isHostSession = false;
  let t = null;
  let unwatch = null;
  let session = null; // 対局中のつなぎ（ホスト：createHostSession／ゲスト：createGuestSession）
  let alive = true;
  const redraw = () => { if (alive) rerender(); };

  async function open() {
    if (!emulator && !ONLINE_PUBLIC) { st.screen = 'disabled'; redraw(); return; } // ONLINE_PUBLIC が false なら本番に接続しない（段階4で true）
    try {
      t = await connect({ emulator });
    } catch {
      if (!alive) return;
      st.screen = 'load-failed'; redraw(); return;
    }
    if (!alive) { t.close(); return; }
    if (!(await isEnabled(t))) { st.screen = 'disabled'; redraw(); return; }
    st.screen = st.name ? 'menu' : 'name';
    redraw();
    if (st.name) await resume();
  }

  // 段階3：同じ端末で入り直す（docs/79「8.2」「8.3」）。前に入っていた部屋に自分の席があれば戻る。
  // ホストは記録の再生で試合を続きから（猶予の90秒を過ぎていれば途中終了）。ゲストは最新の配信から描き直す
  async function resume() {
    const code = normalizeCode(store.get(ROOM_KEY, ''));
    if (!code || !alive) return;
    st.busy = true; redraw();
    try {
      const r = await joinRoom(t, { code, name: st.name, appVersion });
      const meta = r.meta;
      if (meta.status === 'lobby' || meta.hostUid !== t.uid) { st.busy = false; enterLobby(code); return; }
      // ホスト：続きから
      const wait = hostWaitState(meta, t.now(), graceMs);
      if (wait && wait.expired) {
        await t.remove(`rooms/${code}`).catch(() => {});
        store.set(ROOM_KEY, '');
        st.busy = false; st.code = null; st.closedReason = 'host-timeout'; st.screen = 'closed'; redraw();
        return;
      }
      const data = await loadResume(t, code);
      st.busy = false;
      if (!data) { enterLobby(code); return; }
      st.code = code;
      enterLobby(code);
      beginHostGame({ mode: meta.mode, length: meta.length, seats: data.seats, seedBase: data.seedBase, startDealer: data.startDealer }, data);
    } catch {
      store.set(ROOM_KEY, '');
      st.busy = false;
    }
    redraw();
  }

  function setError(e) { st.error = errorText(e, appVersion); st.errorKind = e && e.code; }

  function enterLobby(code) {
    st.code = code; st.view = null; st.screen = 'lobby'; st.error = null; st.closedReason = null;
    store.set(ROOM_KEY, code);
    if (unwatch) unwatch();
    unwatch = watchRoom(t, code, (v) => {
      st.view = v;
      if (v.closed) { stopWatch(); const wasGame = st.screen === 'game'; endGame(); store.set(ROOM_KEY, ''); st.closedReason = wasGame && st.closedReason === 'host-wait' ? 'host-timeout' : 'host-left'; st.screen = 'closed'; }
      else if (v.meta.status === 'lobby' && st.screen === 'game') {
        // 再戦：ホストが部屋をロビーへ戻した。もう一戦を押していれば（席があれば）ロビーへ、なければ部屋から抜ける
        endGame();
        if (v.removed) { stopWatch(); store.set(ROOM_KEY, ''); st.closedReason = 'rematch-out'; st.screen = 'closed'; }
        else st.screen = 'lobby';
      }
      else if (v.removed && st.screen === 'lobby') { stopWatch(); store.set(ROOM_KEY, ''); st.screen = 'closed'; }
      else if (v.meta.status !== 'lobby' && st.screen === 'lobby' && !v.isHost) beginGuestGame(v);
      else if (v.meta.status !== 'lobby' && st.screen === 'lobby' && v.isHost && !st.busy && !session) st.screen = 'started';
      // ホストの切断（ゲストの画面）：paused の間は「ホストの復帰を待っています（残り時間）」。猶予を過ぎたら途中終了
      if (st.screen === 'game' && !isHostSession && game && game.setHostWait) {
        const w = hostWaitState(v.meta, t.now(), graceMs);
        if (w) st.closedReason = 'host-wait';
        else if (st.closedReason === 'host-wait') st.closedReason = null;
        game.setHostWait(w ? { deadline: w.deadline } : null);
      }
      redraw();
    });
    enterPresence(t, code).catch(() => {});
  }
  function stopWatch() { if (unwatch) { unwatch(); unwatch = null; } }

  // ---- 対局（段階2）：ホストは進行役を動かし、ゲストは配信を受ける。画面は app.js の卓（RemoteTable）----
  // restore：ホストの再読み込みからの復帰（loadResume の値）。記録の再生で続きから
  function beginHostGame(r, restore = null) {
    if (!game) { st.screen = 'started'; return; }
    const mySeat = r.seats.findIndex((x) => x.kind === 'human' && x.uid === t.uid);
    const rules = game.rulesFor(r.mode);
    st.screen = 'game';
    isHostSession = true;
    game.enter({ proto, mode: r.mode, length: r.length, mySeat, send: (a) => session && session.send(a), leave: leaveGame, now: () => t.now(), rematch: hostRematch, isHost: true });
    session = createHostSession(t, st.code, {
      rules, mode: r.mode, length: r.length, seats: r.seats, seedBase: r.seedBase, startDealer: r.startDealer, mySeat, restore,
      cpuDelay: { turn: hostOptions.cpuDelayMs ?? 600 }, awayMs: hostOptions.awayMs ?? AWAY_AFTER_MS, onView: (pub, priv) => game.update(pub, priv),
    });
    session.start();
  }
  function beginGuestGame(v) {
    if (!game || v.mySeat === null) { st.screen = 'started'; return; }
    const mySeat = v.mySeat;
    st.screen = 'game';
    isHostSession = false;
    game.enter({ proto, mode: v.meta.mode, length: v.meta.length, mySeat, send: (a) => session && session.send(a), leave: leaveGame, now: () => t.now(), rematch: () => session && session.send({ type: 'ready' }), isHost: false });
    session = createGuestSession(t, st.code, mySeat, { onView: (pub, priv) => game.update(pub, priv) });
    const w = hostWaitState(v.meta, t.now(), graceMs);
    if (w && game.setHostWait) game.setHostWait({ deadline: w.deadline });
  }
  function endGame() {
    if (session) { session.stop(); session = null; }
    isHostSession = false;
    if (game && st.screen === 'game') game.leave();
  }
  // 再戦（ホスト）：もう一戦を押した人とホストだけでロビーへ戻す（matchNo を進める）。押さなかった人は部屋から外れる
  function hostRematch() {
    if (!session || !session.runner) return;
    const rs = session.runner.state;
    const seats = rs.rematch ? [...rs.rematch] : [];
    const uids = seats.map((s) => (st.view && st.view.seats[s] ? st.view.seats[s].uid : null)).filter(Boolean);
    endGame();
    st.screen = 'lobby';
    run(() => reopenLobby(t, st.code, uids));
  }
  // 対局中の「部屋を出る」：ホストは部屋を閉じる（ホストの引き継ぎはしない・U3）。ゲストは離席（代打ち）にしてから抜ける（試合は続く）
  function leaveGame() {
    if (session && !isHostSession) Promise.resolve(session.send({ type: 'away' })).catch(() => {});
    endGame();
    st.screen = 'menu';
    leave().finally(redraw);
    redraw();
  }

  async function run(fn) {
    if (st.busy) return;
    st.busy = true; st.error = null; redraw();
    try { await fn(); } catch (e) { setError(e); }
    st.busy = false; redraw();
  }

  async function leave() {
    const code = st.code;
    store.set(ROOM_KEY, '');
    stopWatch();
    st.code = null; st.view = null;
    if (code && t) await leaveRoom(t, code).catch(() => {});
  }

  const val = (sel) => { const el = root.querySelector(sel); return el ? el.value : ''; };

  function handle(act, data = {}) {
    switch (act) {
      case 'ol-back': close(); onExit(); break;
      case 'ol-reload': location.reload(); break;
      case 'ol-name-save': {
        const n = normalizeName(val('#ol-name'));
        if (!n) { setError({ code: 'bad-name' }); redraw(); break; }
        st.name = n; store.set(NAME_KEY, n); st.error = null; st.screen = 'menu'; redraw(); break;
      }
      case 'ol-name-edit': st.screen = 'name'; st.error = null; redraw(); break;
      case 'ol-create':
        run(async () => { const r = await createRoom(t, { name: st.name, mode: st.mode, length: st.length, appVersion }); enterLobby(r.code); });
        break;
      case 'ol-join': {
        st.codeDraft = val('#ol-code');
        run(async () => { const r = await joinRoom(t, { code: st.codeDraft, name: st.name, appVersion }); enterLobby(r.code); });
        break;
      }
      case 'ol-start': run(async () => { const r = await startMatch(t, st.code); beginHostGame(r); }); break;
      case 'ol-leave': run(async () => { await leave(); st.screen = 'menu'; }); break;
      case 'ol-menu': st.screen = 'menu'; st.error = null; st.closedReason = null; redraw(); break;
      default: break;
    }
  }
  // ラジオ（作成時の設定・ロビーのホストの設定）
  function change(act, value, data = {}) {
    if (act === 'ol-cpu') {
      if (st.screen === 'lobby' && st.view && st.view.isHost) run(() => setCpu(t, st.code, Number(data.slot), value));
      return;
    }
    if (act !== 'ol-mode' && act !== 'ol-length') return;
    const patch = act === 'ol-mode' ? { mode: MODES.includes(value) ? value : 'math1' } : { length: LENGTHS.includes(Number(value)) ? Number(value) : 4 };
    if (st.screen === 'lobby' && st.view && st.view.isHost) run(() => changeSettings(t, st.code, patch));
    else { Object.assign(st, patch); redraw(); }
  }
  function key(ev) {
    if (ev.key !== 'Enter' || !ev.target || !ev.target.id) return false;
    if (ev.target.id === 'ol-name') { handle('ol-name-save'); return true; }
    if (ev.target.id === 'ol-code') { handle('ol-join'); return true; }
    return false;
  }

  function close() {
    endGame();
    alive = false;
    const tt = t;
    leave().finally(() => { if (tt) tt.close(); });
    t = null;
  }

  // ---- 描画 ----
  const errHTML = () => (st.error ? `<p class="ol-error" role="alert" data-kind="${esc(st.errorKind)}">${esc(st.error)}${st.errorKind === 'version' ? ' <button data-action="ol-reload" class="small">再読み込み</button>' : ''}</p>` : '');
  const radio = (name, value, label, checked, disabled) => `<label class="setting radio"><input type="radio" name="ol-${name}" value="${value}" data-action="ol-${name}" ${checked ? 'checked' : ''}${disabled ? ' disabled' : ''}><span>${label}</span></label>`;
  const settingsHTML = (mode, length, editable) => `<div class="ol-settings">
      <fieldset class="title-set"><legend>数学モード</legend>${MODES.map((m) => radio('mode', m, modeLabel(m), mode === m, !editable)).join('')}</fieldset>
      <fieldset class="title-set"><legend>対局の長さ</legend>${LENGTHS.map((l) => radio('length', l, LEN_LABEL[l], length === l, !editable)).join('')}</fieldset>
    </div>`;
  const frame = (body) => `<main class="online-screen" data-online-screen="${st.screen}"><h2 class="ol-title">オンライン対戦</h2>${body}</main>`;

  function html() {
    switch (st.screen) {
      case 'connecting': return frame('<p class="ol-note">接続しています…</p><button data-action="ol-back">タイトルへ戻る</button>');
      case 'load-failed': return frame('<p class="ol-error" role="alert">オンライン対戦の部品を読み込めませんでした。通信の状態を確かめてください。ひとりでの対局はこのまま遊べます。</p><button data-action="ol-back" class="primary">タイトルへ戻る</button>');
      case 'disabled': return frame('<p class="ol-note ol-disabled">オンライン対戦は現在お休み中です。ひとりでの対局はこのまま遊べます。</p><button data-action="ol-back" class="primary">タイトルへ戻る</button>');
      case 'name': return frame(`<label class="ol-field">ニックネーム（1〜${NAME_MAX}文字・この端末に保存）<input id="ol-name" type="text" maxlength="${NAME_MAX}" autocomplete="nickname" value="${esc(st.name || '')}"></label>
        ${errHTML()}<div class="ol-actions"><button data-action="ol-name-save" class="primary">決定</button><button data-action="ol-back">タイトルへ戻る</button></div>`);
      case 'menu': return frame(`<p class="ol-me">ニックネーム：<b class="ol-myname">${esc(st.name)}</b> <button data-action="ol-name-edit" class="small">変更</button></p>
        <section class="ol-box"><h3>部屋を作る</h3>${settingsHTML(st.mode, st.length, true)}
          <button data-action="ol-create" class="primary"${st.busy ? ' disabled' : ''}>部屋を作る</button></section>
        <section class="ol-box"><h3>部屋に入る</h3>
          <label class="ol-field">部屋コード（6文字）<input id="ol-code" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="8" value="${esc(st.codeDraft)}"></label>
          <button data-action="ol-join"${st.busy ? ' disabled' : ''}>入る</button></section>
        ${errHTML()}<button data-action="ol-back">タイトルへ戻る</button>`);
      case 'lobby': return frame(lobbyHTML());
      case 'started': return frame(startedHTML());
      case 'closed': return frame(`<p class="ol-note ol-closed" data-reason="${esc(st.closedReason || 'host-left')}">${esc(CLOSED_TEXT[st.closedReason] || CLOSED_TEXT['host-left'])}</p><button data-action="ol-menu" class="primary">メニューへ</button>`);
      default: return frame('');
    }
  }
  function seatsHTML(v) {
    return `<ol class="ol-seats">${v.seats.map((s) => (s.kind === 'human'
      ? `<li class="ol-seat human${s.me ? ' me' : ''}" data-seat="${s.seat}"><span class="ol-dot ${s.online ? 'on' : 'off'}" aria-label="${s.online ? '接続中' : '未接続'}"></span><span class="ol-name">${esc(s.name)}</span>${s.host ? '<small class="ol-tag">ホスト</small>' : ''}${s.me ? '<small class="ol-tag">あなた</small>' : ''}</li>`
      : `<li class="ol-seat cpu" data-seat="${s.seat}"><span class="ol-dot cpu"></span>${cpuLabelHTML(v, s)}</li>`)).join('')}</ol>`;
  }
  // 空席の CPU：ホストは12人から選ぶ（既定は自動）。ゲストには選択を表示だけ。開始後は決まった名前
  function cpuLabelHTML(v, s) {
    if (s.cpuId) return `<span class="ol-name">${esc(s.name)}</span><small class="ol-tag">CPU</small>`;
    const pickName = (id) => (id === CPU_AUTO ? '自動' : (OPPONENTS.find((o) => o.id === id) || {}).name || id);
    if (v.isHost && v.meta.status === 'lobby') {
      const opts = [`<option value="${CPU_AUTO}"${s.pick === CPU_AUTO ? ' selected' : ''}>自動（おまかせ）</option>`,
        ...OPPONENTS.map((o) => `<option value="${o.id}"${s.pick === o.id ? ' selected' : ''}>${esc(o.name)}（${esc(o.levelLabel)}）</option>`)].join('');
      return `<span class="ol-name">CPU（予定）</span><select class="ol-cpu" data-action="ol-cpu" data-slot="${s.slot}" aria-label="空席${s.seat + 1}の CPU"${st.busy ? ' disabled' : ''}>${opts}</select>`;
    }
    return `<span class="ol-name">CPU（予定）：${esc(pickName(s.pick || CPU_AUTO))}</span>`;
  }
  function lobbyHTML() {
    const v = st.view;
    if (!v || v.closed) return '<p class="ol-note">部屋を読み込んでいます…</p>';
    const m = v.meta;
    const hint = v.isHost ? (v.canStart ? '' : '<p class="ol-note ol-wait">開始には人間が2人以上必要です。部屋コードを伝えて待ちましょう。</p>') : '<p class="ol-note ol-wait">ホストが開始するのを待っています。</p>';
    return `<p class="ol-code-line">部屋コード <b class="ol-code" data-code="${esc(v.code)}">${esc(v.code)}</b></p>
      ${seatsHTML(v)}
      <p class="ol-note">空いている席は CPU が入ります。ルールは新ルールで固定です。</p>
      ${settingsHTML(m.mode, m.length, v.isHost && !st.busy)}
      ${hint}${errHTML()}
      <div class="ol-actions">${v.isHost ? `<button data-action="ol-start" class="primary start-btn"${v.canStart && !st.busy ? '' : ' disabled'}>開始</button>` : ''}
      <button data-action="ol-leave"${st.busy ? ' disabled' : ''}>${v.isHost ? '部屋を閉じて退出' : '退出'}</button></div>`;
  }
  function startedHTML() {
    const v = st.view;
    if (!v || v.closed) return '';
    return `<p class="ol-note ol-started" role="status">対局を開始しました（${esc(modeLabel(v.meta.mode))}・${esc(LEN_LABEL[v.meta.length] || '')}）。</p>
      <p class="ol-note">対局の画面は次の段階で用意します。</p>
      ${seatsHTML(v)}
      <div class="ol-actions"><button data-action="ol-leave">部屋を出る</button></div>`;
  }

  return { open, html, handle, change, key, close, get state() { return { ...st }; } };
}
