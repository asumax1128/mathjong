// オンライン対戦の画面（段階1：ロビーまで・docs/79「7.1」）。app.js がタイトルの「オンライン対戦」で動的 import する。
// Firebase SDK はこの画面に入ったときだけ読み込む（online-transport.js）。読込・接続に失敗しても、この画面に文で示すだけで、
// オフラインの通常対局・初心者の部屋・牌譜には影響しない（app.js の状態 S には触れない）。
// 画面：接続中 → （停止中／読込失敗）→ ニックネーム（初回）→ メニュー（作る／入る）→ ロビー → 開始済み（段階1の終点）
import { NAME_KEY, NAME_MAX, ONLINE_PUBLIC, MODES, LENGTHS, modeLabel, normalizeName } from './online-config.js';
import { createFirebaseTransport } from './online-transport.js';
import { isEnabled, createRoom, joinRoom, changeSettings, startMatch, leaveRoom, enterPresence, watchRoom } from './online-lobby.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEN_LABEL = { 1: '1局戦', 4: '4局戦', 8: '8局戦' };

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
export function createOnlineUI({ appVersion, emulator = false, store, root, rerender, onExit, connect = createFirebaseTransport }) {
  const st = {
    screen: 'connecting', // connecting | load-failed | disabled | name | menu | lobby | started | closed
    name: normalizeName(store.get(NAME_KEY, '')),
    error: null, errorKind: null, busy: false,
    mode: 'math1', length: 4, codeDraft: '',
    view: null, code: null,
  };
  let t = null;
  let unwatch = null;
  let alive = true;
  const redraw = () => { if (alive) rerender(); };

  async function open() {
    if (!emulator && !ONLINE_PUBLIC) { st.screen = 'disabled'; redraw(); return; } // 段階1：本番には接続しない
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
  }

  function setError(e) { st.error = errorText(e, appVersion); st.errorKind = e && e.code; }

  function enterLobby(code) {
    st.code = code; st.view = null; st.screen = 'lobby'; st.error = null;
    if (unwatch) unwatch();
    unwatch = watchRoom(t, code, (v) => {
      st.view = v;
      if (v.closed) { stopWatch(); st.screen = 'closed'; }
      else if (v.removed && st.screen === 'lobby') { stopWatch(); st.screen = 'closed'; }
      else if (v.meta.status !== 'lobby') st.screen = 'started';
      redraw();
    });
    enterPresence(t, code).catch(() => {});
  }
  function stopWatch() { if (unwatch) { unwatch(); unwatch = null; } }

  async function run(fn) {
    if (st.busy) return;
    st.busy = true; st.error = null; redraw();
    try { await fn(); } catch (e) { setError(e); }
    st.busy = false; redraw();
  }

  async function leave() {
    const code = st.code;
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
      case 'ol-start': run(() => startMatch(t, st.code)); break;
      case 'ol-leave': run(async () => { await leave(); st.screen = 'menu'; }); break;
      case 'ol-menu': st.screen = 'menu'; st.error = null; redraw(); break;
      default: break;
    }
  }
  // ラジオ（作成時の設定・ロビーのホストの設定）
  function change(act, value) {
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
      case 'closed': return frame('<p class="ol-note ol-closed">部屋が閉じられました（ホストが退出しました）。</p><button data-action="ol-menu" class="primary">メニューへ</button>');
      default: return frame('');
    }
  }
  function seatsHTML(v) {
    return `<ol class="ol-seats">${v.seats.map((s) => (s.kind === 'human'
      ? `<li class="ol-seat human${s.me ? ' me' : ''}" data-seat="${s.seat}"><span class="ol-dot ${s.online ? 'on' : 'off'}" aria-label="${s.online ? '接続中' : '未接続'}"></span><span class="ol-name">${esc(s.name)}</span>${s.host ? '<small class="ol-tag">ホスト</small>' : ''}${s.me ? '<small class="ol-tag">あなた</small>' : ''}</li>`
      : `<li class="ol-seat cpu" data-seat="${s.seat}"><span class="ol-dot cpu"></span><span class="ol-name">CPU（予定）</span></li>`)).join('')}</ol>`;
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
