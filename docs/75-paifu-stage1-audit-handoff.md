# 数雀｜牌譜 第1段階：Codex 独立監査の引き継ぎ資料

## 第3回の限定再監査（PR #69 監査 HEAD 89d083a の残りの P2 の修正）
| 指摘 | 修正 | 確かめてほしいこと | 固定のテスト |
|---|---|---|---|
| P2 接続なし・行動0件の旧試合の復活 | `src/ui/paifu-recorder.js` の `bind()`：`actionsBeforeBind === 0` による新しい世代への結び付けを廃止（`actionsBeforeBind` 自体を削除）。代替の経路は `epochPre` と一致するときだけ結び付け、違えば `epoch-changed`、`epochPre` が分からなければ `not-ready` | 接続なしの経路で、削除の前から存在する試合が行動0件でも新しい世代に付け替えられないか。削除の後に始めた試合（接続あり・接続なしで世代を覚えた後）は保存できるか。ゲームが記録の準備を待たないか | 単体 `tests/paifu-epoch-fallback.test.js`（固定反例・16通りの組合せ・削除なし・`epochPre` 不明）、E2E `v15PaifuEpochFallback`（実際の IndexedDB・2つのタブ）、単体 `paifu-recorder`（代替の規則） |
| E2E の安定化 | `v15PaifuRecording` (5)：リーチ（自動ツモ切り）をせずに止め、「人の操作待ち・結果画面なし」を確かめてから設定を開く。`v15PaifuEpochNoBC`：結果画面は「次へ」で閉じ、押せなければやり直す | アサーションを減らしていないか・固定の sleep に頼っていないか | 複数回の実行 |

再現：
```
node --test tests/paifu-epoch-fallback.test.js tests/paifu-recorder.test.js
node tests/e2e/play.mjs --only v15PaifuEpochFallback,v15PaifuEpochNoBC,v15PaifuRecording
```

## 第2回の限定再監査（PR #69 監査 HEAD 0b0705b の新 P2 の修正）
| 指摘 | 修正 | 確かめてほしいこと | 固定のテスト |
|---|---|---|---|
| P2-A BroadcastChannel なしでの全件削除の後の新しい試合 | `src/ui/paifu-storage.js` の開いたままの接続と `epochNow()`（開始の瞬間に同期に作る読み取りのトランザクション）。`src/ui/paifu-recorder.js` の `startMatch` は `epochAt` でちょうど結び付け、接続がなければ非同期に読み、`epochPre` と同じなら結び付け・違えば `epoch-changed` で記録から外す（第3回で行動0件の条件を廃止）。保存は結び付けの後まで待つ | 通知なしで新しい試合が新しい世代に結び付くか。前の試合（中断の保存）が新しい世代に付け替えられないか。結び付けの前の行動が欠けた記録を後から作らないか。ゲームの開始が記録の準備を待たないか | E2E `v15PaifuEpochNoBC`（BroadcastChannel を消した2つのタブ・新しい対局・再戦・前の試合の保存を遅らせる）、単体 `paifu-recorder`（P2-A：タブの模擬・新しい対局・再戦・非同期の規則） |
| P2-B 保存中の記録の変更 | `src/engine/paifu.js` の `takePaifuSnapshot`（同期：安全な JSON の検査＋文字列化）・`encodePaifuSnapshot`（Worker）・`encodePaifuSnapshotAsync`（代替）。`store.save` は最初の await の前にスナップショットを作り、検証・正規化 JSON・SHA-256・書込みはそこから | 元のオブジェクトの変更（保存の開始直後・検証中・検証の後で書込みの前）が保存の内容に入らないか。Worker と代替で同じか。成功の後に読込・再検証が通るか。バイト数の上限・安全な JSON・改ざんの拒否が残るか | E2E `v15PaifuSnapshot`（Worker／代替 × 3つの時点）、単体 `paifu-storage`（P2-B） |

再現：
```
node --test tests/paifu.test.js tests/paifu-storage.test.js tests/paifu-recorder.test.js tests/paifu-system.test.js
node tests/e2e/play.mjs --only v15PaifuEpochNoBC,v15PaifuSnapshot,v15PaifuEpoch,v15PaifuStorage,v15PaifuLoadFailure,v15PaifuRecording,v15PaifuExclusions
node tests/e2e/paifu-perf.mjs
```

## 限定再監査（PR #69 監査 HEAD 6e2fb71 の指摘の修正）
| 指摘 | 修正 | 確かめてほしいこと | 固定のテスト |
|---|---|---|---|
| P2-1 上限での自動削除 | `src/ui/paifu-storage.js` から自動削除を取り除いた。上限超過は `capacity-exceeded` | 上限（件数・バイト数・既存の記録の更新）で既存の行が変わらないか。`evict` が受け付けられないか。保存の失敗が表示されるか | E2E `v15PaifuStorage`、単体 `paifu-storage`（`evict` の拒否） |
| P2-2 全件削除と保存の競合 | DB の `meta` 表の削除の世代。`clearAll` は表の消去と世代の更新を同じトランザクションで。`save` は世代を必須にし、トランザクションの中で照合（`stale-epoch`） | 初回の保存前・SHA-256 の計算中・DB 待ち（両順序）・保存の後で、削除の前の要求が牌譜を復活させないか。別のタブ。削除の後の新しい試合 | E2E `v15PaifuEpoch`（保存先の各時点の決定的な割り込み＋アプリの2つのタブ）、単体 `paifu-recorder`（P2-2） |
| P2-3 読込の障害の分離 | `src/ui/app.js` は `import('./paifu-system.js')`（動的）。読込前・失敗時は何もしない窓口。読込の前に始まった試合は記録しない | 取得失敗・構文エラー・HTTP 500・遅延で、タイトル・通常対局・初心者の部屋が動くか。途中から記録しないか | E2E `v15PaifuLoadFailure`、単体 `paifu-recorder`（P2-3） |
| P3-1 表示の区別 | `describePaifuStatus`（`src/ui/paifu-recorder.js`） | 記録中・未保存／保存処理中／保存済み／保存失敗／対象外が別の文か。「保存中」は実際に保存している間だけか | 単体 `paifu-recorder`（P3-1） |
| 性能 | 検証を Web Worker（`src/ui/paifu-worker.js`）で。失敗時は主スレッドで分割（`verifyPaifuAsync`） | 検証を省略していないか（Worker・分割とも同じ検証）。主スレッドの停止の実測 | `tests/e2e/paifu-perf.mjs`・`docs/validation/paifu-perf.json`、単体 `paifu-system` |

再現：
```
node --test tests/paifu.test.js tests/paifu-storage.test.js tests/paifu-recorder.test.js tests/paifu-system.test.js
node tests/e2e/play.mjs --only v15PaifuStorage,v15PaifuEpoch,v15PaifuLoadFailure,v15PaifuRecording,v15PaifuExclusions
node tests/e2e/paifu-perf.mjs
```

---

## 初回の監査の資料（HEAD 6e2fb71）

対象：牌譜の自動記録・端末内保存（docs/74）。監査は PR の固定 HEAD（フル SHA）を GitHub から取得して行う。
本番の AI・ルール・得点・既存のエンジンのファイル・ヒント・聴牌サポート・再現 URL・localStorage のキーは変更しない設計。mainマージ・Pages公開はしていない。

## 変更の範囲
| 種別 | ファイル |
|---|---|
| 新規（エンジン層・DOMなし） | `src/engine/paifu.js` |
| 新規（UI層・保存） | `src/ui/paifu-storage.js`、`src/ui/paifu-recorder.js`、`src/ui/paifu-system.js`（動的 import の入口）、`src/ui/paifu-worker.js`（検証の Worker） |
| 変更（接続・表示） | `src/ui/app.js`、`src/ui/styles.css` |
| テスト | `tests/paifu.test.js`、`tests/paifu-storage.test.js`、`tests/paifu-recorder.test.js`、`tests/paifu-harness.mjs`、`tests/e2e/play.mjs`（`v15Paifu*`） |
| CI・文書 | `.github/workflows/paifu-recording.yml`、`docs/74`、`docs/75` |

## app.js の接続箇所（全6か所＋表示）
| 場所 | 呼び出し | 確認してほしいこと |
|---|---|---|
| `startMatch` の最後（`startRound` の前） | `paifu.startMatch({eligible, reason, mode, length, seedBase, match, players})` | 対象外の判定（卒業試験・再現 URL・過去のルール・旧規則）。前の試合が記録中なら reset として中断を保存 |
| `startRound`（`new Game` の直後） | `paifu.roundStarted(S.game, { presetWall })` | テスト用の山の局は記録をやめる |
| `step()` の AI の `applyAction` の直後 | `paifu.actionApplied(g, seat, action, 'ai', eventsBefore)` | AI の判断・乱数・計測の順序が変わっていないか |
| `applyHumanAction(action, source)` の成功の後 | `paifu.actionApplied(g, 0, action, source, eventsBefore)` | 拒否された操作は記録しない。自動パス（`'auto-pass'`）・自動ツモ切り（`'auto-tsumogiri'`）の出どころ |
| `finishRound`（`applyRoundResult` の直後・1局1回） | `paifu.roundSettled(g, S.match, { maxRound: MAX_ROUND })` | 精算の引数が同じか |
| `leaveGame`（最初） | `paifu.leave('left-match')` | 完了した試合では何もしない |
| `pagehide` | `paifu.flush()` | ベストエフォート。途中退出・流局にしない |
| 表示 | `paifuStatusText()`（最終結果・設定）、`paifuTitleHTML()`（タイトル） | 内容（手牌・山）を出さない・端末内だけと明記 |

## 重点監査項目
1. **再現の正しさ**：`verifyPaifu` が、記録された選択だけで（AI の再判断なし）各手の状態・局の結果・精算・試合の状態を再現し、改ざん・取り違え・欠落・順序の入替えを拒否するか。`stateDigest` の対象（手牌・山・河・面子・記録・リーチ・フリテン・王牌・結果）に漏れがないか。
2. **現行ルールとの一致**：ruleset 2（王牌・ドラ・暗カン・数学Ⅱの通常ツモ24回・フリテン・四家立直）、リーチ宣言料5点の供託、1/4/8局戦、アガリやめ、`maxRound` の打ち切り、400点保存・終了時の供託0。
3. **ゲームの進行への非依存**：記録・保存の失敗（例外・利用不可・容量不足・タイムアウト・競合・結果不明）でも試合が進むか。窓口が例外を出さないか。ゲーム本体・AI の乱数を消費しないか（ID は `crypto.getRandomValues`）。
4. **保存の安全性**：IndexedDB のトランザクション（保存と自動削除の原子性）、トークンの CAS、複数タブ、自動削除の対象（完了・中断だけ・記録中は残す）、読めない行の扱い、既存の localStorage のキーと PR #37 の DB との分離。
5. **対象外の混入防止**：卒業試験・初心者の部屋・再現 URL・過去のルール・テスト用の山・テスト用のフックによる状態の差し替え。
6. **世代の分離**：前の試合の保存が終わる前に新しい試合を始めたとき、前の試合の中断の保存が正しいトークンで行われ、表示が混ざらないか（`tests/paifu-recorder.test.js` の最後のテスト）。
7. **情報の扱い**：記録は全員の手牌・山を再現できる（`private-full`）。画面に出さない・送信しない・AI に渡さない。
8. **回帰**：聴牌サポート Ver.1（`v14DiscardPreview`）、2回タップ・長押し、自動パス、リーチ・自動ツモ切り、結果画面。

## 再現の手順
```
git checkout <HEAD>
node --test tests/paifu.test.js tests/paifu-storage.test.js tests/paifu-recorder.test.js
npm test
node tests/e2e/play.mjs --only v15PaifuRecording,v15PaifuExclusions,v15PaifuStorage,v14DiscardPreview
node tests/e2e/play.mjs        # 全体
```

## 未確認・判断待ち
- iPhone Safari 実機（プライベートモード・容量・バックグラウンド）は未確認。
- 上限 100件・32MB と自動削除の方針、静的読込（PR #37 docs/57 は動的読込を推奨）、主スレッドでの検証の負荷は判断待ち（docs/74「未解決」）。
