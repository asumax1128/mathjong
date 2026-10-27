// 効果音（Ver.0.5-D）。画面だけの機能で、ゲームのルール・判定・得点・進行には一切関わらない。
// すべて Web Audio で**自作の合成音**として生成する（音声ファイル・外部の音源・サンプルは使わない。権利の問題がなく、配信も軽い）。
// このファイルの前半は純粋関数と音の設計データ（DOM・Web Audio を持たない）。後半の scheduleRecipe は、渡された AudioContext
// （本番・OfflineAudioContext・テスト用の偽物）に音を予約するだけで、状態を持たない。再生の管理（iPhone の再生許可・再開・無音の代替）は
// src/ui/app.js が担当する。tests/sound.test.js と E2E（実際の音の波形の検査）で検証。

export const SOUND_KEY = 'mj-sound';
// 保存値：'0' のときだけオフ。未保存・異常値・読込失敗は オン。
export const parseSoundSetting = (saved) => saved !== '0';

// 音の種類と優先度（同じ回に複数の記録が増えたとき、最も高い1つだけを鳴らす）。
// ロン・ツモ ＞ リーチ ＞ ポン ＞ チー ＞ 打牌。リーチの記録は、その宣言牌の打牌の記録より前に残るので、リーチの宣言牌の打牌音は鳴らない。
export const SOUNDS = {
  discard: { prio: 1 },
  chi: { prio: 2 },
  pon: { prio: 3 },
  riichi: { prio: 4 },
  ron: { prio: 5 },
  tsumo: { prio: 5 },
};

// 記録1件 → 音の種類（音のない記録は null）。牌を引く・流局などは鳴らさない。
export function soundKindOf(event) {
  if (!event) return null;
  switch (event.type) {
    case 'discard': return 'discard';
    case 'chi': return 'chi';
    case 'pon': return 'pon';
    case 'riichi': return 'riichi';
    case 'win': return event.how === 'ron' ? 'ron' : event.how === 'tsumo' ? 'tsumo' : null;
    default: return null;
  }
}

// 新しく増えた記録（from 以降）から、鳴らす音を1つ選ぶ（優先度が最も高いもの。同じなら後のもの）。
// 戻り値：{ kind, index, next }。同じ記録を2回鳴らさないよう、next（次回の from）を返す。events が from より短ければ（別の局）先頭から数え直す。
export function pickSound(events, from) {
  const start = from > events.length ? 0 : from;
  let best = null;
  for (let i = start; i < events.length; i++) {
    const kind = soundKindOf(events[i]);
    if (!kind) continue;
    if (!best || SOUNDS[kind].prio >= SOUNDS[best.kind].prio) best = { kind, index: i };
  }
  return { ...(best || { kind: null, index: -1 }), next: events.length };
}

// ---- 音の設計（レシピ）----
// 声（voice）の並び。t：開始（秒）、d：長さ（秒）、g：最大の音量、a：立ち上がり（秒、省略時 0.002）、
//   osc：w（波形）、f：[開始の周波数, 終わりの周波数（省略可）]。noise：ノイズ。
//   filter（省略可）：{ type, f: [開始, 終わり（省略可）], q }。
// 音量は、立ち上がりのあと、指数関数的に減衰する（打楽器・鐘の自然な減衰）。
export const RECIPES = {
  // 打牌：短く硬質な牌の接触音（約 0.09 秒）。高めのノイズの打撃音に、短い「コツ」と胴鳴り
  discard: [
    { k: 'noise', t: 0, d: 0.045, g: 1.6, a: 0.0005, filter: { type: 'bandpass', f: [3400, 2200], q: 1.1 } },
    { k: 'osc', w: 'triangle', f: [1150, 430], t: 0, d: 0.09, g: 1.0, a: 0.0005 },
    { k: 'osc', w: 'sine', f: [260, 120], t: 0, d: 0.07, g: 0.6, a: 0.0005 },
  ],
  // チー：軽快（約 0.2 秒）。短い二音の上昇と、軽い高音の粒
  chi: [
    { k: 'osc', w: 'triangle', f: [784], t: 0, d: 0.11, g: 0.5 },
    { k: 'osc', w: 'triangle', f: [1175], t: 0.075, d: 0.15, g: 0.5 },
    { k: 'noise', t: 0, d: 0.025, g: 0.2, a: 0.0005, filter: { type: 'highpass', f: [6000], q: 0.7 } },
  ],
  // ポン：力強い衝撃（約 0.3 秒）。中低域の打撃（スマートフォンのスピーカーでも聞こえるよう、中音域を厚く）と、ノイズの衝撃、短い角のある音
  pon: [
    { k: 'osc', w: 'sine', f: [200, 90], t: 0, d: 0.24, g: 0.22, a: 0.001 },
    { k: 'osc', w: 'triangle', f: [700, 240], t: 0, d: 0.2, g: 1.1, a: 0.001 },
    { k: 'osc', w: 'square', f: [440, 260], t: 0, d: 0.12, g: 0.22, a: 0.001, filter: { type: 'lowpass', f: [2400], q: 0.7 } },
    { k: 'noise', t: 0, d: 0.22, g: 1.0, a: 0.001, filter: { type: 'bandpass', f: [2200, 700], q: 0.9 } },
    { k: 'noise', t: 0, d: 0.08, g: 0.4, a: 0.0005, filter: { type: 'highpass', f: [4000], q: 0.7 } },
  ],
  // リーチ：緊張感ある鋭い宣言（約 0.75 秒）。上昇する鋭い掃引と空気の擦れ → 金属的な鋭い一撃と低い重み
  riichi: [
    { k: 'osc', w: 'sawtooth', f: [380, 1900], t: 0, d: 0.34, g: 0.2, a: 0.04, filter: { type: 'bandpass', f: [700, 3400], q: 6 } },
    { k: 'noise', t: 0, d: 0.34, g: 0.16, a: 0.12, filter: { type: 'highpass', f: [4500, 7500], q: 0.7 } },
    { k: 'osc', w: 'sine', f: [2637], t: 0.34, d: 0.46, g: 0.3, a: 0.001 },
    { k: 'osc', w: 'sine', f: [3951], t: 0.34, d: 0.34, g: 0.14, a: 0.001 },
    { k: 'osc', w: 'sine', f: [1319], t: 0.34, d: 0.4, g: 0.2, a: 0.001 },
    { k: 'osc', w: 'triangle', f: [220, 110], t: 0.34, d: 0.3, g: 0.35, a: 0.001 },
  ],
  // ロン：迫力ある決着（約 1.0 秒）。重い低音と中音域の爆発、ノイズの衝撃、鋭い和音の一撃、遅れて来る二度目の衝撃
  ron: [
    { k: 'osc', w: 'sine', f: [150, 60], t: 0, d: 0.6, g: 0.25, a: 0.001 },
    { k: 'osc', w: 'triangle', f: [800, 260], t: 0, d: 0.32, g: 0.7, a: 0.001 },
    { k: 'noise', t: 0, d: 0.7, g: 0.55, a: 0.001, filter: { type: 'bandpass', f: [3000, 600], q: 0.8 } },
    { k: 'osc', w: 'square', f: [330], t: 0.02, d: 0.5, g: 0.2, a: 0.002, filter: { type: 'lowpass', f: [2400], q: 0.7 } },
    { k: 'osc', w: 'square', f: [494], t: 0.02, d: 0.5, g: 0.18, a: 0.002, filter: { type: 'lowpass', f: [2400], q: 0.7 } },
    { k: 'osc', w: 'sawtooth', f: [659], t: 0.02, d: 0.4, g: 0.12, a: 0.002, filter: { type: 'lowpass', f: [3000], q: 0.7 } },
    { k: 'osc', w: 'triangle', f: [520, 200], t: 0.45, d: 0.5, g: 0.5, a: 0.002 },
    { k: 'noise', t: 0.45, d: 0.45, g: 0.45, a: 0.002, filter: { type: 'bandpass', f: [2000, 500], q: 0.8 } },
  ],
  // ツモ：澄んだ輝きと達成感のある決着（約 0.95 秒）。高い鐘の上昇する分散和音、きらめき、のびやかな和音
  tsumo: [
    { k: 'osc', w: 'sine', f: [1047], t: 0, d: 0.6, g: 0.4, a: 0.002 },
    { k: 'osc', w: 'sine', f: [1319], t: 0.07, d: 0.6, g: 0.4, a: 0.002 },
    { k: 'osc', w: 'sine', f: [1568], t: 0.14, d: 0.6, g: 0.4, a: 0.002 },
    { k: 'osc', w: 'sine', f: [2093], t: 0.21, d: 0.7, g: 0.4, a: 0.002 },
    { k: 'osc', w: 'sine', f: [4186], t: 0.21, d: 0.4, g: 0.1, a: 0.002 },
    { k: 'noise', t: 0.2, d: 0.55, g: 0.1, a: 0.05, filter: { type: 'bandpass', f: [7000], q: 8 } },
    { k: 'osc', w: 'triangle', f: [523], t: 0.21, d: 0.7, g: 0.2, a: 0.02 },
    { k: 'osc', w: 'triangle', f: [659], t: 0.21, d: 0.7, g: 0.2, a: 0.02 },
    { k: 'osc', w: 'triangle', f: [784], t: 0.21, d: 0.7, g: 0.2, a: 0.02 },
  ],
};

// レシピの長さ（最後の声が終わる時刻、秒）
export const recipeEnd = (recipe) => Math.max(...recipe.map((v) => v.t + v.d));

export const MASTER_GAIN = 0.55; // 全体の音量（合成音の合計が大きくなりすぎないよう、圧縮器の手前で下げる）
const FLOOR = 0.0001; // 指数関数の始まりの値（0 にはできない）

// 白色雑音（決まった式で作る。乱数を使わないので、毎回同じ音になる）
export function makeNoiseData(length) {
  const out = new Float32Array(length);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x / 4294967296) * 2 - 1;
  }
  return out;
}

// 出力の連鎖（音量 → 圧縮器 → 出力）。本番と OfflineAudioContext で同じものを使う。
export function createMasterChain(ctx) {
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;
  master.connect(comp);
  comp.connect(ctx.destination);
  // 出力の連鎖を丸ごと外す（中断した音を、復帰後に鳴らさないため。圧縮器の内部に残った分も出さない）
  master.teardown = () => {
    try { master.disconnect(); } catch { /* すでに外れている */ }
    try { comp.disconnect(); } catch { /* すでに外れている */ }
  };
  return master;
}

// 種類 kind の音を、時刻 when（ctx.currentTime 基準）に予約する。戻り値：音の終わりの時刻。
// 予約するだけで、待たない。音が出せない・予約に失敗しても例外を外へ出さない（呼び出し側は無音の代替になる）。
export function scheduleRecipe(ctx, dest, kind, when, noise) {
  const recipe = RECIPES[kind];
  if (!recipe) return when;
  const noiseBuf = noise || (() => {
    const b = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 1.2)), ctx.sampleRate);
    b.getChannelData(0).set(makeNoiseData(b.length));
    return b;
  })();
  for (const v of recipe) {
    const start = when + v.t;
    const end = start + v.d;
    const att = v.a ?? 0.002;
    const src = v.k === 'noise' ? ctx.createBufferSource() : ctx.createOscillator();
    if (v.k === 'noise') { src.buffer = noiseBuf; } else {
      src.type = v.w;
      src.frequency.setValueAtTime(v.f[0], start);
      if (v.f.length > 1) src.frequency.exponentialRampToValueAtTime(Math.max(1, v.f[1]), end);
    }
    let node = src;
    if (v.filter) {
      const f = ctx.createBiquadFilter();
      f.type = v.filter.type;
      f.Q.value = v.filter.q ?? 1;
      f.frequency.setValueAtTime(v.filter.f[0], start);
      if (v.filter.f.length > 1) f.frequency.exponentialRampToValueAtTime(Math.max(1, v.filter.f[1]), end);
      node.connect(f);
      node = f;
    }
    const env = ctx.createGain();
    // 立ち上がり → 指数関数的な減衰（打楽器・鐘の自然な減衰。終わりの 10% で 0 へ線形に下げ、ぷつっという切れを避ける）
    env.gain.setValueAtTime(FLOOR, start);
    env.gain.linearRampToValueAtTime(v.g, start + att);
    env.gain.exponentialRampToValueAtTime(Math.max(FLOOR, v.g * 0.03), start + v.d * 0.9);
    env.gain.linearRampToValueAtTime(0, end);
    node.connect(env);
    env.connect(dest);
    src.start(start);
    src.stop(end + 0.02);
  }
  return when + recipeEnd(recipe);
}

// ---- 再生の管理（iPhone Safari 対応）----
// iOS Safari は、ユーザーの操作（タップ）の中で AudioContext を作って resume() するまで音を出さない。また、バックグラウンドや
// 着信で context が suspended／interrupted になることがある。方針：
//   ・AudioContext は、最初の操作（unlock）まで作らない。以降も操作のたびに、止まっていれば resume() を試す。
//   ・play は絶対に待たず・例外を出さない。context が running でなければ無音で戻る（ゲームの進行には関係しない）。
//   ・オフ設定のときは何も作らず何も鳴らさない（設定を変える・テスト音も unlock 扱い）。
// getCtor：AudioContext のコンストラクタを返す関数（なければ null。テストで偽物を渡せる）。isOn：現在の設定（オン／オフ）。
export function createSoundPlayer({ getCtor, isOn }) {
  const P = {
    ctx: null, master: null, noise: null,
    log: [], // 確認用：{ kind, status }（status：played／off／blocked／nocontext／error）。最新100件
    unlocked: false,
    buses: new Set(), // 鳴っている（予約済みを含む）音ごとの出力。{ bus, timer }
    drops: 0, // 確認用：中断で古い音を破棄した回数
  };
  const note = (kind, status) => { P.log.push({ kind, status }); if (P.log.length > 100) P.log.shift(); return status; };

  // ---- 中断した音の破棄 ----
  // AudioContext が suspended／interrupted になると、context.currentTime が止まり、予約済みの音の「続き」が復帰後に鳴ってしまう
  // （終わったはずのリーチ音の後半が、遅れて出る）。そこで、止まったことを知った時点で、鳴っている音の出力をすべて外す。
  //   ・音ごとの出力（bus）と、全体の出力の連鎖（音量 → 圧縮器 → 出力）を丸ごと切断する。古い音源は何にもつながらないので、復帰しても聞こえない。
  //   ・復帰後の新しい音は、新しい出力の連鎖につなぐ（AudioContext は作り直さない）。
  //   ・止まったことを知るきっかけ：statechange、画面が隠れた／離れた（app.js から drop）、unlock・play が止まった状態を見つけたとき。
  //   ・さらに、各 bus は「音の長さ＋余裕」の実時間（setTimeout）でも外す。止まったことに気づけなくても、終わった音は再び鳴らない。
  const retire = (rec) => {
    clearTimeout(rec.timer);
    P.buses.delete(rec);
    try { rec.bus.disconnect(); } catch { /* すでに外れている */ }
  };
  P.drop = () => {
    const had = P.buses.size > 0 || !!P.master;
    for (const rec of [...P.buses]) retire(rec);
    const m = P.master;
    P.master = null;
    if (m) { try { if (m.teardown) m.teardown(); else m.disconnect(); } catch { /* 切断できなくても進行には関係しない */ } }
    if (had) P.drops++;
  };
  const onState = () => { if (P.ctx && P.ctx.state !== 'running') P.drop(); };
  const tryResume = (ctx) => {
    if (typeof ctx.resume !== 'function') return;
    try { const r = ctx.resume(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* 再開できなくても進行には関係しない */ }
  };

  // ユーザーの操作の中で呼ぶ。context を作り（なければ）、止まっていれば resume() し、無音を1回鳴らして iOS の再生許可を確実にする。
  P.unlock = () => {
    try {
      if (!P.ctx) {
        const C = getCtor && getCtor();
        if (!C) return false;
        P.ctx = new C();
        if (typeof P.ctx.addEventListener === 'function') P.ctx.addEventListener('statechange', onState); // context ごとに1回だけ
      }
      const ctx = P.ctx;
      if (ctx.state !== 'running') {
        P.drop(); // 止まっている間に残った古い音は、再開する前に切り離す
        tryResume(ctx);
      }
      if (!P.unlocked) {
        // 無音の1サンプルを再生（iOS の再生許可のきっかけ）
        const b = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
        P.unlocked = true;
      }
      return true;
    } catch { return false; }
  };

  P.state = () => (P.ctx ? P.ctx.state : 'none');

  // 音を1つ鳴らす準備：止まっていないことを確かめ、出力の連鎖（なければ作る）に、この音専用の出力（bus）をつなぐ。
  // schedule(ctx, bus, when) が音を予約して終わりの時刻を返す。戻り値は状態（played／blocked／nocontext）。
  // 効果音（レシピ）も宣言ボイス（音声ファイル）も、同じ bus の仕組みを通す。中断・画面が隠れた・次の局で、どちらも同じように切り離される。
  const start = (gain, schedule) => {
    if (!P.ctx) return 'nocontext'; // まだ操作がない・AudioContext を持たない環境：無音
    const ctx = P.ctx;
    if (ctx.state !== 'running') {
      // 止まっている：古い音を切り離し、再開を試みるだけで待たない。この音は鳴らさない（遅れて鳴ると場面とずれる）
      P.drop();
      tryResume(ctx);
      return 'blocked';
    }
    if (!P.master) {
      P.master = createMasterChain(ctx);
      const nb = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 1.2)), ctx.sampleRate);
      nb.getChannelData(0).set(makeNoiseData(nb.length));
      P.noise = nb;
    }
    const bus = ctx.createGain();
    if (gain !== 1) bus.gain.value = gain;
    bus.connect(P.master);
    const rec = { bus, timer: null };
    P.buses.add(rec);
    const end = schedule(ctx, bus, ctx.currentTime + 0.005);
    rec.timer = setTimeout(() => retire(rec), Math.max(0, end - ctx.currentTime) * 1000 + 250);
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref(); // Node のテストで終了を妨げない
    return 'played';
  };

  // 効果音（レシピ）を鳴らす。opts.gain：この音だけの音量（宣言ボイスと重なるとき、声を聞き取りやすくするため下げる。既定 1）
  P.play = (kind, opts = {}) => {
    try {
      if (!isOn()) return note(kind, 'off');
      return note(kind, start(opts.gain ?? 1, (ctx, bus, when) => scheduleRecipe(ctx, bus, kind, when, P.noise)));
    } catch { return note(kind, 'error'); }
  };

  // 読み込み済みの音声（AudioBuffer）を鳴らす（宣言ボイス）。tag は記録用の名前（例 'voice:ron'）。効果音のオン／オフとは別に、呼び出し側が判断する。
  P.playBuffer = (tag, buffer, opts = {}) => {
    try {
      return note(tag, start(opts.gain ?? 1, (ctx, bus, when) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(bus);
        src.start(when);
        return when + (buffer.duration || 0);
      }));
    } catch { return note(tag, 'error'); }
  };

  // 鳴っている音を短く絞って止める（新しい局・タイトルへ戻るとき）。次の play は新しい出力の連鎖で鳴る。
  // 止まっている context では絞る処理が進まないので、そのまま切り離す。
  P.silence = () => {
    try {
      if (!P.ctx || P.ctx.state !== 'running') { P.drop(); return; }
      const m = P.master;
      P.master = null;
      for (const rec of [...P.buses]) { clearTimeout(rec.timer); P.buses.delete(rec); }
      if (!m) return;
      const t = P.ctx.currentTime;
      m.gain.cancelScheduledValues(t);
      m.gain.setValueAtTime(m.gain.value, t);
      m.gain.linearRampToValueAtTime(0, t + 0.03);
      setTimeout(() => { try { if (m.teardown) m.teardown(); else m.disconnect(); } catch { /* すでに外れている */ } }, 120);
    } catch { /* 無音にできなくても進行には関係しない */ }
  };
  return P;
}
