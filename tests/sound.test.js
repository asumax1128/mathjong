// 効果音（Ver.0.5-D）の単体テスト。src/ui/sound.js は DOM を持たず、渡された AudioContext（ここでは偽物）に音を予約するだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOUND_KEY, parseSoundSetting, SOUNDS, soundKindOf, pickSound, RECIPES, recipeEnd, MASTER_GAIN,
  makeNoiseData, createMasterChain, scheduleRecipe, createSoundPlayer,
} from '../src/ui/sound.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor } from './helpers.js';

const KINDS = ['discard', 'chi', 'pon', 'riichi', 'ron', 'tsumo'];

// ---- 偽の AudioContext（予約された声の数・状態・resume の回数を数える）----
function mockCtx(state = 'running') {
  const calls = { sources: 0, started: [], resumes: 0, created: 0, gains: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  class Ctx {
    constructor() { calls.created++; this.state = state; this.sampleRate = 44100; this.currentTime = 1; this.destination = { id: 'dest' }; }
    resume() { calls.resumes++; return Promise.resolve(); }
    createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; }
    createGain() { calls.gains++; return { gain: param(), connect() {}, disconnect() {} }; }
    createDynamicsCompressor() { return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect() {} }; }
    createBiquadFilter() { return { type: '', Q: param(), frequency: param(), connect() {} }; }
    createOscillator() { calls.sources++; return { type: '', frequency: param(), connect() {}, start(t) { calls.started.push(t); }, stop() {} }; }
    createBufferSource() { calls.sources++; return { buffer: null, connect() {}, start(t) { calls.started.push(t); }, stop() {} }; }
  }
  return { Ctx, calls };
}

test('設定：保存キー mj-sound、"0" のときだけオフ。未保存・異常値はオン', () => {
  assert.equal(SOUND_KEY, 'mj-sound');
  assert.equal(parseSoundSetting('0'), false);
  for (const v of ['1', null, undefined, '', 'off', 'abc']) assert.equal(parseSoundSetting(v), true, String(v));
});

test('記録 → 音の種類：打牌・チー・ポン・リーチ・ロン・ツモ。牌を引く・流局・不明は鳴らさない', () => {
  assert.equal(soundKindOf({ type: 'discard', seat: 0 }), 'discard');
  assert.equal(soundKindOf({ type: 'chi', seat: 1 }), 'chi');
  assert.equal(soundKindOf({ type: 'pon', seat: 1 }), 'pon');
  assert.equal(soundKindOf({ type: 'riichi', seat: 1, tile: 3 }), 'riichi');
  assert.equal(soundKindOf({ type: 'win', how: 'ron' }), 'ron');
  assert.equal(soundKindOf({ type: 'win', how: 'tsumo' }), 'tsumo');
  for (const e of [{ type: 'draw' }, { type: 'win', how: 'x' }, { type: 'exhaustive-draw' }, { type: 'unknown' }, null, undefined]) assert.equal(soundKindOf(e), null);
});

test('優先度：ロン・ツモ ＞ リーチ ＞ ポン ＞ チー ＞ 打牌。同じ回に複数の記録が増えても鳴るのは1つ', () => {
  assert.ok(SOUNDS.ron.prio === SOUNDS.tsumo.prio && SOUNDS.ron.prio > SOUNDS.riichi.prio);
  assert.ok(SOUNDS.riichi.prio > SOUNDS.pon.prio && SOUNDS.pon.prio > SOUNDS.chi.prio && SOUNDS.chi.prio > SOUNDS.discard.prio);
  // リーチ宣言：リーチの記録は宣言牌の打牌の記録より前に残る → リーチ音だけ（打牌音は重ならない）
  const ev = [{ type: 'draw' }, { type: 'riichi', seat: 0, tile: 4 }, { type: 'discard', seat: 0, tile: 4 }];
  assert.equal(pickSound(ev, 0).kind, 'riichi');
  assert.equal(pickSound(ev, 0).index, 1);
  // 打牌 → ロン が一度に増えたらロン
  assert.equal(pickSound([{ type: 'discard' }, { type: 'win', how: 'ron' }], 0).kind, 'ron');
  assert.equal(pickSound([{ type: 'discard' }, { type: 'pon' }], 0).kind, 'pon');
  assert.equal(pickSound([{ type: 'discard' }, { type: 'chi' }], 0).kind, 'chi');
  assert.equal(pickSound([{ type: 'draw' }, { type: 'draw' }], 0).kind, null);
});

test('二重再生の防止：同じ記録で2回選ばない。別の局（記録が短い）は数え直す', () => {
  const ev = [{ type: 'discard' }, { type: 'pon' }];
  const a = pickSound(ev, 0);
  assert.equal(a.kind, 'pon');
  assert.equal(a.next, 2);
  assert.equal(pickSound(ev, a.next).kind, null, '同じ記録は2回鳴らさない');
  ev.push({ type: 'discard' });
  assert.equal(pickSound(ev, a.next).kind, 'discard', '新しい記録だけ');
  assert.equal(pickSound([{ type: 'chi' }], 99).kind, 'chi', '別の局は先頭から数え直す');
});

test('レシピ：6種類すべてあり、値が正常（有限・正・時刻の順序）。長さは短く、種類ごとに特徴が異なる', () => {
  assert.deepEqual(Object.keys(RECIPES).sort(), [...KINDS].sort());
  const seen = new Set();
  for (const kind of KINDS) {
    const r = RECIPES[kind];
    assert.ok(r.length >= 3, `${kind}：声が複数（厚みのある音）`);
    for (const v of r) {
      assert.ok(v.k === 'osc' || v.k === 'noise');
      if (v.k === 'osc') {
        assert.ok(['sine', 'triangle', 'square', 'sawtooth'].includes(v.w), `${kind} 波形`);
        assert.ok(v.f.length >= 1 && v.f.every((x) => Number.isFinite(x) && x > 20 && x < 12000), `${kind} 周波数 ${v.f}`);
      }
      assert.ok(Number.isFinite(v.t) && v.t >= 0 && Number.isFinite(v.d) && v.d > 0.01, `${kind} 時刻`);
      assert.ok(v.g > 0 && v.g <= 2, `${kind} 音量 ${v.g}`);
      assert.ok((v.a ?? 0.002) < v.d, `${kind} 立ち上がりは長さより短い`);
      if (v.filter) assert.ok(['lowpass', 'highpass', 'bandpass'].includes(v.filter.type) && v.filter.f.every((x) => x > 20 && x < 20000));
    }
    seen.add(JSON.stringify(r));
  }
  assert.equal(seen.size, 6, '6種類は互いに違う音');
  // 長さ（短く、はっきり）：打牌 ＜ チー ＜ ポン ＜ リーチ ・ ロン ・ ツモ。ロン・ツモ・リーチは 1.2 秒以内
  const len = Object.fromEntries(KINDS.map((k) => [k, recipeEnd(RECIPES[k])]));
  assert.ok(len.discard <= 0.15, `打牌 ${len.discard}`);
  assert.ok(len.chi <= 0.3 && len.chi > len.discard);
  assert.ok(len.pon <= 0.4 && len.pon > len.discard);
  assert.ok(len.riichi >= 0.6 && len.riichi <= 1.0, `リーチ ${len.riichi}`);
  assert.ok(len.ron >= 0.8 && len.ron <= 1.2, `ロン ${len.ron}`);
  assert.ok(len.tsumo >= 0.8 && len.tsumo <= 1.2, `ツモ ${len.tsumo}`);
});

test('雑音は決まった式（毎回同じ）で、-1〜1 に収まる。音声ファイル・外部の音源は使わない', () => {
  const a = makeNoiseData(2000);
  const b = makeNoiseData(2000);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.ok(a.every((x) => x >= -1 && x <= 1));
  assert.ok(new Set(Array.from(a)).size > 1900, '白色雑音らしくばらつく');
  const src = readFileSync(new URL('../src/ui/sound.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|new Audio|decodeAudioData|\.mp3|\.wav|\.ogg|\.m4a|Math\.random/.test(src), '音は自作の合成だけ（ファイル・乱数なし）');
});

test('scheduleRecipe：偽の AudioContext に、レシピの声の数だけ予約する。開始時刻は指定時刻以降。例外を出さない', () => {
  for (const kind of KINDS) {
    const { Ctx, calls } = mockCtx();
    const ctx = new Ctx();
    const end = scheduleRecipe(ctx, ctx.destination, kind, 5);
    assert.equal(calls.sources, RECIPES[kind].length, kind);
    assert.ok(calls.started.every((t) => t >= 5), kind);
    assert.ok(Math.abs(end - (5 + recipeEnd(RECIPES[kind]))) < 1e-9);
  }
  const { Ctx } = mockCtx();
  const ctx = new Ctx();
  assert.equal(scheduleRecipe(ctx, ctx.destination, 'nope', 3), 3, '知らない種類は何もしない');
  const m = createMasterChain(ctx);
  assert.ok(m && MASTER_GAIN > 0 && MASTER_GAIN < 1);
});

test('再生管理：操作の前は無音（AudioContext を作らない）、unlock で作って resume、running で鳴る', () => {
  const { Ctx, calls } = mockCtx('suspended');
  let on = true;
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => on });
  assert.equal(P.play('discard'), 'nocontext', '操作の前は鳴らさない');
  assert.equal(calls.created, 0, '操作の前に AudioContext を作らない（iOS の規則）');
  assert.equal(P.unlock(), true);
  assert.equal(calls.created, 1);
  assert.equal(calls.resumes, 1, 'suspended なら resume() を呼ぶ');
  assert.equal(P.play('pon'), 'blocked', 'まだ suspended：無音で戻る（待たない）');
  assert.equal(calls.sources, 1, '無音の1サンプルだけ（unlock）');
  P.ctx.state = 'running'; // resume が完了した
  assert.equal(P.play('pon'), 'played');
  assert.equal(calls.sources, 1 + RECIPES.pon.length);
  assert.equal(P.play('ron'), 'played');
  on = false;
  const before = calls.sources;
  assert.equal(P.play('ron'), 'off', 'オフなら鳴らさない');
  assert.equal(calls.sources, before);
  assert.deepEqual(P.log.map((x) => x.status), ['nocontext', 'blocked', 'played', 'played', 'off']);
});

test('再生管理：interrupted（iOS の着信・バックグラウンド）でも、次の操作で再開を試みる。例外を出さない', () => {
  const { Ctx, calls } = mockCtx('interrupted');
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  P.unlock();
  const r1 = calls.resumes;
  P.unlock();
  assert.equal(calls.resumes, r1 + 1, '操作のたびに再開を試みる');
  assert.equal(P.play('chi'), 'blocked');
  P.ctx.state = 'running';
  const r2 = calls.resumes;
  P.unlock();
  assert.equal(calls.resumes, r2, 'running なら呼ばない');
  assert.equal(P.play('chi'), 'played');
});

test('再生管理：AudioContext がない・作れない・resume が失敗しても、例外を出さず無音で続く', () => {
  const none = createSoundPlayer({ getCtor: () => null, isOn: () => true });
  assert.equal(none.unlock(), false);
  assert.equal(none.play('ron'), 'nocontext');
  none.silence();
  const thrower = createSoundPlayer({ getCtor: () => class { constructor() { throw new Error('denied'); } }, isOn: () => true });
  assert.equal(thrower.unlock(), false);
  assert.equal(thrower.play('ron'), 'nocontext');
  const { Ctx } = mockCtx('suspended');
  class Bad extends Ctx { resume() { return Promise.reject(new Error('no')); } }
  const bad = createSoundPlayer({ getCtor: () => Bad, isOn: () => true });
  assert.doesNotThrow(() => bad.unlock());
  assert.equal(bad.play('tsumo'), 'blocked');
  // 予約の途中で失敗しても例外を外へ出さない
  class Broken extends Ctx { createOscillator() { throw new Error('boom'); } }
  const br = createSoundPlayer({ getCtor: () => Broken, isOn: () => true });
  br.unlock();
  br.ctx.state = 'running';
  assert.equal(br.play('discard'), 'error');
});

test('silence：新しい局・タイトルへ戻るとき、鳴っている音を絞る。次の再生は新しい出力で鳴る', () => {
  const { Ctx, calls } = mockCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  P.unlock();
  assert.equal(P.play('ron'), 'played');
  const m = P.master;
  assert.ok(m);
  P.silence();
  assert.equal(P.master, null);
  assert.equal(P.play('chi'), 'played');
  assert.notEqual(P.master, m, '新しい出力の連鎖');
  assert.ok(calls.gains >= 4);
  assert.doesNotThrow(() => P.silence());
});

test('実際の対局：数学Ⅰ・Ⅱの AI 対局（リーチあり）で、記録から全種類の音を検出し、音の判定でゲームの結果が変わらない。1つの記録で2回鳴らない', () => {
  const total = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 14; i++) {
      const lineup = ['speed', 'value', 'closed', 'speed'];
      const run = (scan) => {
        const g = new Game({ rules: r, seed: 900 + i, dealer: i % 4, players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
        const rng = createRng(i);
        let from = 0;
        let played = 0;
        let riichiEvents = 0;
        while (g.pending()) {
          const p = g.pending();
          applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
          if (scan) {
            const before = from;
            const pk = pickSound(g.events, from);
            from = pk.next;
            if (pk.kind) { total[pk.kind]++; played++; }
            riichiEvents += g.events.slice(before).filter((e) => e.type === 'riichi').length;
            // 同じ回の増分に含まれるリーチは必ずリーチ音（打牌音と重ならない）
            if (g.events.slice(before).some((e) => e.type === 'riichi')) assert.equal(pk.kind, 'riichi');
          }
        }
        if (scan) assert.ok(played <= g.events.length, '記録の数を超えて鳴らさない');
        return JSON.stringify({ events: g.events, result: g.result && { ...g.result, analysis: undefined } });
      };
      assert.equal(run(true), run(false), `${mode} 局${i}：音の判定は記録を変えない`);
    }
  }
  assert.ok(total.discard > 100 && total.ron + total.tsumo > 0 && total.pon + total.chi > 0, JSON.stringify(total));
  assert.ok(total.riichi > 0, `リーチ音が検出される ${JSON.stringify(total)}`);
});

test('構造：sound.js はエンジンを読み込まない。app.js は音の判定で状態を変えず、操作の許可は受け身・捕捉で行い、オフでは何も作らない', () => {
  const snd = readFileSync(new URL('../src/ui/sound.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"]\.\.\/engine/.test(snd), 'sound.js はエンジンを読み込まない');
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const scan = app.slice(app.indexOf('function soundScan()'), app.indexOf('// iPhone Safari：最初のタップ'));
  assert.ok(scan.includes('pickSound(g.events, S.sound.seen)') && scan.includes("if (pick.kind === 'discard') sound.play('discard');"), 'ここで鳴らすのは打牌だけ（Ver.0.5-E：宣言の音は演出の開始時）');
  const show = app.slice(app.indexOf('function fxShow('), app.indexOf('// 盤面の演出（ロン・ツモの画面揺れ'));
  assert.ok(show.includes('sound.play(kind,'), '宣言の音は演出が実際に始まったとき（fxShow）に鳴らす');
  assert.ok(!/g\.(discard|draw|chi|pon|ron|tsumo|riichi|pass)\s*\(/.test(scan), '音の判定はゲームを進めない');
  assert.ok(/for \(const t of \['touchend', 'pointerup', 'click', 'keydown'\]\)/.test(app) && app.includes("{ capture: true, passive: true }"));
  assert.ok(app.includes('const audioWanted = () => S.sound.on || voiceWanted();') && app.includes('if (!audioWanted()) return;'), '効果音も声も要らないときは AudioContext を作らない（監査 P2-B）');
  assert.ok(app.includes("soundScan(); //"), 'step() の先頭で、演出と同じく1回だけ判定する');
  assert.ok(app.includes('sound.silence()'), '新しい局・タイトルで音を止める');
});

// ---- P2（Codex 監査）：中断した音を、復帰後に鳴らさない ----
// 接続関係を持つ偽の AudioContext：ノードのつながりを記録し、「この音源は出力（destination）まで届くか」を調べられる。
function graphCtx(state = 'running') {
  const reg = { sources: [], listeners: [], created: 0, addCalls: 0, resumes: 0 };
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = () => {
    const n = { out: new Set(), type: '', buffer: null, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), start() {}, stop() {} };
    n.connect = (d) => { n.out.add(d); return d; };
    n.disconnect = () => { n.out.clear(); };
    return n;
  };
  class Ctx {
    constructor() { reg.created++; reg.ctx = this; this.state = state; this.sampleRate = 44100; this.currentTime = 1; this.destination = node(); this.destination.isDest = true; }
    addEventListener(type, fn) { reg.addCalls++; if (type === 'statechange') reg.listeners.push(fn); }
    resume() { reg.resumes++; return Promise.resolve(); }
    setState(s) { this.state = s; for (const fn of reg.listeners) fn(); } // 状態の変化と statechange
    createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; }
    createGain() { return node(); }
    createDynamicsCompressor() { return node(); }
    createBiquadFilter() { return node(); }
    createOscillator() { const n = node(); reg.sources.push(n); return n; }
    createBufferSource() { const n = node(); reg.sources.push(n); return n; }
  }
  const reaches = (n, seen = new Set()) => {
    if (n.isDest) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return [...n.out].some((d) => reaches(d, seen));
  };
  // 声（レシピの音源）だけ。unlock の無音の1サンプルは除く
  const voices = () => reg.sources.filter((s) => !(s.buffer && s.buffer.length === 1));
  return { Ctx, reg, reaches, voices };
}

test('P2：suspended になったら、鳴っている音（予約済みを含む）を切り離す。復帰しても古い音は出力に届かず、新しい音は届く', () => {
  const { Ctx, reg, reaches, voices } = graphCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  P.unlock();
  assert.equal(P.play('riichi'), 'played');
  const old = voices().slice();
  assert.equal(old.length, RECIPES.riichi.length);
  assert.ok(old.every((s) => reaches(s)), '鳴らした直後はすべて出力に届く');
  assert.equal(P.buses.size, 1);
  reg.ctx.setState('suspended'); // 音の途中で中断（statechange）
  assert.ok(old.every((s) => !reaches(s)), '中断したら、古い音源は出力に届かない');
  assert.equal(P.buses.size, 0);
  assert.equal(P.master, null);
  assert.equal(P.drops, 1);
  reg.ctx.setState('running'); // 復帰
  assert.ok(old.every((s) => !reaches(s)), '復帰しても古い音は出力に届かない（再接続されない）');
  assert.equal(P.play('discard'), 'played');
  const fresh = voices().slice(old.length);
  assert.equal(fresh.length, RECIPES.discard.length);
  assert.ok(fresh.every((s) => reaches(s)), '復帰後の新しい音は出力に届く');
  assert.ok(old.every((s) => !reaches(s)), '新しい音を鳴らしても古い音は戻らない');
  assert.equal(reg.created, 1, 'AudioContext は作り直さない');
});

test('P2：6種類すべて、中断で切り離される。interrupted（iOS）も同じ', () => {
  for (const kind of KINDS) {
    for (const st of ['suspended', 'interrupted']) {
      const { Ctx, reg, reaches, voices } = graphCtx();
      const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
      P.unlock();
      P.play(kind);
      const old = voices().slice();
      assert.ok(old.length === RECIPES[kind].length && old.every((s) => reaches(s)));
      reg.ctx.setState(st);
      assert.ok(old.every((s) => !reaches(s)), `${kind}/${st}`);
      reg.ctx.setState('running');
      assert.ok(old.every((s) => !reaches(s)), `${kind}/${st}：復帰後`);
    }
  }
});

test('P2：statechange を受け取れなくても、unlock・play が止まった状態を見つけて古い音を切り離してから再開する', () => {
  for (const via of ['unlock', 'play']) {
    const { Ctx, reg, reaches, voices } = graphCtx();
    const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
    P.unlock();
    P.play('ron');
    const old = voices().slice();
    reg.ctx.state = 'suspended'; // イベントなしで止まった
    const r0 = reg.resumes;
    if (via === 'unlock') P.unlock(); else assert.equal(P.play('tsumo'), 'blocked', '中断中の要求は鳴らさない');
    assert.ok(old.every((s) => !reaches(s)), `${via}：再開を試みる前に切り離す`);
    assert.equal(reg.resumes, r0 + 1, '再開は試みる');
    assert.equal(voices().length, old.length, '中断中の要求は声を予約しない');
    reg.ctx.state = 'running';
    assert.ok(old.every((s) => !reaches(s)), `${via}：復帰後も古い音は出力に届かない`);
    assert.equal(P.play('chi'), 'played');
  }
});

test('P2：中断中に新しい音を要求しても、復帰後に鳴らない（その場で無音・待たない・溜めない）', () => {
  const { Ctx, reg, reaches, voices } = graphCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  P.unlock();
  reg.ctx.setState('suspended');
  const before = voices().length;
  for (const k of KINDS) assert.equal(P.play(k), 'blocked');
  assert.equal(voices().length, before, '予約しない');
  assert.equal(P.buses.size, 0);
  reg.ctx.setState('running');
  assert.equal(voices().length, before);
  assert.ok(voices().every((s) => !reaches(s)));
});

test('P2：複数回の中断・復帰。AudioContext・statechange のリスナー・出力は増え続けない', () => {
  const { Ctx, reg, reaches, voices } = graphCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  for (let i = 0; i < 5; i++) P.unlock(); // 連続した unlock
  assert.equal(reg.created, 1);
  assert.equal(reg.addCalls, 1, 'リスナーは1つ');
  const all = [];
  for (let i = 0; i < 6; i++) {
    P.play(KINDS[i % 6]);
    all.push(...voices().slice(all.length));
    reg.ctx.setState(i % 2 ? 'interrupted' : 'suspended');
    P.unlock(); P.unlock();
    reg.ctx.setState('running');
    assert.equal(P.buses.size, 0);
  }
  assert.ok(all.length > 0 && all.every((s) => !reaches(s)), '何度中断・復帰しても、古い音は出力に届かない');
  assert.equal(reg.created, 1);
  assert.equal(reg.addCalls, 1);
  assert.equal(P.play('ron'), 'played');
  assert.ok(voices().slice(all.length).every((s) => reaches(s)));
});

test('P2：drop は何度呼んでも安全。何も鳴っていなければ破棄回数を増やさない', () => {
  const { Ctx } = graphCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  assert.doesNotThrow(() => P.drop());
  assert.equal(P.drops, 0);
  P.unlock();
  P.drop();
  assert.equal(P.drops, 0);
  P.play('pon');
  P.drop(); P.drop();
  assert.equal(P.drops, 1);
  assert.equal(P.play('pon'), 'played');
});

test('P2：鳴り終わる時刻（実時間）を過ぎた音の出力は、気づけなくても切り離される。短時間に何度鳴らしても溜まらない', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { Ctx, reaches, voices } = graphCtx();
  const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  P.unlock();
  P.play('ron');
  const ron = voices().slice();
  t.mock.timers.tick(400);
  assert.ok(ron.every((s) => reaches(s)), '鳴っている最中は切り離さない');
  t.mock.timers.tick(1200);
  assert.ok(ron.every((s) => !reaches(s)), '音の長さ（0.95秒）＋余裕の実時間のあとに切り離す');
  assert.equal(P.buses.size, 0);
  for (let i = 0; i < 40; i++) P.play(KINDS[i % 6]);
  assert.equal(P.buses.size, 40);
  t.mock.timers.tick(2000);
  assert.equal(P.buses.size, 0, '溜まらない');
});

test('P2：silence は止まった context では絞る処理が進まないので切り離す。動いているときは従来どおり絞ってから外す', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  {
    const { Ctx, reg, reaches, voices } = graphCtx();
    const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
    P.unlock(); P.play('ron');
    const v = voices().slice();
    reg.ctx.state = 'suspended';
    P.silence();
    assert.ok(v.every((s) => !reaches(s)));
    assert.equal(P.master, null);
  }
  {
    const { Ctx, reaches, voices } = graphCtx();
    const P = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
    P.unlock(); P.play('ron');
    const v = voices().slice();
    P.silence();
    assert.equal(P.master, null);
    assert.ok(v.every((s) => reaches(s)), '絞っている間（約0.03秒）はまだつながっている');
    t.mock.timers.tick(200);
    assert.ok(v.every((s) => !reaches(s)), 'そのあと切り離す');
    assert.equal(P.play('chi'), 'played', '次の再生は新しい出力で鳴る');
  }
});

test('P2 構造：画面が隠れた・ページを離れたとき drop する（リスナーは1回だけ登録）。P3：設定名は「視覚演出」で選択肢・保存キー・動作は不変', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/addEventListener\('visibilitychange'/g) || []).length, 1);
  assert.equal((app.match(/addEventListener\('pagehide'/g) || []).length, 1);
  assert.ok(app.includes("document.addEventListener('visibilitychange', () => { if (document.hidden) sound.drop(); })"));
  assert.ok(app.includes("window.addEventListener('pagehide', () => sound.drop())"));
  const m = app.match(/<label class="setting">([^<]*)<select data-action="fx-mode">(.*?)<\/select>/);
  assert.ok(m, '演出の設定項目');
  assert.equal(m[1].trim(), '視覚演出');
  assert.ok(/value="full"[^>]*>通常<\/option>/.test(m[2]) && /value="lite"[^>]*>簡易（文字だけ）<\/option>/.test(m[2]), '選択肢は 通常／簡易（文字だけ）');
  assert.ok(!app.includes('>ロン・ポン・チーの演出 <select'), '旧名称は残さない');
  const fx = readFileSync(new URL('../src/ui/effects.js', import.meta.url), 'utf8');
  assert.ok(fx.includes("EFFECT_MODE_KEY = 'mj-effects'"), '保存キーは不変');
});
