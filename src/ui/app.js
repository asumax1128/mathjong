// MATHJONG Ver.0.1 画面制御。ゲームの判定はすべて engine 側で行い、ここは表示と入力だけを担当する。
import { createRules } from '../engine/rules.js';
import { DEFAULT_CONFIG, ENGINE_VERSION } from '../engine/config.js';
import { Game } from '../engine/game.js';
import { decide, applyAction, PERSONALITIES } from '../engine/ai.js';
import { createRng } from '../engine/rng.js';
import { trigExact } from '../engine/exact.js';
import { tileHTML, formulaHTML, backHTML, valueHTML } from './render.js';

const params = new URLSearchParams(location.search);
const rules = createRules(DEFAULT_CONFIG);
const HUMAN = 0;
const POS = ['自分', '下家', '対面', '上家'];
const PLAYERS = [
  { name: 'あなた', kind: 'human' },
  { name: 'AI-A', kind: 'ai', personality: 'speed' },
  { name: 'AI-B', kind: 'ai', personality: 'value' },
  { name: 'AI-C', kind: 'ai', personality: 'closed' },
];
const SPEEDS = { fast: [250, 120], normal: [700, 350], slow: [1200, 600], test: [0, 0] };

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作する */ } },
};

const S = {
  round: 1,
  dealer: 0,
  scores: [0, 0, 0, 0],
  seedBase: params.has('seed') ? Number(params.get('seed')) : Math.floor(Math.random() * 1e9),
  game: null,
  selected: null,
  hintsUsed: 0,
  modal: null,
  speed: params.get('speed') || store.get('mj-speed', 'normal'),
  timer: null,
  aiRng: null,
  history: [],
};

const app = document.getElementById('app');
const T = (idx) => rules.types[idx];
const nameOf = (s) => (s === HUMAN ? 'あなた' : `${PLAYERS[s].name}`);

function startRound() {
  clearTimeout(S.timer);
  const seed = S.seedBase + S.round * 7919;
  const presetWall = S.nextPresetWall || null; // テスト用：山の並びを指定
  S.nextPresetWall = null;
  S.game = new Game({ rules, seed, dealer: S.dealer, players: PLAYERS, round: S.round, presetWall });
  S.aiRng = createRng(seed ^ 0x5bd1e995);
  S.selected = null;
  S.hintsUsed = 0;
  S.modal = null;
  S.scored = false;
  render();
  step();
}

function step() {
  clearTimeout(S.timer);
  const g = S.game;
  const p = g.pending();
  if (!p) return finishRound();
  if (p.seat === HUMAN) return render();
  const [turnDelay, claimDelay] = SPEEDS[S.speed] || SPEEDS.normal;
  S.timer = setTimeout(() => {
    const action = decide(g, p.seat, PLAYERS[p.seat].personality, S.aiRng);
    applyAction(g, p.seat, action);
    render();
    step();
  }, p.type === 'turn' ? turnDelay : claimDelay);
}

function finishRound() {
  const g = S.game;
  if (!S.scored) {
    S.scored = true;
    if (g.result.type === 'win') S.scores[g.result.winner] += g.result.points;
    S.history.push({ round: S.round, result: g.result.type === 'win' ? { ...g.result, analysis: undefined } : g.result });
  }
  S.modal = 'result';
  render();
}

function humanAct(action) {
  const g = S.game;
  const p = g.pending();
  if (!p || p.seat !== HUMAN) return;
  try {
    applyAction(g, HUMAN, action);
  } catch (e) {
    console.error(e);
    return;
  }
  S.selected = null;
  render();
  step();
}

// ---------- 描画 ----------

function lastEventText() {
  const g = S.game;
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.type === 'discard') return `${nameOf(e.seat)} が ${tileHTML(T(g.typeOf(e.tile)), { size: 's' })} を捨てました`;
    if (e.type === 'chi') return `${nameOf(e.seat)} がチー： ${formulaHTML(rules, e.meld)}`;
    if (e.type === 'win') return `${nameOf(e.seat)} の${e.how === 'ron' ? 'ロン' : 'ツモ'}和了！`;
    if (e.type === 'exhaustive-draw') return '流局（山がなくなりました）';
  }
  return `${nameOf(g.dealer)} が親です`;
}

function meldsHTML(seat, size) {
  const g = S.game;
  return g.melds[seat].map((m) => {
    const tiles = m.tiles.map((id) => tileHTML(T(g.typeOf(id)), { size, cls: id === m.claimed ? 'claimed' : '' })).join('');
    return `<span class="meld" title="${rules.melds[m.meld].key}">${tiles}</span>`;
  }).join('');
}

function riverHTML(seat, size) {
  const g = S.game;
  const last = [...g.events].reverse().find((e) => e.type === 'discard');
  const claimTile = g.claim ? g.claim.tile : null;
  return g.rivers[seat].map((r) => tileHTML(T(g.typeOf(r.id)), {
    size,
    cls: [r.tsumogiri ? 'tsumogiri' : '', last && last.tile === r.id ? 'last' : '', claimTile === r.id ? 'claimable' : ''].join(' '),
  })).join('');
}

function panelHTML(seat) {
  const g = S.game;
  const p = g.pending();
  const active = p && p.seat === seat && p.type === 'turn';
  const pl = PLAYERS[seat];
  const pers = pl.personality ? `<span class="pers">${PERSONALITIES[pl.personality].label}</span>` : '';
  return `<section class="panel seat-${seat} ${active ? 'active' : ''}">
    <header>
      <span class="pos">${POS[seat]}</span><span class="name">${pl.name}</span>${pers}
      ${g.dealer === seat ? '<span class="oya">親</span>' : ''}
      ${!g.isClosed(seat) ? '<span class="naki">鳴き</span>' : ''}
      <span class="score">${S.scores[seat]}点</span>
    </header>
    <div class="row">${backHTML(g.hands[seat].length)}<span class="melds">${meldsHTML(seat, 's')}</span></div>
    <div class="river">${riverHTML(seat, 'xs')}</div>
  </section>`;
}

function handHTML() {
  const g = S.game;
  const p = g.pending();
  const myTurn = p && p.seat === HUMAN && p.type === 'turn';
  const drawn = myTurn ? g.drawn : null;
  const sorted = g.hands[HUMAN].filter((id) => id !== drawn).sort((a, b) => g.typeOf(a) - g.typeOf(b) || a - b);
  const hl = S.hintHighlight || new Set();
  const tile = (id) => tileHTML(T(g.typeOf(id)), {
    size: 'l', id,
    cls: [myTurn ? 'tap' : '', S.selected === id ? 'selected' : '', hl.has(id) ? 'hint' : ''].join(' '),
    attrs: myTurn ? `data-action="tile" tabindex="0"` : '',
  });
  return `<div class="hand">${sorted.map(tile).join('')}${drawn !== null && drawn !== undefined ? `<span class="drawn-gap"></span>${tile(drawn)}` : ''}</div>`;
}

function actionsHTML() {
  const g = S.game;
  const p = g.pending();
  if (!p) return `<div class="actions"><button data-action="show-result" class="primary">結果を見る</button></div>`;
  if (p.seat !== HUMAN) {
    const what = p.type === 'turn' ? `${nameOf(p.seat)} の手番…` : `${nameOf(p.seat)} が考え中…`;
    return `<div class="actions waiting"><span class="status">${what}</span></div>`;
  }
  if (p.type === 'turn') {
    const tsumo = p.canTsumo ? '<button data-action="tsumo" class="win">ツモ</button>' : '';
    const sel = S.selected !== null;
    return `<div class="actions">
      <span class="status">${p.canTsumo ? '和了できます！' : g.justDrew ? 'あなたの番：捨てる牌を選択' : 'チー後：捨てる牌を選択'}</span>
      ${tsumo}
      <button data-action="discard" class="primary" ${sel ? '' : 'disabled'}>捨てる</button>
    </div>`;
  }
  const tile = tileHTML(T(g.typeOf(p.tile)), { size: 'm' });
  const ron = p.ron ? '<button data-action="ron" class="win">ロン</button>' : '';
  const chi = p.chi.map((o, i) => {
    const m = rules.melds[o.meld];
    return `<button data-action="chi" data-opt="${i}" class="chi">チー ${formulaHTML(rules, m.idx)}</button>`;
  }).join('');
  return `<div class="actions claim">
    <span class="status">${POS[p.from]} ${nameOf(p.from)} の打牌 ${tile}</span>
    ${ron}${chi}
    <button data-action="pass">${p.ron ? 'ロンしない' : '見送る'}</button>
  </div>`;
}

function headerHTML() {
  const g = S.game;
  return `<header class="top">
    <span class="logo">MATHJONG <small>Ver.0.1</small></span>
    <span class="info">第${S.round}局 <span class="wall" aria-label="山の残り">山 <b>${g.wall.length}</b></span></span>
    <span class="tools">
      <button data-action="hint" class="small">ヒント</button>
      <button data-action="rules" class="small">ルール</button>
      <button data-action="settings" class="small" aria-label="設定">⚙</button>
    </span>
  </header>`;
}

let lastHandKey = '';
function render() {
  if (!S.game) return;
  const g = S.game;
  // 手牌が変わったらヒント表示を消す（考える余地を残す）
  const handKey = g.hands[HUMAN].join(',');
  if (handKey !== lastHandKey) { lastHandKey = handKey; S.hintText = null; S.hintHighlight = null; }
  app.innerHTML = `
    ${headerHTML()}
    <main class="table">
      <div class="opponents">
        <div class="area-top">${panelHTML(2)}</div>
        <div class="area-left">${panelHTML(3)}</div>
        <div class="area-right">${panelHTML(1)}</div>
      </div>
      <div class="msg" aria-live="polite">${lastEventText()}</div>
      <section class="self ${g.pending() && g.pending().seat === HUMAN && g.pending().type === 'turn' ? 'active' : ''}">
        <header>
          <span class="pos">自分</span><span class="name">あなた</span>
          ${g.dealer === HUMAN ? '<span class="oya">親</span>' : ''}
          ${!g.isClosed(HUMAN) ? '<span class="naki">鳴き（役が必要）</span>' : '<span class="menzen">門前</span>'}
          <span class="score">${S.scores[HUMAN]}点</span>
        </header>
        <div class="river mine">${riverHTML(HUMAN, 'xs')}</div>
        <div class="melds mine">${meldsHTML(HUMAN, 'm')}</div>
        ${handHTML()}
        ${S.hintText ? `<div class="hint-box">${S.hintText}</div>` : ''}
      </section>
    </main>
    <footer class="bar">${actionsHTML()}</footer>
    ${modalHTML()}
  `;
}

// ---------- モーダル ----------

function modalHTML() {
  if (!S.modal) return '';
  let body = '';
  if (S.modal === 'result') body = resultHTML();
  if (S.modal === 'rules') body = rulesHTML();
  if (S.modal === 'table') body = tableHTML();
  if (S.modal === 'settings') body = settingsHTML();
  const closable = S.modal !== 'result';
  return `<div class="overlay" role="dialog" aria-modal="true"><div class="modal">${body}
    ${closable ? '<div class="modal-actions"><button data-action="close" class="primary">閉じる</button></div>' : ''}</div></div>`;
}

function revealHTML(seat) {
  const g = S.game;
  const hand = g.hands[seat].slice().sort((a, b) => g.typeOf(a) - g.typeOf(b)).map((id) => tileHTML(T(g.typeOf(id)), { size: 's' })).join('');
  return `<div class="reveal"><span class="who">${seat === HUMAN ? 'あなた' : `${POS[seat]} ${nameOf(seat)}`}</span><span class="tiles">${hand}</span><span class="melds">${meldsHTML(seat, 's')}</span></div>`;
}

function resultHTML() {
  const g = S.game;
  const r = g.result;
  let head;
  let detail = '';
  if (r.type === 'win') {
    const a = r.analysis;
    const how = r.how === 'ron' ? `ロン（${r.from === HUMAN ? 'あなた' : `${POS[r.from]} ${nameOf(r.from)}`} から）` : 'ツモ';
    head = `<h2>${nameOf(r.winner)} の和了 <small>${how}</small></h2>`;
    if (a.kind === 'special') {
      const sp = rules.config.specialHands.find((s) => s.id === a.special);
      detail = `<p class="special">特殊和了：角度牌9種類 ${sp.angles.map((d) => `${d}°`).join('・')}</p>
        <div class="tiles">${g.hands[r.winner].slice().sort((x, y) => g.typeOf(x) - g.typeOf(y)).map((id) => tileHTML(T(g.typeOf(id)), { size: 'm' })).join('')}</div>`;
    } else {
      const exposed = new Set(a.exposedMelds);
      detail = `<ol class="formulas">${a.melds.map((mi) => {
        const m = rules.melds[mi];
        const tiles = m.tiles.map((t) => tileHTML(T(t), { size: 's' })).join('');
        return `<li><span class="tiles">${tiles}</span>${formulaHTML(rules, mi)}${exposed.has(mi) ? '<span class="tag">チー</span>' : ''}</li>`;
      }).join('')}</ol>`;
    }
    const base = a.yakuman ? '' : `<li><span>通常和了</span><b>${rules.config.scoring.base}</b></li>`;
    const yaku = a.yaku.map((y) => `<li class="${y.yakuman ? 'yakuman' : ''}"><span>${y.name}${y.yakuman ? '（役満）' : ''}</span><b>${a.yakuman ? '' : '+'}${y.points}</b></li>`).join('');
    detail += `<ul class="yaku">${base}${yaku || (a.yakuman ? '' : '<li class="none"><span>役なし（門前のため和了可）</span><b></b></li>')}
      <li class="total"><span>合計</span><b>${r.points}点</b></li></ul>
      ${a.candidateCount > 1 ? `<p class="note">この手は${a.candidateCount}通りの和了形に分けられます。最高得点の形を採用しました。</p>` : ''}`;
  } else {
    head = '<h2>流局</h2>';
    detail = '<p>山の牌がなくなりました。得点の移動はありません。</p>';
  }
  const scores = `<table class="scores"><tr>${[0, 1, 2, 3].map((s) => `<th>${POS[s]}<br>${PLAYERS[s].name}</th>`).join('')}</tr>
    <tr>${[0, 1, 2, 3].map((s) => `<td class="${r.winner === s ? 'win' : ''}">${S.scores[s]}</td>`).join('')}</tr></table>`;
  const hints = S.hintsUsed ? `<p class="note">この局のヒント使用：${S.hintsUsed}回</p>` : '';
  return `<div class="result">${head}${detail}
    <h3>累計得点（仮）</h3>${scores}${hints}
    <details><summary>全員の手牌を見る</summary>${[0, 1, 2, 3].map(revealHTML).join('')}</details>
    <div class="modal-actions"><button data-action="next" class="primary">次の局へ</button>
    <button data-action="close-result">盤面を見る</button></div></div>`;
}

function rulesHTML() {
  const c = rules.config;
  const yaku = c.yaku.filter((y) => y.enabled).map((y) => `<li><span>${y.name}${y.yakuman ? '（役満候補）' : ''}${y.closedOnly ? '・門前限定' : ''}</span><b>${y.yakuman ? y.points : '+' + y.points}</b></li>`).join('');
  const sp = c.specialHands.filter((s) => s.enabled).map((s) => `<li><span>${s.name}（${s.angles.join('°・')}°）${s.closedOnly ? '・門前限定' : ''}</span><b>${s.points}</b></li>`).join('');
  return `<h2>ルール（Ver.0.1 暫定）</h2>
  <ul class="rules-list">
    <li><b>面子</b>：関数牌＋角度牌＋結果牌で正しい等式（例：sin 30° = 1/2）。</li>
    <li><b>和了</b>：8枚＋1枚＝9枚で3面子。または特殊和了。</li>
    <li><b>チー</b>：上家の捨て牌で面子が完成するときのみ。面子は公開され、手牌から2枚減ります。チー後は役がないと和了できません。チーは最大2回。</li>
    <li><b>ロン</b>：他の3人の捨て牌で和了。ロンはチーより優先、複数ならアタマハネ（打牌者に近い人）。</li>
    <li><b>門前</b>（チーなし）なら役なしでも和了できます。</li>
    <li>フリテンは Ver.0.1 では未実装。流局は山が尽きたとき。</li>
  </ul>
  <h3>役と仮得点</h3><ul class="yaku"><li><span>通常和了</span><b>${c.scoring.base}</b></li>${yaku}${sp}</ul>
  <p class="note">役満成立時は通常和了点・通常役を加算せず、役満の点のみ（複数役満は加算）。<br>エンジン ${ENGINE_VERSION} / 牌 ${rules.deckSize}枚 / 面子 ${rules.melds.length}種類</p>`;
}

function tableHTML() {
  const angles = rules.types.filter((t) => t.kind === 'angle');
  const cell = (fn, deg) => {
    const ex = trigExact(fn, deg);
    if (!ex) return '<td class="undef">なし</td>';
    const v = rules.types.find((t) => t.kind === 'value' && t.exact.p === ex.p && t.exact.q === ex.q && t.exact.r === ex.r);
    return `<td>${valueHTML(v.display)}</td>`;
  };
  return `<h2>三角関数の値表</h2><div class="table-wrap"><table class="values"><tr><th>角度</th><th>sin</th><th>cos</th><th>tan</th></tr>
    ${angles.map((a) => `<tr><th>${a.deg}°</th>${cell('sin', a.deg)}${cell('cos', a.deg)}${cell('tan', a.deg)}</tr>`).join('')}</table></div>`;
}

function settingsHTML() {
  const opt = (v, l) => `<option value="${v}" ${S.speed === v ? 'selected' : ''}>${l}</option>`;
  return `<h2>設定</h2>
    <label class="setting">AIの速さ <select data-action="speed">${opt('fast', '速い')}${opt('normal', '普通')}${opt('slow', 'ゆっくり')}</select></label>
    <p class="note">シード：${S.seedBase}（同じ URL に ?seed=${S.seedBase} を付けると同じ配牌を再現できます）</p>
    <div class="modal-actions"><button data-action="reset">新しい対局（得点リセット）</button></div>`;
}

// ---------- ヒント ----------
function computeHint() {
  const g = S.game;
  const ids = g.hands[HUMAN];
  // 手牌から同時に取れる完成面子の最大数（重複利用なし）
  const best = { n: 0, used: [] };
  (function rec(pool, used) {
    if (used.length / 3 > best.n) { best.n = used.length / 3; best.used = used.slice(); }
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
      if (!rules.meldOf(g.typeOf(pool[i]), g.typeOf(pool[j]), g.typeOf(pool[k]))) continue;
      const rest = pool.filter((_, x) => x !== i && x !== j && x !== k);
      rec(rest, [...used, pool[i], pool[j], pool[k]]);
      if (best.n === 3) return;
    }
  })(ids, []);
  const types = new Set(ids.map((id) => g.typeOf(id)));
  const partial = rules.melds.filter((m) => m.tiles.filter((t) => types.has(t)).length === 2).length;
  S.hintHighlight = new Set(best.used);
  S.hintText = `完成している面子：<b>${best.n}組</b>（黄色の枠）／ あと1枚で完成する組み合わせ：<b>${partial}通り</b>
    <button data-action="table" class="small">値表を見る</button>`;
}

// ---------- 入力 ----------
app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const g = S.game;
  switch (act) {
    case 'tile': {
      const id = Number(el.dataset.id);
      if (S.selected === id) humanAct({ type: 'discard', tile: id });
      else { S.selected = id; render(); }
      break;
    }
    case 'discard':
      if (S.selected !== null) humanAct({ type: 'discard', tile: S.selected });
      break;
    case 'tsumo': humanAct({ type: 'tsumo' }); break;
    case 'ron': humanAct({ type: 'ron' }); break;
    case 'chi': humanAct({ type: 'chi', option: Number(el.dataset.opt) }); break;
    case 'pass': humanAct({ type: 'pass' }); break;
    case 'hint':
      if (S.hintText) { S.hintText = null; S.hintHighlight = null; } else { S.hintsUsed++; computeHint(); }
      render();
      break;
    case 'rules': case 'table': case 'settings':
      if (act === 'table' && S.modal !== 'table') S.hintsUsed++;
      S.modal = act; render(); break;
    case 'close': S.modal = g.pending() ? null : 'result'; render(); break;
    case 'close-result': S.modal = null; render(); break;
    case 'show-result': S.modal = 'result'; render(); break;
    case 'next':
      S.round++;
      S.dealer = (S.dealer + 1) % 4;
      startRound();
      break;
    case 'reset':
      S.round = 1; S.dealer = 0; S.scores = [0, 0, 0, 0]; S.history = [];
      startRound();
      break;
    default:
  }
});

app.addEventListener('change', (ev) => {
  if (ev.target.dataset.action === 'speed') {
    S.speed = ev.target.value;
    store.set('mj-speed', S.speed);
  }
});

// テスト・デバッグ用（E2E テストが盤面を確認するため）
window.__mathjong = { S, rules, decide, startRound };

startRound();
