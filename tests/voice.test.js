// 宣言ボイス（Ver.0.5-E：導入の準備, src/ui/voice.js）の単体テスト。
// 正式に採用された音声はまだないので、テスト用の設定（manifest）と偽の fetch・AudioContext で、読み込み・再生・失敗時・中断時を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_KEY, parseVoiceSetting, VOICE_KINDS, VOICE_MANIFEST, validateManifest, createVoicePlayer } from '../src/ui/voice.js';
import { createSoundPlayer } from '../src/ui/sound.js';

const M = { id: 'test', credit: 'テスト用', gain: 1, sfxGain: 0.5, files: { chi: 'src/ui/voice-test-chi.m4a', pon: 'src/ui/voice-test-pon.m4a', ron: 'src/ui/voice-test-ron.m4a', tsumo: 'src/ui/voice-test-tsumo.mp3' } };

// 接続関係を持つ偽の AudioContext（音源が出力まで届くかを調べられる）。decodeAudioData は Promise 形式とコールバック形式の両方を試せる
function graphCtx({ state = 'running', decode = 'promise', failDecode = [] } = {}) {
  const reg = { sources: [], listeners: [], decodes: 0 };
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = () => {
    const n = { out: new Set(), type: '', buffer: null, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), start() {}, stop() {} };
    n.connect = (d) => { n.out.add(d); return d; };
    n.disconnect = () => { n.out.clear(); };
    return n;
  };
  class Ctx {
    constructor() { reg.ctx = this; this.state = state; this.sampleRate = 44100; this.currentTime = 1; this.destination = node(); this.destination.isDest = true; }
    addEventListener(type, fn) { if (type === 'statechange') reg.listeners.push(fn); }
    resume() { return Promise.resolve(); }
    setState(s) { this.state = s; for (const fn of reg.listeners) fn(); }
    createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, duration: len / 44100, getChannelData: () => d }; }
    createGain() { return node(); }
    createDynamicsCompressor() { return node(); }
    createBiquadFilter() { return node(); }
    createOscillator() { const n = node(); reg.sources.push(n); return n; }
    createBufferSource() { const n = node(); reg.sources.push(n); return n; }
    decodeAudioData(data, ok, ng) {
      reg.decodes++;
      const name = new TextDecoder().decode(data);
      const fail = failDecode.some((k) => name.includes(k));
      const buf = { duration: 0.8, name };
      if (decode === 'callback') { setTimeout(() => (fail ? ng(new Error('decode')) : ok(buf)), 0); return undefined; }
      return fail ? Promise.reject(new Error('decode')) : Promise.resolve(buf);
    }
  }
  const reaches = (n, seen = new Set()) => { if (n.isDest) return true; if (seen.has(n)) return false; seen.add(n); return [...n.out].some((d) => reaches(d, seen)); };
  return { Ctx, reg, reaches };
}
// 偽の fetch：ファイル名をそのまま中身として返す。missing の名前を含むものは 404
const fakeFetch = (calls, missing = []) => async (url) => {
  calls.push(url);
  if (missing.some((m) => url.includes(m))) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
};

test('設定：保存キー mj-voice、"0" のときだけオフ。正式採用された音声はまだない（VOICE_MANIFEST は null）', () => {
  assert.equal(VOICE_KEY, 'mj-voice');
  assert.equal(parseVoiceSetting('0'), false);
  for (const v of ['1', null, undefined, '', 'x']) assert.equal(parseVoiceSetting(v), true);
  assert.deepEqual(VOICE_KINDS, ['chi', 'pon', 'ron', 'tsumo']);
  assert.equal(VOICE_MANIFEST, null, 'オーナーが採用するまで、仮の声を組み込まない');
});

test('音声の設定の検査：4種類すべて・決まった場所（src/ui/voice-*.m4a|mp3）・音量の範囲。正しくなければ使わない', () => {
  assert.equal(validateManifest(M), true);
  assert.equal(validateManifest(null), false);
  assert.equal(validateManifest({ ...M, id: '' }), false);
  assert.equal(validateManifest({ ...M, files: { ...M.files, tsumo: undefined } }), false, '1種類でも欠けたら使わない');
  for (const bad of ['../secret.m4a', 'src/ui/voice-x.wav', 'https://example.com/voice-x.mp3', 'src/ui/Voice-x.mp3', 'src/engine/voice-x.mp3', 'src/ui/voice-.mp3']) {
    assert.equal(validateManifest({ ...M, files: { ...M.files, chi: bad } }), false, bad);
  }
  assert.equal(validateManifest({ ...M, gain: 0 }), false);
  assert.equal(validateManifest({ ...M, sfxGain: 3 }), false);
});

test('採用された音声がないとき：何も読み込まず、鳴らさない（効果音だけで遊べる）', async () => {
  const calls = [];
  const { Ctx } = graphCtx();
  const sound = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  sound.unlock();
  const V = createVoicePlayer({ sound, isOn: () => true, fetchFn: fakeFetch(calls) });
  assert.equal(V.available(), false);
  assert.equal(await V.load(), false);
  assert.equal(V.play('ron'), 'none');
  assert.equal(calls.length, 0);
  assert.equal(V.sfxGain(), 1, '効果音の音量も下げない');
});

test('読み込み：操作（AudioContext）の前は読まない。後で1回だけ4種類を読む（同時に呼んでも1回）。Promise 形式・コールバック形式の decode', async () => {
  for (const decode of ['promise', 'callback']) {
    const calls = [];
    const { Ctx, reg } = graphCtx({ decode });
    const sound = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
    const V = createVoicePlayer({ sound, isOn: () => true, fetchFn: fakeFetch(calls), manifest: M });
    assert.equal(V.available(), true);
    assert.equal(await V.load(), false, 'AudioContext がまだない');
    assert.equal(V.play('ron'), 'notready');
    assert.equal(calls.length, 0);
    sound.unlock();
    await Promise.all([V.load(), V.load(), V.load()]);
    assert.equal(calls.length, 4, `${decode}：4種類を1回ずつ`);
    assert.equal(reg.decodes, 4);
    assert.deepEqual(Object.keys(V.buffers).sort(), [...VOICE_KINDS].sort());
    await V.load();
    assert.equal(calls.length, 4, '読み込み済みなら読み直さない');
  }
});

test('再生：読み込み済みなら共通の再生管理（playBuffer）で鳴らし、声と重なる効果音の音量を下げる。オフなら鳴らさない', async () => {
  const calls = [];
  const { Ctx, reg, reaches } = graphCtx();
  let on = true;
  const sound = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  sound.unlock();
  const V = createVoicePlayer({ sound, isOn: () => on, fetchFn: fakeFetch(calls), manifest: M });
  await V.load();
  const before = reg.sources.length;
  assert.equal(V.play('ron'), 'played');
  const src = reg.sources[before];
  assert.equal(src.buffer.name, 'src/ui/voice-test-ron.m4a', 'ロンの声');
  assert.ok(reaches(src), '出力に届く');
  assert.equal(sound.log.at(-1).kind, 'voice:ron');
  assert.equal(V.sfxGain(), 0.5);
  assert.equal(V.play('riichi'), 'none', 'リーチの声はない（4種類だけ）');
  on = false;
  assert.equal(V.play('pon'), 'off');
  assert.equal(reg.sources.length, before + 1);
});

test('読み込み・再生の失敗：その種類だけ鳴らさず、例外を出さない。ほかの種類と効果音は鳴る', async () => {
  const calls = [];
  const { Ctx } = graphCtx({ failDecode: ['tsumo'] });
  const sound = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
  sound.unlock();
  const V = createVoicePlayer({ sound, isOn: () => true, fetchFn: fakeFetch(calls, ['pon']), manifest: M });
  await V.load();
  assert.deepEqual(Object.keys(V.buffers).sort(), ['chi', 'ron']);
  assert.match(V.errors.pon, /404/);
  assert.match(V.errors.tsumo, /decode/);
  assert.equal(V.play('pon'), 'notready');
  assert.equal(V.play('tsumo'), 'notready');
  assert.equal(V.play('chi'), 'played');
  assert.equal(sound.play('pon'), 'played', '効果音は鳴る');
  // fetch そのものが例外を出しても大丈夫
  const V2 = createVoicePlayer({ sound, isOn: () => true, fetchFn: async () => { throw new Error('offline'); }, manifest: M });
  await assert.doesNotReject(V2.load());
  assert.equal(V2.play('ron'), 'notready');
});

test('P2（Ver.0.5-D）を再発させない：中断・画面が隠れた・次の局で、宣言ボイスも効果音と同じように切り離される', async () => {
  for (const how of ['suspended', 'interrupted', 'drop', 'silence-suspended']) {
    const { Ctx, reg, reaches } = graphCtx();
    const sound = createSoundPlayer({ getCtor: () => Ctx, isOn: () => true });
    sound.unlock();
    const V = createVoicePlayer({ sound, isOn: () => true, fetchFn: fakeFetch([]), manifest: M });
    await V.load();
    const before = reg.sources.length;
    V.play('ron');
    sound.play('ron', { gain: V.sfxGain() });
    const voiceSrc = reg.sources[before];
    assert.ok(reaches(voiceSrc));
    if (how === 'drop') sound.drop(); // 画面が隠れた・ページを離れた
    else if (how === 'silence-suspended') { reg.ctx.state = 'suspended'; sound.silence(); } // 中断中に次の局へ
    else reg.ctx.setState(how);
    assert.ok(!reaches(voiceSrc), `${how}：古い声は出力に届かない`);
    reg.ctx.setState('running');
    assert.ok(!reaches(voiceSrc), `${how}：復帰後も古い声は戻らない`);
    assert.equal(V.play('chi'), 'played', '新しい声は鳴る');
    assert.ok(reaches(reg.sources.at(-1)));
  }
});

test('構造：声は演出が実際に始まったとき（fxShow）に鳴らし、鳴ったときだけ宣言の効果音を下げる。設定項目は採用された音声があるときだけ出す', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const show = app.slice(app.indexOf('function fxShow('), app.indexOf('// 盤面の演出（ロン・ツモの画面揺れ'));
  assert.match(show, /const v = voice\.play\(kind\);\s*\n\s*sound\.play\(kind, v === 'played' \? \{ gain: voice\.sfxGain\(\) \} : \{\}\);/);
  assert.ok(app.includes('${voice.available() ? `<label class="setting">宣言ボイス <select data-action="voice">'), '採用された音声があるときだけ設定に出す');
  assert.ok(app.includes("store.set(VOICE_KEY, S.voice.on ? '1' : '0');"));
  const v = readFileSync(new URL('../src/ui/voice.js', import.meta.url), 'utf8');
  assert.ok(!/from ['"]\.\.\/engine/.test(v), 'voice.js はエンジンを読み込まない');
  assert.ok(!/new Audio\(|<audio/.test(v), 'HTMLAudioElement は使わない（AudioContext の中断管理の外に出さない）');
});
