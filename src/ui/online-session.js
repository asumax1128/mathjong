// オンライン対戦 段階2：進行役（online-host.js）・ゲストと Transport のつなぎ（docs/79「6」）。
// ・ホスト：publish で pub/state と各人間席の priv/$seat を1回のまとめ書き（update）で書く。ゲストの act/$seat を購読して進行役へ渡す。
//   ホスト自身の席は通信を通さず、配信値をそのまま手元の画面へ渡し、操作も直接進行役へ渡す。
// ・ゲスト：pub/state と自分の priv/$seat を購読し、操作は act/$seat への追記だけ。
import { createHostRunner } from './online-host.js';
import { wrap, unwrap, actOf } from './online-protocol.js';

const room = (code, p = '') => `rooms/${code}${p ? `/${p}` : ''}`;
let keySeq = 0;
const actKey = (t) => `${Math.floor(t.now()).toString(36)}-${(++keySeq).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

// seats：ゲームの席の並び（{ kind, name, cpuId, uid }）。mySeat：ホストの席。onView(pub, priv)：ホストの画面へ
export function createHostSession(t, code, { rules, mode, length, seats, seedBase, startDealer, mySeat, onView, clock, limits, cpuDelay, onError, presetWalls }) {
  let last = null;
  const runner = createHostRunner({
    rules, mode, length, seats, seedBase, startDealer, clock, limits, cpuDelay, presetWalls,
    publish(pub, privs) {
      last = { pub, priv: privs[mySeat] || null };
      const upd = { 'pub/state': wrap(pub.seq, pub) };
      for (const [s, p] of Object.entries(privs)) if (Number(s) !== mySeat) upd[`priv/${s}`] = wrap(pub.seq, p);
      Promise.resolve(t.update(room(code), upd)).catch((e) => { if (onError) onError(e); });
      if (onView) onView(pub, last.priv);
    },
  });
  const seen = new Set();
  const uns = [];
  for (let s = 0; s < 4; s++) {
    if (s === mySeat || seats[s].kind !== 'human') continue;
    uns.push(t.onValue(room(code, `act/${s}`), (v) => {
      if (!v) return;
      for (const k of Object.keys(v).sort()) {
        const id = `${s}/${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        runner.receive(s, v[k]);
      }
    }));
  }
  return {
    runner,
    start() { Promise.resolve(t.set(room(code, 'host'), { seedBase, startDealer })).catch(() => {}); runner.start(); },
    send(action) { const sid = last ? last.pub.sid : 0; runner.receive(mySeat, actOf(action, sid, Math.floor(t.now())), { host: true }); },
    get last() { return last; },
    stop() { runner.stop(); uns.forEach((u) => u()); },
  };
}

// onView(pub, priv)：配信を受けるたび（pub と priv の両方が揃ってから。priv は pub と同じ seq 以上のものを使う）
export function createGuestSession(t, code, mySeat, { onView }) {
  let pub = null;
  let priv = null;
  // 自分の手牌（priv）が届くまでは描かない（他家と同じ「枚数だけ」の手牌にならないように）。sid が違う priv は選択肢を出さない
  const emit = () => { if (pub && priv) onView(pub, priv.sid === pub.sid ? priv : { ...priv, pending: null }); };
  const uns = [
    t.onValue(room(code, 'pub/state'), (v) => { const x = unwrap(v); if (x && (!pub || x.seq >= pub.seq)) { pub = x; emit(); } }),
    t.onValue(room(code, `priv/${mySeat}`), (v) => { const x = unwrap(v); if (x) { priv = x; emit(); } }),
  ];
  return {
    send(action) {
      const sid = pub ? pub.sid : 0;
      return t.set(room(code, `act/${mySeat}/${actKey(t)}`), actOf(action, sid, Math.floor(t.now())));
    },
    get pub() { return pub; },
    get priv() { return priv; },
    stop() { uns.forEach((u) => u()); },
  };
}
