// 宣言ボイス（Ver.0.5-E：導入の準備）。画面だけの機能で、ゲームのルール・判定・得点・進行には一切関わらない。
// チー・ポン・ロン・ツモの4種類の人の声を、音声ファイルから読み込んで鳴らす。
// **正式に採用された音声はまだない**（VOICE_MANIFEST が null）。オーナーが声を採用したら、ファイルを src/ui/ に置き、
// VOICE_MANIFEST に書く。それまでは何も読み込まず、設定画面にも項目を出さない（効果音だけで遊べる）。
// 再生は src/ui/sound.js の再生管理（playBuffer）を通すので、AudioContext の中断・画面が隠れた・次の局／タイトルでは、
// 効果音と同じように古い声も切り離される（Ver.0.5-D の P2 修正をそのまま使う）。tests/voice.test.js で検証。

export const VOICE_KEY = 'mj-voice';
// 保存値：'0' のときだけオフ。未保存・異常値・読込失敗は オン（採用された音声があるときだけ意味を持つ）。
export const parseVoiceSetting = (saved) => saved !== '0';

export const VOICE_KINDS = ['chi', 'pon', 'ron', 'tsumo'];

// 正式採用された音声（オーナーの承認後に設定する）。null：未採用（宣言ボイスなし）。
// 形式：{ id, credit, gain, sfxGain, files: { chi, pon, ron, tsumo } }
//   files：ページからの相対パス（src/ui/voice-<名前>.m4a または .mp3。iPhone Safari で再生できる形式）。
//   credit：利用条件で求められる表記（例 'VOICEVOX:〇〇'）。設定画面に表示する。
//   gain：声の音量（既定 1）。sfxGain：声と重なる宣言の効果音の音量（声を聞き取りやすくするため下げる。既定 0.55）。
export const VOICE_MANIFEST = null;

const FILE = /^src\/ui\/voice-[a-z0-9][a-z0-9-]*\.(?:m4a|mp3)$/;

// 音声の設定が正しいか（4種類すべてのファイルが決まった場所・形式にある）。正しくなければ使わない（宣言ボイスなし）。
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return false;
  if (typeof m.id !== 'string' || !m.id) return false;
  for (const k of ['gain', 'sfxGain']) if (m[k] !== undefined && !(Number.isFinite(m[k]) && m[k] > 0 && m[k] <= 2)) return false;
  return VOICE_KINDS.every((k) => typeof m.files[k] === 'string' && FILE.test(m.files[k]));
}

// 宣言ボイスの再生管理。
//   sound：src/ui/sound.js の再生管理（ctx・playBuffer を使う）。isOn：宣言ボイスの設定。fetchFn：fetch（テストで差し替え）。
//   manifest：使う音声の設定（既定は VOICE_MANIFEST。テスト用にローカルだけ差し替えられる）。
// 読み込み（load）：AudioContext ができた後（最初の操作の後）に1回だけ。失敗した種類は鳴らさない（効果音だけで続く）。
// 再生（play）：演出が実際に始まったときに呼ぶ。読み込みが済んでいなければ鳴らさない（待たない・後から鳴らさない）。
export function createVoicePlayer({ sound, isOn, fetchFn, manifest = VOICE_MANIFEST }) {
  const V = {
    manifest: validateManifest(manifest) ? manifest : null,
    buffers: {}, // kind → AudioBuffer
    errors: {}, // kind → 失敗の理由（確認用）
    loading: null, // 読み込み中の Promise（同時に2回読まない）
    loadedFor: null, // 読み込んだ AudioContext（別の context 用には読み直す）
    log: [], // 確認用：{ kind, status }（status：played／off／none／notready／blocked／nocontext／error）。最新100件
  };
  const note = (kind, status) => { V.log.push({ kind, status }); if (V.log.length > 100) V.log.shift(); return status; };
  V.available = () => !!V.manifest;
  // 音声の設定を差し替える（ローカルの開発・テスト用。公開サイトでは呼ばれない）。読み込み済みの音声は捨てて読み直す。
  V.setManifest = (m) => {
    V.manifest = validateManifest(m) ? m : null;
    V.buffers = {};
    V.errors = {};
    V.loadedFor = null;
    V.loading = null;
    return !!V.manifest;
  };

  const decode = (ctx, data) => new Promise((resolve, reject) => {
    // 古い Safari は Promise を返さず、コールバックだけを受け付ける
    try {
      const r = ctx.decodeAudioData(data, resolve, reject);
      if (r && typeof r.then === 'function') r.then(resolve, reject);
    } catch (e) { reject(e); }
  });

  // 採用された音声を読み込む（何度呼んでもよい。読み込み中・読み込み済みなら何もしない）
  V.load = () => {
    const ctx = sound.ctx;
    if (!V.manifest || !isOn() || !ctx) return Promise.resolve(false);
    if (V.loading) return V.loading;
    if (V.loadedFor === ctx) return Promise.resolve(true);
    const fetcher = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!fetcher) return Promise.resolve(false);
    V.loading = Promise.all(VOICE_KINDS.map(async (k) => {
      try {
        const res = await fetcher(V.manifest.files[k]);
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
        V.buffers[k] = await decode(ctx, await res.arrayBuffer());
        delete V.errors[k];
      } catch (e) {
        delete V.buffers[k];
        V.errors[k] = String((e && e.message) || e);
      }
    })).then(() => { V.loadedFor = ctx; V.loading = null; return true; });
    return V.loading;
  };

  // 宣言ボイスを鳴らす。戻り値は状態。鳴らせなかったときも例外を出さない。
  V.play = (kind) => {
    try {
      if (!V.manifest || !VOICE_KINDS.includes(kind)) return note(kind, 'none');
      if (!isOn()) return note(kind, 'off');
      const buf = V.buffers[kind];
      if (!buf) { V.load(); return note(kind, 'notready'); }
      return note(kind, sound.playBuffer(`voice:${kind}`, buf, { gain: V.manifest.gain ?? 1 }));
    } catch { return note(kind, 'error'); }
  };
  // 声と重なる宣言の効果音の音量（声が鳴るときだけ下げる）
  V.sfxGain = () => (V.manifest ? V.manifest.sfxGain ?? 0.55 : 1);
  return V;
}
