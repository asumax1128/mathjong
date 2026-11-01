# 数雀｜牌譜・振り返り・戦績 第1段階：通常対局の牌譜の自動記録・端末内保存（実装記録）

2026-11-01。開発計画：[PR #68](https://github.com/asumax1128/mathjong/pull/68)（`docs/73-paifu-review-stats-implementation-plan.md`）。既存の牌譜基盤：Draft [PR #37](https://github.com/asumax1128/mathjong/pull/37)（参照資料として残し、丸ごとはマージしない）。
最新 main（`d1d5eac`、聴牌サポート Ver.1 を含む）から独立したブランチで実装した。**振り返り画面・戦績画面は作らない**（第2・第3段階で別PR）。**AI・ルール・得点・ゲームエンジン（既存ファイル）・ヒント・聴牌サポートは変更しない。** 既存の再現 URL（`src/ui/replay.js`）と localStorage の保存キーは変更しない。

## PR #37 から移植したもの・作り直したもの
PR #37 の牌譜は旧 main（ruleset 2・1局戦・リーチ宣言料・アガリやめ以前）を前提にし、各手で山と全員の手牌のスナップショットを保存する。現行エンジンの状態（王牌・ドラ・フリテン・供託など）を含まないため、そのままは使えない。

| PR #37 | この PR | 扱い |
|---|---|---|
| `src/engine/paifu.js` | `src/engine/paifu.js` | **部分移植・作り直し**。エラー型 `PaifuError`、正規化 JSON、JSON の安全検査（プレーンな JSON・深さ・要素数・危険なキー）、バイト上限、凍結、「記録された選択を隔離した Game で再生して検証する」方式を移植。記録の形式は現行エンジンに合わせて作り直した（schemaVersion 2） |
| `src/ui/paifu-storage.js` | `src/ui/paifu-storage.js` | **移植・改修**。IndexedDB の原子的な書込み（`durability:'strict'`・`oncomplete` まで待つ）、トークンによる比較交換（CAS・別タブ／削除後の古い書込みを防ぐ）、SHA-256 の要約、失敗の分類（例外を出さず `{ok:false,error}`）、確定の途中の `outcome-unknown`。変更：DB名を `mathjong-paifu-records`（PR #37 の試作の DB と分離）、要約の項目を現行形式に、1局戦を許可、上限 100件・32MB、**上限に達したときの古い完了・中断の記録の自動削除（同じトランザクション）**、読めない行（壊れた行・将来の版）は一覧・容量計算で除外し自動では削除しない |
| `src/ui/paifu-session.js`・`paifu-lifecycle.js` | `src/ui/paifu-recorder.js` | **考え方を移植し、小さく作り直し**。保存の直列化（1件ずつ・保存中の変更は後で最新を保存）、失敗の分類、試合ごとの独立した保存の流れ（世代の分離）。Worker・復旧の照合・30秒ごとの保存は第1段階では使わない |
| `paifu-worker*.js`・`paifu-recovery.js`・`paifu-save-state.js` | — | 移植しない（第1段階の範囲外） |
| `tests/paifu-storage.test.js` | `tests/paifu-storage.test.js` | 失敗の契約のテストを現行形式に合わせて移植 |

## 記録の形式（schemaVersion 2、`visibility: 'private-full'`）
```
{ format:'mathjong-paifu', schemaVersion:2, kind:'normal-match', engineVersion, appVersion, visibility:'private-full',
  id, createdAt (ISO UTC),
  settings: { mode:'math1'|'math2', length:1|4|8, ruleset:2, seedBase, players:[{kind:'human',name}, {kind:'ai',name,id}×3] },
  initialMatch,                      // createMatch の直後（持ち点100×4・供託なし・宣言料5点・アガリやめ）
  status: 'recording'|'complete'|'aborted',
  rounds: [ { round, dealer, seed, matchBefore, startDigest,
              steps: [ { seat, source:'human'|'auto-pass'|'auto-tsumogiri'|'ai', action, events, digest } ],
              result: { type:'win', how, winner, from, points } | { type:'draw', reason } | null,
              settlement: { maxRound, riichi, deltas, matchAfter } | null } ],
  final: { scores, ranks, endReason, played } | null,
  termination: { reason:'left-match'|'reset'|'recording-error' } | null }
```
- **局の開始は保存しない**：配牌は seed（`seedBase＋局番号×7919`、app.js と同じ式）・親・局番号・ruleset から決定的に作られる。山・手牌のスナップショットの代わりに、配牌直後の状態の要約（`startDigest`）で一致を確かめる。
- **行動**：エンジンが受け付けた行動だけ（`discard`（`riichi:true`）・`chi`・`pon`・`pass`・`ron`・`tsumo`・`ankan`）。牌の選択・ヒント・並べ替えは記録しない。出どころ：手動（human）、チー・ポンの自動パス（auto-pass）、リーチ後の自動ツモ切り（auto-tsumogiri）、AI（ai）。
- **状態の要約（digest）**：行動の後のエンジンの状態（全員の手牌・山・河・面子・記録・リーチ・フリテン・王牌・結果）の正規化 JSON の FNV-1a（16桁）。改ざん・取り違えの検出用で、暗号学的な証明ではない。
- **精算**：`applyRoundResult` と同じ引数（局番号・`maxRound`・リーチ）。`matchAfter` を保存し、検証で計算し直して一致を確かめる。
- 1件の大きさ：1局戦 約5〜6KB、4局戦 約50KB、8局戦 約85〜125KB（試算）。上限 4MB。

## 再現・検証（`verifyPaifu`・`replayPaifuRound`）
- 局ごとに、設定から新しい Game を作り、`startDigest` を照合し、記録された行動を順にエンジンへ適用する（その席の判断番か・エンジンが受け付けるか・不変条件・`events` の数・digest）。**AI に再判断させない。ゲーム本体・AI の乱数を消費しない。**
- 精算・局の結果・リーチ・持ち点の変化・試合の状態（400点保存＝持ち点＋供託、終了時の供託0、終了理由）を計算し直して照合する。
- 未精算の局は最後の局だけ（記録中・中断）。完了は試合の終了と一致し、`final` を照合する。
- **保存の前に必ず検証する**（保存の中の `encodePaifu`）。読み込み（`decodePaifu`）でも検証する。検証に失敗した記録は保存しない。

## 記録の対象・対象外
| 対象 | 対象外（通常の牌譜に混ぜない） |
|---|---|
| 選択画面・同じ3人と再戦・新しい対局（設定画面）から始めた、現行ルール（ruleset 2）の通常対局。数学Ⅰ・Ⅱ × 1/4/8局戦 | 卒業試験（初心者の部屋）、初心者の部屋の練習（S.game を使わない）、再現 URL から始めた対局、過去のルールの版・旧規則、テスト用の山（presetWall）の局、テスト用のフックで状態を差し替えた局（記録をやめる） |

## 保存（IndexedDB・この端末のブラウザ内だけ）
- 保存の時点：各局の精算の後、試合の終了（完了）、途中退出（タイトルへ・相手を変更：中断 `left-match`）、新しい対局・再戦で記録中だった試合（中断 `reset`）、ページを離れる（`pagehide`：記録中のまま、ベストエフォート）。**行動ごとには保存しない。**
- 保存は非同期で、ゲームの進行は待たない・成否に依存しない。保存の中の検証（記録の再生）は描画の後に行う（8局戦で数十ms）。
- 失敗の扱い：利用不可（プライベートモード・IndexedDB の拒否）・容量不足・上限・タイムアウトは「保存できませんでした」と表示し、試合は続く（次の局の保存で再試行）。競合・結果不明・記録の検証失敗はその記録の保存をやめる（上書きで解決しない）。
- 記録の失敗（標準でない局・記録していない状態の変更）：記録をやめ、それまでの検証済みの部分を中断（`recording-error`）として保存する。完成した牌譜を偽造しない。
- 複数のタブ：記録ごとに別の ID とトークン。自動削除は完了・中断の記録だけ（記録中の記録は消さない）。
- 上限：100件・32MB。超えたら古い完了・中断の記録から自動で削除する（保存と同じトランザクション）。

## 画面（最小限）
- 最終結果：「牌譜：この試合をこの端末に保存しました（端末内だけ・送信しません）」／保存中／保存できませんでした（ゲームの進行・結果には影響しません）／記録できませんでした／この対局は牌譜の記録の対象外です。
- 設定（対局中）：同じ文で、いまの試合の記録の状態。
- タイトル：「牌譜：この端末にN件（通常対局を自動で記録・このブラウザ内だけに保存し、送信しません）」と「削除」（2段階：削除する／やめる）。保存を確認できない端末ではその旨。
- **牌譜の内容（手牌・山・他家の手）は表示しない。書き出し・共有の機能はない。**

## テスト
- 単体（`npm test` に含む）：
  - `tests/paifu.test.js`（13件）：数学Ⅰ・Ⅱ × 1/4/8局戦を記録して再現・検証（各局の digest・結果・精算・400点・終了時の供託0）、出どころ（手動・自動パス・自動ツモ切り・AI）とリーチ・ロン・ツモ・チー・ポン・暗カン、途中退出、標準でない局の拒否、対象外の試合、改ざん19種の拒否、JSON の往復と上限、ゲームの状態を変えない
  - `tests/paifu-storage.test.js`（15件）：失敗の契約（利用不可3種・DB を開くときの5種・blocked・タイムアウト・不正な引数・不正な設定・形の違う DB・確定途中の結果不明）
  - `tests/paifu-recorder.test.js`（16件）：app.js と同じ流れで、保存の時点・途中退出・再戦・対象外・保存の失敗6種・一時的な失敗からの回復・記録できない操作・テスト用の山・pagehide・記録あり／なしで対局が同じ・前の試合の保存中に新しい試合
  - `tests/paifu-harness.mjs`：app.js と同じ式で試合を進めるテスト用の道具
- E2E（Chromium・実際の IndexedDB。`tests/e2e/play.mjs`）：
  - `v15PaifuRecording`：iPhone 縦で数学Ⅰ1局戦を画面で打って完了として保存・読込で再生検証・最終の持ち点と最後の状態が一致、再戦で別の記録、タイトルの件数と2段階の削除・localStorage は不変、数学Ⅱ4局戦（チー・ポンの自動パス ON）、途中退出（中断・未精算の局はそのまま）
  - `v15PaifuExclusions`：卒業試験・再現 URL は記録しない、IndexedDB が使えない端末でも試合は最後まで進み「保存できませんでした」
  - `v15PaifuStorage`：上限で古い完了の記録から自動削除・記録中は残す・evict なしは既存を消さずに失敗、2つのタブの同時記録
  - 全体の E2E（既存の対局・リーチ・ヒント・聴牌サポート・結果画面・並べ替えの回帰）
- CI：`.github/workflows/paifu-recording.yml`（既存のエンジンのファイルが main と同じ・単体・ブラウザ。公開なし）

## 未解決・判断が必要な点
- 記録のモジュールは通常の起動で静的に読み込む（PR #37 の docs/57 は動的読込を推奨）。同じ配信物で CI の構文検査があるので、読込の失敗の危険は小さいと判断した。必要なら動的読込に変更する。
- 上限（100件・32MB）と、上限での古い記録の自動削除は暫定の方針。オーナーの判断を求める。
- 保存の中の検証（記録の再生）は主スレッドで行う（8局戦で数十ms、iPhone では長くなる可能性）。局の結果の表示中に行う。
- ページの再読み込み・クラッシュで終わった試合の記録は「記録中」のまま残る（第2段階の一覧で「中断（記録途中）」として扱う）。
- iPhone Safari 実機での保存・プライベートモード・容量の挙動は未確認（オーナーの受入で確認）。
