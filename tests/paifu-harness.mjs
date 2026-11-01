// 牌譜テスト用：app.js と同じ式で試合を進め（seed＝seedBase＋局番号×7919、親＝dealerOf、精算＝applyRoundResult）、
// src/engine/paifu.js で記録する。席0（人間）の判断は AI の方針で代わりに打つ（出どころは 'human'／自動パス／自動ツモ切り）。
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, RIICHI_DEPOSIT } from '../src/engine/match.js';
import { MAX_ROUND } from '../src/ui/params.js';
import { createPaifu, beginRound, appendStep, settleRound, endRecording, paifuRules, ROUND_SEED_STEP } from '../src/engine/paifu.js';

export const SEATS = ['human', 'aoto', 'kanata', 'mitsuki'];
export const PLAYERS = [{ kind: 'human', name: 'あなた' }, { kind: 'ai', name: 'あおと', id: 'aoto' }, { kind: 'ai', name: 'かなた', id: 'kanata' }, { kind: 'ai', name: 'みつき', id: 'mitsuki' }];

// opts：mode, length, seedBase, stopAfterSteps（途中退出）, humanPolicy（席0の代わりに打つキャラクター）, autoPassChance
// leaveOpen：stopAfterSteps で止めたとき、中断にせず記録中のまま返す（保存の上限・自動削除のテスト用）
export function playRecorded({ mode = 'math1', length = 4, seedBase = 12345, stopAfterSteps = null, humanAs = 'yujin', id = 'test-record', autoPass = true, leaveOpen = false } = {}) {
  const rules = paifuRules(mode);
  let match = createMatch({ length, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  let p = createPaifu({ id, createdAt: '2026-11-01T00:00:00.000Z', appVersion: '0.7.0', mode, length, seedBase, players: PLAYERS, match });
  const rng = createRng(seedBase ^ 0x5bd1e995);
  const ids = ['human', ...SEATS.slice(1)];
  let steps = 0, round = 1;
  const counts = { human: 0, 'auto-pass': 0, 'auto-tsumogiri': 0, ai: 0, riichi: 0, chi: 0, pon: 0, ron: 0, tsumo: 0, ankan: 0 };
  while (!match.over) {
    const g = new Game({ rules, seed: seedBase + round * ROUND_SEED_STEP, dealer: dealerOf(match), players: PLAYERS, round, ruleset: 2 });
    p = beginRound(p, g);
    while (g.pending()) {
      const q = g.pending();
      const who = q.seat === 0 ? humanAs : ids[q.seat];
      let action = decideCharacter(g, q.seat, who, rng, null, [humanAs, ...ids.slice(1)]);
      let source = q.seat === 0 ? 'human' : 'ai';
      // 自動パスの代わり：席0の鳴きだけの宣言（ロンなし）を見送る（交互に）
      if (q.seat === 0 && autoPass && q.type === 'claim' && !q.ron && (q.pon || q.chi.length) && action.type === 'pass' && steps % 2) source = 'auto-pass';
      // 自動ツモ切りの代わり：リーチ中のツモ切り
      if (q.seat === 0 && q.type === 'turn' && g.riichi[0] && action.type === 'discard' && action.tile === g.drawn) source = 'auto-tsumogiri';
      const before = g.events.length;
      applyAction(g, q.seat, action);
      counts[source]++;
      if (action.riichi) counts.riichi++;
      if (['chi', 'pon', 'ron', 'tsumo', 'ankan'].includes(action.type)) counts[action.type]++;
      p = appendStep(p, g, { seat: q.seat, action, source, eventsBefore: before });
      steps++;
      if (stopAfterSteps !== null && steps >= stopAfterSteps) return { record: leaveOpen ? p : endRecording(p, 'left-match'), match, counts, game: g };
    }
    match = applyRoundResult(match, g.result, { round, maxRound: MAX_ROUND, riichi: g.riichi });
    p = settleRound(p, g, match, { maxRound: MAX_ROUND });
    round++;
  }
  return { record: p, match, counts };
}
